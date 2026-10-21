package session

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/heyJordanParker/oneclaude/cli/internal/model"
	"github.com/heyJordanParker/oneclaude/cli/internal/usage"
)

// Recorded is one request a Claude Code transcript records: when, under which
// request id, on which model, its tokens, and the agent type and project it
// ran for. A main session's Agent is empty.
type Recorded struct {
	At       time.Time
	Request  string
	Model    string
	Subagent bool
	Agent    string
	Project  string
	Tokens   model.Tokens
}

var (
	usageTag     = []byte(`"usage":{"input_tokens":`)
	timestampTag = []byte(`"timestamp":"`)
	requestTag   = []byte(`"requestId":"`)
	modelTag     = []byte(`"model":"`)
)

// RecordedBetween finds the requests Claude Code's transcripts record from
// since until before until, keeping those whose tokens keep accepts. It reads
// each transcript written since then back from its end, on workers
// goroutines, and stops early once current reports false.
func (r *Records) RecordedBetween(since, until time.Time, keep func(model.Tokens) bool, workers int, current func() bool) []Recorded {
	var found []Recorded
	if r.root == "" {
		return found
	}
	var files []string
	for _, pattern := range []string{"*/*.jsonl", "*/*/subagents/*.jsonl"} {
		matches, _ := filepath.Glob(filepath.Join(r.root, pattern))
		for _, path := range matches {
			if info, err := os.Stat(path); err == nil && !info.ModTime().Before(since) {
				files = append(files, path)
			}
		}
	}
	var mu sync.Mutex
	paths := make(chan string)
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for path := range paths {
				recorded := recordedIn(path, since, until, keep)
				mu.Lock()
				found = append(found, recorded...)
				mu.Unlock()
			}
		}()
	}
	for _, path := range files {
		if !current() {
			break
		}
		paths <- path
	}
	close(paths)
	wg.Wait()
	return found
}

// recordedIn reads one transcript back to since. A subagent's transcript
// sits at <session>/subagents/agent-<id>.jsonl, its type in the meta file
// beside it, and every transcript's project is its session's.
func recordedIn(path string, since, until time.Time, keep func(model.Tokens) bool) []Recorded {
	var base Recorded
	transcript := path
	if folder := filepath.Dir(path); filepath.Base(folder) == "subagents" {
		session := filepath.Dir(folder)
		agent := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "agent-"), ".jsonl")
		base.Subagent = true
		base.Agent, _ = agentTypeIn(filepath.Dir(session), Identity{Session: filepath.Base(session), Agent: agent})
		transcript = session + ".jsonl"
	}
	if cwd := cwdOf(transcript); cwd != "" {
		base.Project = filepath.Base(cwd)
	}
	var found []Recorded
	_ = usage.ReadBack(path, func(line []byte) bool {
		at, err := time.Parse(time.RFC3339Nano, lastField(line, timestampTag))
		if err != nil || !at.Before(until) {
			return true
		}
		if at.Before(since) {
			return false
		}
		i := bytes.LastIndex(line, usageTag)
		if i < 0 {
			return true
		}
		var u struct {
			Input      int64 `json:"input_tokens"`
			Output     int64 `json:"output_tokens"`
			CacheRead  int64 `json:"cache_read_input_tokens"`
			CacheWrite int64 `json:"cache_creation_input_tokens"`
		}
		if json.NewDecoder(bytes.NewReader(line[i+len(`"usage":`):])).Decode(&u) != nil {
			return true
		}
		tokens := model.Tokens{Input: u.Input, Output: u.Output, CacheRead: u.CacheRead, CacheWrite: u.CacheWrite}
		if !keep(tokens) {
			return true
		}
		recorded := base
		recorded.At, recorded.Request, recorded.Model, recorded.Tokens = at, lastField(line, requestTag), firstField(line, modelTag), tokens
		found = append(found, recorded)
		return true
	})
	return found
}

func firstField(line, tag []byte) string {
	i := bytes.Index(line, tag)
	if i < 0 {
		return ""
	}
	return valueAt(line[i+len(tag):])
}

// lastField reads the last occurrence of a top-level field, which Claude Code
// writes after the message.
func lastField(line, tag []byte) string {
	i := bytes.LastIndex(line, tag)
	if i < 0 {
		return ""
	}
	return valueAt(line[i+len(tag):])
}

func valueAt(rest []byte) string {
	end := bytes.IndexByte(rest, '"')
	if end < 0 {
		return ""
	}
	return string(rest[:end])
}
