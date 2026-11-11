package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/heyJordanParker/oneclaude/cli/internal/claudecode"
	"github.com/heyJordanParker/oneclaude/cli/internal/usage"
)

const (
	profileURL    = "https://api.anthropic.com/api/oauth/profile"
	usageURL      = "https://api.anthropic.com/api/oauth/usage"
	codexUsageURL = "https://chatgpt.com/backend-api/wham/usage"
	pollTick      = time.Minute
	listEvery     = 10 * time.Minute
	planEvery     = 24 * time.Hour
	fetchTimeout  = 15 * time.Second
	startupGrace  = 20 * time.Second
	retryFailures = 30 * time.Minute
	catchUp       = 2 * time.Second
	catchUpStep   = 50 * time.Millisecond
)

// startPoller starts the usage poll, unless the options leave it out, and
// lets watch start the watch on the proxy's credentials.
func (p *Plugin) startPoller() {
	p.lifeMu.Lock()
	defer p.lifeMu.Unlock()
	if p.stop != nil {
		return
	}
	stop := make(chan struct{})
	p.stop = stop
	if !p.opts.NoPoller {
		p.host.spawn(func() { p.pollLoop(stop) })
	}
}

func (p *Plugin) stopPoller() {
	p.lifeMu.Lock()
	defer p.lifeMu.Unlock()
	if p.stop != nil {
		close(p.stop)
		p.stop = nil
	}
	if p.watcher != nil {
		_ = p.watcher.Close()
		p.watcher, p.watched = nil, ""
	}
}

func (p *Plugin) pollLoop(stop chan struct{}) {
	timer := time.NewTimer(startupGrace)
	defer timer.Stop()
	var listedAt time.Time
	for {
		select {
		case <-stop:
			return
		case <-timer.C:
		}
		func() {
			defer func() { _ = recover() }()
			now := p.now()
			p.followClaudeLogin(now)
			if now.Sub(listedAt) >= listEvery {
				if p.list() == nil {
					listedAt = now
				}
			}
			p.refreshOne(now)
			p.save()
			p.changed(false)
		}()
		timer.Reset(pollTick)
	}
}

func (p *Plugin) list() error {
	files, err := p.authFiles()
	if err != nil {
		return err
	}
	p.updateAccounts(files)
	return nil
}

func (p *Plugin) authFiles() ([]HostAuthFileEntry, error) {
	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()
	return p.host.authList(ctx)
}

// updateAccounts takes the accounts the proxy lists. A Claude account it
// listed before, so one with an auth index, leaves once the proxy lists it
// no more, and one only the pick offered, as the dev proxy's api-key ones,
// stays.
func (p *Plugin) updateAccounts(files []HostAuthFileEntry) {
	p.mu.Lock()
	defer p.mu.Unlock()
	listed, claude := map[string]bool{}, map[string]bool{}
	for _, f := range files {
		if f.ID == "" {
			continue
		}
		if isProvider(f, claudeProvider) {
			claude[f.ID] = true
		}
		if f.Disabled {
			continue
		}
		if isProvider(f, codexProvider) {
			listed[f.ID] = true
			c, ok := p.codex[f.ID]
			if !ok {
				c = &codexAccount{}
				p.codex[f.ID] = c
			}
			c.AuthIndex, c.Name = f.AuthIndex, accountName(f)
			continue
		}
		if !isProvider(f, claudeProvider) {
			continue
		}
		a, ok := p.accounts[f.ID]
		if !ok {
			a = &accountState{}
			a.ID = f.ID
			p.accounts[f.ID] = a
		}
		a.AuthIndex = f.AuthIndex
		a.Name = accountName(f)
		p.dirty = true
	}
	for id := range p.codex {
		if !listed[id] {
			delete(p.codex, id)
		}
	}
	for id, a := range p.accounts {
		if a.AuthIndex != "" && !claude[id] {
			delete(p.accounts, id)
			p.dirty = true
		}
	}
}

// watch watches dir, the folder the proxy keeps its credential files in,
// which oneclaude install names in the auth-dir setting, until the plugin
// quiesces.
func (p *Plugin) watch(dir string) {
	p.lifeMu.Lock()
	defer p.lifeMu.Unlock()
	if p.stop == nil || dir == p.watched {
		return
	}
	failed := func(err error) {
		p.host.spawn(func() {
			p.host.log("warn", "oneclaude cannot watch the proxy's credentials", map[string]any{"folder": dir, "error": err.Error()})
		})
	}
	if p.watcher == nil {
		w, err := fsnotify.NewWatcher()
		if err != nil {
			failed(err)
			return
		}
		p.watcher = w
		stop := p.stop
		p.host.spawn(func() { p.watchLoop(w, stop) })
	}
	if p.watched != "" {
		_ = p.watcher.Remove(p.watched)
		p.watched = ""
	}
	if dir == "" {
		return
	}
	if err := p.watcher.Add(dir); err != nil {
		failed(err)
		return
	}
	p.watched = dir
}

// watchLoop answers the changes to the credential files the proxy reads,
// every .json file directly in the watched folder, as the proxy's own watch
// does. Every event that arrived by then, those during the last answer
// included, goes into one answer, and like the proxy it skips a file whose
// content it already answered, and an empty one, which its write fills next.
func (p *Plugin) watchLoop(w *fsnotify.Watcher, stop chan struct{}) {
	answered := map[string]string{}
	for {
		select {
		case <-stop:
			return
		case err, ok := <-w.Errors:
			if !ok {
				return
			}
			p.host.log("warn", "oneclaude's watch on the proxy's credentials failed", map[string]any{"error": err.Error()})
		case event, ok := <-w.Events:
			if !ok {
				return
			}
			named := map[string]bool{}
			for ok {
				if event.Has(fsnotify.Create|fsnotify.Write|fsnotify.Remove|fsnotify.Rename) && strings.HasSuffix(event.Name, ".json") {
					named[event.Name] = true
				}
				select {
				case event, ok = <-w.Events:
				default:
					ok = false
				}
			}
			changed := map[string]bool{}
			for path := range named {
				content, written := contentOf(path)
				if was, seen := answered[path]; !written || seen && was == content {
					continue
				}
				answered[path] = content
				changed[filepath.Base(path)] = content != ""
			}
			if len(changed) > 0 {
				func() {
					defer func() { _ = recover() }()
					p.credentialsChanged(changed)
				}()
			}
		}
	}
}

// contentOf is a credential file's content as its hash, empty for a file
// that is gone, and not written for a file that is still empty.
func contentOf(path string) (content string, written bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", true
	}
	if len(raw) == 0 {
		return "", false
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), true
}

// credentialsChanged lists the accounts once the proxy lists each changed
// file that is still there, and leaves out each whose file is gone, which the
// proxy drops only after it checked the file stays gone. It clears the
// proxy's blocks on each account Anthropic rejected whose file changed, as
// its new login may fix them, and counts a change of the status
// and of the blocks, so the blocks a session reads next are the cleared
// ones. Then it reads the usage of every account Anthropic rejects or that
// has no reading, at once and with its failures forgotten. host.auth.get
// reads the file, so the read takes the new login even before the proxy
// does. names holds each changed file's name, true for a file still there.
func (p *Plugin) credentialsChanged(names map[string]bool) {
	listed, err := p.listHolding(names)
	if err != nil {
		p.host.log("warn", "oneclaude could not list the proxy's credentials after one changed", map[string]any{"error": err.Error()})
		return
	}
	var files []HostAuthFileEntry
	for _, f := range listed {
		if there, changed := names[filepath.Base(f.Path)]; !changed || there {
			files = append(files, f)
		}
	}
	p.updateAccounts(files)
	now := p.now()
	var due []reading
	var blocked []string
	p.mu.Lock()
	for _, f := range files {
		if a := p.accounts[f.ID]; a != nil && a.AuthIndex != "" && a.loginFails() && names[filepath.Base(f.Path)] {
			blocked = append(blocked, a.AuthIndex)
		}
	}
	for id, a := range p.accounts {
		if a.AuthIndex == "" || a.known && !a.loginFails() {
			continue
		}
		delete(p.failedAt, id+"#plan")
		due = append(due, usageReading(id, a.AuthIndex))
	}
	p.mu.Unlock()
	for _, index := range blocked {
		if err := p.unblock(index); err != nil {
			p.host.log("warn", "oneclaude could not clear the blocks of a credential that changed", map[string]any{"auth_index": index, "error": err.Error()})
		}
	}
	p.save()
	p.changed(true)
	p.readNow(due, now)
}

// listHolding lists the proxy's credentials once the list holds every file in
// names that is still there, or after catchUp. The proxy lists a new file only
// once its own watch, which the same file event wakes, has read it, so the
// list right after the event lacks it.
func (p *Plugin) listHolding(names map[string]bool) ([]HostAuthFileEntry, error) {
	for waited := time.Duration(0); ; waited += catchUpStep {
		listed, err := p.authFiles()
		if err != nil || holdsAll(listed, names) || waited >= catchUp {
			return listed, err
		}
		time.Sleep(catchUpStep)
	}
}

// holdsAll reports whether listed holds every file in names that is still
// there.
func holdsAll(listed []HostAuthFileEntry, names map[string]bool) bool {
	held := map[string]bool{}
	for _, f := range listed {
		held[filepath.Base(f.Path)] = true
	}
	for name, there := range names {
		if there && !held[name] {
			return false
		}
	}
	return true
}

// readNow makes each reading at once, all together, with its earlier failures
// forgotten, then saves and counts what they changed.
func (p *Plugin) readNow(due []reading, now time.Time) {
	p.mu.Lock()
	for _, r := range due {
		delete(p.failedAt, r.attempt)
	}
	p.mu.Unlock()
	var reads sync.WaitGroup
	for _, r := range due {
		reads.Add(1)
		p.host.spawn(func() {
			defer reads.Done()
			p.read(r, now)
		})
	}
	reads.Wait()
	p.save()
	p.changed(false)
}

// followClaudeLogin keeps each copy of Claude Code's login, the credential
// oneclaude install writes, on the access token Claude Code keeps. A copy
// holds no refresh token, so the proxy never refreshes it, and Claude Code
// stays the one program that refreshes that login: Anthropic's refresh
// tokens work once, so a second refresher signs Claude Code out. A copy
// whose token expired while no Claude Code ran stays signed out until Claude
// Code next refreshes. A copy is a Claude credential of the account and
// organization Claude Code is logged in to that holds no refresh token, or
// Claude Code's own, as an earlier install's copy does, which loses it here.
// A credential with another refresh token is a login of its own.
func (p *Plugin) followClaudeLogin(now time.Time) {
	if p.opts.Home == "" {
		return
	}
	p.followMu.Lock()
	defer p.followMu.Unlock()
	files, err := p.authFiles()
	if err != nil {
		return
	}
	var claude []HostAuthFileEntry
	for _, f := range files {
		if isProvider(f, claudeProvider) && f.AuthIndex != "" && f.Path != "" {
			claude = append(claude, f)
		}
	}
	if len(claude) == 0 {
		return
	}
	login, err := claudecode.StoredLogin(p.opts.Home)
	if err != nil || login.Account == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()
	copies := map[string]credential{}
	for _, f := range claude {
		c, err := p.host.credential(ctx, f.AuthIndex)
		if err == nil && c.AccountUUID == login.Account && c.OrganizationUUID == login.Organization && (c.RefreshToken == "" || c.RefreshToken == login.RefreshToken) {
			copies[filepath.Base(f.Path)] = c
		}
	}
	for name, c := range copies {
		if c.AccessToken == login.AccessToken && c.RefreshToken == "" {
			continue
		}
		var file map[string]any
		if err := json.Unmarshal(c.file, &file); err != nil {
			continue
		}
		file["access_token"] = login.AccessToken
		file["expired"] = login.ExpiresAt.Format(time.RFC3339)
		file["last_refresh"] = now.Format(time.RFC3339)
		delete(file, "refresh_token")
		raw, err := json.Marshal(file)
		if err != nil {
			continue
		}
		if err := p.host.saveCredential(ctx, name, raw); err != nil {
			p.host.log("warn", "oneclaude could not move its copy of Claude Code's login to Claude Code's new token", map[string]any{"credential": name, "error": err.Error()})
			continue
		}
		p.host.log("info", "oneclaude moved its copy of Claude Code's login to Claude Code's new token", map[string]any{"credential": name, "expires": login.ExpiresAt.Format(time.RFC3339)})
	}
}

func anthropicHeaders(cred credential) http.Header {
	return http.Header{
		"Authorization":  {"Bearer " + cred.AccessToken},
		"Content-Type":   {"application/json"},
		"Anthropic-Beta": {"oauth-2025-04-20"},
		"User-Agent":     {"claude-cli/1.0.60 (external, cli)"},
	}
}

// codexHeaders are the headers the proxy's management panel sends to read a
// Codex account's usage.
func codexHeaders(cred credential) http.Header {
	headers := http.Header{
		"Authorization": {"Bearer " + cred.AccessToken},
		"Content-Type":  {"application/json"},
		"User-Agent":    {"codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)"},
	}
	if cred.AccountID != "" {
		headers.Set("Chatgpt-Account-Id", cred.AccountID)
	}
	return headers
}

func isProvider(f HostAuthFileEntry, provider string) bool {
	return strings.EqualFold(f.Provider, provider) || strings.EqualFold(f.Type, provider)
}

// A reading is one upstream call for an account: its Claude plan, its
// Claude weekly usage, or its Codex weekly usage. attempt keys its failures.
type reading struct {
	id, index, url, attempt string
	plan, codex             bool
}

// usageReading is the reading of a Claude account's weekly usage.
func usageReading(id, index string) reading {
	return reading{id: id, index: index, url: usageURL, attempt: id + "#usage"}
}

// refreshOne makes at most one upstream call per tick: a Claude plan that is
// missing or a day old, a weekly reading for a Claude account with no reply
// within the poll interval, or else a Codex account's weekly reading. A
// reading that failed waits retryFailures.
func (p *Plugin) refreshOne(now time.Time) {
	s := p.settings()
	var next *reading
	p.mu.Lock()
	for _, a := range p.accounts {
		if a.AuthIndex == "" {
			continue
		}
		planDue := a.Plan == "" || now.Sub(a.PlanAt) > planEvery
		if planDue && now.Sub(p.failedAt[a.ID+"#plan"]) >= retryFailures {
			next = &reading{id: a.ID, index: a.AuthIndex, url: profileURL, attempt: a.ID + "#plan", plan: true}
			break
		}
		usageDue := !a.known || now.Sub(a.weekly.ObservedAt) > s.PollInterval
		if r := usageReading(a.ID, a.AuthIndex); usageDue && now.Sub(p.failedAt[r.attempt]) >= retryFailures {
			next = &r
		}
	}
	for id, c := range p.codex {
		if next != nil {
			break
		}
		usageDue := !c.known || now.Sub(c.weekly.ObservedAt) > s.PollInterval
		if c.AuthIndex != "" && usageDue && now.Sub(p.failedAt[id+"#codex"]) >= retryFailures {
			next = &reading{id: id, index: c.AuthIndex, url: codexUsageURL, attempt: id + "#codex", codex: true}
		}
	}
	p.mu.Unlock()
	if next != nil {
		p.read(*next, now)
	}
}

func (p *Plugin) read(r reading, now time.Time) {
	failed := func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		p.failedAt[r.attempt] = now
	}
	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()
	cred, err := p.host.credential(ctx, r.index)
	if err != nil {
		failed()
		return
	}
	headers := anthropicHeaders(cred)
	if r.codex {
		headers = codexHeaders(cred)
	}
	status, body, err := p.host.get(ctx, r.url, headers)
	if err != nil {
		failed()
		return
	}
	if !r.codex {
		p.loginAnswered(r.id, status, body)
	}
	if status != http.StatusOK {
		failed()
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if r.codex {
		if c := p.codex[r.id]; c != nil {
			if w, ok := usage.WeeklyFromCodex(body, now); ok {
				c.weekly, c.known = w, true
			}
		}
		return
	}
	a := p.accounts[r.id]
	if a == nil {
		return
	}
	if r.plan {
		if plan := usage.PlanFromProfile(body); plan != "" {
			a.Plan, a.PlanAt = plan, now
			p.dirty = true
		}
		return
	}
	if w, ok := usage.WeeklyFromEndpoint(body, now); ok {
		a.weekly, a.known = w, true
		p.dirty = true
	}
}
