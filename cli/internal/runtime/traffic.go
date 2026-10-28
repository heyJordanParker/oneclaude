package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"time"

	"github.com/heyJordanParker/oneclaude/cli/internal/limits"
	"github.com/heyJordanParker/oneclaude/cli/internal/model"
	"github.com/heyJordanParker/oneclaude/cli/internal/route"
	"github.com/heyJordanParker/oneclaude/cli/internal/session"
	"github.com/heyJordanParker/oneclaude/cli/internal/usage"
)

// The interceptor is the only hook that sees the request body and the client's
// headers, so it hands the agent's identity to the pick in these headers.
const (
	headerKey    = "X-Oneclaude-Key"
	headerFamily = "X-Oneclaude-Family"
)

var bridgeHeaders = []string{headerKey, headerFamily}

const (
	claudeProvider = "claude"
	codexProvider  = "codex"
)

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

	var body []byte
	headers := http.Header{}
	cleared := append(slices.Clone(bridgeHeaders), headerCacheKey)
	if filters := p.sessions.of(id.Session).Filters; len(filters) > 0 {
		c := p.chainOf(filters)
		out := p.filterRequest(req, c)
		if out.answer != nil {
			return okEnvelope(*out.answer)
		}
		if !bytes.Equal(out.body, req.Body) {
			body = out.body
		}
		headers, cleared = out.set, append(cleared, out.cleared...)
		if out.cacheKey != "" {
			key = "cache/" + out.cacheKey
		}
		p.expectResponse(req.RequestID, out.responses, c, now)
	}

	if rid := requestKey(req.TraceID, req.RequestID); rid != "" {
		p.mu.Lock()
		p.requests[rid] = request{id: id, key: key, family: family, at: now}
		if len(p.requests) > 20000 {
			for rid, r := range p.requests {
				if now.Sub(r.at) > 30*time.Minute {
					delete(p.requests, rid)
				}
			}
		}
		p.mu.Unlock()
	}
	headers.Set(headerFamily, string(family))
	if key != "" {
		headers.Set(headerKey, key)
	}
	return okEnvelope(RequestInterceptResponse{ClearHeaders: cleared, Headers: headers, Body: body})
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
	name := familyName(family)
	message := fmt.Sprintf("Every Claude account is at its %s limit of %d agents. Retry this subagent in %d minutes.", name, limit, minutes)
	body, _ := json.Marshal(map[string]any{
		"type":  "error",
		"error": map[string]string{"type": "rate_limit_error", "message": message},
	})
	p.mu.Lock()
	stalled := now.Sub(p.refusedAt) >= s.RetryAfter
	p.refusedAt = now
	p.mu.Unlock()
	if stalled {
		p.note(levelWarn, "oneclaude refused a new %s subagent: every account reached its limit of %d.", name, limit)
	}
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

// requestLine is one request in requests.jsonl. Agent is a subagent's type,
// and Project the folder its session runs in; either is empty when Claude
// Code had not written it down.
type requestLine struct {
	At             time.Time    `json:"at"`
	Plan           string       `json:"plan"`
	Model          string       `json:"model,omitempty"`
	Family         model.Family `json:"family"`
	Account        string       `json:"account"`
	Subagent       bool         `json:"subagent"`
	Agent          string       `json:"agent,omitempty"`
	Project        string       `json:"project,omitempty"`
	Agents         int          `json:"agents_on_account"`
	Outcome        string       `json:"outcome"`
	Status         int          `json:"status,omitempty"`
	RetryOfFailure bool         `json:"retry_of_failure"`
	LatencyMS      int64        `json:"latency_ms"`
	FirstTokenMS   int64        `json:"first_token_ms"`
	Tokens         model.Tokens `json:"tokens"`
	WeeklyAfter    *float64     `json:"weekly_after,omitempty"`
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
	case status == statusClientClosed:
		return "cancelled"
	default:
		return "error"
	}
}

// statusClientClosed is the proxy's status for a request Claude Code dropped,
// as when you press Esc.
const statusClientClosed = 499

// falseBlock is how recently an account must have answered a model for a 404
// on it to be a block that can't be true.
const falseBlock = 24 * time.Hour

// unblock clears every block the proxy holds on an account.
func (p *Plugin) unblock(authIndex string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return p.host.invokeCtx(ctx, MethodHostRoutingResetCooldown, HostRoutingResetCooldownRequest{AuthIndex: authIndex}, nil)
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

	outcome := outcomeOf(rec)
	modelID := model.Canonical(rec.Model)
	weekly, haveWeekly := usage.WeeklyFromHeaders(rec.ResponseHeaders, now)
	p.mu.Lock()
	a := p.accounts[rec.AuthID]
	if haveWeekly {
		a.weekly, a.known = weekly, true
		p.dirty = true
	}
	served, throttled, overloaded, notFound := a.served[modelID], a.throttled, a.overloaded, a.notFound
	limited := !a.throttled.Before(served) || !a.rejected.Before(served) || a.signedOut
	switch outcome {
	case "ok":
		if a.served == nil {
			a.served = map[string]time.Time{}
		}
		a.served[modelID], a.signedOut = now, false
	case "throttled":
		a.throttled = now
	case "quota":
		a.rejected = now
	case "overloaded":
		a.overloaded = now
	case "error":
		if rec.Failure.StatusCode == http.StatusNotFound {
			a.notFound = now
		}
	}
	plan, name := a.Plan, a.Name
	p.mu.Unlock()

	retry := false
	if key := r.key; tracked && key != "" {
		if outcome == "ok" {
			p.agents.Touch(key, rec.AuthID, family, now)
		} else {
			retry = p.agents.Failed(key, now)
		}
	}
	agents := p.agents.Active(now)[rec.AuthID][family]

	switch outcome {
	case "throttled":
		if now.Sub(throttled) >= episode {
			p.note(levelWarn, "Anthropic rate limited %s (429).", name)
		}
		before := p.book.Limit(s, plan, family)
		if p.book.Record(s, limits.Throttle{At: now, Plan: plan, Family: family, Account: rec.AuthID, Agents: agents}) {
			p.note(levelInfo, "oneclaude lowered the %s agent limit from %d to %d after Anthropic rate limited accounts below %d on 3 separate days.", familyName(family), before, p.book.Limit(s, plan, family), before)
		}
	case "overloaded":
		if now.Sub(overloaded) >= episode {
			p.note(levelWarn, "Anthropic returned 529 Overloaded to %s.", name)
		}
	case "error":
		if rec.Failure.StatusCode != http.StatusNotFound {
			break
		}
		label := model.Label(modelID)
		fresh := now.Sub(notFound) >= episode
		if fresh {
			p.note(levelWarn, "Anthropic returned 404 Not Found for %s on %s.", label, name)
		}
		if now.Sub(served) < falseBlock && !limited && rec.AuthIndex != "" {
			p.host.spawn(func() {
				if p.unblock(rec.AuthIndex) == nil && fresh {
					p.note(levelInfo, "oneclaude cleared the proxy's blocks on %s, set after a 404 for %s.", name, label)
				}
			})
		}
	}

	agentType, project := p.labelsOf(r.id.Session, r.id.Agent, r.id.Type)
	line := requestLine{
		At:             now,
		Plan:           plan,
		Model:          modelID,
		Family:         family,
		Account:        p.hash(rec.AuthID),
		Subagent:       r.id.Subagent(),
		Agent:          agentType,
		Project:        project,
		Agents:         agents,
		Outcome:        outcome,
		Status:         rec.Failure.StatusCode,
		RetryOfFailure: retry,
		LatencyMS:      rec.Latency.Milliseconds(),
		FirstTokenMS:   rec.TTFT.Milliseconds(),
		Tokens: model.Tokens{
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
	p.history.add(line, true)
	log := p.log
	p.mu.Unlock()
	if log != nil {
		log.Append(line)
	}
}
