package main

import (
	"bufio"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"strings"
	"testing"
)

// These checks run against the dev proxy (dev/config.yaml) and the fake
// Anthropic server: go test -run DevProxy with ONECLAUDE_DEV_PROXY set.

const devProxy = "http://127.0.0.1:8318"

func devOnly(t *testing.T) {
	if os.Getenv("ONECLAUDE_DEV_PROXY") == "" {
		t.Skip("set ONECLAUDE_DEV_PROXY to run against the dev proxy")
	}
}

func devSend(t *testing.T, session, agent, model, prompt string) *http.Response {
	t.Helper()
	body := fmt.Sprintf(`{"model":%q,"max_tokens":20,"stream":true,"messages":[{"role":"user","content":%q}]}`, model, prompt)
	req, _ := http.NewRequest(http.MethodPost, devProxy+"/v1/messages", strings.NewReader(body))
	req.Header.Set("x-api-key", "dev-client")
	req.Header.Set("content-type", "application/json")
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("X-Claude-Code-Session-Id", session)
	if agent != "" {
		req.Header.Set("X-Claude-Code-Agent-Id", agent)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	return resp
}

func devStatus(t *testing.T, session, agent, model, prompt string) int {
	t.Helper()
	resp := devSend(t, session, agent, model, prompt)
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	return resp.StatusCode
}

func served(t *testing.T) map[string]int {
	t.Helper()
	resp, err := http.Get("http://127.0.0.1:8319/served")
	if err != nil {
		t.Fatalf("served: %v", err)
	}
	defer resp.Body.Close()
	out := map[string]int{}
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		var key string
		var n int
		if _, err := fmt.Sscanf(scanner.Text(), "%s %d", &key, &n); err == nil {
			out[key] = n
		}
	}
	return out
}

func TestDevProxyAConversationStaysOnOneAccount(t *testing.T) {
	devOnly(t)
	session := fmt.Sprintf("stick-%d", rand.Int())
	before := served(t)
	for i := 0; i < 5; i++ {
		if code := devStatus(t, session, "", "claude-opus-5-5", "hi"); code != 200 {
			t.Fatalf("turn %d = %d", i, code)
		}
	}
	after := served(t)
	moved := 0
	for key, n := range after {
		if n != before[key] {
			moved++
		}
	}
	if moved != 1 {
		t.Fatalf("5 turns reached %d accounts, want 1: before %v after %v", moved, before, after)
	}
}

func TestDevProxyRefusesANewSubagentWhenEveryAccountIsFull(t *testing.T) {
	devOnly(t)
	session := fmt.Sprintf("pool-%d", rand.Int())
	for i := 1; i <= 12; i++ {
		if code := devStatus(t, session, fmt.Sprintf("agent-%d", i), "claude-fable-5", "hi"); code != 200 {
			t.Fatalf("fable subagent %d = %d, want 200", i, code)
		}
	}
	resp := devSend(t, session, "agent-13", "claude-fable-5", "hi")
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 429 {
		t.Fatalf("13th fable subagent = %d, want 429", resp.StatusCode)
	}
	if got := resp.Header.Get("X-Should-Retry"); got != "false" {
		t.Errorf("x-should-retry = %q, want false", got)
	}
	if !strings.Contains(string(body), "Retry this subagent in 3 minutes") {
		t.Errorf("body = %s", body)
	}
	t.Logf("refusal body: %s", body)
	if code := devStatus(t, session, "agent-3", "claude-fable-5", "hi"); code != 200 {
		t.Errorf("a running subagent = %d, want 200", code)
	}
	if code := devStatus(t, session+"-main", "", "claude-fable-5", "hi"); code != 200 {
		t.Errorf("a primary agent = %d, want 200", code)
	}
	if code := devStatus(t, session, "agent-h", "claude-haiku-5-5", "hi"); code != 200 {
		t.Errorf("a haiku subagent = %d, want 200", code)
	}
}

func TestDevProxyReportsAThrottle(t *testing.T) {
	devOnly(t)
	if code := devStatus(t, fmt.Sprintf("throttle-%d", rand.Int()), "", "claude-opus-5-5", "throttle"); code != 429 {
		t.Fatalf("throttle = %d, want 429", code)
	}
	resp, err := http.Get(devProxy + "/v0/resource/plugins/oneclaude/status.json")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if !strings.Contains(string(body), `"kind":"throttled"`) {
		t.Fatalf("status has no throttle warning: %s", body)
	}
}
