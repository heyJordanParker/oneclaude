package runtime

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/heyJordanParker/oneclaude/plugin/internal/usage"
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
)

func (p *Plugin) startPoller() {
	if p.opts.NoPoller {
		return
	}
	p.lifeMu.Lock()
	defer p.lifeMu.Unlock()
	if p.stop != nil {
		return
	}
	stop := make(chan struct{})
	p.stop = stop
	p.host.spawn(func() { p.pollLoop(stop) })
}

func (p *Plugin) stopPoller() {
	p.lifeMu.Lock()
	defer p.lifeMu.Unlock()
	if p.stop != nil {
		close(p.stop)
		p.stop = nil
	}
}

func (p *Plugin) pollLoop(stop chan struct{}) {
	timer := time.NewTimer(startupGrace)
	defer timer.Stop()
	var listedAt time.Time
	failedAt := map[string]time.Time{}
	for {
		select {
		case <-stop:
			return
		case <-timer.C:
		}
		func() {
			defer func() { _ = recover() }()
			now := p.now()
			if now.Sub(listedAt) >= listEvery {
				if p.list() == nil {
					listedAt = now
				}
			}
			p.refreshOne(now, failedAt)
			p.save()
		}()
		timer.Reset(pollTick)
	}
}

func (p *Plugin) list() error {
	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()
	files, err := p.host.authList(ctx)
	if err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	listed := map[string]bool{}
	for _, f := range files {
		if f.Disabled || f.ID == "" {
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
	return nil
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

// refreshOne makes at most one upstream call per tick: a Claude plan that is
// missing or a day old, a weekly reading for a Claude account with no reply
// within the poll interval, or else a Codex account's weekly reading.
func (p *Plugin) refreshOne(now time.Time, failedAt map[string]time.Time) {
	s := p.settings()
	type job struct {
		id, index, url, attempt string
		plan, codex             bool
	}
	var next *job
	p.mu.Lock()
	for _, a := range p.accounts {
		if a.AuthIndex == "" {
			continue
		}
		planDue := a.Plan == "" || now.Sub(a.PlanAt) > planEvery
		if planDue && now.Sub(failedAt[a.ID+"#plan"]) >= retryFailures {
			next = &job{id: a.ID, index: a.AuthIndex, url: profileURL, attempt: a.ID + "#plan", plan: true}
			break
		}
		usageDue := !a.known || now.Sub(a.weekly.ObservedAt) > s.PollInterval
		if usageDue && now.Sub(failedAt[a.ID+"#usage"]) >= retryFailures {
			next = &job{id: a.ID, index: a.AuthIndex, url: usageURL, attempt: a.ID + "#usage"}
		}
	}
	for id, c := range p.codex {
		if next != nil {
			break
		}
		usageDue := !c.known || now.Sub(c.weekly.ObservedAt) > s.PollInterval
		if c.AuthIndex != "" && usageDue && now.Sub(failedAt[id+"#codex"]) >= retryFailures {
			next = &job{id: id, index: c.AuthIndex, url: codexUsageURL, attempt: id + "#codex", codex: true}
		}
	}
	p.mu.Unlock()
	if next == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()
	cred, err := p.host.credential(ctx, next.index)
	if err != nil {
		failedAt[next.attempt] = now
		return
	}
	headers := anthropicHeaders(cred)
	if next.codex {
		headers = codexHeaders(cred)
	}
	status, body, err := p.host.get(ctx, next.url, headers)
	if err != nil || status != http.StatusOK {
		failedAt[next.attempt] = now
		if status == http.StatusUnauthorized && !next.codex {
			p.mu.Lock()
			name := p.accounts[next.id].Name
			p.mu.Unlock()
			p.warn(Warning{At: now, Kind: "login", Account: name, Detail: fmt.Sprintf("login expired on %s, run /accounts add to log it in again", name)})
		}
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if next.codex {
		if c := p.codex[next.id]; c != nil {
			if w, ok := usage.WeeklyFromCodex(body, now); ok {
				c.weekly, c.known = w, true
			}
		}
		return
	}
	a := p.accounts[next.id]
	if a == nil {
		return
	}
	if next.plan {
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
