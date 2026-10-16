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

	"github.com/heyJordanParker/oneclaude/plugin/internal/limits"
	"github.com/heyJordanParker/oneclaude/plugin/internal/model"
	"github.com/heyJordanParker/oneclaude/plugin/internal/session"
	"github.com/heyJordanParker/oneclaude/plugin/internal/usage"
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
}

type accountState struct {
	model.Account
	weekly model.Weekly
	known  bool
}

type request struct {
	key      string
	family   model.Family
	subagent bool
	at       time.Time
}

type Warning struct {
	At      time.Time    `json:"at"`
	Kind    string       `json:"kind"`
	Account string       `json:"account,omitempty"`
	Family  model.Family `json:"family,omitempty"`
	Agents  int          `json:"agents,omitempty"`
	Detail  string       `json:"detail"`
}

// Plugin answers every host method. The host calls pick, the interceptor and
// usage concurrently, so shared state sits behind mu, held only for field
// access and never across a host callback.
type Plugin struct {
	opts   Options
	host   host
	now    func() time.Time
	cfg    atomic.Pointer[model.Settings]
	agents *session.Agents
	book   *limits.Book

	mu           sync.Mutex
	accounts     map[string]*accountState
	requests     map[string]request
	warnings     []Warning
	log          *usage.Log
	salt         string
	loadedDir    string
	dirty        bool
	mgmtBase     string
	resourceBase string

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
		accounts: map[string]*accountState{},
		requests: map[string]request{},
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
	case MethodRequestInterceptAfter, MethodUsageHandle:
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
			CapabilityRequestInterceptor: true,
			CapabilityScheduler:          true,
			CapabilityUsagePlugin:        true,
			CapabilityManagementAPI:      true,
		},
	})
}

type savedUsage struct {
	Accounts []savedAccount `json:"accounts"`
	Warnings []Warning      `json:"warnings"`
}

type savedAccount struct {
	model.Account
	Weekly *model.Weekly `json:"weekly,omitempty"`
}

func (p *Plugin) path(name string) string {
	dir := p.settings().DataDir
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
	p.loadedDir = dir
	old := p.log
	p.log = usage.NewLog(filepath.Join(dir, "requests.jsonl"), 90*24*time.Hour)
	p.mu.Unlock()
	if old != nil {
		old.Close()
	}
	if dir == "" {
		return
	}
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
		p.warnings = saved.Warnings
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
	saved := savedUsage{Warnings: append([]Warning(nil), p.warnings...)}
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

func (p *Plugin) warn(w Warning) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.warnings = append(p.warnings, w)
	cutoff := w.At.Add(-7 * 24 * time.Hour)
	kept := p.warnings[:0]
	for _, x := range p.warnings {
		if x.At.After(cutoff) {
			kept = append(kept, x)
		}
	}
	if len(kept) > 500 {
		kept = kept[len(kept)-500:]
	}
	p.warnings = kept
	p.dirty = true
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
