package runtime

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/heyJordanParker/oneclaude/cli/internal/model"
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

func TestTheDashboardIsThePanelsFirstPageAndTheStatusKeepsItsJSON(t *testing.T) {
	p := newTestPlugin(t, enabled)
	send(t, p, "r1", "s1", "", "claude-opus-5-5", []string{"claude-turing@example.com.json"}, weekly(0.58, 48*time.Hour), 200)
	reg := call[ManagementRegistrationResponse](t, p, MethodManagementRegister, ManagementRegistrationRequest{BasePath: "/v0/management", ResourceBasePath: "/v0/resource/plugins/oneclaude"})
	var pages []string
	served := map[string]bool{}
	for _, r := range reg.Resources {
		served[r.Path] = true
		if r.Menu != "" {
			pages = append(pages, r.Path)
		}
	}
	sort.Strings(pages)
	if len(pages) == 0 || pages[0] != "/v0/resource/plugins/oneclaude/dashboard" || !served["/v0/resource/plugins/oneclaude/status.json"] {
		t.Fatalf("resources = %+v", reg.Resources)
	}

	page := call[ManagementResponse](t, p, MethodManagementHandle, ManagementRequest{Method: "GET", Path: "/v0/resource/plugins/oneclaude/dashboard"})
	if page.StatusCode != 200 || !strings.HasPrefix(page.Headers.Get("Content-Type"), "text/html") || !bytes.Contains(page.Body, []byte("<title>oneclaude</title>")) {
		t.Fatalf("dashboard = %d %v", page.StatusCode, page.Headers)
	}
	_, rest, _ := bytes.Cut(page.Body, []byte("<script>"))
	script, _, _ := bytes.Cut(rest, []byte("</script>"))
	sum := sha256.Sum256(script)
	if len(script) == 0 || !strings.Contains(page.Headers.Get("Content-Security-Policy"), "'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"'") {
		t.Fatalf("the policy %q does not admit the page's script", page.Headers.Get("Content-Security-Policy"))
	}

	resp := call[ManagementResponse](t, p, MethodManagementHandle, ManagementRequest{Method: "GET", Path: "/v0/resource/plugins/oneclaude/status.json"})
	var st Status
	if resp.StatusCode != 200 || json.Unmarshal(resp.Body, &st) != nil {
		t.Fatalf("status = %d %s", resp.StatusCode, resp.Body)
	}
	if st.Pool.Used != 0.58 || st.Pool.Agents != 1 || st.Accounts[0].Name != "turing" {
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

func history(t *testing.T, p *Plugin) (History, string) {
	t.Helper()
	resp := call[ManagementResponse](t, p, MethodManagementHandle, ManagementRequest{Method: "GET", Path: "/v0/resource/plugins/oneclaude/history.json"})
	var h History
	if resp.StatusCode != 200 || json.Unmarshal(resp.Body, &h) != nil {
		t.Fatalf("history = %d %s", resp.StatusCode, resp.Body)
	}
	return h, string(resp.Body)
}

func requestsIn(h History) (total int, byHour map[int64]int) {
	byHour = map[int64]int{}
	for _, a := range h.Accounts {
		for _, hour := range a.Hours {
			total += hour.Requests
			byHour[hour.At.Unix()] += hour.Requests
		}
	}
	return total, byHour
}

func TestHistoryCountsEachAccountsRequestsByTheHour(t *testing.T) {
	p := newTestPlugin(t, enabled)
	call[ManagementRegistrationResponse](t, p, MethodManagementRegister, ManagementRegistrationRequest{BasePath: "/v0/management", ResourceBasePath: "/v0/resource/plugins/oneclaude"})
	account := []string{"claude-turing@example.com.json"}
	send(t, p, "r1", "s1", "", "claude-opus-5-5", account, weekly(0.5, 48*time.Hour), 200)
	send(t, p, "r2", "s1", "", "claude-opus-5-5", account, nil, http.StatusTooManyRequests)
	h, body := history(t, p)
	if len(h.Accounts) != 1 || h.Accounts[0].Name != "turing" || len(h.Accounts[0].Hours) != 1 {
		t.Fatalf("history = %+v", h)
	}
	hour := h.Accounts[0].Hours[0]
	if !hour.At.Equal(testNow) || hour.Requests != 2 || hour.Outcomes["ok"] != 1 || hour.Outcomes["throttled"] != 1 {
		t.Fatalf("hour = %+v", hour)
	}
	if strings.Contains(body, "parkerlabs") {
		t.Fatal("the history leaks an account address")
	}
}

func TestHistoryKeepsTheRequestsOfAnEarlierLoad(t *testing.T) {
	dir := t.TempDir()
	cfg, _ := json.Marshal(LifecycleRequest{ConfigYAML: []byte("enabled: true\ndata-dir: " + dir)})
	account := []string{"claude-turing@example.com.json"}
	p := New(Options{Name: "oneclaude", NoPoller: true, Now: func() time.Time { return testNow }})
	p.Call(MethodPluginRegister, cfg)
	call[ManagementRegistrationResponse](t, p, MethodManagementRegister, ManagementRegistrationRequest{BasePath: "/v0/management", ResourceBasePath: "/v0/resource/plugins/oneclaude"})
	send(t, p, "r1", "s1", "", "claude-opus-5-5", account, weekly(0.5, 48*time.Hour), 200)
	send(t, p, "r2", "s1", "", "claude-opus-5-5", account, weekly(0.51, 48*time.Hour), 200)
	p.Shutdown()

	later := testNow.Add(time.Hour)
	again := New(Options{Name: "oneclaude", NoPoller: true, Now: func() time.Time { return later }})
	again.Call(MethodPluginRegister, cfg)
	defer again.Shutdown()
	call[ManagementRegistrationResponse](t, again, MethodManagementRegister, ManagementRegistrationRequest{BasePath: "/v0/management", ResourceBasePath: "/v0/resource/plugins/oneclaude"})
	send(t, again, "r3", "s1", "", "claude-opus-5-5", account, weekly(0.52, 48*time.Hour), 200)
	h, _ := history(t, again)
	total, byHour := requestsIn(h)
	if total != 3 || byHour[testNow.Unix()] != 2 || byHour[later.Unix()] != 1 || len(h.Accounts) != 1 || h.Accounts[0].Name != "turing" {
		t.Fatalf("history = %+v, want 2 requests before the restart and 1 after, each once", h)
	}
	second, _ := history(t, again)
	if total, _ := requestsIn(second); total != 3 {
		t.Fatalf("a second read counted %d requests, want 3", total)
	}
}

func TestHistoryReadsOnlyTheLastWeekOfTheRequestLog(t *testing.T) {
	dir := t.TempDir()
	var log bytes.Buffer
	for hoursAgo := 240; hoursAgo >= 1; hoursAgo-- {
		for i := 0; i < 20; i++ {
			line, _ := json.Marshal(requestLine{At: testNow.Add(-time.Duration(hoursAgo)*time.Hour + time.Duration(i)*time.Minute), Family: "opus", Account: "0000beef", Outcome: "ok"})
			log.Write(append(line, '\n'))
		}
	}
	if log.Len() <= 1<<20 {
		t.Fatalf("the log is %d bytes, want more than one read chunk", log.Len())
	}
	if err := os.WriteFile(filepath.Join(dir, "requests.jsonl"), log.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, _ := json.Marshal(LifecycleRequest{ConfigYAML: []byte("enabled: true\ndata-dir: " + dir)})
	p := New(Options{Name: "oneclaude", NoPoller: true, Now: func() time.Time { return testNow }})
	p.Call(MethodPluginRegister, cfg)
	defer p.Shutdown()
	call[ManagementRegistrationResponse](t, p, MethodManagementRegister, ManagementRegistrationRequest{BasePath: "/v0/management", ResourceBasePath: "/v0/resource/plugins/oneclaude"})
	h, _ := history(t, p)
	total, byHour := requestsIn(h)
	if total != 168*20 || len(byHour) != 168 || byHour[testNow.Add(-168*time.Hour).Unix()] != 20 || byHour[testNow.Add(-169*time.Hour).Unix()] != 0 {
		t.Fatalf("history holds %d requests in %d hours, want %d in 168", total, len(byHour), 168*20)
	}
}

// spend runs one answered request that used tokens.
func spend(t *testing.T, p *Plugin, rid, session, agent, model, account string, detail UsageDetail) {
	t.Helper()
	in := call[RequestInterceptResponse](t, p, MethodRequestInterceptBefore, RequestInterceptRequest{RequestID: "client-" + rid, TraceID: rid, Model: model, Headers: agentHeaders(session, agent)})
	pick := call[SchedulerPickResponse](t, p, MethodSchedulerPick, SchedulerPickRequest{Provider: "claude", Model: model, Options: SchedulerOptions{Headers: in.Headers}, Candidates: []SchedulerAuthCandidate{{ID: account, Provider: "claude"}}})
	call[struct{}](t, p, MethodUsageHandle, UsageRecord{RequestID: "attempt-" + rid, TraceID: rid, Provider: "claude", Model: model, AuthID: pick.AuthID, Detail: detail})
}

// claudeProjects writes what Claude Code keeps for session s1 in the project
// dotfiles, with its subagent a7, a code-reviewer.
func claudeProjects(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	folder := filepath.Join(root, "-Users-turing-dotfiles")
	files := map[string]string{
		filepath.Join(folder, "s1.jsonl"):                                `{"type":"user","cwd":"/Users/turing/dotfiles"}`,
		filepath.Join(folder, "s1", "subagents", "agent-a7.meta.json"): `{"agentType":"code-reviewer"}`,
	}
	for path, text := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func usageOf(t *testing.T, p *Plugin, period, by string) UsageTable {
	t.Helper()
	resp := call[ManagementResponse](t, p, MethodManagementHandle, ManagementRequest{Method: "GET", Path: "/v0/resource/plugins/oneclaude/usage.json", Query: url.Values{"period": {period}, "by": {by}, "units": {"cost"}}})
	var table UsageTable
	if resp.StatusCode != 200 || json.Unmarshal(resp.Body, &table) != nil {
		t.Fatalf("usage = %d %s", resp.StatusCode, resp.Body)
	}
	return table
}

func costOf(row UsageRow) float64 {
	return row.amount("cost")
}

func TestUsageSplitsAPeriodByAccountModelAgentAndProjectAtListPrices(t *testing.T) {
	p := New(Options{Name: "oneclaude", NoPoller: true, ClaudeProjects: claudeProjects(t), Now: func() time.Time { return testNow }})
	cfg, _ := json.Marshal(LifecycleRequest{ConfigYAML: []byte("enabled: true\ndata-dir: " + t.TempDir())})
	p.Call(MethodPluginRegister, cfg)
	defer p.Shutdown()
	call[ManagementRegistrationResponse](t, p, MethodManagementRegister, ManagementRegistrationRequest{BasePath: "/v0/management", ResourceBasePath: "/v0/resource/plugins/oneclaude"})
	account := "claude-turing@example.com.json"
	spend(t, p, "r1", "s1", "", "claude-opus-5-5", account, UsageDetail{InputTokens: 2, OutputTokens: 127, CacheCreationTokens: 43544})
	spend(t, p, "r2", "s1", "", "claude-opus-5-5", account, UsageDetail{InputTokens: 2, OutputTokens: 127, CacheCreationTokens: 43544})
	spend(t, p, "r3", "s1", "a7", "claude-sonnet-5-5-20261001", account, UsageDetail{CacheReadTokens: 1_000_000})
	spend(t, p, "r4", "elsewhere", "", "claude-haiku-5-5", account, UsageDetail{OutputTokens: 1_000_000})

	agents := usageOf(t, p, "today", "agent")
	if agents.Today != testNow.In(time.Local).Format("2006-01-02") || len(agents.Rows) != 2 || agents.Total.Label != "All agents" {
		t.Fatalf("by agent = %+v", agents)
	}
	main, review := agents.Rows[0], agents.Rows[1]
	if main.Label != "Main sessions" || main.Tokens.CacheWrite != 87088 || math.Abs(costOf(main)-(2*0.3509+0.5)) > 1e-9 {
		t.Fatalf("main sessions = %+v, want both Opus requests and the Haiku one", main)
	}
	if review.Label != "code-reviewer" || math.Abs(costOf(review)-0.1) > 1e-9 {
		t.Fatalf("subagent = %+v", review)
	}
	projects := usageOf(t, p, "today", "project")
	if projects.Rows[0].Label != "dotfiles" || projects.Rows[1].Label != "Not recorded" || projects.Rows[1].Key != "" {
		t.Fatalf("by project = %+v, want dotfiles, then the session Claude Code wrote nothing for", projects.Rows)
	}
	models := usageOf(t, p, "today", "model")
	if models.Rows[0].Label != "Opus 5.5" || models.Rows[1].Label != "Haiku 5.5" || models.Rows[2].Label != "Sonnet 5.5" {
		t.Fatalf("by model = %+v, want the costliest first", models.Rows)
	}
	accounts := usageOf(t, p, "yesterday", "account")
	if len(accounts.Rows) != 1 || accounts.Rows[0].Label != "turing" || costOf(accounts.Rows[0]) != 0 || len(accounts.Days) != chartDays {
		t.Fatalf("yesterday = %+v, want turing with nothing, and 30 chart days", accounts)
	}
	if last := accounts.Days[chartDays-1]; last.Day != agents.Today || len(last.Rows) != 1 || last.Rows[0].Label != "turing" {
		t.Fatalf("today's chart day = %+v, by account", last)
	}
}

func TestUsageKeepsNinetyDaysAndPricesALineWithoutItsModelAsItsFamilysNewest(t *testing.T) {
	dir := t.TempDir()
	var log bytes.Buffer
	for _, daysAgo := range []int{100, 20} {
		line, _ := json.Marshal(requestLine{At: testNow.AddDate(0, 0, -daysAgo), Family: "opus", Account: "0000beef", Outcome: "ok", Tokens: model.Tokens{Output: 1_000_000}})
		log.Write(append(line, '\n'))
	}
	if err := os.WriteFile(filepath.Join(dir, "requests.jsonl"), log.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, _ := json.Marshal(LifecycleRequest{ConfigYAML: []byte("enabled: true\ndata-dir: " + dir)})
	p := New(Options{Name: "oneclaude", NoPoller: true, Now: func() time.Time { return testNow }})
	p.Call(MethodPluginRegister, cfg)
	defer p.Shutdown()
	call[ManagementRegistrationResponse](t, p, MethodManagementRegister, ManagementRegistrationRequest{BasePath: "/v0/management", ResourceBasePath: "/v0/resource/plugins/oneclaude"})
	table := usageOf(t, p, "month", "model")
	twentyDaysAgo := testNow.AddDate(0, 0, -20).In(time.Local).Format("2006-01-02")
	if table.Since != twentyDaysAgo {
		t.Fatalf("since = %q, want %s: the line 100 days old is past the 90 days kept", table.Since, twentyDaysAgo)
	}
	if len(table.Rows) != 1 || table.Rows[0].Label != "Opus 5.5" || math.Abs(costOf(table.Rows[0])-20) > 1e-9 {
		t.Fatalf("rows = %+v, want Opus 5.5 output at $20", table.Rows)
	}
	byDay := usageOf(t, p, "month", "day")
	if len(byDay.Rows) != 1 || byDay.Rows[0].Label != testNow.AddDate(0, 0, -20).In(time.Local).Format("Jan 2") || byDay.Rows[0].Key != twentyDaysAgo {
		t.Fatalf("by day = %+v", byDay.Rows)
	}
	if agents := usageOf(t, p, "month", "agent"); agents.Rows[0].Label != "Main sessions" {
		t.Fatalf("an old main-session line = %+v", agents.Rows)
	}
}

// proxyWithCodex answers the host calls a usage poll makes, for a proxy that
// holds one Codex account and no Claude account.
func proxyWithCodex(t *testing.T) HostFunc {
	return func(method string, payload []byte) ([]byte, error) {
		switch method {
		case MethodHostAuthList:
			return okEnvelope(HostAuthListResponse{Files: []HostAuthFileEntry{{ID: "codex-ada.json", AuthIndex: "c1", Type: "codex", Email: "ada@example.com"}}})
		case MethodHostAuthGet:
			return okEnvelope(HostAuthGetResponse{AuthIndex: "c1", JSON: json.RawMessage(`{"access_token":"codex-token","account_id":"chatgpt-account"}`)})
		case MethodHostHTTPDo:
			var req HostHTTPRequest
			_ = json.Unmarshal(payload, &req)
			if req.URL != codexUsageURL || req.Headers.Get("Authorization") != "Bearer codex-token" || req.Headers.Get("Chatgpt-Account-Id") != "chatgpt-account" {
				t.Errorf("usage request = %s %v", req.URL, req.Headers)
				return okEnvelope(HostHTTPResponse{StatusCode: http.StatusBadRequest})
			}
			body := fmt.Sprintf(`{"rate_limit":{"allowed":true,"primary_window":{"used_percent":23,"limit_window_seconds":604800,"reset_at":%d}}}`, testNow.Add(50*time.Hour).Unix())
			return okEnvelope(HostHTTPResponse{StatusCode: http.StatusOK, Body: []byte(body)})
		}
		return okEnvelope(emptyResult)
	}
}

func TestStatusShowsACodexAccountsWeeklyUsageApartFromThePool(t *testing.T) {
	p := New(Options{Name: "oneclaude", Version: "test", NoPoller: true, Host: proxyWithCodex(t), Now: func() time.Time { return testNow }})
	cfg, _ := json.Marshal(LifecycleRequest{ConfigYAML: []byte("enabled: true\ndata-dir: " + t.TempDir()), SchemaVersion: 1})
	p.Call(MethodPluginRegister, cfg)
	defer p.Shutdown()
	if err := p.list(); err != nil {
		t.Fatal(err)
	}
	p.refreshOne(testNow, map[string]time.Time{})
	st := p.Status()
	if len(st.Codex) != 1 {
		t.Fatalf("codex = %+v", st.Codex)
	}
	codex := st.Codex[0]
	if codex.Name != "ada" || !codex.Known || codex.Used != 0.23 || codex.ResetsAt == nil || !codex.ResetsAt.Equal(testNow.Add(50*time.Hour)) || codex.Empty {
		t.Fatalf("codex account = %+v", codex)
	}
	if st.Pool.Accounts != 0 || len(st.Accounts) != 0 {
		t.Fatalf("a Codex account joined the Claude pool: %+v", st.Pool)
	}
}
