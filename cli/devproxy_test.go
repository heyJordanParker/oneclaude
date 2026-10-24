package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// These checks run against the dev proxy (dev/config.yaml) and the fake
// Anthropic server: go test -run DevProxy with ONECLAUDE_DEV_PROXY set.

const devProxy = "http://127.0.0.1:8318"

const headerCacheKeyName = "X-Oneclaude-Cache-Key"

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
	if !strings.Contains(string(body), `"throttled_at"`) || !strings.Contains(string(body), `(429).`) {
		t.Fatalf("status shows no throttled account and logs no throttle: %s", body)
	}
}

func TestDevProxyServesTheDashboardAndItsHistory(t *testing.T) {
	devOnly(t)
	page, err := http.Get(devProxy + "/v0/resource/plugins/oneclaude/dashboard")
	if err != nil {
		t.Fatal(err)
	}
	html, _ := io.ReadAll(page.Body)
	_ = page.Body.Close()
	if page.StatusCode != 200 || !strings.HasPrefix(page.Header.Get("Content-Type"), "text/html") || !strings.Contains(string(html), "<title>oneclaude</title>") {
		t.Fatalf("dashboard = %d %s", page.StatusCode, page.Header.Get("Content-Type"))
	}
	if !strings.Contains(page.Header.Get("Content-Security-Policy"), "frame-ancestors 'self'") {
		t.Fatalf("dashboard policy = %q", page.Header.Get("Content-Security-Policy"))
	}
	resp, err := http.Get(devProxy + "/v0/resource/plugins/oneclaude/history.json")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	var history struct {
		Accounts []struct {
			Name  string            `json:"name"`
			Hours []json.RawMessage `json:"hours"`
		} `json:"accounts"`
	}
	if resp.StatusCode != 200 || json.Unmarshal(body, &history) != nil || len(history.Accounts) == 0 {
		t.Fatalf("history = %d %s", resp.StatusCode, body)
	}
}

// TestDevProxyAFilterRewritesTheRequestAndEachEventOfItsReply runs a filter
// that turns the prompt into "slow", which the fake answers over 6 seconds,
// and every text delta into "filtered".
func TestDevProxyAFilterRewritesAWholeResponseAndAnswersARequestItself(t *testing.T) {
	devOnly(t)
	filter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var post struct {
			Request *struct {
				Body json.RawMessage `json:"body"`
			} `json:"request"`
			Response *struct {
				Body json.RawMessage `json:"body"`
			} `json:"response"`
		}
		_ = json.NewDecoder(r.Body).Decode(&post)
		switch {
		case post.Request != nil && strings.Contains(string(post.Request.Body), "refuse me"):
			_ = json.NewEncoder(w).Encode(map[string]any{"immediateResponse": map[string]any{"status": 403, "body": map[string]any{"type": "error", "error": map[string]string{"type": "permission_error", "message": "the policy filter refused this"}}}})
		case post.Request != nil:
			_ = json.NewEncoder(w).Encode(map[string]any{"headers": map[string]any{"anthropic-beta": "oneclaude-filter-test", "x-oneclaude-cache-key": "whole"}})
		case post.Response != nil:
			_ = json.NewEncoder(w).Encode(map[string]any{"body": json.RawMessage(strings.Replace(string(post.Response.Body), `"text":"ok"`, `"text":"rewritten"`, 1))})
		}
	}))
	defer filter.Close()
	session := fmt.Sprintf("whole-%d", rand.Int())
	filters := "../.target/dev/data/filters/" + session + ".json"
	raw, _ := json.Marshal([]map[string]any{{"name": "dev", "url": filter.URL, "responses": true}})
	if err := os.MkdirAll("../.target/dev/data/filters", 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filters, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(filters)

	send := func(prompt string) (int, string) {
		body := fmt.Sprintf(`{"model":"claude-opus-5-5","max_tokens":20,"messages":[{"role":"user","content":%q}]}`, prompt)
		req, _ := http.NewRequest(http.MethodPost, devProxy+"/v1/messages", strings.NewReader(body))
		req.Header.Set("x-api-key", "dev-client")
		req.Header.Set("content-type", "application/json")
		req.Header.Set("anthropic-version", "2023-06-01")
		req.Header.Set("X-Claude-Code-Session-Id", session)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("send: %v", err)
		}
		defer resp.Body.Close()
		out, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(out)
	}

	if status, body := send("hi"); status != 200 || !strings.Contains(body, `"text":"rewritten"`) {
		t.Fatalf("whole response: %d %s, want the filter's rewrite", status, body)
	}
	resp, err := http.Get("http://127.0.0.1:8319/headers")
	if err != nil {
		t.Fatal(err)
	}
	var upstream http.Header
	_ = json.NewDecoder(resp.Body).Decode(&upstream)
	_ = resp.Body.Close()
	if !strings.Contains(upstream.Get("Anthropic-Beta"), "oneclaude-filter-test") || upstream.Get(headerCacheKeyName) != "" {
		t.Fatalf("Anthropic got headers %v, want the filter's beta and no cache key", upstream)
	}
	if status, body := send("refuse me"); status != 403 || !strings.Contains(body, "the policy filter refused this") {
		t.Fatalf("answered request: %d %s, want the filter's own answer", status, body)
	}
}

func TestDevProxyAFilterRewritesTheRequestAndEachEventOfItsResponse(t *testing.T) {
	devOnly(t)
	var mu sync.Mutex
	var sessions, paths []string
	filter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var post struct {
			Request *struct {
				Path    string            `json:"path"`
				Headers map[string]string `json:"headers"`
				Body    map[string]any    `json:"body"`
			} `json:"request"`
			Response *struct {
				Body map[string]any `json:"body"`
			} `json:"response"`
		}
		_ = json.NewDecoder(r.Body).Decode(&post)
		switch {
		case post.Request != nil:
			mu.Lock()
			sessions = append(sessions, post.Request.Headers["x-claude-code-session-id"])
			paths = append(paths, post.Request.Path)
			mu.Unlock()
			body := post.Request.Body
			body["messages"] = []map[string]string{{"role": "user", "content": "slow"}}
			_ = json.NewEncoder(w).Encode(map[string]any{"body": body})
		case post.Response != nil && post.Response.Body["type"] == "content_block_delta":
			event := post.Response.Body
			event["delta"] = map[string]string{"type": "text_delta", "text": "filtered "}
			_ = json.NewEncoder(w).Encode(map[string]any{"body": event})
		}
	}))
	defer filter.Close()

	session := fmt.Sprintf("filter-%d", rand.Int())
	filters := "../.target/dev/data/filters/" + session + ".json"
	raw, _ := json.Marshal([]map[string]any{{"name": "dev", "url": filter.URL, "responses": true, "timeoutSeconds": 5}})
	if err := os.MkdirAll("../.target/dev/data/filters", 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filters, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(filters)

	started := time.Now()
	resp := devSend(t, session, "", "claude-opus-5-5", "hi")
	reply, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	took := time.Since(started)

	if resp.StatusCode != 200 || took < 5*time.Second {
		t.Fatalf("status %d in %s, want 200 after the fake's slow reply", resp.StatusCode, took)
	}
	if strings.Contains(string(reply), "chunk") || !strings.Contains(string(reply), `"text":"filtered "`) {
		t.Fatalf("reply was not filtered: %s", reply)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(sessions) == 0 || sessions[0] != session || paths[0] != "/v1/messages" {
		t.Fatalf("the filter saw sessions %v on paths %v, want %s on /v1/messages", sessions, paths, session)
	}
	t.Logf("filtered reply in %s:\n%s", took, reply)
}
