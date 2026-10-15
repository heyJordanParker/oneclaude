package limits

import (
	"sort"
	"sync"
	"time"

	"github.com/heyJordanParker/oneclaude/plugin/internal/model"
)

// DefaultPlan is the plan the defaults were measured on. A plan with no
// defaults of its own starts from it.
const DefaultPlan = "default_claude_max_20x"

// Defaults are the most agents one account ran at once with no throttle,
// from Claude Code transcripts of 2026-06-08 to 2026-09-29. Sonnet and Haiku
// borrow Opus's number: the paid API gives each its own bucket of the same size.
var Defaults = map[string]map[model.Family]int{
	DefaultPlan: {model.Opus: 19, model.Sonnet: 19, model.Haiku: 19, model.Fable: 6},
}

const (
	correctionDays     = 3
	correctionAccounts = 2
	correctionWindow   = 14 * 24 * time.Hour
)

type Throttle struct {
	At      time.Time    `json:"at"`
	Plan    string       `json:"plan"`
	Family  model.Family `json:"family"`
	Account string       `json:"account"`
	Agents  int          `json:"agents"`
}

// Saved is what the book keeps on disk.
type Saved struct {
	Corrected map[string]map[model.Family]int `json:"corrected"`
	Throttles []Throttle                      `json:"throttles"`
}

// Book holds the self-corrected limits and the throttles that justify them.
type Book struct {
	mu        sync.Mutex
	Corrected map[string]map[model.Family]int
	Throttles []Throttle
}

func NewBook() *Book {
	return &Book{Corrected: map[string]map[model.Family]int{}}
}

// Limit is the agents one account on plan may run for family.
func (b *Book) Limit(s model.Settings, plan string, family model.Family) int {
	if n := s.Override[plan][family]; n > 0 {
		return n
	}
	base := defaultFor(plan, family)
	if !s.SelfCorrect {
		return base
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if n := b.Corrected[planKey(plan)][family]; n > 0 && n < base {
		return n
	}
	return base
}

func defaultFor(plan string, family model.Family) int {
	if n := Defaults[plan][family]; n > 0 {
		return n
	}
	if n := Defaults[DefaultPlan][family]; n > 0 {
		return n
	}
	return Defaults[DefaultPlan][model.Opus]
}

func planKey(plan string) string {
	if plan == "" {
		return DefaultPlan
	}
	return plan
}

// Record notes a throttle and lowers the plan's limit once throttles below it
// reach correctionAccounts accounts on correctionDays separate days. It
// reports whether the limit changed.
func (b *Book) Record(s model.Settings, t Throttle) bool {
	limit := b.Limit(s, t.Plan, t.Family)
	b.mu.Lock()
	defer b.mu.Unlock()
	t.Plan = planKey(t.Plan)
	b.Throttles = append(b.Throttles, t)
	cutoff := t.At.Add(-correctionWindow)
	kept := b.Throttles[:0]
	for _, x := range b.Throttles {
		if x.At.After(cutoff) {
			kept = append(kept, x)
		}
	}
	b.Throttles = kept
	if !s.SelfCorrect || t.Agents >= limit {
		return false
	}
	days := map[string]bool{}
	accounts := map[string]bool{}
	var counts []int
	for _, x := range b.Throttles {
		if x.Plan != t.Plan || x.Family != t.Family || x.Agents >= limit {
			continue
		}
		days[x.At.UTC().Format("2006-01-02")] = true
		accounts[x.Account] = true
		counts = append(counts, x.Agents)
	}
	if len(days) < correctionDays || len(accounts) < correctionAccounts {
		return false
	}
	sort.Ints(counts)
	lowered := counts[len(counts)-1]
	if lowered < 1 {
		lowered = 1
	}
	if b.Corrected[t.Plan] == nil {
		b.Corrected[t.Plan] = map[model.Family]int{}
	}
	b.Corrected[t.Plan][t.Family] = lowered
	return true
}

func (b *Book) Snapshot() Saved {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := Saved{Corrected: map[string]map[model.Family]int{}, Throttles: append([]Throttle(nil), b.Throttles...)}
	for plan, fams := range b.Corrected {
		out.Corrected[plan] = map[model.Family]int{}
		for f, n := range fams {
			out.Corrected[plan][f] = n
		}
	}
	return out
}

func (b *Book) Restore(saved Saved) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if saved.Corrected != nil {
		b.Corrected = saved.Corrected
	}
	b.Throttles = saved.Throttles
}
