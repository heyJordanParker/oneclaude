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
	for _, f := range files {
		if f.Disabled || !(strings.EqualFold(f.Provider, claudeProvider) || strings.EqualFold(f.Type, claudeProvider)) || f.ID == "" {
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
	return nil
}

// refreshOne makes at most one Anthropic call per tick: a plan that is
// missing or a day old, or a weekly reading for an account with no reply
// within the poll interval.
func (p *Plugin) refreshOne(now time.Time, failedAt map[string]time.Time) {
	s := p.settings()
	type job struct {
		id, index, url, attempt string
		plan                    bool
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
	p.mu.Unlock()
	if next == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()
	token, err := p.host.accessToken(ctx, next.index)
	if err != nil {
		failedAt[next.attempt] = now
		return
	}
	status, body, err := p.host.get(ctx, next.url, token)
	if err != nil || status != http.StatusOK {
		failedAt[next.attempt] = now
		if status == http.StatusUnauthorized {
			p.mu.Lock()
			name := p.accounts[next.id].Name
			p.mu.Unlock()
			p.warn(Warning{At: now, Kind: "login", Account: name, Detail: fmt.Sprintf("login expired on %s, run /accounts add to log it in again", name)})
		}
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
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
