package runtime

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

var testNow = time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)

func newTestPlugin(t *testing.T, config string) *Plugin {
	t.Helper()
	p := New(Options{Name: "oneclaude", Version: "test", NoPoller: true, Now: func() time.Time { return testNow }})
	payload, _ := json.Marshal(LifecycleRequest{ConfigYAML: []byte(config + "\ndata-dir: " + t.TempDir()), SchemaVersion: 1})
	if _, ok := p.Call(MethodPluginRegister, payload); !ok {
		t.Fatal("register failed")
	}
	t.Cleanup(p.Shutdown)
	return p
}

func call[T any](t *testing.T, p *Plugin, method string, req any) T {
	t.Helper()
	payload, _ := json.Marshal(req)
	raw, ok := p.Call(method, payload)
	if !ok {
		t.Fatalf("%s failed: %s", method, raw)
	}
	var out T
	if err := unwrapEnvelope(raw, &out); err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	return out
}

func agentHeaders(session, agent string) http.Header {
	h := http.Header{}
	h.Set("X-Claude-Code-Session-Id", session)
	if agent != "" {
		h.Set("X-Claude-Code-Agent-Id", agent)
	}
	return h
}

// send runs one request the way the proxy does: intercept, pick, usage.
func send(t *testing.T, p *Plugin, rid, session, agent, model string, accounts []string, replyHeaders http.Header, status int) (string, RequestInterceptResponse) {
	t.Helper()
	in := call[RequestInterceptResponse](t, p, MethodRequestInterceptBefore, RequestInterceptRequest{RequestID: "client-" + rid, TraceID: rid, Model: model, Headers: agentHeaders(session, agent)})
	if in.Terminate {
		return "", in
	}
	var cands []SchedulerAuthCandidate
	for _, a := range accounts {
		cands = append(cands, SchedulerAuthCandidate{ID: a, Provider: "claude"})
	}
	pick := call[SchedulerPickResponse](t, p, MethodSchedulerPick, SchedulerPickRequest{Provider: "claude", Model: model, Options: SchedulerOptions{Headers: in.Headers}, Candidates: cands})
	if !pick.Handled {
		t.Fatalf("pick declined a Claude request")
	}
	rec := UsageRecord{RequestID: "attempt-" + rid, TraceID: rid, Provider: "claude", Model: model, AuthID: pick.AuthID, ResponseHeaders: replyHeaders}
	if status != http.StatusOK {
		rec.Failed, rec.Failure.StatusCode = true, status
	}
	call[struct{}](t, p, MethodUsageHandle, rec)
	return pick.AuthID, in
}

func weekly(used float64, resetIn time.Duration) http.Header {
	h := http.Header{}
	h.Set("anthropic-ratelimit-unified-7d-utilization", fmt.Sprintf("%.2f", used))
	h.Set("anthropic-ratelimit-unified-7d-reset", fmt.Sprintf("%d", testNow.Add(resetIn).Unix()))
	return h
}

const enabled = "enabled: true"

func TestAConversationStaysOnItsAccount(t *testing.T) {
	p := newTestPlugin(t, enabled)
	accounts := []string{"a@x.json", "b@x.json"}
	first, _ := send(t, p, "r1", "s1", "", "claude-opus-5-5", accounts, weekly(0.5, 48*time.Hour), 200)
	other := accounts[0]
	if first == other {
		other = accounts[1]
	}
	send(t, p, "r2", "s2", "", "claude-opus-5-5", []string{other}, weekly(0.1, 6*24*time.Hour), 200)
	for i := 0; i < 5; i++ {
		got, _ := send(t, p, fmt.Sprintf("r%d", i+3), "s1", "", "claude-opus-5-5", accounts, nil, 200)
		if got != first {
			t.Fatalf("turn %d went to %s, want %s", i, got, first)
		}
	}
}

func TestANewConversationGoesToTheAccountMostBehind(t *testing.T) {
	p := newTestPlugin(t, enabled)
	send(t, p, "r1", "s1", "", "claude-opus-5-5", []string{"soon"}, weekly(0.6, 20*time.Hour), 200)
	send(t, p, "r2", "s2", "", "claude-opus-5-5", []string{"late"}, weekly(0.4, 5*24*time.Hour), 200)
	got, _ := send(t, p, "r3", "s3", "", "claude-opus-5-5", []string{"late", "soon"}, nil, 200)
	if got != "soon" {
		t.Fatalf("new conversation went to %s, want soon", got)
	}
}

func TestANewSubagentIsRefusedWhenEveryAccountIsFull(t *testing.T) {
	p := newTestPlugin(t, enabled)
	accounts := []string{"a", "b"}
	for i := 0; i < 12; i++ {
		send(t, p, fmt.Sprintf("r%d", i), "main", fmt.Sprintf("agent%d", i), "claude-fable-5", accounts, weekly(0.3, 72*time.Hour), 200)
	}
	_, in := send(t, p, "r-new", "main", "agent-new", "claude-fable-5", accounts, nil, 200)
	if !in.Terminate || in.StatusCode != http.StatusTooManyRequests || in.ResponseHeaders.Get("X-Should-Retry") != "false" {
		t.Fatalf("new subagent = %+v, want a 429 refusal", in)
	}
	if !strings.Contains(string(in.ResponseBody), "Retry this subagent in 3 minutes") {
		t.Fatalf("body = %s", in.ResponseBody)
	}
	if _, in := send(t, p, "r-old", "main", "agent3", "claude-fable-5", accounts, nil, 200); in.Terminate {
		t.Fatal("a running subagent must never be refused")
	}
	if _, in := send(t, p, "r-main", "other-session", "", "claude-fable-5", accounts, nil, 200); in.Terminate {
		t.Fatal("a primary agent must never be refused")
	}
	if _, in := send(t, p, "r-haiku", "main", "agent-h", "claude-haiku-5", accounts, nil, 200); in.Terminate {
		t.Fatal("haiku has its own limit")
	}
	st := p.Status()
	if len(st.Warnings) == 0 || st.Warnings[0].Kind != "refused" {
		t.Fatalf("warnings = %+v, want the refusal", st.Warnings)
	}
	p.mu.Lock()
	pending := len(p.requests)
	p.mu.Unlock()
	if pending != 0 {
		t.Fatalf("%d intercepted requests never met their usage record", pending)
	}
}

func TestOtherProvidersAreDeclined(t *testing.T) {
	p := newTestPlugin(t, enabled)
	in := call[RequestInterceptResponse](t, p, MethodRequestInterceptBefore, RequestInterceptRequest{Model: "gpt-5", Headers: agentHeaders("s", "")})
	if len(in.Headers) != 0 || in.Terminate {
		t.Fatalf("intercept = %+v", in)
	}
	pick := call[SchedulerPickResponse](t, p, MethodSchedulerPick, SchedulerPickRequest{Provider: "codex", Model: "gpt-5", Candidates: []SchedulerAuthCandidate{{ID: "c", Provider: "codex"}}})
	if pick.Handled {
		t.Fatal("pick handled a codex request")
	}
}

func TestDisabledDeclinesEverything(t *testing.T) {
	p := newTestPlugin(t, "enabled: false")
	pick := call[SchedulerPickResponse](t, p, MethodSchedulerPick, SchedulerPickRequest{Provider: "claude", Model: "claude-opus-5-5", Candidates: []SchedulerAuthCandidate{{ID: "a", Provider: "claude"}}})
	if pick.Handled {
		t.Fatal("a disabled plugin handled a pick")
	}
}

func TestAThrottleIsAWarningAndAQuotaRefusalIsNot(t *testing.T) {
	p := newTestPlugin(t, enabled)
	send(t, p, "r1", "s1", "", "claude-opus-5-5", []string{"a"}, http.Header{}, http.StatusTooManyRequests)
	quota := weekly(1, time.Hour)
	quota.Set("anthropic-ratelimit-unified-status", "rejected")
	send(t, p, "r2", "s2", "", "claude-opus-5-5", []string{"a"}, quota, http.StatusTooManyRequests)
	st := p.Status()
	if len(st.Warnings) != 1 || st.Warnings[0].Kind != "throttled" {
		t.Fatalf("warnings = %+v, want one throttle", st.Warnings)
	}
	if !st.Accounts[0].Empty {
		t.Fatal("the account's week is spent, want empty")
	}
}

func TestGarbageNeverFailsARequest(t *testing.T) {
	p := newTestPlugin(t, enabled)
	for _, method := range []string{MethodRequestInterceptBefore, MethodSchedulerPick, MethodUsageHandle, MethodManagementHandle} {
		if raw, ok := p.Call(method, []byte("{not json")); !ok {
			t.Errorf("%s failed on garbage: %s", method, raw)
		}
	}
}

func TestAPanicNeverFailsARequest(t *testing.T) {
	p := newTestPlugin(t, enabled)
	p.agents = nil
	pick := call[SchedulerPickResponse](t, p, MethodSchedulerPick, SchedulerPickRequest{Provider: "claude", Model: "claude-opus-5-5", Options: SchedulerOptions{Headers: map[string][]string{headerKey: {"s1"}}}, Candidates: []SchedulerAuthCandidate{{ID: "a", Provider: "claude"}}})
	if pick.Handled {
		t.Fatal("a panicking pick must decline to the proxy's own routing")
	}
	in := call[RequestInterceptResponse](t, p, MethodRequestInterceptBefore, RequestInterceptRequest{Model: "claude-opus-5-5", Headers: agentHeaders("s1", "sub")})
	if in.Terminate {
		t.Fatal("a panicking interceptor must pass the request through")
	}
	call[struct{}](t, p, MethodUsageHandle, UsageRecord{RequestID: "r", Provider: "claude", AuthID: "a"})
}

func TestStatusIsServedOnTheResourceRoute(t *testing.T) {
	p := newTestPlugin(t, enabled)
	send(t, p, "r1", "s1", "", "claude-opus-5-5", []string{"claude-jordan@parkerlabs.co.json"}, weekly(0.58, 48*time.Hour), 200)
	reg := call[ManagementRegistrationResponse](t, p, MethodManagementRegister, ManagementRegistrationRequest{BasePath: "/v0/management", ResourceBasePath: "/v0/resource/plugins/oneclaude"})
	if len(reg.Resources) != 1 || reg.Resources[0].Path != "/v0/resource/plugins/oneclaude/status.json" {
		t.Fatalf("resources = %+v", reg.Resources)
	}
	resp := call[ManagementResponse](t, p, MethodManagementHandle, ManagementRequest{Method: "GET", Path: "/v0/resource/plugins/oneclaude/status.json"})
	var st Status
	if resp.StatusCode != 200 || json.Unmarshal(resp.Body, &st) != nil {
		t.Fatalf("status = %d %s", resp.StatusCode, resp.Body)
	}
	if st.Pool.Used != 0.58 || st.Pool.Agents != 1 || st.Accounts[0].Name != "jordan" {
		t.Fatalf("status = %+v", st)
	}
	if strings.Contains(string(resp.Body), "parkerlabs") {
		t.Fatal("the status leaks an account address")
	}
}

func TestAConversationKeepsItsAccountAcrossAReload(t *testing.T) {
	dir := t.TempDir()
	cfg, _ := json.Marshal(LifecycleRequest{ConfigYAML: []byte("enabled: true\ndata-dir: " + dir)})
	p := New(Options{Name: "oneclaude", NoPoller: true, Now: func() time.Time { return testNow }})
	p.Call(MethodPluginRegister, cfg)
	send(t, p, "r1", "s1", "", "claude-opus-5-5", []string{"behind"}, weekly(0.6, 20*time.Hour), 200)
	p.Shutdown()
	again := New(Options{Name: "oneclaude", NoPoller: true, Now: func() time.Time { return testNow }})
	again.Call(MethodPluginRegister, cfg)
	defer again.Shutdown()
	send(t, again, "r2", "s2", "", "claude-opus-5-5", []string{"ahead"}, weekly(0.1, 6*24*time.Hour), 200)
	if got, _ := send(t, again, "r3", "s1", "", "claude-opus-5-5", []string{"ahead", "behind"}, nil, 200); got != "behind" {
		t.Fatalf("after a reload the conversation moved to %q, want behind", got)
	}
}

func TestUsageSurvivesARestart(t *testing.T) {
	dir := t.TempDir()
	cfg, _ := json.Marshal(LifecycleRequest{ConfigYAML: []byte("enabled: true\ndata-dir: " + dir)})
	p := New(Options{Name: "oneclaude", NoPoller: true, Now: func() time.Time { return testNow }})
	p.Call(MethodPluginRegister, cfg)
	send(t, p, "r1", "s1", "", "claude-opus-5-5", []string{"a"}, weekly(0.42, 48*time.Hour), 200)
	p.Shutdown()
	again := New(Options{Name: "oneclaude", NoPoller: true, Now: func() time.Time { return testNow }})
	again.Call(MethodPluginRegister, cfg)
	defer again.Shutdown()
	if st := again.Status(); st.Pool.Used != 0.42 {
		t.Fatalf("after restart used = %v, want 0.42", st.Pool.Used)
	}
}
