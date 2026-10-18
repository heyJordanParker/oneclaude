package session

import (
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

func TestRecordsNameASubagentsTypeAndItsSessionsProject(t *testing.T) {
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	r := NewRecords(claudeProjects(t, "s1", "dotfiles", map[string]string{"a7": "code-reviewer"}))
	if agentType, project := r.Of(Identity{Session: "s1", Agent: "a7"}, now); agentType != "code-reviewer" || project != "dotfiles" {
		t.Fatalf("subagent = %q in %q", agentType, project)
	}
	if agentType, project := r.Of(Identity{Session: "s1"}, now); agentType != "" || project != "dotfiles" {
		t.Fatalf("main session = %q in %q", agentType, project)
	}
	if agentType, _ := r.Of(Identity{Session: "s1", Agent: "b2", Type: "Explore"}, now); agentType != "Explore" {
		t.Fatalf("a subagent with no meta file = %q, want the type Claude Code sent", agentType)
	}
}

func TestRecordsLookAgainForASessionWrittenLater(t *testing.T) {
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	root := t.TempDir()
	r := NewRecords(root)
	if _, project := r.Of(Identity{Session: "late"}, now); project != "" {
		t.Fatalf("project = %q before the transcript exists", project)
	}
	write(t, filepath.Join(root, "-Users-turing-oneclaude", "late.jsonl"), `{"cwd":"/Users/turing/oneclaude"}`+"\n")
	if _, project := r.Of(Identity{Session: "late"}, now.Add(10*time.Second)); project != "" {
		t.Fatalf("project = %q, want the miss kept for a minute", project)
	}
	if _, project := r.Of(Identity{Session: "late"}, now.Add(lookAgain)); project != "oneclaude" {
		t.Fatalf("project = %q a minute later", project)
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
