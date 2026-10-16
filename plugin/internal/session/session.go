package session

import (
	"encoding/json"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/heyJordanParker/oneclaude/plugin/internal/model"
)

const (
	headerSession = "X-Claude-Code-Session-Id"
	headerAgent   = "X-Claude-Code-Agent-Id"
)

var userIDSession = regexp.MustCompile(`_session_([a-f0-9-]+)$`)

// Identity names one agent: a Claude Code session plus, for a subagent, its
// agent id. Claude Code sends the agent id only for subagents.
type Identity struct {
	Session string
	Agent   string
}

func (i Identity) Key() string {
	if i.Session == "" {
		return ""
	}
	if i.Agent == "" {
		return i.Session
	}
	return i.Session + "/" + i.Agent
}

func (i Identity) Subagent() bool {
	return i.Agent != ""
}

func FromRequest(headers http.Header, body []byte) Identity {
	id := Identity{Session: header(headers, headerSession), Agent: header(headers, headerAgent)}
	if id.Session == "" {
		id.Session = fromBody(body)
	}
	if id.Agent == "main" {
		id.Agent = ""
	}
	return id
}

func header(h http.Header, name string) string {
	if v := strings.TrimSpace(h.Get(name)); v != "" {
		return v
	}
	for key, values := range h {
		if strings.EqualFold(key, name) {
			for _, v := range values {
				if v = strings.TrimSpace(v); v != "" {
					return v
				}
			}
		}
	}
	return ""
}

func fromBody(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	var payload struct {
		Metadata struct {
			UserID string `json:"user_id"`
		} `json:"metadata"`
	}
	if json.Unmarshal(body, &payload) != nil || payload.Metadata.UserID == "" {
		return ""
	}
	userID := payload.Metadata.UserID
	if m := userIDSession.FindStringSubmatch(userID); len(m) == 2 {
		return m[1]
	}
	if strings.HasPrefix(userID, "{") {
		var inner struct {
			SessionID string `json:"session_id"`
		}
		if json.Unmarshal([]byte(userID), &inner) == nil {
			return strings.TrimSpace(inner.SessionID)
		}
	}
	return ""
}

type agent struct {
	account  string
	family   model.Family
	lastSeen time.Time
	failedAt time.Time
}

// Agents binds each agent to an account and counts the agents active on each
// account per model family.
type Agents struct {
	mu     sync.Mutex
	agents map[string]*agent
}

func NewAgents() *Agents {
	return &Agents{agents: map[string]*agent{}}
}

// Bound returns the account an agent sent a request to within ttl.
func (a *Agents) Bound(key string, now time.Time, ttl time.Duration) (string, bool) {
	if key == "" {
		return "", false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	ag, ok := a.agents[key]
	if !ok || now.Sub(ag.lastSeen) > ttl {
		return "", false
	}
	return ag.account, true
}

func (a *Agents) Touch(key, account string, family model.Family, now time.Time) {
	if key == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	ag, ok := a.agents[key]
	if !ok {
		ag = &agent{}
		a.agents[key] = ag
	}
	if account != "" {
		ag.account = account
	}
	if family != "" {
		ag.family = family
	}
	ag.lastSeen = now
}

// Failed marks an agent's failed request and reports whether the agent had
// already failed within the last two minutes, which makes this one a retry.
func (a *Agents) Failed(key string, now time.Time) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	ag, ok := a.agents[key]
	if !ok {
		return false
	}
	retry := !ag.failedAt.IsZero() && now.Sub(ag.failedAt) < 2*time.Minute
	ag.failedAt = now
	return retry
}

func (a *Agents) RecentlyFailed(key string, now time.Time) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	ag, ok := a.agents[key]
	return ok && !ag.failedAt.IsZero() && now.Sub(ag.failedAt) < 2*time.Minute
}

// Pin is one agent's account, saved so a reload of the plugin keeps every
// running conversation on the account that holds its cache.
type Pin struct {
	Key      string       `json:"key"`
	Account  string       `json:"account"`
	Family   model.Family `json:"family,omitempty"`
	LastSeen time.Time    `json:"last_seen"`
}

func (a *Agents) Pins() []Pin {
	a.mu.Lock()
	defer a.mu.Unlock()
	pins := make([]Pin, 0, len(a.agents))
	for key, ag := range a.agents {
		if ag.account != "" {
			pins = append(pins, Pin{Key: key, Account: ag.account, Family: ag.family, LastSeen: ag.lastSeen})
		}
	}
	sort.Slice(pins, func(i, j int) bool { return pins[i].Key < pins[j].Key })
	return pins
}

// Restore adds saved pins, keeping any agent seen since.
func (a *Agents) Restore(pins []Pin) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, pin := range pins {
		if ag, ok := a.agents[pin.Key]; ok && !ag.lastSeen.Before(pin.LastSeen) {
			continue
		}
		a.agents[pin.Key] = &agent{account: pin.Account, family: pin.Family, lastSeen: pin.LastSeen}
	}
}

// Active counts agents seen within model.ActiveWindow, per account and family.
func (a *Agents) Active(now time.Time) map[string]map[model.Family]int {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := map[string]map[model.Family]int{}
	for key, ag := range a.agents {
		age := now.Sub(ag.lastSeen)
		if age > 24*time.Hour {
			delete(a.agents, key)
			continue
		}
		if age > model.ActiveWindow || ag.account == "" {
			continue
		}
		if out[ag.account] == nil {
			out[ag.account] = map[model.Family]int{}
		}
		out[ag.account][ag.family]++
	}
	return out
}
