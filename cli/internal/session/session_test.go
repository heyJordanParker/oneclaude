package session

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/heyJordanParker/oneclaude/cli/internal/model"
)

func TestIdentityFromHeaders(t *testing.T) {
	h := http.Header{}
	h.Set("X-Claude-Code-Session-Id", "s1")
	if id := FromRequest(h, nil); id.Key() != "s1" || id.Subagent() {
		t.Fatalf("main agent = %+v", id)
	}
	h.Set("X-Claude-Code-Agent-Id", "a7")
	if id := FromRequest(h, nil); id.Key() != "s1/a7" || !id.Subagent() {
		t.Fatalf("subagent = %+v", id)
	}
}

func TestIdentityFromBody(t *testing.T) {
	body := []byte(`{"metadata":{"user_id":"user_abc_account_def_session_0b5f8a1e-1111-2222-3333-444455556666"}}`)
	if id := FromRequest(http.Header{}, body); id.Session != "0b5f8a1e-1111-2222-3333-444455556666" {
		t.Fatalf("session = %q", id.Session)
	}
	body = []byte(`{"metadata":{"user_id":"{\"device_id\":\"d\",\"session_id\":\"s9\"}"}}`)
	if id := FromRequest(http.Header{}, body); id.Session != "s9" {
		t.Fatalf("session = %q", id.Session)
	}
}

func TestAgentsBindAndCount(t *testing.T) {
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	a := NewAgents()
	a.Touch("s1", "acct", model.Opus, now)
	a.Touch("s1/x", "acct", model.Haiku, now)
	a.Touch("s2", "other", model.Opus, now.Add(-10*time.Minute))
	if acct, ok := a.Bound("s1", now.Add(30*time.Minute), time.Hour); !ok || acct != "acct" {
		t.Fatalf("bound = %q %v", acct, ok)
	}
	if _, ok := a.Bound("s1", now.Add(2*time.Hour), time.Hour); ok {
		t.Fatal("binding outlived its ttl")
	}
	active := a.Active(now)
	if active["acct"][model.Opus] != 1 || active["acct"][model.Haiku] != 1 || active["other"][model.Opus] != 0 {
		t.Fatalf("active = %v", active)
	}
}

// claudeProjects writes the files Claude Code keeps for one session in
// project, and for each of its subagents, named by id, with its type.
func claudeProjects(t *testing.T, session, project string, subagents map[string]string) string {
	t.Helper()
	root := t.TempDir()
	folder := filepath.Join(root, "-Users-turing-"+project)
	transcript := `{"type":"file-history-snapshot"}` + "\n" + `{"type":"user","cwd":"/Users/turing/` + project + `","sessionId":"` + session + `"}` + "\n"
	write(t, filepath.Join(folder, session+".jsonl"), transcript)
	for id, agentType := range subagents {
		write(t, filepath.Join(folder, session, "subagents", "agent-"+id+".meta.json"), `{"agentType":"`+agentType+`","description":"a task"}`)
	}
	return root
}

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

// assistant is a transcript line for one request, as Claude Code writes it.
func assistant(at, request string, tokens model.Tokens) string {
	return fmt.Sprintf(`{"type":"assistant","cwd":"/elsewhere","message":{"model":"claude-opus-5-5","role":"assistant","content":[{"type":"text","text":"\"model\":\"not this\""}],"usage":{"input_tokens":%d,"cache_creation_input_tokens":%d,"cache_read_input_tokens":%d,"output_tokens":%d,"output_tokens_details":{"thinking_tokens":0}}},"requestId":"%s","timestamp":"%s"}`+"\n",
		tokens.Input, tokens.CacheWrite, tokens.CacheRead, tokens.Output, request, at)
}

func TestRecordedBetweenFindsEachRequestWithItsTokensAgentTypeAndItsSessionsProject(t *testing.T) {
	root := claudeProjects(t, "s1", "dotfiles", map[string]string{"a7": "code-reviewer"})
	folder := filepath.Join(root, "-Users-turing-dotfiles")
	main := model.Tokens{Input: 2, Output: 5411, CacheRead: 66598, CacheWrite: 19897}
	review := model.Tokens{Input: 3, Output: 10, CacheRead: 100}
	old := model.Tokens{Input: 4, Output: 20}
	late := model.Tokens{Input: 5, Output: 30}
	transcript, _ := os.ReadFile(filepath.Join(folder, "s1.jsonl"))
	write(t, filepath.Join(folder, "s1.jsonl"), string(transcript)+
		assistant("2026-10-14T23:00:00Z", "req_old", old)+
		assistant("2026-10-15T16:14:48.1Z", "req_main", main)+
		assistant("2026-10-15T16:14:48.1Z", "req_main", main)+
		assistant("2026-10-15T16:20:00Z", "req_unwanted", model.Tokens{Input: 9})+
		assistant("2026-10-16T00:00:00Z", "req_late", late))
	write(t, filepath.Join(folder, "s1", "subagents", "agent-a7.jsonl"), assistant("2026-10-15T17:00:00Z", "req_review", review))

	wanted := map[model.Tokens]bool{main: true, review: true, old: true, late: true}
	found := map[model.Tokens][]Recorded{}
	for _, r := range NewRecords(root).RecordedBetween(time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC), time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC), func(t model.Tokens) bool { return wanted[t] }, 2, func() bool { return true }) {
		found[r.Tokens] = append(found[r.Tokens], r)
	}
	if len(found) != 2 || len(found[old]) != 0 || len(found[late]) != 0 {
		t.Fatalf("found = %+v, want the two requests on Oct 15", found)
	}
	if got := found[main]; len(got) != 2 || got[0].Request != "req_main" || got[0].Model != "claude-opus-5-5" || got[0].Subagent || got[0].Agent != "" || got[0].Project != "dotfiles" {
		t.Fatalf("main session = %+v", got)
	}
	if got := found[review]; len(got) != 1 || !got[0].Subagent || got[0].Agent != "code-reviewer" || got[0].Project != "dotfiles" || !got[0].At.Equal(time.Date(2026, 10, 15, 17, 0, 0, 0, time.UTC)) {
		t.Fatalf("subagent = %+v, want the code-reviewer in its session's project", got)
	}
}

func TestACustomAgentTypeIsNotItsName(t *testing.T) {
	h := http.Header{}
	h.Set("X-Claude-Code-Session-Id", "s1")
	h.Set("X-Claude-Code-Agent-Id", "a7")
	h.Set("X-Claude-Code-Agent-Type", "custom")
	if id := FromRequest(h, nil); id.Type != "" {
		t.Fatalf("type = %q, want none for a custom agent", id.Type)
	}
	h.Set("X-Claude-Code-Agent-Type", "Explore")
	if id := FromRequest(h, nil); id.Type != "Explore" {
		t.Fatalf("type = %q", id.Type)
	}
}

func TestRetryDetection(t *testing.T) {
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	a := NewAgents()
	a.Touch("s1", "acct", model.Opus, now)
	if a.Failed("s1", now) {
		t.Fatal("a first failure is not a retry")
	}
	if !a.Failed("s1", now.Add(30*time.Second)) {
		t.Fatal("a failure 30s after a failure is a retry")
	}
}
