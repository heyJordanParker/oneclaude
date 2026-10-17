package route

import (
	"testing"
	"time"

	"github.com/heyJordanParker/oneclaude/cli/internal/model"
)

var now = time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)

func account(id string, used float64, resetIn time.Duration, agents int) Candidate {
	return Candidate{ID: id, Known: true, Weekly: model.Weekly{Used: used, ResetsAt: now.Add(resetIn), ObservedAt: now}, Agents: agents, Limit: 19}
}

func TestBestPrefersQuotaLeftNearItsReset(t *testing.T) {
	soon := account("soon", 0.6, 20*time.Hour, 0)
	late := account("late", 0.4, 5*24*time.Hour, 0)
	got, _ := Best([]Candidate{late, soon}, now, true)
	if got.ID != "soon" {
		t.Fatalf("got %s, want soon: 40%% left over 20h beats 60%% left over 5 days", got.ID)
	}
}

func TestBestSkipsAFullAccount(t *testing.T) {
	soon := account("soon", 0.6, 20*time.Hour, 19)
	late := account("late", 0.4, 5*24*time.Hour, 3)
	got, _ := Best([]Candidate{soon, late}, now, true)
	if got.ID != "late" {
		t.Fatalf("got %s, want late: soon is at its limit", got.ID)
	}
}

func TestBestNeverRefusesWhenEveryAccountIsFull(t *testing.T) {
	soon := account("soon", 0.6, 20*time.Hour, 19)
	late := account("late", 0.4, 5*24*time.Hour, 25)
	got, ok := Best([]Candidate{soon, late}, now, true)
	if !ok || got.ID != "soon" {
		t.Fatalf("got %s %v, want soon: full pool still places on the best", got.ID, ok)
	}
	if !AllFull([]Candidate{soon, late}, true, now) {
		t.Fatal("AllFull = false, want true")
	}
}

func TestBestIgnoresLimitsWhenOff(t *testing.T) {
	soon := account("soon", 0.6, 20*time.Hour, 40)
	late := account("late", 0.4, 5*24*time.Hour, 0)
	if got, _ := Best([]Candidate{soon, late}, now, false); got.ID != "soon" {
		t.Fatalf("got %s, want soon with limits off", got.ID)
	}
	if AllFull([]Candidate{soon}, false, now) {
		t.Fatal("AllFull with limits off must be false")
	}
}

func TestAnEmptyWeekHasNoRoom(t *testing.T) {
	empty := account("empty", 1, 2*time.Hour, 0)
	other := account("other", 0.9, 6*24*time.Hour, 0)
	if got, _ := Best([]Candidate{empty, other}, now, true); got.ID != "other" {
		t.Fatalf("got %s, want other: empty's week is spent", got.ID)
	}
}

func TestAWeekThatResetSinceItsReadingStartsOver(t *testing.T) {
	stale := Candidate{ID: "stale", Known: true, Weekly: model.Weekly{Used: 1, ResetsAt: now.Add(-time.Hour)}, Limit: 19}
	if !stale.Room(true, now) {
		t.Fatal("a reading from before the reset must not block the account")
	}
}
