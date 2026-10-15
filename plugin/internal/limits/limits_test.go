package limits

import (
	"testing"
	"time"

	"github.com/heyJordanParker/oneclaude/plugin/internal/model"
)

var day0 = time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)

func TestDefaults(t *testing.T) {
	b, s := NewBook(), model.Defaults()
	cases := map[model.Family]int{model.Opus: 19, model.Sonnet: 19, model.Haiku: 19, model.Fable: 6}
	for f, want := range cases {
		if got := b.Limit(s, DefaultPlan, f); got != want {
			t.Errorf("%s = %d, want %d", f, got, want)
		}
		if got := b.Limit(s, "default_claude_max_5x", f); got != want {
			t.Errorf("unmeasured plan %s = %d, want the Max 20x %d", f, got, want)
		}
	}
}

func TestOverrideWins(t *testing.T) {
	b, s := NewBook(), model.Defaults()
	s.Override[DefaultPlan] = map[model.Family]int{model.Haiku: 30}
	if got := b.Limit(s, DefaultPlan, model.Haiku); got != 30 {
		t.Fatalf("haiku = %d, want the override 30", got)
	}
}

func TestOneBadDayChangesNothing(t *testing.T) {
	b, s := NewBook(), model.Defaults()
	for i := 0; i < 20; i++ {
		b.Record(s, Throttle{At: day0.Add(time.Duration(i) * time.Minute), Plan: DefaultPlan, Family: model.Opus, Account: []string{"a", "b"}[i%2], Agents: 10})
	}
	if got := b.Limit(s, DefaultPlan, model.Opus); got != 19 {
		t.Fatalf("opus = %d, want 19 after one bad day", got)
	}
}

func TestThreeDaysOnTwoAccountsLowerTheLimit(t *testing.T) {
	b, s := NewBook(), model.Defaults()
	changed := false
	for d := 0; d < 3; d++ {
		at := day0.Add(time.Duration(d) * 24 * time.Hour)
		changed = b.Record(s, Throttle{At: at, Plan: DefaultPlan, Family: model.Opus, Account: "a", Agents: 12}) || changed
		changed = b.Record(s, Throttle{At: at.Add(time.Hour), Plan: DefaultPlan, Family: model.Opus, Account: "b", Agents: 14}) || changed
	}
	if !changed {
		t.Fatal("Record never reported a change")
	}
	if got := b.Limit(s, DefaultPlan, model.Opus); got != 14 {
		t.Fatalf("opus = %d, want 14", got)
	}
	if got := b.Limit(s, DefaultPlan, model.Haiku); got != 19 {
		t.Fatalf("haiku = %d, want 19, the families are separate", got)
	}
	s.SelfCorrect = false
	if got := b.Limit(s, DefaultPlan, model.Opus); got != 19 {
		t.Fatalf("opus with self-correct off = %d, want 19", got)
	}
}

func TestOneAccountNeverLowersTheLimit(t *testing.T) {
	b, s := NewBook(), model.Defaults()
	for d := 0; d < 5; d++ {
		b.Record(s, Throttle{At: day0.Add(time.Duration(d) * 24 * time.Hour), Plan: DefaultPlan, Family: model.Opus, Account: "a", Agents: 8})
	}
	if got := b.Limit(s, DefaultPlan, model.Opus); got != 19 {
		t.Fatalf("opus = %d, want 19 with one account", got)
	}
}

func TestThrottlesAtOrAboveTheLimitDoNotCount(t *testing.T) {
	b, s := NewBook(), model.Defaults()
	for d := 0; d < 3; d++ {
		at := day0.Add(time.Duration(d) * 24 * time.Hour)
		b.Record(s, Throttle{At: at, Plan: DefaultPlan, Family: model.Opus, Account: "a", Agents: 19})
		b.Record(s, Throttle{At: at, Plan: DefaultPlan, Family: model.Opus, Account: "b", Agents: 25})
	}
	if got := b.Limit(s, DefaultPlan, model.Opus); got != 19 {
		t.Fatalf("opus = %d, want 19", got)
	}
}
