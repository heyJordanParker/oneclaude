package runtime

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/heyJordanParker/oneclaude/plugin/internal/model"
)

const (
	resourceStatusPath = "/status.json"
	routeStatus        = "/status"
)

type Status struct {
	Version  string          `json:"version"`
	Now      time.Time       `json:"now"`
	Pool     PoolStatus      `json:"pool"`
	Accounts []AccountStatus `json:"accounts"`
	Warnings []Warning       `json:"warnings"`
}

type PoolStatus struct {
	Used       float64   `json:"used"`
	Even       float64   `json:"even"`
	Pace       float64   `json:"pace"`
	NextRefill *time.Time `json:"next_refill,omitempty"`
	RefillGain float64   `json:"refill_gain"`
	Agents     int       `json:"agents"`
	Accounts   int       `json:"accounts"`
	Known      int       `json:"known"`
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
			{Path: resource + resourceStatusPath, Menu: "oneclaude", Description: "The pool's usage, pace, accounts and warnings as JSON, for the oneclaude mod."},
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
	case req.Path == resource+resourceStatusPath, req.Path == mgmt+"/plugins/"+p.opts.Name+routeStatus:
		return okEnvelope(jsonResponse(http.StatusOK, p.Status()))
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
