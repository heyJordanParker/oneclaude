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

	"github.com/heyJordanParker/oneclaude/plugin/internal/model"
	"github.com/heyJordanParker/oneclaude/plugin/internal/usage"
)

const (
	resourceDashboardPath = "/dashboard"
	resourceStatusPath    = "/status.json"
	resourceHistoryPath   = "/history.json"
	routeStatus           = "/status"
	historyWindow         = 7 * 24 * time.Hour
)

//go:embed dashboard.html
var dashboardPage []byte

var dashboardPolicy = "default-src 'none'; script-src " + scriptHash(dashboardPage) + "; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"

type Status struct {
	Version  string          `json:"version"`
	Now      time.Time       `json:"now"`
	Pool     PoolStatus      `json:"pool"`
	Accounts []AccountStatus `json:"accounts"`
	Warnings []Warning       `json:"warnings"`
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

type History struct {
	Now      time.Time        `json:"now"`
	Accounts []AccountHistory `json:"accounts"`
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
	Tokens   tokens         `json:"tokens"`
}

type requestHistory map[string]map[int64]*HourHistory

// Status is the pool as the mod draws it. Every account counts equally; an
// account whose week reset since its last reading shows as projected.
func (p *Plugin) Status() Status {
	s := p.settings()
	now := p.now()
	active := p.agents.Active(now)
	st := Status{Version: p.opts.Version, Now: now, Accounts: []AccountStatus{}, Warnings: []Warning{}}
	p.mu.Lock()
	accounts := make([]accountState, 0, len(p.accounts))
	for _, a := range p.accounts {
		accounts = append(accounts, *a)
	}
	for _, w := range p.warnings {
		if now.Sub(w.At) <= 24*time.Hour {
			st.Warnings = append(st.Warnings, w)
		}
	}
	p.mu.Unlock()
	sort.Slice(accounts, func(i, j int) bool { return accounts[i].Name < accounts[j].Name })

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

func (p *Plugin) History() History {
	p.readRequestLog()
	now := p.now()
	cutoff := now.Add(-historyWindow).Truncate(time.Hour)
	p.mu.Lock()
	accounts := make([]model.Account, 0, len(p.accounts))
	for _, a := range p.accounts {
		accounts = append(accounts, a.Account)
	}
	p.mu.Unlock()
	rows := map[string]AccountHistory{}
	for _, a := range accounts {
		rows[p.hash(a.ID)] = AccountHistory{Name: a.Name, AuthIndex: a.AuthIndex, Hours: []HourHistory{}}
	}
	p.mu.Lock()
	for account, hours := range p.history {
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
	hist := History{Now: now, Accounts: make([]AccountHistory, 0, len(rows))}
	for _, row := range rows {
		sort.Slice(row.Hours, func(i, j int) bool { return row.Hours[i].At.Before(row.Hours[j].At) })
		hist.Accounts = append(hist.Accounts, row)
	}
	sort.Slice(hist.Accounts, func(i, j int) bool { return hist.Accounts[i].Name < hist.Accounts[j].Name })
	return hist
}

func (p *Plugin) readRequestLog() {
	p.historyMu.Lock()
	defer p.historyMu.Unlock()
	p.mu.Lock()
	read, dir, loadedAt := p.historyRead, p.loadedDir, p.loadedAt
	p.mu.Unlock()
	if read {
		return
	}
	earlier := requestHistory{}
	if dir != "" {
		_ = usage.ReadSince(filepath.Join(dir, "requests.jsonl"), loadedAt.Add(-historyWindow), func(raw []byte) {
			var line requestLine
			if json.Unmarshal(raw, &line) == nil && line.At.Before(loadedAt) {
				earlier.add(line)
			}
		})
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.loadedDir != dir || !p.loadedAt.Equal(loadedAt) {
		return
	}
	for account, hours := range earlier {
		for _, h := range hours {
			p.history.bucket(account, h.At).merge(h)
		}
	}
	p.historyRead = true
}

func (h requestHistory) add(line requestLine) {
	hour := h.bucket(line.Account, line.At.Truncate(time.Hour).UTC())
	hour.merge(&HourHistory{Requests: 1, Outcomes: map[string]int{line.Outcome: 1}, Tokens: line.Tokens})
}

func (h requestHistory) bucket(account string, at time.Time) *HourHistory {
	hours := h[account]
	if hours == nil {
		hours = map[int64]*HourHistory{}
		h[account] = hours
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
	h.Tokens.Input += other.Tokens.Input
	h.Tokens.Output += other.Tokens.Output
	h.Tokens.CacheRead += other.Tokens.CacheRead
	h.Tokens.CacheWrite += other.Tokens.CacheWrite
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
