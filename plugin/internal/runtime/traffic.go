package runtime

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/heyJordanParker/oneclaude/plugin/internal/limits"
	"github.com/heyJordanParker/oneclaude/plugin/internal/model"
	"github.com/heyJordanParker/oneclaude/plugin/internal/route"
	"github.com/heyJordanParker/oneclaude/plugin/internal/session"
	"github.com/heyJordanParker/oneclaude/plugin/internal/usage"
)

// The interceptor is the only hook that sees the request body and the client's
// headers, so it hands the agent's identity to the pick in these headers.
const (
	headerKey    = "X-Oneclaude-Key"
	headerFamily = "X-Oneclaude-Family"
)

var bridgeHeaders = []string{headerKey, headerFamily}

const claudeProvider = "claude"

func (p *Plugin) interceptBefore(payload []byte) ([]byte, error) {
	var req RequestInterceptRequest
	if err := json.Unmarshal(payload, &req); err != nil {
		return okEnvelope(RequestInterceptResponse{ClearHeaders: bridgeHeaders})
	}
	modelID := req.RequestedModel
	if modelID == "" {
		modelID = req.Model
	}
	s := p.settings()
	if !s.Enabled || !model.IsClaude(modelID) {
		return okEnvelope(RequestInterceptResponse{ClearHeaders: bridgeHeaders})
	}
	id := session.FromRequest(req.Headers, req.Body)
	family := model.FamilyOf(modelID)
	now := p.now()
	key := id.Key()

	if id.Subagent() && s.LimitsOn {
		if _, bound := p.agents.Bound(key, now, s.AffinityTTL); !bound && !p.agents.RecentlyFailed(key, now) {
			if full, limit := p.poolFull(s, family, now); full {
				return okEnvelope(p.refuse(s, family, limit, now))
			}
		}
	}

	if rid := requestKey(req.TraceID, req.RequestID); rid != "" {
		p.mu.Lock()
		p.requests[rid] = request{key: key, family: family, subagent: id.Subagent(), at: now}
		if len(p.requests) > 20000 {
			for rid, r := range p.requests {
				if now.Sub(r.at) > 30*time.Minute {
					delete(p.requests, rid)
				}
			}
		}
		p.mu.Unlock()
	}
	headers := http.Header{}
	headers.Set(headerFamily, string(family))
	if key != "" {
		headers.Set(headerKey, key)
	}
	return okEnvelope(RequestInterceptResponse{ClearHeaders: bridgeHeaders, Headers: headers})
}

// poolFull reports whether every known account is at its limit for family.
func (p *Plugin) poolFull(s model.Settings, family model.Family, now time.Time) (bool, int) {
	cands := p.candidates(nil, family, now)
	if len(cands) == 0 {
		return false, 0
	}
	return route.AllFull(cands, s.LimitsOn, now), cands[0].Limit
}

func (p *Plugin) refuse(s model.Settings, family model.Family, limit int, now time.Time) RequestInterceptResponse {
	minutes := int(s.RetryAfter.Round(time.Minute) / time.Minute)
	name := strings.ToUpper(string(family[:1])) + string(family[1:])
	message := fmt.Sprintf("Every Claude account is at its %s limit of %d agents. Retry this subagent in %d minutes.", name, limit, minutes)
	body, _ := json.Marshal(map[string]any{
		"type":  "error",
		"error": map[string]string{"type": "rate_limit_error", "message": message},
	})
	p.warn(Warning{At: now, Kind: "refused", Family: family, Agents: limit, Detail: fmt.Sprintf("subagent refused, every account at its %s limit, told to retry in %d minutes", name, minutes)})
	return RequestInterceptResponse{
		ClearHeaders: bridgeHeaders,
		Terminate:    true,
		StatusCode:   http.StatusTooManyRequests,
		ResponseHeaders: http.Header{
			"Content-Type":   {"application/json"},
			"Retry-After":    {fmt.Sprintf("%d", int(s.RetryAfter.Seconds()))},
			"X-Should-Retry": {"false"},
		},
		ResponseBody: body,
	}
}

// candidates describes accounts for family. With ids nil it describes every
// known account; otherwise the offered ones, in the order offered.
func (p *Plugin) candidates(ids []string, family model.Family, now time.Time) []route.Candidate {
	s := p.settings()
	active := p.agents.Active(now)
	p.mu.Lock()
	if ids == nil {
		for id := range p.accounts {
			ids = append(ids, id)
		}
	}
	type snap struct {
		plan   string
		weekly model.Weekly
		known  bool
	}
	snaps := make([]snap, len(ids))
	for i, id := range ids {
		if a, ok := p.accounts[id]; ok {
			snaps[i] = snap{plan: a.Plan, weekly: a.weekly, known: a.known}
		}
	}
	p.mu.Unlock()
	out := make([]route.Candidate, len(ids))
	for i, id := range ids {
		out[i] = route.Candidate{
			ID:     id,
			Weekly: snaps[i].weekly,
			Known:  snaps[i].known,
			Agents: active[id][family],
			Limit:  p.book.Limit(s, snaps[i].plan, family),
		}
	}
	return out
}

func (p *Plugin) pickEnvelope(payload []byte) ([]byte, error) {
	var req SchedulerPickRequest
	if err := json.Unmarshal(payload, &req); err != nil {
		return okEnvelope(SchedulerPickResponse{Handled: false})
	}
	return okEnvelope(p.pick(req))
}

func (p *Plugin) pick(req SchedulerPickRequest) SchedulerPickResponse {
	s := p.settings()
	if !s.Enabled || !governs(req) {
		return SchedulerPickResponse{Handled: false}
	}
	var ids []string
	for _, c := range req.Candidates {
		if c.Provider == "" || c.Provider == claudeProvider {
			ids = append(ids, c.ID)
		}
	}
	if len(ids) == 0 {
		return SchedulerPickResponse{Handled: false}
	}
	headers := http.Header(req.Options.Headers)
	key := headers.Get(headerKey)
	family := model.Family(headers.Get(headerFamily))
	if family == "" {
		family = model.FamilyOf(req.Model)
	}
	now := p.now()
	p.remember(ids)

	if account, ok := p.agents.Bound(key, now, s.AffinityTTL); ok && contains(ids, account) {
		p.agents.Touch(key, account, family, now)
		return SchedulerPickResponse{AuthID: account, Handled: true}
	}
	best, ok := route.Best(p.candidates(ids, family, now), now, s.LimitsOn)
	if !ok {
		return SchedulerPickResponse{Handled: false}
	}
	p.agents.Touch(key, best.ID, family, now)
	return SchedulerPickResponse{AuthID: best.ID, Handled: true}
}

func governs(req SchedulerPickRequest) bool {
	if req.Provider == claudeProvider {
		return true
	}
	if req.Provider == "" {
		for _, provider := range req.Providers {
			if provider == claudeProvider {
				return model.IsClaude(req.Model)
			}
		}
	}
	return false
}

// remember adds offered accounts the poller has not listed yet.
func (p *Plugin) remember(ids []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, id := range ids {
		if _, ok := p.accounts[id]; !ok {
			p.accounts[id] = &accountState{Account: model.Account{ID: id, Name: accountName(HostAuthFileEntry{ID: id})}}
		}
	}
}

// requestKey ties a usage record to its intercepted request. The trace id is
// the client request's; the request id is per upstream attempt.
func requestKey(traceID, requestID string) string {
	if traceID != "" {
		return traceID
	}
	return requestID
}

func contains(ids []string, id string) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

type requestLine struct {
	At             time.Time    `json:"at"`
	Plan           string       `json:"plan"`
	Family         model.Family `json:"family"`
	Account        string       `json:"account"`
	Subagent       bool         `json:"subagent"`
	Agents         int          `json:"agents_on_account"`
	Outcome        string       `json:"outcome"`
	Status         int          `json:"status,omitempty"`
	RetryOfFailure bool         `json:"retry_of_failure"`
	LatencyMS      int64        `json:"latency_ms"`
	FirstTokenMS   int64        `json:"first_token_ms"`
	Tokens         tokens       `json:"tokens"`
	WeeklyAfter    *float64     `json:"weekly_after,omitempty"`
}

type tokens struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
}

func (p *Plugin) usageEnvelope(payload []byte) ([]byte, error) {
	var rec UsageRecord
	if err := json.Unmarshal(payload, &rec); err == nil {
		p.observe(rec)
	}
	return okEnvelope(emptyResult)
}

func outcomeOf(rec UsageRecord) string {
	if !rec.Failed {
		return "ok"
	}
	switch status := rec.Failure.StatusCode; {
	case status == http.StatusTooManyRequests && usage.QuotaRefused(rec.ResponseHeaders):
		return "quota"
	case status == http.StatusTooManyRequests:
		return "throttled"
	case status == 529:
		return "overloaded"
	default:
		return "error"
	}
}

func (p *Plugin) observe(rec UsageRecord) {
	if rec.Provider != claudeProvider || rec.AuthID == "" {
		return
	}
	s := p.settings()
	now := p.now()
	rid := requestKey(rec.TraceID, rec.RequestID)
	p.mu.Lock()
	r, tracked := p.requests[rid]
	delete(p.requests, rid)
	p.mu.Unlock()
	family := r.family
	if family == "" {
		family = model.FamilyOf(rec.Model)
	}
	p.remember([]string{rec.AuthID})

	weekly, haveWeekly := usage.WeeklyFromHeaders(rec.ResponseHeaders, now)
	p.mu.Lock()
	a := p.accounts[rec.AuthID]
	if haveWeekly {
		a.weekly, a.known = weekly, true
		p.dirty = true
	}
	plan, name := a.Plan, a.Name
	p.mu.Unlock()

	outcome := outcomeOf(rec)
	retry := false
	if tracked && r.key != "" {
		if outcome == "ok" {
			p.agents.Touch(r.key, rec.AuthID, family, now)
		} else {
			retry = p.agents.Failed(r.key, now)
		}
	}
	agents := p.agents.Active(now)[rec.AuthID][family]

	if outcome == "throttled" || outcome == "overloaded" {
		p.warn(Warning{At: now, Kind: outcome, Account: name, Family: family, Agents: agents, Detail: fmt.Sprintf("%s on %s with %d %s agents on the account", outcome, name, agents, family)})
		if outcome == "throttled" && p.book.Record(s, limits.Throttle{At: now, Plan: plan, Family: family, Account: rec.AuthID, Agents: agents}) {
			p.warn(Warning{At: now, Kind: "limit", Family: family, Detail: fmt.Sprintf("%s limit for %s lowered after throttles on 3 days", family, plan)})
		}
	}

	line := requestLine{
		At:             now,
		Plan:           plan,
		Family:         family,
		Account:        p.hash(rec.AuthID),
		Subagent:       r.subagent,
		Agents:         agents,
		Outcome:        outcome,
		Status:         rec.Failure.StatusCode,
		RetryOfFailure: retry,
		LatencyMS:      rec.Latency.Milliseconds(),
		FirstTokenMS:   rec.TTFT.Milliseconds(),
		Tokens: tokens{
			Input:      rec.Detail.InputTokens,
			Output:     rec.Detail.OutputTokens,
			CacheRead:  rec.Detail.CacheReadTokens,
			CacheWrite: rec.Detail.CacheCreationTokens,
		},
	}
	if haveWeekly {
		used := weekly.Used
		line.WeeklyAfter = &used
	}
	p.mu.Lock()
	p.history.add(line)
	log := p.log
	p.mu.Unlock()
	if log != nil {
		log.Append(line)
	}
}
