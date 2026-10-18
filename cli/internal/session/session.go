package session

import (
	"bufio"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/heyJordanParker/oneclaude/cli/internal/model"
)

const (
	headerSession   = "X-Claude-Code-Session-Id"
	headerAgent     = "X-Claude-Code-Agent-Id"
	headerAgentType = "X-Claude-Code-Agent-Type"
)

var userIDSession = regexp.MustCompile(`_session_([a-f0-9-]+)$`)

// Identity names one agent: a Claude Code session plus, for a subagent, its
// agent id and the type Claude Code sends, which names a built-in type such
// as Explore and calls every custom one "custom".
type Identity struct {
	Session string
	Agent   string
	Type    string
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
	id := Identity{Session: header(headers, headerSession), Agent: header(headers, headerAgent), Type: header(headers, headerAgentType)}
	if id.Session == "" {
		id.Session = fromBody(body)
	}
	if id.Agent == "main" {
		id.Agent = ""
	}
	if id.Agent == "" || id.Type == "custom" {
		id.Type = ""
	}
	return id
}

// Records reads what Claude Code writes about its sessions under its
// projects folder: the folder a session runs in, from the cwd its transcript
// records, and a subagent's type, from the meta file Claude Code writes as it
// starts the subagent. Each answer is read once; a session or subagent not
// written yet is looked for again a minute later.
type Records struct {
	root string

	mu       sync.Mutex
	sessions map[string]lookup[sessionRecord]
	types    map[string]lookup[string]
}

// sessionRecord is where a session's transcript lives and the project it
// runs in.
type sessionRecord struct {
	folder  string
	project string
}

// lookup is one answer read from Claude Code's files, or a miss and when it
// was looked for.
type lookup[T any] struct {
	value   T
	found   bool
	checked time.Time
}

const (
	lookAgain  = time.Minute
	remembered = 10000
)

// NewRecords reads the projects folder at root, Claude Code's
// ~/.claude/projects.
func NewRecords(root string) *Records {
	return &Records{root: root, sessions: map[string]lookup[sessionRecord]{}, types: map[string]lookup[string]{}}
}

// remember answers key from cache, or reads it when it was never looked for
// or was missing a minute or more ago.
func remember[T any](r *Records, cache map[string]lookup[T], key string, now time.Time, read func() (T, bool)) T {
	r.mu.Lock()
	known, ok := cache[key]
	r.mu.Unlock()
	if ok && (known.found || now.Sub(known.checked) < lookAgain) {
		return known.value
	}
	value, found := read()
	r.mu.Lock()
	if len(cache) >= remembered {
		clear(cache)
	}
	cache[key] = lookup[T]{value: value, found: found, checked: now}
	r.mu.Unlock()
	return value
}

// ClaudeProjects is where Claude Code keeps its transcripts.
func ClaudeProjects() string {
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, "projects")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude", "projects")
}

// Of answers an agent's type and its session's project: the folder name of
// the session's working directory. A main session's type is empty.
func (r *Records) Of(id Identity, now time.Time) (agentType, project string) {
	if id.Session == "" || r.root == "" {
		return id.Type, ""
	}
	record := remember(r, r.sessions, id.Session, now, func() (sessionRecord, bool) { return r.session(id.Session) })
	if id.Agent == "" || id.Type != "" || record.folder == "" {
		return id.Type, record.project
	}
	return remember(r, r.types, id.Key(), now, func() (string, bool) { return agentTypeIn(record.folder, id) }), record.project
}

func (r *Records) session(sessionID string) (sessionRecord, bool) {
	entries, err := os.ReadDir(r.root)
	if err != nil {
		return sessionRecord{}, false
	}
	for _, entry := range entries {
		folder := filepath.Join(r.root, entry.Name())
		if cwd := cwdOf(filepath.Join(folder, sessionID+".jsonl")); cwd != "" {
			return sessionRecord{folder: folder, project: filepath.Base(cwd)}, true
		}
	}
	return sessionRecord{}, false
}

func agentTypeIn(folder string, id Identity) (string, bool) {
	var meta struct {
		AgentType string `json:"agentType"`
	}
	raw, err := os.ReadFile(filepath.Join(folder, id.Session, "subagents", "agent-"+id.Agent+".meta.json"))
	if err != nil || json.Unmarshal(raw, &meta) != nil {
		return "", false
	}
	return meta.AgentType, meta.AgentType != ""
}

// cwdOf reads a transcript's first lines for the working directory the
// session started in.
func cwdOf(transcript string) string {
	f, err := os.Open(transcript)
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for lines := 0; lines < 50 && scanner.Scan(); lines++ {
		var entry struct {
			Cwd string `json:"cwd"`
		}
		if json.Unmarshal(scanner.Bytes(), &entry) == nil && entry.Cwd != "" {
			return entry.Cwd
		}
	}
	return ""
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
