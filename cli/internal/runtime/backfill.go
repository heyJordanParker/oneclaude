package runtime

import (
	"bufio"
	"encoding/json"
	"os"
	"strconv"
	"time"

	"github.com/heyJordanParker/oneclaude/cli/internal/model"
	"github.com/heyJordanParker/oneclaude/cli/internal/session"
	"github.com/heyJordanParker/oneclaude/cli/internal/usage"
)

// A logged request and the request its transcript records match when their
// tokens are equal and their times are this close.
const backfillWindow = time.Minute

// backfillWorkers keeps the one-time read of the transcripts to two cores,
// so the agents running beside it keep the rest.
const backfillWorkers = 2

// backfill fills in the model, agent type and project of the lines oneclaude
// logged before it recorded them, once. Each takes them from the one request
// Claude Code's transcripts record with the same tokens within a minute. A
// line no transcript records takes its family's newest model, the model it
// was already priced at, so no later load looks for it again.
func (p *Plugin) backfill(path string, log *usage.Log, current func() bool) {
	if log == nil || !startsUnfilled(path) {
		return
	}
	wanted := map[model.Tokens]bool{}
	var first time.Time
	_ = usage.ReadBack(path, func(raw []byte) bool {
		var line requestLine
		if json.Unmarshal(raw, &line) == nil && line.Model == "" {
			wanted[line.Tokens], first = true, line.At
		}
		return true
	})
	recorded := p.records.RecordedSince(first.Add(-backfillWindow), wanted, backfillWorkers, current)
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

// startsUnfilled reports whether the log's oldest line has no model, which
// only lines from before oneclaude 0.5.1 lack.
func startsUnfilled(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	reader := bufio.NewReaderSize(f, 64*1024)
	raw, err := reader.ReadBytes('\n')
	if err != nil && len(raw) == 0 {
		return false
	}
	var line requestLine
	return json.Unmarshal(raw, &line) == nil && line.Model == ""
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
