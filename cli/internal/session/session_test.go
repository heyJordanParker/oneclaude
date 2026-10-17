package session

import (
	"net/http"
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
