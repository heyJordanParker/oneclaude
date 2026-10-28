package runtime

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/heyJordanParker/oneclaude/cli/internal/limits"
	"github.com/heyJordanParker/oneclaude/cli/internal/model"
	"github.com/heyJordanParker/oneclaude/cli/internal/session"
	"github.com/heyJordanParker/oneclaude/cli/internal/usage"
)

type Options struct {
	Name         string
	Version      string
	Author       string
	Repository   string
	ConfigFields []ConfigField
	Host         HostFunc
	Now          func() time.Time
	NoPoller     bool
	// ClaudeProjects is Claude Code's projects folder, where the plugin reads
	// each subagent's type and each session's project; empty reads none.
	ClaudeProjects string
}

// accountState is an account as the plugin knows it. served is when it last
// answered each model. throttled, rejected, overloaded and notFound are when
// Anthropic last throttled it, turned it away for its spent week, answered
// overloaded, or answered 404. signedOut is whether its login failed since it
// last answered.
type accountState struct {
	model.Account
	weekly     model.Weekly
	known      bool
	served     map[string]time.Time
	throttled  time.Time
	rejected   time.Time
	overloaded time.Time
	notFound   time.Time
	signedOut  bool
}

// codexAccount is a Codex account the proxy holds. oneclaude routes none of
// its requests and reads only its weekly usage, so the Accounts tab can show it.
type codexAccount struct {
	Name      string
	AuthIndex string
	weekly    model.Weekly
	known     bool
}

// request is an intercepted request until its usage arrives. key is the
// agent the pick placed it as: its session's, or a filter's cache key.
type request struct {
	id     session.Identity
	key    string
	family model.Family
	at     time.Time
}

// A LogEntry is one event that changed where requests go: when, WARN or
// INFO, and a sentence that says what happened and what came of it.
type LogEntry struct {
	At    time.Time `json:"at"`
	Level string    `json:"level"`
	Text  string    `json:"text"`
}

const (
	levelWarn = "WARN"
	levelInfo = "INFO"
)

// An account's throttles and overloads log once per episode: again only after
// this long without one.
const episode = 10 * time.Minute

// Plugin answers every host method. The host calls pick, the interceptor and
// usage concurrently, so shared state sits behind mu, held only for field
// access and never across a host callback.
type Plugin struct {
	opts    Options
	host    host
	now     func() time.Time
	cfg     atomic.Pointer[model.Settings]
	agents  *session.Agents
	book    *limits.Book
	records *session.Records

	mu           sync.Mutex
	accounts     map[string]*accountState
	codex        map[string]*codexAccount
	requests     map[string]request
	events       []LogEntry
	refusedAt    time.Time
	log          *usage.Log
	salt         string
	loadedDir    string
	loadedAt     time.Time
	dirty        bool
	mgmtBase     string
	resourceBase string
	history      requestHistory
	historyRead  bool
	imported     bool

	filterFailedAt map[string]time.Time
	responses      map[string]*response
	responding     atomic.Int32
	sessions       recordSet

	historyMu sync.Mutex

	lifeMu sync.Mutex
	stop   chan struct{}
}

func New(opts Options) *Plugin {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	p := &Plugin{
		opts:     opts,
		host:     newHost(opts.Host),
		now:      opts.Now,
		agents:   session.NewAgents(),
		book:     limits.NewBook(),
		records:  session.NewRecords(opts.ClaudeProjects),
		accounts: map[string]*accountState{},
		codex:    map[string]*codexAccount{},
		requests: map[string]request{},
		history:  newRequestHistory(),

		filterFailedAt: map[string]time.Time{},
		responses:      map[string]*response{},
	}
	s := model.Defaults()
	s.Enabled = false
	p.cfg.Store(&s)
	return p
}

func (p *Plugin) settings() model.Settings {
	return *p.cfg.Load()
}

// Call answers one host method. It never panics: a panic escaping this library
// kills the proxy.
func (p *Plugin) Call(method string, payload []byte) (raw []byte, ok bool) {
	defer func() {
		if r := recover(); r != nil {
			raw, ok = Degrade(method, codePluginPanic, fmt.Sprintf("recovered: %v", r))
			p.host.spawn(func() {
				p.host.log("error", "oneclaude recovered from a panic", map[string]any{"method": method, "panic": fmt.Sprintf("%v", r)})
			})
		}
	}()
	raw, err := p.dispatch(method, payload)
	if err != nil {
		return Degrade(method, codePluginError, err.Error())
	}
	var env Envelope
	if json.Unmarshal(raw, &env) == nil && !env.OK {
		return raw, false
	}
	return raw, true
}

// Degrade is each method's least damaging answer when the plugin cannot serve
// it: a pick declines to the proxy's own routing, an interceptor passes the
// request through, and nothing ever fails a request.
func Degrade(method, code, message string) ([]byte, bool) {
	var result any
	switch method {
	case MethodSchedulerPick:
		result = SchedulerPickResponse{Handled: false}
	case MethodRequestInterceptBefore:
		result = RequestInterceptResponse{ClearHeaders: bridgeHeaders}
	case MethodRequestInterceptAfter, MethodResponseInterceptAfter, MethodStreamChunkIntercept, MethodUsageHandle:
		result = emptyResult
	case MethodManagementHandle:
		result = jsonResponse(500, map[string]string{"error": "plugin request failed"})
	default:
		return errorEnvelope(code, message), false
	}
	raw, err := okEnvelope(result)
	if err != nil {
		return errorEnvelope(code, message), false
	}
	return raw, true
}

func (p *Plugin) dispatch(method string, payload []byte) ([]byte, error) {
	switch method {
	case MethodPluginRegister, MethodPluginReconfigure:
		return p.configure(payload)
	case MethodPluginQuiesce:
		p.stopPoller()
		return okEnvelope(emptyResult)
	case MethodPluginShutdown:
		p.Shutdown()
		return okEnvelope(emptyResult)
	case MethodRequestInterceptBefore:
		return p.interceptBefore(payload)
	case MethodRequestInterceptAfter:
		return okEnvelope(emptyResult)
	case MethodStreamChunkIntercept:
		return p.interceptChunk(payload)
	case MethodResponseInterceptAfter:
		return p.interceptResponse(payload)
	case MethodSchedulerPick:
		return p.pickEnvelope(payload)
	case MethodUsageHandle:
		return p.usageEnvelope(payload)
	case MethodManagementRegister:
		return p.managementRegister(payload)
	case MethodManagementHandle:
		return p.managementHandle(payload)
	default:
		return errorEnvelope(codeUnknownMethod, "unknown method: "+method), nil
	}
}

func (p *Plugin) configure(payload []byte) ([]byte, error) {
	var req LifecycleRequest
	if len(payload) > 0 {
		_ = json.Unmarshal(payload, &req)
	}
	s, err := model.ParseSettings(req.ConfigYAML)
	if err != nil {
		p.host.spawn(func() {
			p.host.log("warn", "oneclaude config is invalid, using defaults", map[string]any{"error": err.Error()})
		})
	}
	p.cfg.Store(&s)
	p.load(s.DataDir)
	p.startPoller()
	return okEnvelope(RegisterResult{
		SchemaVersion: SchemaVersion,
		Metadata: Metadata{
			Name:             p.opts.Name,
			Version:          p.opts.Version,
			Author:           p.opts.Author,
			GitHubRepository: p.opts.Repository,
			ConfigFields:     p.opts.ConfigFields,
		},
		Capabilities: map[string]bool{
			CapabilityRequestInterceptor:  true,
			CapabilityStreamInterceptor:   true,
			CapabilityResponseInterceptor: true,
			CapabilityScheduler:           true,
			CapabilityUsagePlugin:         true,
			CapabilityManagementAPI:       true,
		},
	})
}

// savedUsage is usage.json. Imported is true once the request log holds the
// requests Claude Code's transcripts record from before it.
type savedUsage struct {
	Accounts []savedAccount `json:"accounts"`
	Log      []LogEntry     `json:"log"`
	Imported bool           `json:"imported"`
}

type savedAccount struct {
	model.Account
	Weekly *model.Weekly `json:"weekly,omitempty"`
}

func (p *Plugin) path(name string) string {
	return pathIn(p.settings().DataDir, name)
}

// pathIn is a file of the data folder dir; with no folder the plugin keeps no
// files.
func pathIn(dir, name string) string {
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, name)
}

// load reads the data folder once per folder: usage.json, limits.json and the
// install salt, and opens requests.jsonl.
func (p *Plugin) load(dir string) {
	p.mu.Lock()
	if p.loadedDir == dir {
		p.mu.Unlock()
		return
	}
	old := p.log
	p.loadedDir, p.loadedAt = dir, p.now()
	p.history, p.historyRead, p.imported = newRequestHistory(), false, false
	p.log = usage.NewLog(pathIn(dir, "requests.jsonl"), daysKept*24*time.Hour)
	p.mu.Unlock()
	if old != nil {
		old.Close()
	}
	if dir == "" {
		return
	}
	p.sessions.load(dir, p.now())
	var saved savedUsage
	if usage.ReadJSON(filepath.Join(dir, "usage.json"), &saved) == nil {
		p.mu.Lock()
		for _, a := range saved.Accounts {
			st := &accountState{Account: a.Account}
			if a.Weekly != nil {
				st.weekly, st.known = *a.Weekly, true
			}
			p.accounts[a.ID] = st
		}
		p.events, p.imported = saved.Log, saved.Imported
		p.mu.Unlock()
	}
	var book limits.Saved
	if usage.ReadJSON(filepath.Join(dir, "limits.json"), &book) == nil {
		p.book.Restore(book)
	}
	var pins []session.Pin
	if usage.ReadJSON(filepath.Join(dir, "agents.json"), &pins) == nil {
		p.agents.Restore(pins)
	}
	salt, err := os.ReadFile(filepath.Join(dir, "install.key"))
	if err != nil || len(salt) < 16 {
		buf := make([]byte, 32)
		_, _ = rand.Read(buf)
		salt = []byte(hex.EncodeToString(buf))
		_ = os.MkdirAll(dir, 0o700)
		_ = os.WriteFile(filepath.Join(dir, "install.key"), salt, 0o600)
	}
	p.mu.Lock()
	p.salt = string(salt)
	p.mu.Unlock()
	p.host.spawn(p.readRequestLog)
}

func (p *Plugin) save() {
	if p.agents != nil {
		_ = usage.WriteJSON(p.path("agents.json"), p.agents.Pins())
	}
	p.mu.Lock()
	if !p.dirty {
		p.mu.Unlock()
		return
	}
	p.dirty = false
	saved := savedUsage{Log: append([]LogEntry(nil), p.events...), Imported: p.imported}
	for _, a := range p.accounts {
		sa := savedAccount{Account: a.Account}
		if a.known {
			w := a.weekly
			sa.Weekly = &w
		}
		saved.Accounts = append(saved.Accounts, sa)
	}
	p.mu.Unlock()
	sort.Slice(saved.Accounts, func(i, j int) bool { return saved.Accounts[i].ID < saved.Accounts[j].ID })
	_ = usage.WriteJSON(p.path("usage.json"), saved)
	_ = usage.WriteJSON(p.path("limits.json"), p.book.Snapshot())
}

func (p *Plugin) hash(authID string) string {
	p.mu.Lock()
	salt := p.salt
	p.mu.Unlock()
	sum := sha256.Sum256([]byte(salt + authID))
	return hex.EncodeToString(sum[:])[:8]
}

// note logs one event, and keeps the last 7 days of them, 500 at most.
func (p *Plugin) note(level, format string, args ...any) {
	now := p.now()
	p.mu.Lock()
	defer p.mu.Unlock()
	p.dirty = true
	p.events = append(p.events, LogEntry{At: now, Level: level, Text: fmt.Sprintf(format, args...)})
	cutoff := now.Add(-7 * 24 * time.Hour)
	kept := p.events[:0]
	for _, x := range p.events {
		if x.At.After(cutoff) {
			kept = append(kept, x)
		}
	}
	if len(kept) > 500 {
		kept = kept[len(kept)-500:]
	}
	p.events = kept
}

// familyName is a family as a person writes it: Opus.
func familyName(f model.Family) string {
	if f == "" {
		return ""
	}
	return strings.ToUpper(string(f[:1])) + string(f[1:])
}

// Shutdown stops background work, saves, and waits for outstanding host calls,
// because the host unloads the library as soon as this returns.
func (p *Plugin) Shutdown() {
	p.stopPoller()
	p.save()
	p.mu.Lock()
	log := p.log
	p.log = nil
	p.loadedDir = ""
	p.mu.Unlock()
	if log != nil {
		log.Close()
	}
	p.host.drain(3 * time.Second)
}

func accountName(e HostAuthFileEntry) string {
	for _, v := range []string{e.Email, e.Label, e.Name, e.ID} {
		v = strings.TrimSuffix(strings.TrimSpace(v), ".json")
		if v == "" {
			continue
		}
		if at := strings.Index(v, "@"); at > 0 {
			local := v[:at]
			if dash := strings.LastIndex(local, "-"); dash >= 0 && strings.HasPrefix(v, "claude-") {
				local = local[dash+1:]
			}
			return local
		}
		return v
	}
	return "account"
}
