package route

import (
	"math"
	"time"

	"github.com/heyJordanParker/oneclaude/plugin/internal/model"
)

// Candidate is one account the proxy offers for a request.
type Candidate struct {
	ID     string
	Weekly model.Weekly
	Known  bool
	Agents int
	Limit  int
}

// Room reports whether a new agent may go here: the week isn't spent and,
// with limits on, the account is under its limit.
func (c Candidate) Room(limitsOn bool, now time.Time) bool {
	if w, _ := c.Weekly.Now(now); c.Known && (w.Rejected || w.Used >= 1) {
		return false
	}
	return !limitsOn || c.Agents < c.Limit
}

// Score ranks an account by weekly quota left per hour until it resets, so an
// account close to its reset with quota left goes first. An account with no
// reading yet scores as a full week left over a full week.
func Score(c Candidate, now time.Time) float64 {
	w, _ := c.Weekly.Now(now)
	if !c.Known {
		return 1 / model.Week.Hours()
	}
	if w.Rejected || w.Used >= 1 {
		return -1
	}
	hours := math.Max(w.ResetsAt.Sub(now).Hours(), 1)
	if w.ResetsAt.IsZero() {
		hours = model.Week.Hours()
	}
	return (1 - w.Used) / hours
}

// Best returns the highest-scoring candidate with room, or the highest-scoring
// one overall when none has room. A primary agent is never refused.
func Best(cands []Candidate, now time.Time, limitsOn bool) (Candidate, bool) {
	var best, bestRoom Candidate
	haveBest, haveRoom := false, false
	for _, c := range cands {
		s := Score(c, now)
		if !haveBest || s > Score(best, now) {
			best, haveBest = c, true
		}
		if c.Room(limitsOn, now) && (!haveRoom || s > Score(bestRoom, now)) {
			bestRoom, haveRoom = c, true
		}
	}
	if haveRoom {
		return bestRoom, true
	}
	return best, haveBest
}

// AllFull reports whether no candidate has room.
func AllFull(cands []Candidate, limitsOn bool, now time.Time) bool {
	if !limitsOn || len(cands) == 0 {
		return false
	}
	for _, c := range cands {
		if c.Room(true, now) {
			return false
		}
	}
	return true
}
