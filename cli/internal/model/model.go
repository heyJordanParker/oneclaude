package model

import (
	"strings"
	"time"
)

type Family string

const (
	Opus   Family = "opus"
	Sonnet Family = "sonnet"
	Haiku  Family = "haiku"
	Fable  Family = "fable"
)

var Families = []Family{Opus, Sonnet, Haiku, Fable}

func FamilyOf(modelID string) Family {
	id := strings.ToLower(modelID)
	for _, f := range Families {
		if strings.Contains(id, string(f)) {
			return f
		}
	}
	return ""
}

func IsClaude(modelID string) bool {
	return strings.Contains(strings.ToLower(modelID), "claude") || FamilyOf(modelID) != ""
}

const Week = 7 * 24 * time.Hour

const ActiveWindow = 5 * time.Minute

type Account struct {
	ID        string `json:"id"`
	AuthIndex string `json:"auth_index"`
	Name      string `json:"name"`
	Plan      string `json:"plan,omitempty"`
	PlanAt    time.Time `json:"plan_at,omitempty"`
}

type Weekly struct {
	Used       float64   `json:"used"`
	ResetsAt   time.Time `json:"resets_at"`
	Rejected   bool      `json:"rejected,omitempty"`
	ObservedAt time.Time `json:"observed_at"`
}

// Now returns the reading as of now: a week that has reset since the reading
// starts over at zero and its next reset.
func (w Weekly) Now(now time.Time) (Weekly, bool) {
	if w.ResetsAt.IsZero() || now.Before(w.ResetsAt) {
		return w, false
	}
	next := w.ResetsAt
	for !now.Before(next) {
		next = next.Add(Week)
	}
	return Weekly{Used: 0, ResetsAt: next, ObservedAt: w.ObservedAt}, true
}

func (w Weekly) Elapsed(now time.Time) float64 {
	if w.ResetsAt.IsZero() {
		return 0
	}
	left := w.ResetsAt.Sub(now)
	if left <= 0 {
		return 1
	}
	if left >= Week {
		return 0
	}
	return 1 - float64(left)/float64(Week)
}
