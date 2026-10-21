package runtime

import (
	"bufio"
	"encoding/json"
	"maps"
	"os"
	"slices"
	"strconv"
	"time"

	"github.com/heyJordanParker/oneclaude/cli/internal/model"
	"github.com/heyJordanParker/oneclaude/cli/internal/session"
	"github.com/heyJordanParker/oneclaude/cli/internal/usage"
)

// A logged request and the request its transcript records match when their
// tokens are equal and their times are this close.
const backfillWindow = time.Minute

// backfillWorkers keeps the one-time reads of the transcripts to two cores,
// so the agents running beside them keep the rest.
const backfillWorkers = 2

// backfill fills in the model, agent type and project of the lines oneclaude
// logged before it recorded them, once. Each takes them from the one request
// Claude Code's transcripts record with the same tokens within a minute. A
// line no transcript records takes its family's newest model, the model it
// was already priced at, so no later load looks for it again.
func (p *Plugin) backfill(path string, log *usage.Log, current func() bool) {
	first, ok := firstLine(path)
	if log == nil || !ok || first.Model != "" {
		return
	}
	wanted := map[model.Tokens]bool{}
	var last time.Time
	_ = usage.ReadBack(path, func(raw []byte) bool {
		var line requestLine
		if json.Unmarshal(raw, &line) == nil && line.Model == "" {
			if last.IsZero() {
				last = line.At
			}
			wanted[line.Tokens] = true
		}
		return true
	})
	recorded := map[model.Tokens][]session.Recorded{}
	for _, r := range p.records.RecordedBetween(first.At.Add(-backfillWindow), last.Add(backfillWindow), func(t model.Tokens) bool { return wanted[t] }, backfillWorkers, current) {
		recorded[r.Tokens] = append(recorded[r.Tokens], r)
	}
	if !current() {
		return
	}
	log.Rewrite(func(raw []byte) []byte {
		var line requestLine
		if json.Unmarshal(raw, &line) != nil || line.Model != "" {
			return raw
		}
		fill(&line, recorded[line.Tokens])
		filled, err := json.Marshal(line)
		if err != nil {
			return raw
		}
		return filled
	})
}

// importTranscripts adds the requests Claude Code's transcripts record from
// the 90 days before the log's first line, once, so Usage covers the time
// before oneclaude routed. They have no account, as no transcript says which
// account answered. A transcript's time and the log's differ by seconds, so
// the import stops a minute short of the log, and no request counts twice.
func (p *Plugin) importTranscripts(path string, log *usage.Log, loadedAt time.Time, current func() bool) bool {
	if log == nil {
		return false
	}
	until := loadedAt
	if first, ok := firstLine(path); ok {
		until = first.At
	}
	until = until.Add(-backfillWindow)
	answered := func(t model.Tokens) bool { return t != model.Tokens{} }
	kept := map[string]session.Recorded{}
	for i, r := range p.records.RecordedBetween(loadedAt.AddDate(0, 0, -daysKept), until, answered, backfillWorkers, current) {
		id := r.Request
		if id == "" {
			id = "#" + strconv.Itoa(i)
		}
		if seen, ok := kept[id]; !ok || r.Tokens.Output > seen.Tokens.Output {
			kept[id] = r
		}
	}
	if !current() {
		return false
	}
	if len(kept) == 0 {
		return true
	}
	requests := slices.SortedFunc(maps.Values(kept), func(a, b session.Recorded) int { return a.At.Compare(b.At) })
	head := path + ".import"
	defer os.Remove(head)
	f, err := os.OpenFile(head, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return false
	}
	out := bufio.NewWriterSize(f, 1<<20)
	encoder := json.NewEncoder(out)
	for _, r := range requests {
		modelID := model.Canonical(r.Model)
		if encoder.Encode(requestLine{At: r.At, Model: modelID, Family: model.FamilyOf(modelID), Subagent: r.Subagent, Agent: r.Agent, Project: r.Project, Outcome: "ok", Tokens: r.Tokens}) != nil {
			_ = f.Close()
			return false
		}
	}
	if out.Flush() != nil || f.Close() != nil {
		return false
	}
	return current() && log.Prepend(head)
}

// firstLine reads the log's oldest line.
func firstLine(path string) (requestLine, bool) {
	var line requestLine
	f, err := os.Open(path)
	if err != nil {
		return line, false
	}
	defer f.Close()
	raw, err := bufio.NewReaderSize(f, 64*1024).ReadBytes('\n')
	if err != nil && len(raw) == 0 {
		return line, false
	}
	return line, json.Unmarshal(raw, &line) == nil
}

func fill(line *requestLine, candidates []session.Recorded) {
	var match session.Recorded
	requests := map[string]bool{}
	for i, c := range candidates {
		if d := c.At.Sub(line.At); d > -backfillWindow && d < backfillWindow {
			match = c
			id := c.Request
			if id == "" {
				id = "#" + strconv.Itoa(i)
			}
			requests[id] = true
		}
	}
	line.Model = model.ModelOf("", line.Family)
	if len(requests) != 1 {
		return
	}
	if match.Model != "" {
		line.Model = model.Canonical(match.Model)
	}
	line.Subagent, line.Agent, line.Project = match.Subagent, match.Agent, match.Project
}
