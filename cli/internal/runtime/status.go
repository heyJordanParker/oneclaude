package runtime

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"maps"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/heyJordanParker/oneclaude/cli/internal/model"
	"github.com/heyJordanParker/oneclaude/cli/internal/usage"
)

const (
	resourceDashboardPath = "/dashboard"
	resourceStatusPath    = "/status.json"
	resourceHistoryPath   = "/history.json"
	resourceUsagePath     = "/usage.json"
	routeStatus           = "/status"
	historyWindow         = 7 * 24 * time.Hour
	daysKept              = 90
	dayLayout             = "2006-01-02"
)

//go:embed dashboard.html
var dashboardPage []byte

var dashboardPolicy = "default-src 'none'; script-src " + scriptHash(dashboardPage) + "; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"

type Status struct {
	Version  string          `json:"version"`
	Now      time.Time       `json:"now"`
	Pool     PoolStatus      `json:"pool"`
	Accounts []AccountStatus `json:"accounts"`
	Codex    []CodexStatus   `json:"codex"`
	Warnings []Warning       `json:"warnings"`
}

type CodexStatus struct {
	Name      string     `json:"name"`
	Known     bool       `json:"known"`
	Used      float64    `json:"used"`
	ResetsAt  *time.Time `json:"resets_at,omitempty"`
	Projected bool       `json:"projected"`
	Empty     bool       `json:"empty"`
}

type PoolStatus struct {
	Used       float64    `json:"used"`
	Even       float64    `json:"even"`
	Pace       float64    `json:"pace"`
	NextRefill *time.Time `json:"next_refill,omitempty"`
	RefillGain float64    `json:"refill_gain"`
	Agents     int        `json:"agents"`
	Accounts   int        `json:"accounts"`
	Known      int        `json:"known"`
}

type AccountStatus struct {
	Name       string               `json:"name"`
	Plan       string               `json:"plan,omitempty"`
	Known      bool                 `json:"known"`
	Used       float64              `json:"used"`
	ResetsAt   *time.Time           `json:"resets_at,omitempty"`
	ObservedAt *time.Time           `json:"observed_at,omitempty"`
	Projected  bool                 `json:"projected"`
	Empty      bool                 `json:"empty"`
	Agents     map[model.Family]int `json:"agents"`
	Limits     map[model.Family]int `json:"limits"`
}

// History is each account's requests by the hour for the last 7 days.
type History struct {
	Now      time.Time        `json:"now"`
	Accounts []AccountHistory `json:"accounts"`
}

// dayKey is one day's requests for one account, by its hashed id, model,
// agent type and project. agent is "main" for a main session and empty for a
// subagent whose type Claude Code had not written down; project is empty
// likewise.
type dayKey struct {
	day, account, model, agent, project string
}

type dayUsage struct {
	tokens model.Tokens
	cost   model.Cost
}

type AccountHistory struct {
	Name      string        `json:"name"`
	AuthIndex string        `json:"auth_index,omitempty"`
	Hours     []HourHistory `json:"hours"`
}

type HourHistory struct {
	At       time.Time      `json:"at"`
	Requests int            `json:"requests"`
	Outcomes map[string]int `json:"outcomes"`
	Tokens   model.Tokens   `json:"tokens"`
}

// requestHistory holds the request log as History serves it: hours per
// account, and days per account, model, agent type and project.
type requestHistory struct {
	hours map[string]map[int64]*HourHistory
	days  map[dayKey]*dayUsage
}

func newRequestHistory() requestHistory {
	return requestHistory{hours: map[string]map[int64]*HourHistory{}, days: map[dayKey]*dayUsage{}}
}

// Status is the pool as the mod draws it. Every account counts equally; an
// account whose week reset since its last reading shows as projected.
func (p *Plugin) Status() Status {
	s := p.settings()
	now := p.now()
	active := p.agents.Active(now)
	st := Status{Version: p.opts.Version, Now: now, Accounts: []AccountStatus{}, Codex: []CodexStatus{}, Warnings: []Warning{}}
	p.mu.Lock()
	accounts := make([]accountState, 0, len(p.accounts))
	for _, a := range p.accounts {
		accounts = append(accounts, *a)
	}
	for _, c := range p.codex {
		row := CodexStatus{Name: c.Name, Known: c.known}
		if c.known {
			w, projected := c.weekly.Now(now)
			row.Used, row.Projected, row.Empty = w.Used, projected, w.Rejected || w.Used >= 1
			if !w.ResetsAt.IsZero() {
				resets := w.ResetsAt
				row.ResetsAt = &resets
			}
		}
		st.Codex = append(st.Codex, row)
	}
	for _, w := range p.warnings {
		if now.Sub(w.At) <= 24*time.Hour {
			st.Warnings = append(st.Warnings, w)
		}
	}
	p.mu.Unlock()
	sort.Slice(accounts, func(i, j int) bool { return accounts[i].Name < accounts[j].Name })
	sort.Slice(st.Codex, func(i, j int) bool { return st.Codex[i].Name < st.Codex[j].Name })

	var used, even float64
	for _, a := range accounts {
		row := AccountStatus{Name: a.Name, Plan: a.Plan, Known: a.known, Agents: map[model.Family]int{}, Limits: map[model.Family]int{}}
		for _, f := range model.Families {
			row.Limits[f] = p.book.Limit(s, a.Plan, f)
			if n := active[a.ID][f]; n > 0 {
				row.Agents[f] = n
				st.Pool.Agents += n
			}
		}
		if a.known {
			w, projected := a.weekly.Now(now)
			observed := a.weekly.ObservedAt
			row.Used, row.ObservedAt, row.Projected = w.Used, &observed, projected
			row.Empty = w.Rejected || w.Used >= 1
			used += w.Used
			even += w.Elapsed(now)
			st.Pool.Known++
			if !w.ResetsAt.IsZero() {
				resets := w.ResetsAt
				row.ResetsAt = &resets
				if st.Pool.NextRefill == nil || resets.Before(*st.Pool.NextRefill) {
					st.Pool.NextRefill, st.Pool.RefillGain = &resets, w.Used
				}
			}
		}
		st.Accounts = append(st.Accounts, row)
	}
	st.Pool.Accounts = len(accounts)
	if st.Pool.Known > 0 {
		st.Pool.Used = used / float64(st.Pool.Known)
		st.Pool.Even = even / float64(st.Pool.Known)
		st.Pool.Pace = st.Pool.Used - st.Pool.Even
		st.Pool.RefillGain /= float64(st.Pool.Known)
	}
	return st
}

func (p *Plugin) accountList() []model.Account {
	p.mu.Lock()
	defer p.mu.Unlock()
	accounts := make([]model.Account, 0, len(p.accounts))
	for _, a := range p.accounts {
		accounts = append(accounts, a.Account)
	}
	return accounts
}

func (p *Plugin) History() History {
	p.readRequestLog()
	now := p.now()
	cutoff := now.Add(-historyWindow).Truncate(time.Hour)
	rows := map[string]AccountHistory{}
	for _, a := range p.accountList() {
		rows[p.hash(a.ID)] = AccountHistory{Name: a.Name, AuthIndex: a.AuthIndex, Hours: []HourHistory{}}
	}
	hist := History{Now: now, Accounts: make([]AccountHistory, 0, len(rows))}
	p.mu.Lock()
	for account, hours := range p.history.hours {
		row, ok := rows[account]
		if !ok {
			row = AccountHistory{Name: account, Hours: []HourHistory{}}
		}
		for _, h := range hours {
			if h.At.Before(cutoff) {
				continue
			}
			hour := *h
			hour.Outcomes = maps.Clone(h.Outcomes)
			row.Hours = append(row.Hours, hour)
		}
		rows[account] = row
	}
	p.mu.Unlock()
	for _, row := range rows {
		sort.Slice(row.Hours, func(i, j int) bool { return row.Hours[i].At.Before(row.Hours[j].At) })
		hist.Accounts = append(hist.Accounts, row)
	}
	sort.Slice(hist.Accounts, func(i, j int) bool { return hist.Accounts[i].Name < hist.Accounts[j].Name })
	return hist
}

// readRequestLog adds the lines earlier loads wrote to requests.jsonl, the
// last 90 days of them, once per load, after filling in the lines logged
// before oneclaude recorded their agent and project. load starts it in the
// background, so the first History waits for it only while it is still
// reading.
func (p *Plugin) readRequestLog() {
	p.historyMu.Lock()
	defer p.historyMu.Unlock()
	p.mu.Lock()
	read, dir, loadedAt, log := p.historyRead, p.loadedDir, p.loadedAt, p.log
	p.mu.Unlock()
	if read || dir == "" {
		return
	}
	stillLoaded := func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		return p.loadedDir == dir && p.loadedAt.Equal(loadedAt)
	}
	path := filepath.Join(dir, "requests.jsonl")
	p.backfill(path, log, stillLoaded)
	earlier := newRequestHistory()
	hoursFrom := loadedAt.Add(-historyWindow)
	daysFrom := loadedAt.AddDate(0, 0, -daysKept)
	current := true
	lines := 0
	_ = usage.ReadBack(path, func(raw []byte) bool {
		if lines++; lines%4096 == 0 {
			current = stillLoaded()
		}
		var line requestLine
		if json.Unmarshal(raw, &line) != nil {
			return current
		}
		if line.At.Before(daysFrom) {
			return false
		}
		if line.At.Before(loadedAt) {
			earlier.add(line, !line.At.Before(hoursFrom))
		}
		return current
	})
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.loadedDir != dir || !p.loadedAt.Equal(loadedAt) {
		return
	}
	for account, hours := range earlier.hours {
		for _, h := range hours {
			p.history.bucket(account, h.At).merge(h)
		}
	}
	for key, d := range earlier.days {
		p.history.day(key).merge(d)
	}
	p.historyRead = true
}

// add counts one request, in its hour when withHour, and in its day.
func (h requestHistory) add(line requestLine, withHour bool) {
	if withHour {
		h.bucket(line.Account, line.At.Truncate(time.Hour).UTC()).merge(&HourHistory{Requests: 1, Outcomes: map[string]int{line.Outcome: 1}, Tokens: line.Tokens})
	}
	agent := line.Agent
	if !line.Subagent {
		agent = "main"
	}
	modelID := model.ModelOf(line.Model, line.Family)
	h.day(dayKey{day: line.At.In(time.Local).Format(dayLayout), account: line.Account, model: modelID, agent: agent, project: line.Project}).
		merge(&dayUsage{tokens: line.Tokens, cost: model.CostOf(modelID, line.Tokens)})
}

func (h requestHistory) day(key dayKey) *dayUsage {
	d := h.days[key]
	if d == nil {
		d = &dayUsage{}
		h.days[key] = d
	}
	return d
}

func (d *dayUsage) merge(other *dayUsage) {
	d.tokens.Add(other.tokens)
	d.cost.Add(other.cost)
}

func (h requestHistory) bucket(account string, at time.Time) *HourHistory {
	hours := h.hours[account]
	if hours == nil {
		hours = map[int64]*HourHistory{}
		h.hours[account] = hours
	}
	hour := hours[at.Unix()]
	if hour == nil {
		hour = &HourHistory{At: at, Outcomes: map[string]int{}}
		hours[at.Unix()] = hour
		for key, old := range hours {
			if at.Sub(old.At) > historyWindow {
				delete(hours, key)
			}
		}
	}
	return hour
}

func (h *HourHistory) merge(other *HourHistory) {
	h.Requests += other.Requests
	for outcome, n := range other.Outcomes {
		h.Outcomes[outcome] += n
	}
	h.Tokens.Add(other.Tokens)
}

func scriptHash(page []byte) string {
	_, rest, _ := bytes.Cut(page, []byte("<script>"))
	script, _, _ := bytes.Cut(rest, []byte("</script>"))
	sum := sha256.Sum256(script)
	return "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
}

func (p *Plugin) managementRegister(payload []byte) ([]byte, error) {
	var req ManagementRegistrationRequest
	_ = json.Unmarshal(payload, &req)
	mgmt := strings.TrimRight(req.BasePath, "/")
	if mgmt == "" {
		mgmt = "/v0/management"
	}
	resource := strings.TrimRight(req.ResourceBasePath, "/")
	if resource == "" {
		resource = "/v0/resource/plugins/" + p.opts.Name
	}
	p.mu.Lock()
	p.mgmtBase, p.resourceBase = mgmt, resource
	p.mu.Unlock()
	return okEnvelope(ManagementRegistrationResponse{
		Routes: []ManagementRoute{
			{Method: http.MethodGet, Path: mgmt + "/plugins/" + p.opts.Name + routeStatus, Description: "The pool's usage, pace, accounts and warnings as JSON."},
		},
		Resources: []ResourceRoute{
			{Path: resource + resourceDashboardPath, Menu: "oneclaude", Description: "Your Claude pool, its accounts and the proxy"},
			{Path: resource + resourceStatusPath, Description: "The pool's usage, pace, accounts and warnings as JSON, for the oneclaude mod."},
			{Path: resource + resourceHistoryPath, Description: "Each account's requests per hour over the last 7 days as JSON, for the dashboard."},
			{Path: resource + resourceUsagePath, Description: "Usage at API list prices for ?period=today|yesterday|week|month by ?by=account|model|agent|project|day, sorted by ?units=cost|tokens, as JSON."},
		},
	})
}

func (p *Plugin) managementHandle(payload []byte) ([]byte, error) {
	var req ManagementRequest
	if err := json.Unmarshal(payload, &req); err != nil {
		return okEnvelope(jsonResponse(http.StatusBadRequest, map[string]string{"error": "undecodable request"}))
	}
	p.mu.Lock()
	mgmt, resource := p.mgmtBase, p.resourceBase
	p.mu.Unlock()
	switch {
	case req.Path == resource+resourceDashboardPath:
		return okEnvelope(ManagementResponse{
			StatusCode: http.StatusOK,
			Headers: http.Header{
				"Content-Type":            {"text/html; charset=utf-8"},
				"Cache-Control":           {"no-store"},
				"Content-Security-Policy": {dashboardPolicy},
				"X-Content-Type-Options":  {"nosniff"},
				"Referrer-Policy":         {"no-referrer"},
			},
			Body: dashboardPage,
		})
	case req.Path == resource+resourceStatusPath, req.Path == mgmt+"/plugins/"+p.opts.Name+routeStatus:
		return okEnvelope(jsonResponse(http.StatusOK, p.Status()))
	case req.Path == resource+resourceHistoryPath:
		return okEnvelope(jsonResponse(http.StatusOK, p.History()))
	case req.Path == resource+resourceUsagePath:
		return okEnvelope(jsonResponse(http.StatusOK, p.Usage(req.Query.Get("period"), req.Query.Get("by"), req.Query.Get("units"))))
	default:
		return okEnvelope(jsonResponse(http.StatusNotFound, map[string]string{"error": "unknown path"}))
	}
}

func jsonResponse(status int, body any) ManagementResponse {
	encoded, err := json.Marshal(body)
	if err != nil {
		status, encoded = http.StatusInternalServerError, []byte(`{"error":"failed to encode response"}`)
	}
	return ManagementResponse{
		StatusCode: status,
		Headers: http.Header{
			"Content-Type":  {"application/json; charset=utf-8"},
			"Cache-Control": {"no-store"},
		},
		Body: encoded,
	}
}
