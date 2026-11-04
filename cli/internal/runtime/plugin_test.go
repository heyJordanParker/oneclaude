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
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/heyJordanParker/oneclaude/cli/internal/model"
	"github.com/heyJordanParker/oneclaude/cli/internal/usage"
)

var testNow = time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)

func newTestPlugin(t *testing.T, config string) *Plugin {
	t.Helper()
	return newClockedPlugin(t, config, func() time.Time { return testNow })
}

// testClock is a time the test moves on while the plugin's own goroutines
// read it.
func testClock() (now func() time.Time, set func(time.Time)) {
	var at atomic.Int64
	at.Store(testNow.UnixNano())
	return func() time.Time { return time.Unix(0, at.Load()).UTC() }, func(to time.Time) { at.Store(to.UnixNano()) }
}

func newClockedPlugin(t *testing.T, config string, now func() time.Time) *Plugin {
	t.Helper()
	p := New(Options{Name: "oneclaude", Version: "test", NoPoller: true, Now: now})
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
	send(t, p, "r-again", "main", "agent-again", "claude-fable-5", accounts, nil, 200)
	st := p.Status()
	if !st.Pool.LimitReached {
		t.Fatal("pool = false, want the agent limit reached")
	}
	if len(st.Log) != 1 || st.Log[0].Level != levelWarn || st.Log[0].Text != "oneclaude refused a new Fable subagent: every account reached its limit of 6." {
		t.Fatalf("log = %+v, want the refusals as one line", st.Log)
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

func TestAThrottleIsLoggedOnceAndAQuotaRefusalIsNot(t *testing.T) {
	now, setNow := testClock()
	p := newClockedPlugin(t, enabled, now)
	send(t, p, "r1", "s1", "", "claude-opus-5-5", []string{"claude-ada@x.json"}, http.Header{}, http.StatusTooManyRequests)
	send(t, p, "r2", "s2", "", "claude-opus-5-5", []string{"claude-ada@x.json"}, http.Header{}, http.StatusTooManyRequests)
	quota := weekly(1, time.Hour)
	quota.Set("anthropic-ratelimit-unified-status", "rejected")
	send(t, p, "r3", "s3", "", "claude-opus-5-5", []string{"claude-ada@x.json"}, quota, http.StatusTooManyRequests)
	st := p.Status()
	if len(st.Log) != 1 || st.Log[0].Text != "Anthropic rate limited ada (429)." {
		t.Fatalf("log = %+v, want the throttles as one line", st.Log)
	}
	if st.Accounts[0].ThrottledAt == nil || !st.Accounts[0].Empty {
		t.Fatalf("account = %+v, want throttled and its week spent", st.Accounts[0])
	}
	setNow(testNow.Add(episode))
	send(t, p, "r4", "s4", "", "claude-opus-5-5", []string{"claude-ada@x.json"}, http.Header{}, http.StatusTooManyRequests)
	if log := p.Status().Log; len(log) != 2 {
		t.Fatalf("log = %+v, want a second line once 10 minutes passed", log)
	}
}

func TestTheLogRecordsEachAccountsFailuresOncePerEpisodeAndLeavesOutCancelledRequests(t *testing.T) {
	now, setNow := testClock()
	p := newClockedPlugin(t, enabled, now)
	fail := func(id, account string, status int) {
		call[struct{}](t, p, MethodUsageHandle, UsageRecord{RequestID: id, Provider: "claude", Model: "claude-opus-5-5", AuthID: account, Failed: true, Failure: UsageFailure{StatusCode: status}})
	}
	fail("cancelled", "claude-ada@x.json", statusClientClosed)
	fail("ada-1", "claude-ada@x.json", http.StatusInternalServerError)
	fail("ada-2", "claude-ada@x.json", http.StatusBadRequest)
	fail("bob-1", "claude-bob@x.json", http.StatusInternalServerError)
	fail("busy", "claude-ada@x.json", 529)
	setNow(testNow.Add(episode))
	fail("ada-3", "claude-ada@x.json", http.StatusBadGateway)
	var texts []string
	for _, e := range p.Status().Log {
		texts = append(texts, e.Level+" "+e.Text)
	}
	want := []string{
		"WARN Anthropic returned 500 Internal Server Error to ada.",
		"WARN Anthropic returned 500 Internal Server Error to bob.",
		"WARN Anthropic returned 529 Overloaded to ada.",
		"WARN Anthropic returned 502 Bad Gateway to ada.",
	}
	if !slices.Equal(texts, want) {
		t.Fatalf("log = %q, want %q: each account's failures once per 10 minutes, and no cancelled request", texts, want)
	}
}

func TestAConnectionThatFailsLogsItsCauseOnceForEveryAccount(t *testing.T) {
	now, setNow := testClock()
	p := newClockedPlugin(t, enabled, now)
	fail := func(id, account string, status int, body string) {
		call[struct{}](t, p, MethodUsageHandle, UsageRecord{RequestID: id, Provider: "claude", Model: "claude-opus-5-5", AuthID: account, Failed: true, Failure: UsageFailure{StatusCode: status, Body: body}})
	}
	dns := `Post "https://api.anthropic.com/v1/messages?beta=true": claude tls: dial upstream: dial tcp: lookup api.anthropic.com on 127.0.0.53:53: read udp 127.0.0.1:50528->127.0.0.53:53: i/o timeout`
	for _, account := range []string{"claude-ada@x.json", "claude-bob@x.json", "claude-cy@x.json"} {
		fail("dns-"+account, account, 0, dns)
	}
	fail("ada-500", "claude-ada@x.json", http.StatusInternalServerError, "")
	setNow(testNow.Add(episode))
	fail("refused", "claude-bob@x.json", 0, `Post "https://api.anthropic.com/v1/messages?beta=true": claude tls: dial upstream: dial tcp 160.79.104.10:443: connect: connection refused`)
	var texts []string
	for _, e := range p.Status().Log {
		texts = append(texts, e.Level+" "+e.Text)
	}
	want := []string{
		"WARN oneclaude couldn't reach Anthropic: the DNS lookup of api.anthropic.com timed out.",
		"WARN Anthropic returned 500 Internal Server Error to ada.",
		"WARN oneclaude couldn't reach Anthropic: the connection was refused.",
	}
	if !slices.Equal(texts, want) {
		t.Fatalf("log = %q, want %q: one line per burst of failed connections, with its cause", texts, want)
	}
}

func TestEachFailedConnectionReadsAsItsCause(t *testing.T) {
	for err, want := range map[string]string{
		`Post "https://api.anthropic.com/v1/messages?beta=true": claude tls: dial upstream: dial tcp: lookup api.anthropic.com on 127.0.0.53:53: read udp 127.0.0.1:50528->127.0.0.53:53: i/o timeout`: "the DNS lookup of api.anthropic.com timed out",
		`Post "https://api.anthropic.com/v1/messages?beta=true": dial tcp: lookup api.anthropic.com: no such host`:                                                                                     "the DNS lookup of api.anthropic.com failed",
		`Post "https://api.anthropic.com/v1/messages?beta=true": claude tls: dial upstream: dial tcp 160.79.104.10:443: connect: connection refused`:                                                   "the connection was refused",
		`Post "https://api.anthropic.com/v1/messages?beta=true": dial tcp 160.79.104.10:443: i/o timeout`:                                                                                              "the connection timed out",
		`Post "https://api.anthropic.com/v1/messages?beta=true": dial tcp 160.79.104.10:443: connect: network is unreachable`:                                                                          "the network is unreachable",
		`Post "https://api.anthropic.com/v1/messages?beta=true": read tcp 198.51.100.8:55242->160.79.104.10:443: read: connection reset by peer`:                                                       "the connection was reset",
		`Post "https://api.anthropic.com/v1/messages?beta=true": write tcp 198.51.100.8:52396->160.79.104.10:443: write: broken pipe`:                                                                  "the connection dropped",
		`Post "https://api.anthropic.com/v1/messages?beta=true": write tcp 198.51.100.8:55250->160.79.104.10:443: use of closed network connection`:                                                    "the connection dropped",
		`Post "https://api.anthropic.com/v1/messages?beta=true": EOF`:                                                                                                                                  "the connection dropped",
		`unexpected EOF`: "the connection dropped",
		`Post "https://api.anthropic.com/v1/messages?beta=true": claude tls: handshake upstream: EOF`:    "the TLS handshake failed",
		`Post "https://api.anthropic.com/v1/messages?beta=true": remote error: tls: bad record MAC`:      "the TLS connection failed (bad record MAC)",
		`Post "https://api.anthropic.com/v1/messages?beta=true": proxyconnect tcp: socks connect failed`: "proxyconnect tcp: socks connect failed",
		`Post "https://api.anthropic.com/v1/messages?beta=true": context deadline exceeded`:              "the request timed out",
		`tls handshake timeout: context deadline exceeded`:                                               "the TLS handshake timed out",
		``: "no answer came",
	} {
		if got := networkCause(err); got != want {
			t.Errorf("networkCause(%q) = %q, want %q", err, got, want)
		}
	}
}

func TestA504TheProxyMadeFromItsOwnDeadlineLogsTheNetworkLine(t *testing.T) {
	p := newTestPlugin(t, enabled)
	call[struct{}](t, p, MethodUsageHandle, UsageRecord{RequestID: "deadline", Provider: "claude", Model: "claude-opus-5-5", AuthID: "claude-ada@x.json", Failed: true, Failure: UsageFailure{StatusCode: http.StatusGatewayTimeout, Body: `Post "https://api.anthropic.com/v1/messages?beta=true": context deadline exceeded`}})
	call[struct{}](t, p, MethodUsageHandle, UsageRecord{RequestID: "deadline-bob", Provider: "claude", Model: "claude-opus-5-5", AuthID: "claude-bob@x.json", Failed: true, Failure: UsageFailure{StatusCode: http.StatusGatewayTimeout, Body: `Post "https://api.anthropic.com/v1/messages?beta=true": context deadline exceeded`}})
	var texts []string
	for _, e := range p.Status().Log {
		texts = append(texts, e.Level+" "+e.Text)
	}
	if want := []string{"WARN oneclaude couldn't reach Anthropic: the request timed out."}; !slices.Equal(texts, want) {
		t.Fatalf("log = %q, want %q: the proxy's own deadline is no answer from Anthropic", texts, want)
	}
}

func TestA504FromAnthropicKeepsItsLine(t *testing.T) {
	p := newTestPlugin(t, enabled)
	call[struct{}](t, p, MethodUsageHandle, UsageRecord{RequestID: "gateway", Provider: "claude", Model: "claude-opus-5-5", AuthID: "claude-ada@x.json", Failed: true, Failure: UsageFailure{StatusCode: http.StatusGatewayTimeout, Body: `{"type":"error","error":{"type":"timeout_error","message":"Request timed out"}}`}})
	var texts []string
	for _, e := range p.Status().Log {
		texts = append(texts, e.Level+" "+e.Text)
	}
	if want := []string{"WARN Anthropic returned 504 Gateway Timeout to ada."}; !slices.Equal(texts, want) {
		t.Fatalf("log = %q, want %q", texts, want)
	}
}

func TestA504WithAnHTMLBodyFromACDNKeepsItsLine(t *testing.T) {
	p := newTestPlugin(t, enabled)
	call[struct{}](t, p, MethodUsageHandle, UsageRecord{RequestID: "cdn", Provider: "claude", Model: "claude-opus-5-5", AuthID: "claude-ada@x.json", Failed: true, Failure: UsageFailure{StatusCode: http.StatusGatewayTimeout, Body: `<html><head><title>504 Gateway Time-out</title></head><body><center><h1>504 Gateway Time-out</h1></center></body></html>`}})
	var texts []string
	for _, e := range p.Status().Log {
		texts = append(texts, e.Level+" "+e.Text)
	}
	if want := []string{"WARN Anthropic returned 504 Gateway Timeout to ada."}; !slices.Equal(texts, want) {
		t.Fatalf("log = %q, want %q: a CDN's page is an answer, so only the proxy's own deadline is no answer", texts, want)
	}
}

func TestABlockOnAnAccountThatJustAnsweredIsCleared(t *testing.T) {
	var (
		mu    sync.Mutex
		reset []string
	)
	host := func(method string, payload []byte) ([]byte, error) {
		if method == MethodHostRoutingResetCooldown {
			var req HostRoutingResetCooldownRequest
			_ = json.Unmarshal(payload, &req)
			mu.Lock()
			reset = append(reset, req.AuthIndex)
			mu.Unlock()
		}
		return okEnvelope(emptyResult)
	}
	p := New(Options{Name: "oneclaude", NoPoller: true, Host: host, Now: func() time.Time { return testNow }})
	cfg, _ := json.Marshal(LifecycleRequest{ConfigYAML: []byte("enabled: true\ndata-dir: " + t.TempDir())})
	p.Call(MethodPluginRegister, cfg)
	defer p.Shutdown()
	notFound := UsageFailure{StatusCode: http.StatusNotFound, Body: `{"type":"error","error":{"type":"not_found_error","message":"No thread state was found"}}`}
	for _, account := range []string{"claude-ada@x.json", "claude-bob@x.json"} {
		call[struct{}](t, p, MethodUsageHandle, UsageRecord{RequestID: "ok-" + account, Provider: "claude", Model: "claude-opus-5-5", AuthID: account})
		call[struct{}](t, p, MethodUsageHandle, UsageRecord{RequestID: "404-" + account, Provider: "claude", Model: "claude-opus-5-5", AuthID: account, AuthIndex: "index-" + account, Failed: true, Failure: notFound})
	}
	call[struct{}](t, p, MethodUsageHandle, UsageRecord{RequestID: "404-again", Provider: "claude", Model: "claude-opus-5-5", AuthID: "claude-ada@x.json", AuthIndex: "index-claude-ada@x.json", Failed: true, Failure: notFound})
	call[struct{}](t, p, MethodUsageHandle, UsageRecord{RequestID: "404-new", Provider: "claude", Model: "claude-opus-5-5", AuthID: "claude-cy@x.json", AuthIndex: "index-cy", Failed: true, Failure: notFound})
	spent := weekly(1, time.Hour)
	spent.Set("anthropic-ratelimit-unified-status", "rejected")
	call[struct{}](t, p, MethodUsageHandle, UsageRecord{RequestID: "ok-dan", Provider: "claude", Model: "claude-opus-5-5", AuthID: "claude-dan@x.json"})
	call[struct{}](t, p, MethodUsageHandle, UsageRecord{RequestID: "spent-dan", Provider: "claude", Model: "claude-opus-5-5", AuthID: "claude-dan@x.json", Failed: true, Failure: UsageFailure{StatusCode: http.StatusTooManyRequests}, ResponseHeaders: spent})
	call[struct{}](t, p, MethodUsageHandle, UsageRecord{RequestID: "404-dan", Provider: "claude", Model: "claude-opus-5-5", AuthID: "claude-dan@x.json", AuthIndex: "index-dan", Failed: true, Failure: notFound})
	p.host.drain(time.Second)
	sort.Strings(reset)
	if !slices.Equal(reset, []string{"index-claude-ada@x.json", "index-claude-ada@x.json", "index-claude-bob@x.json"}) {
		t.Fatalf("reset = %v, want ada at each 404 and bob, which answered Opus 5.5 before, and not cy, or dan, whose week is spent", reset)
	}
	var texts []string
	for _, e := range p.Status().Log {
		texts = append(texts, e.Level+" "+e.Text)
	}
	sort.Strings(texts)
	want := []string{
		"INFO oneclaude cleared the proxy's blocks on ada, set after a 404 for Opus 5.5.",
		"INFO oneclaude cleared the proxy's blocks on bob, set after a 404 for Opus 5.5.",
		"WARN Anthropic returned 404 Not Found for Opus 5.5 on ada.",
		"WARN Anthropic returned 404 Not Found for Opus 5.5 on bob.",
		"WARN Anthropic returned 404 Not Found for Opus 5.5 on cy.",
		"WARN Anthropic returned 404 Not Found for Opus 5.5 on dan.",
	}
	if !slices.Equal(texts, want) {
		t.Fatalf("log = %q, want %q", texts, want)
	}
}

func TestUsageImportsTheRequestsFromBeforeTheLogOnceUnderNoAccountRecorded(t *testing.T) {
	root := claudeProjects(t)
	folder := filepath.Join(root, "-Users-turing-dotfiles")
	before := model.Tokens{Input: 10, Output: 1_000_000}
	tenDaysAgo := testNow.AddDate(0, 0, -10)
	reply := func(at time.Time, message string, output int64) string {
		return fmt.Sprintf(`{"type":"assistant","message":{"model":"claude-opus-5-5","id":"%s","usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":%d}},"timestamp":"%s"}`+"\n", message, output, at.UTC().Format(time.RFC3339Nano))
	}
	appendTo(t, filepath.Join(folder, "s1.jsonl"), reply(tenDaysAgo, "msg_old", 1)+reply(tenDaysAgo, "msg_old", before.Output)+reply(testNow.Add(-time.Minute), "msg_logged", 5))
	appendTo(t, filepath.Join(folder, "s1", "subagents", "agent-a7.jsonl"), reply(tenDaysAgo.Add(time.Hour), "msg_review", before.Output))

	dir := logOneRequest(t)
	load := func() *Plugin { return loadWithTranscripts(t, root, dir) }
	p := load()
	agents := usageOf(t, p, "month", "agent")
	accounts := usageOf(t, p, "month", "account")
	p.Shutdown()
	if len(agents.Rows) != 2 || agents.Total.Tokens.Output != 2*before.Output+5 {
		t.Fatalf("by agent = %+v, want the old main request and its code-reviewer, once each, beside the logged one", agents)
	}
	if labels := []string{agents.Rows[0].Label, agents.Rows[1].Label}; !(labels[0] == "Main sessions" && labels[1] == "code-reviewer" || labels[1] == "Main sessions" && labels[0] == "code-reviewer") {
		t.Fatalf("by agent = %+v", agents.Rows)
	}
	unknown := slices.IndexFunc(accounts.Rows, func(row UsageRow) bool { return row.Label == "No account recorded" })
	if accounts.Total.Tokens != agents.Total.Tokens || unknown < 0 || accounts.Rows[unknown].Tokens.Output != 2*before.Output {
		t.Fatalf("by account = %+v, want every request, the imported ones under No account recorded", accounts)
	}

	again := load()
	defer again.Shutdown()
	if after := usageOf(t, again, "month", "agent"); after.Total.Tokens != agents.Total.Tokens {
		t.Fatalf("a second load = %+v, want the import once", after.Total)
	}
}

func TestTheImportCountsAResponseClaudeCodeWroteAsOneLinePerContentBlockOnce(t *testing.T) {
	root := claudeProjects(t)
	at := testNow.AddDate(0, 0, -10)
	block := func(index int, output int64) string {
		return fmt.Sprintf(`{"type":"assistant","message":{"model":"claude-sonnet-5-5","id":"msg_011CgDDCyjiM6tftGKPphP6j","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_%d","name":"Read","input":{}}],"usage":{"input_tokens":3,"cache_creation_input_tokens":1200,"cache_read_input_tokens":26835,"output_tokens":%d}},"apiBlockIndex":%d,"requestRef":"8fdbd989-db6f-488e-bb76-b46cad3f7979","timestamp":"%s"}`+"\n",
			index, output, index, at.Add(time.Duration(index)*300*time.Millisecond).Format(time.RFC3339Nano))
	}
	appendTo(t, filepath.Join(root, "-Users-turing-dotfiles", "s1.jsonl"), block(0, 4)+block(1, 4)+block(2, 280))
	dir := logOneRequest(t)

	p := loadWithTranscripts(t, root, dir)
	usageOf(t, p, "month", "model")
	p.Shutdown()
	var imported []requestLine
	for _, line := range linesIn(t, filepath.Join(dir, "requests.jsonl")) {
		if line.Account == "" {
			imported = append(imported, line)
		}
	}
	if want := (model.Tokens{Input: 3, Output: 280, CacheRead: 26835, CacheWrite: 1200}); len(imported) != 1 || imported[0].Tokens != want {
		t.Fatalf("imported = %+v, want the one response with its final tokens %+v", imported, want)
	}
}

func TestTheImportLeavesOutRequestsToModelsThatAreNotClaude(t *testing.T) {
	root := claudeProjects(t)
	at := testNow.AddDate(0, 0, -10).Format(time.RFC3339Nano)
	appendTo(t, filepath.Join(root, "-Users-turing-dotfiles", "s1.jsonl"),
		`{"type":"assistant","message":{"id":"resp_0bce8705e77acffe","type":"message","role":"assistant","model":"gpt-6-astra","usage":{"input_tokens":24405,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":49}},"timestamp":"`+at+`"}`+"\n"+
			`{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_claude","usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":7}},"timestamp":"`+at+`"}`+"\n")
	p := loadWithTranscripts(t, root, logOneRequest(t))
	defer p.Shutdown()
	if models := usageOf(t, p, "month", "model"); len(models.Rows) != 1 || models.Rows[0].Label != "Opus 5.5" || models.Total.Tokens.Input != 10 {
		t.Fatalf("by model = %+v, want only the Claude request beside the logged one", models)
	}
}

func TestALoadRepairsTheLinesAnEarlierImportCountedOncePerContentBlockOnce(t *testing.T) {
	at := testNow.AddDate(0, 0, -10)
	imported := func(after time.Duration, modelID, project string, tokens model.Tokens) requestLine {
		return requestLine{At: at.Add(after), Model: modelID, Family: model.FamilyOf(modelID), Project: project, Outcome: "ok", Tokens: tokens}
	}
	block := model.Tokens{Input: 3, Output: 4, CacheRead: 26835, CacheWrite: 1200}
	final := block
	final.Output = 280
	next := model.Tokens{Input: 1, Output: 90, CacheRead: 28035, CacheWrite: 400}
	dir := t.TempDir()
	written := []requestLine{
		imported(0, "claude-sonnet-5-5", "cmod", block),
		imported(300*time.Millisecond, "claude-sonnet-5-5", "cmod", block),
		imported(400*time.Millisecond, "gpt-6-astra", "cmod", model.Tokens{Input: 24405, Output: 49}),
		imported(600*time.Millisecond, "claude-sonnet-5-5", "cmod", final),
		imported(10*time.Second, "claude-sonnet-5-5", "cmod", next),
		imported(20*time.Second, "claude-sonnet-5-5", "dotfiles", next),
		{At: testNow.Add(-time.Minute), Model: "claude-opus-5-5", Family: "opus", Account: "0000beef", Outcome: "ok", Tokens: model.Tokens{Output: 5}},
	}
	writeLog := func() {
		var log bytes.Buffer
		for _, line := range written {
			raw, _ := json.Marshal(line)
			log.Write(append(raw, '\n'))
		}
		if err := os.WriteFile(filepath.Join(dir, "requests.jsonl"), log.Bytes(), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeLog()
	if err := os.WriteFile(filepath.Join(dir, "usage.json"), []byte(`{"imported":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	load := func() []requestLine {
		p := loadWithTranscripts(t, "", dir)
		usageOf(t, p, "month", "model")
		p.Shutdown()
		return linesIn(t, filepath.Join(dir, "requests.jsonl"))
	}

	repaired := load()
	want := []model.Tokens{final, next, next, {Output: 5}}
	var got []model.Tokens
	for _, line := range repaired {
		got = append(got, line.Tokens)
	}
	if !slices.Equal(got, want) || repaired[1].Project != "cmod" || repaired[2].Project != "dotfiles" {
		t.Fatalf("log = %+v, want the response's last line, the next request, the same tokens in another project, and the logged line", repaired)
	}
	var saved savedUsage
	if err := usage.ReadJSON(filepath.Join(dir, "usage.json"), &saved); err != nil || !saved.Repaired {
		t.Fatalf("usage.json = %+v, %v, want repaired", saved, err)
	}

	writeLog()
	if again := load(); len(again) != len(written) {
		t.Fatalf("a second load = %d lines, want the %d written after the repair, as the repair runs once", len(again), len(written))
	}
}

// logOneRequest is a data folder whose request log holds one request, a
// minute ago, so the import reads the transcripts from before it.
func logOneRequest(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	logged, _ := json.Marshal(requestLine{At: testNow.Add(-time.Minute), Model: "claude-opus-5-5", Family: "opus", Account: "0000beef", Outcome: "ok", Tokens: model.Tokens{Output: 5}})
	if err := os.WriteFile(filepath.Join(dir, "requests.jsonl"), append(logged, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func loadWithTranscripts(t *testing.T, root, dir string) *Plugin {
	t.Helper()
	p := New(Options{Name: "oneclaude", NoPoller: true, ClaudeProjects: root, Now: func() time.Time { return testNow }})
	cfg, _ := json.Marshal(LifecycleRequest{ConfigYAML: []byte("enabled: true\ndata-dir: " + dir)})
	p.Call(MethodPluginRegister, cfg)
	call[ManagementRegistrationResponse](t, p, MethodManagementRegister, ManagementRegistrationRequest{BasePath: "/v0/management", ResourceBasePath: "/v0/resource/plugins/oneclaude"})
	return p
}

func appendTo(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(text); err != nil {
		t.Fatal(err)
	}
}

func linesIn(t *testing.T, path string) []requestLine {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var lines []requestLine
	for _, text := range bytes.Split(bytes.TrimSpace(raw), []byte("\n")) {
		var line requestLine
		if err := json.Unmarshal(text, &line); err != nil {
			t.Fatal(err)
		}
		lines = append(lines, line)
	}
	return lines
}

func TestTimeStepsByTheHourOverADayAndByTheWeekOver90Days(t *testing.T) {
	dir := t.TempDir()
	var log bytes.Buffer
	for _, at := range []time.Time{testNow.Add(-3 * time.Hour), testNow.Add(-time.Hour), testNow.AddDate(0, 0, -40)} {
		line, _ := json.Marshal(requestLine{At: at, Model: "claude-opus-5-5", Family: "opus", Account: "0000beef", Outcome: "ok", Tokens: model.Tokens{Output: 1000}})
		log.Write(append(line, '\n'))
	}
	if err := os.WriteFile(filepath.Join(dir, "requests.jsonl"), log.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	p := New(Options{Name: "oneclaude", NoPoller: true, Now: func() time.Time { return testNow }})
	cfg, _ := json.Marshal(LifecycleRequest{ConfigYAML: []byte("enabled: true\ndata-dir: " + dir)})
	p.Call(MethodPluginRegister, cfg)
	defer p.Shutdown()
	call[ManagementRegistrationResponse](t, p, MethodManagementRegister, ManagementRegistrationRequest{BasePath: "/v0/management", ResourceBasePath: "/v0/resource/plugins/oneclaude"})
	hours := usageOf(t, p, "today", "time")
	if len(hours.Rows) != 2 || hours.Rows[0].Label != testNow.Add(-time.Hour).In(time.Local).Format("15")+":00" || hours.Total.Label != "All hours" {
		t.Fatalf("today by time = %+v, want two hours, newest first", hours)
	}
	weeks := usageOf(t, p, "quarter", "time")
	if len(weeks.Rows) != 2 || !strings.HasPrefix(weeks.Rows[1].Label, "Week of ") || weeks.Total.Label != "All weeks" {
		t.Fatalf("90 days by time = %+v, want two weeks", weeks)
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
	if strings.Contains(string(resp.Body), "example.com") {
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
	if strings.Contains(body, "example.com") {
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
		filepath.Join(folder, "s1.jsonl"):                              `{"type":"user","cwd":"/Users/turing/dotfiles"}`,
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
	p := New(Options{Name: "oneclaude", NoPoller: true, Now: func() time.Time { return testNow }})
	cfg, _ := json.Marshal(LifecycleRequest{ConfigYAML: []byte("enabled: true\ndata-dir: " + t.TempDir())})
	p.Call(MethodPluginRegister, cfg)
	defer p.Shutdown()
	sendRecord(t, p, sessionRecord{Session: "s1", Project: "/Users/turing/dotfiles", Agents: map[string]string{"a7": "code-reviewer"}})
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
		t.Fatalf("by project = %+v, want dotfiles, then the session no mod sent a record for", projects.Rows)
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
	table := usageOf(t, p, "quarter", "model")
	twentyDaysAgo := testNow.AddDate(0, 0, -20).In(time.Local).Format("2006-01-02")
	if len(table.Rows) != 1 || table.Rows[0].Label != "Opus 5.5" || math.Abs(costOf(table.Rows[0])-20) > 1e-9 {
		t.Fatalf("rows = %+v, want Opus 5.5 output at $20: the line 100 days old is past the 90 days kept", table.Rows)
	}
	byDay := usageOf(t, p, "month", "time")
	if len(byDay.Rows) != 1 || byDay.Rows[0].Label != testNow.AddDate(0, 0, -20).In(time.Local).Format("Jan 2") || byDay.Rows[0].Key != twentyDaysAgo || byDay.Total.Label != "All days" {
		t.Fatalf("by day = %+v", byDay)
	}
	if agents := usageOf(t, p, "month", "agent"); agents.Rows[0].Label != "Main sessions" {
		t.Fatalf("an old main-session line = %+v", agents.Rows)
	}
}

func TestALoadFillsInTheAgentAndProjectOfLinesLoggedBeforeOneclaudeRecordedThem(t *testing.T) {
	root := claudeProjects(t)
	folder := filepath.Join(root, "-Users-turing-dotfiles")
	main := model.Tokens{Input: 2, Output: 5411, CacheRead: 66598, CacheWrite: 19897}
	review := model.Tokens{Input: 3, Output: 10, CacheRead: 100}
	unrecorded := model.Tokens{Input: 4301, Output: 71, CacheRead: 190961}
	assistant := func(at time.Time, message string, tokens model.Tokens) string {
		return fmt.Sprintf(`{"type":"assistant","message":{"model":"claude-sonnet-5-5-20261001","id":"%s","usage":{"input_tokens":%d,"cache_creation_input_tokens":%d,"cache_read_input_tokens":%d,"output_tokens":%d}},"timestamp":"%s"}`+"\n",
			message, tokens.Input, tokens.CacheWrite, tokens.CacheRead, tokens.Output, at.UTC().Format(time.RFC3339Nano))
	}
	at := testNow.Add(-2 * time.Hour)
	appendTo(t, filepath.Join(folder, "s1.jsonl"), assistant(at.Add(-2*time.Second), "msg_main", main)+assistant(at.Add(-time.Second), "msg_main", main))
	appendTo(t, filepath.Join(folder, "s1", "subagents", "agent-a7.jsonl"), assistant(at.Add(time.Minute), "msg_review", review))

	dir := t.TempDir()
	var log bytes.Buffer
	for _, line := range []requestLine{
		{At: at, Family: "opus", Account: "0000beef", Subagent: false, Outcome: "ok", Tokens: main},
		{At: at.Add(time.Minute), Family: "opus", Account: "0000beef", Subagent: false, Outcome: "ok", Tokens: review},
		{At: at.Add(2 * time.Minute), Family: "opus", Account: "0000beef", Subagent: true, Outcome: "ok", Tokens: unrecorded},
		{At: at.Add(3 * time.Minute), Model: "claude-opus-5-5", Family: "opus", Account: "0000beef", Agent: "Explore", Subagent: true, Project: "cmod", Outcome: "ok", Tokens: unrecorded},
	} {
		raw, _ := json.Marshal(line)
		log.Write(append(raw, '\n'))
	}
	if err := os.WriteFile(filepath.Join(dir, "requests.jsonl"), log.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	load := func() *Plugin { return loadWithTranscripts(t, root, dir) }
	p := load()
	agents := usageOf(t, p, "today", "agent")
	p.Shutdown()
	labels := map[string]string{}
	for _, row := range agents.Rows {
		labels[row.Label] = row.Key
	}
	if len(agents.Rows) != 4 || labels["Main sessions"] != "main" || labels["code-reviewer"] != "code-reviewer" || labels["Explore"] != "Explore" || labels["Not recorded"] != "" {
		t.Fatalf("by agent = %+v, want the old main and code-reviewer lines filled in, and the line no transcript records still Not recorded", agents.Rows)
	}

	filled := linesIn(t, filepath.Join(dir, "requests.jsonl"))
	if len(filled) != 4 {
		t.Fatalf("log holds %d lines, want 4", len(filled))
	}
	if l := filled[0]; l.Model != "claude-sonnet-5-5" || l.Subagent || l.Project != "dotfiles" {
		t.Fatalf("main line = %+v", l)
	}
	if l := filled[1]; l.Model != "claude-sonnet-5-5" || !l.Subagent || l.Agent != "code-reviewer" || l.Project != "dotfiles" {
		t.Fatalf("subagent line = %+v, want the code-reviewer the old log called a main session", l)
	}
	if l := filled[2]; l.Model != "claude-opus-5-5" || l.Agent != "" || l.Project != "" {
		t.Fatalf("unrecorded line = %+v, want its family's newest model so no load looks again", l)
	}
	if l := filled[3]; l.Agent != "Explore" || l.Project != "cmod" {
		t.Fatalf("a recorded line = %+v, want it untouched", l)
	}

	again := load()
	defer again.Shutdown()
	if after := usageOf(t, again, "today", "agent"); len(after.Rows) != 4 {
		t.Fatalf("a second load = %+v", after.Rows)
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

func TestASignedOutAccountShowsUntilItAnswersAgainAndLogsOnce(t *testing.T) {
	host := func(method string, payload []byte) ([]byte, error) {
		switch method {
		case MethodHostAuthList:
			return okEnvelope(HostAuthListResponse{Files: []HostAuthFileEntry{{ID: "claude-ada@x.json", AuthIndex: "a1", Type: "claude", Email: "ada@x"}}})
		case MethodHostAuthGet:
			return okEnvelope(HostAuthGetResponse{AuthIndex: "a1", JSON: json.RawMessage(`{"access_token":"expired"}`)})
		case MethodHostHTTPDo:
			return okEnvelope(HostHTTPResponse{StatusCode: http.StatusUnauthorized})
		}
		return okEnvelope(emptyResult)
	}
	p := New(Options{Name: "oneclaude", NoPoller: true, Host: host, Now: func() time.Time { return testNow }})
	cfg, _ := json.Marshal(LifecycleRequest{ConfigYAML: []byte("enabled: true\ndata-dir: " + t.TempDir())})
	p.Call(MethodPluginRegister, cfg)
	defer p.Shutdown()
	if err := p.list(); err != nil {
		t.Fatal(err)
	}
	p.refreshOne(testNow)
	p.failedAt = map[string]time.Time{}
	p.refreshOne(testNow)
	st := p.Status()
	if !st.Accounts[0].SignedOut || len(st.Log) != 1 || st.Log[0].Text != "Anthropic rejected ada's login (401)." {
		t.Fatalf("account = %+v, log = %+v, want ada signed out and logged once", st.Accounts[0], st.Log)
	}
	call[struct{}](t, p, MethodUsageHandle, UsageRecord{RequestID: "back", Provider: "claude", Model: "claude-opus-5-5", AuthID: "claude-ada@x.json"})
	if p.Status().Accounts[0].SignedOut {
		t.Fatal("ada answered, want signed in")
	}
}

func TestUnblockClearsTheAccountsBlocksAndLogsIt(t *testing.T) {
	var reset []string
	host := func(method string, payload []byte) ([]byte, error) {
		switch method {
		case MethodHostAuthList:
			return okEnvelope(HostAuthListResponse{Files: []HostAuthFileEntry{{ID: "claude-ada@x.json", AuthIndex: "a1", Type: "claude", Email: "ada@x"}}})
		case MethodHostRoutingResetCooldown:
			var req HostRoutingResetCooldownRequest
			_ = json.Unmarshal(payload, &req)
			reset = append(reset, req.AuthIndex)
		}
		return okEnvelope(emptyResult)
	}
	p := New(Options{Name: "oneclaude", NoPoller: true, Host: host, Now: func() time.Time { return testNow }})
	cfg, _ := json.Marshal(LifecycleRequest{ConfigYAML: []byte("enabled: true\ndata-dir: " + t.TempDir())})
	p.Call(MethodPluginRegister, cfg)
	defer p.Shutdown()
	if err := p.list(); err != nil {
		t.Fatal(err)
	}
	call[ManagementRegistrationResponse](t, p, MethodManagementRegister, ManagementRegistrationRequest{BasePath: "/v0/management", ResourceBasePath: "/v0/resource/plugins/oneclaude"})
	unblock := func(body string) int {
		return call[ManagementResponse](t, p, MethodManagementHandle, ManagementRequest{Method: "POST", Path: "/v0/management/plugins/oneclaude/unblock", Body: []byte(body)}).StatusCode
	}
	if got := unblock(`{"auth_index":"nobody"}`); got != http.StatusNotFound {
		t.Fatalf("an unknown account = %d, want 404", got)
	}
	if got := unblock(`{"auth_index":"a1"}`); got != http.StatusOK || !slices.Equal(reset, []string{"a1"}) {
		t.Fatalf("unblock = %d, reset = %v, want ada's blocks cleared", got, reset)
	}
	if log := p.Status().Log; len(log) != 1 || log[0].Text != "oneclaude cleared the proxy's blocks on ada on request." {
		t.Fatalf("log = %+v", log)
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
	p.refreshOne(testNow)
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

// statusAfter asks for status.json after a change, as the mod does, and
// sends the status once the plugin answers.
func statusAfter(t *testing.T, p *Plugin, change uint64) <-chan Status {
	t.Helper()
	call[ManagementRegistrationResponse](t, p, MethodManagementRegister, ManagementRegistrationRequest{BasePath: "/v0/management", ResourceBasePath: "/v0/resource/plugins/oneclaude"})
	answered := make(chan Status, 1)
	go func() {
		payload, _ := json.Marshal(ManagementRequest{Method: "GET", Path: "/v0/resource/plugins/oneclaude/status.json", Query: url.Values{"after": {fmt.Sprint(change)}}})
		raw, _ := p.Call(MethodManagementHandle, payload)
		var resp ManagementResponse
		var st Status
		if unwrapEnvelope(raw, &resp) != nil || resp.StatusCode != http.StatusOK || json.Unmarshal(resp.Body, &st) != nil {
			t.Errorf("status.json?after=%d answered %d %s", change, resp.StatusCode, resp.Body)
		}
		answered <- st
	}()
	return answered
}

func TestTheLongPollAnswersAtTheNextChange(t *testing.T) {
	p := newTestPlugin(t, enabled)
	before := p.Status()
	answered := statusAfter(t, p, before.Change)
	select {
	case st := <-answered:
		t.Fatalf("status answered with no change: %+v", st)
	case <-time.After(200 * time.Millisecond):
	}
	send(t, p, "r1", "s1", "", "claude-opus-5-5", []string{"a@x.json"}, weekly(0.5, 48*time.Hour), http.StatusOK)
	select {
	case st := <-answered:
		if st.Change <= before.Change || st.Pool.Agents != 1 {
			t.Fatalf("got change %d with %d agents, want a change after %d with the new agent", st.Change, st.Pool.Agents, before.Change)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("status did not answer the change")
	}
}

func TestTheLongPollAnswersAtItsDeclaredWait(t *testing.T) {
	p := newTestPlugin(t, enabled)
	p.changes.longest = 100 * time.Millisecond
	before := p.Status()
	if before.AnswersWithinMS != (100*time.Millisecond + answerTrip).Milliseconds() {
		t.Fatalf("answers_within_ms = %d, want the longest wait and the trip back", before.AnswersWithinMS)
	}
	asked := time.Now()
	select {
	case st := <-statusAfter(t, p, before.Change):
		if waited := time.Since(asked); waited < 100*time.Millisecond || st.Change != before.Change {
			t.Fatalf("answered after %v with change %d, want the same change after the longest wait", waited, st.Change)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("status waited past its longest wait")
	}
}

func TestQuiesceAnswersEveryWaitingAsk(t *testing.T) {
	p := newTestPlugin(t, enabled)
	change := p.Status().Change
	first, second := statusAfter(t, p, change), statusAfter(t, p, change)
	time.Sleep(50 * time.Millisecond)
	call[struct{}](t, p, MethodPluginQuiesce, struct{}{})
	for _, answered := range []<-chan Status{first, second, statusAfter(t, p, change)} {
		select {
		case st := <-answered:
			if st.Change != 0 {
				t.Fatalf("a quiesced plugin answered with change %d, so its readers would ask it again at once", st.Change)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("a waiting ask outlived the plugin's quiesce")
		}
	}
	call[RegisterResult](t, p, MethodPluginRegister, LifecycleRequest{ConfigYAML: []byte("enabled: true\ndata-dir: " + t.TempDir())})
	select {
	case st := <-statusAfter(t, p, p.Status().Change):
		t.Fatalf("a plugin registered again after its quiesce answered at once, with change %d", st.Change)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestARequestThatChangesNothingTheStatusShowsCountsNoChange(t *testing.T) {
	var ticks atomic.Int64
	p := New(Options{Name: "oneclaude", NoPoller: true, Now: func() time.Time { return testNow.Add(time.Duration(ticks.Add(1)) * time.Millisecond) }})
	cfg, _ := json.Marshal(LifecycleRequest{ConfigYAML: []byte("enabled: true\ndata-dir: " + t.TempDir())})
	p.Call(MethodPluginRegister, cfg)
	defer p.Shutdown()
	loaded := p.Status().Change
	p.changed(false)
	if got := p.Status().Change; got != loaded {
		t.Fatalf("a poll that found the status as it was at the load counted a change: %d after %d", got, loaded)
	}
	send(t, p, "r1", "s1", "", "claude-opus-5-5", []string{"a@x.json"}, weekly(0.5, 48*time.Hour), http.StatusOK)
	before := p.Status().Change
	send(t, p, "r2", "s1", "", "claude-opus-5-5", []string{"a@x.json"}, weekly(0.5, 48*time.Hour), http.StatusOK)
	if got := p.Status().Change; got != before {
		t.Fatalf("a request that changed only when the account was read counted a change: %d after %d", got, before)
	}
	send(t, p, "r3", "s1", "", "claude-opus-5-5", []string{"a@x.json"}, weekly(0.51, 48*time.Hour), http.StatusOK)
	if got := p.Status().Change; got <= before {
		t.Fatalf("a request that moved the account's usage counted no change: %d after %d", got, before)
	}
}

func TestOneAnswerPerMachineReadsEachBlocksChange(t *testing.T) {
	p := newTestPlugin(t, enabled)
	call[ManagementRegistrationResponse](t, p, MethodManagementRegister, ManagementRegistrationRequest{BasePath: "/v0/management", ResourceBasePath: "/v0/resource/plugins/oneclaude"})
	reads := func(device string) bool {
		query := url.Values{}
		if device != "" {
			query.Set("device", device)
		}
		resp := call[ManagementResponse](t, p, MethodManagementHandle, ManagementRequest{Method: "GET", Path: "/v0/resource/plugins/oneclaude/status.json", Query: query})
		var st Status
		if err := json.Unmarshal(resp.Body, &st); err != nil {
			t.Fatal(err)
		}
		return st.ReadsBlocks
	}
	if got := []bool{reads("mac"), reads("mac"), reads("homeserver"), reads(""), reads("")}; !slices.Equal(got, []bool{true, false, true, true, true}) {
		t.Fatalf("reads_blocks = %v, want the first answer of each machine, and every answer that names none", got)
	}
	send(t, p, "r1", "s1", "", "claude-opus-5-5", []string{"a@x.json"}, nil, http.StatusTooManyRequests)
	if got := []bool{reads("mac"), reads("mac")}; !slices.Equal(got, []bool{true, false}) {
		t.Fatalf("reads_blocks after a blocks change = %v, want the first answer again", got)
	}
}

func TestOnlyAFailedRequestTheAnswerAfterOneOrAnUnblockCountsABlocksChange(t *testing.T) {
	host := func(method string, payload []byte) ([]byte, error) {
		if method == MethodHostAuthList {
			return okEnvelope(HostAuthListResponse{Files: []HostAuthFileEntry{{ID: "a@x.json", AuthIndex: "a1", Type: "claude", Email: "ada@x"}}})
		}
		return okEnvelope(emptyResult)
	}
	p := New(Options{Name: "oneclaude", NoPoller: true, Host: host, Now: func() time.Time { return testNow }})
	cfg, _ := json.Marshal(LifecycleRequest{ConfigYAML: []byte("enabled: true\ndata-dir: " + t.TempDir())})
	p.Call(MethodPluginRegister, cfg)
	defer p.Shutdown()
	if err := p.list(); err != nil {
		t.Fatal(err)
	}
	blocksChange := func() uint64 { return p.Status().BlocksChange }
	send(t, p, "r1", "s1", "", "claude-opus-5-5", []string{"a@x.json"}, weekly(0.5, 48*time.Hour), http.StatusOK)
	send(t, p, "r2", "s1", "", "claude-opus-5-5", []string{"a@x.json"}, weekly(0.5, 48*time.Hour), http.StatusOK)
	served := blocksChange()
	send(t, p, "r3", "s1", "", "claude-opus-5-5", []string{"a@x.json"}, weekly(0.5, 48*time.Hour), http.StatusOK)
	send(t, p, "r4", "s1", "", "claude-opus-5-5", []string{"a@x.json"}, nil, statusClientClosed)
	if got := blocksChange(); got != served {
		t.Fatalf("a served or dropped request counted a blocks change: %d after %d", got, served)
	}
	send(t, p, "r5", "s1", "", "claude-opus-5-5", []string{"a@x.json"}, nil, http.StatusTooManyRequests)
	throttled := blocksChange()
	if throttled <= served {
		t.Fatalf("a throttled request counted no blocks change: %d after %d", throttled, served)
	}
	send(t, p, "r6", "s1", "", "claude-opus-5-5", []string{"a@x.json"}, weekly(0.5, 48*time.Hour), http.StatusOK)
	answered := blocksChange()
	if answered <= throttled {
		t.Fatalf("the answer after a throttle counted no blocks change: %d after %d", answered, throttled)
	}
	call[ManagementRegistrationResponse](t, p, MethodManagementRegister, ManagementRegistrationRequest{BasePath: "/v0/management", ResourceBasePath: "/v0/resource/plugins/oneclaude"})
	call[ManagementResponse](t, p, MethodManagementHandle, ManagementRequest{Method: "POST", Path: "/v0/management/plugins/oneclaude/unblock", Body: []byte(`{"auth_index":"a1"}`)})
	if got := blocksChange(); got <= answered {
		t.Fatalf("an unblock counted no blocks change: %d after %d", got, answered)
	}
}

func TestAFailedConnectionAndTheAnswerAfterItCountABlocksChange(t *testing.T) {
	now, setNow := testClock()
	p := newClockedPlugin(t, enabled, now)
	blocksChange := func() uint64 { return p.Status().BlocksChange }
	at := func(seconds int, status int) uint64 {
		setNow(testNow.Add(time.Duration(seconds) * time.Second))
		send(t, p, fmt.Sprintf("r%d", seconds), "s1", "", "claude-opus-5-5", []string{"a@x.json"}, weekly(0.5, 48*time.Hour), status)
		return blocksChange()
	}
	served := at(1, http.StatusOK)
	unreached := at(2, 0)
	if unreached <= served {
		t.Fatalf("a failed connection counted no blocks change: %d after %d", unreached, served)
	}
	answered := at(3, http.StatusOK)
	if answered <= unreached {
		t.Fatalf("the answer after a failed connection counted no blocks change: %d after %d", answered, unreached)
	}
	if got := at(4, http.StatusOK); got != answered {
		t.Fatalf("a second answer counted a blocks change: %d after %d", got, answered)
	}
}

// writeCredential writes a Claude credential file as the proxy's login does.
func writeCredential(t *testing.T, path, token string) {
	t.Helper()
	email := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "claude-"), ".json")
	raw, _ := json.Marshal(map[string]string{"type": "claude", "email": email, "access_token": token})
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

// credentialProxy answers the host calls for the Claude credential files in
// dir as the proxy does, and Anthropic takes only the token "signed-in". It
// counts the usage reads, and keeps the auth index of each credential whose
// blocks the plugin cleared. Like the proxy, which drops a removed file's
// credential only after it checked the file stays gone, it lists every file
// it ever listed.
type credentialProxy struct {
	dir     string
	mu      sync.Mutex
	listed  map[string]bool
	reads   int
	cleared []string
	saved   []string
}

func (c *credentialProxy) call(method string, payload []byte) ([]byte, error) {
	switch method {
	case MethodHostAuthList:
		entries, _ := os.ReadDir(c.dir)
		c.mu.Lock()
		if c.listed == nil {
			c.listed = map[string]bool{}
		}
		for _, entry := range entries {
			c.listed[entry.Name()] = true
		}
		var files []HostAuthFileEntry
		for name := range c.listed {
			files = append(files, HostAuthFileEntry{ID: name, AuthIndex: name, Type: "claude", Email: strings.TrimSuffix(strings.TrimPrefix(name, "claude-"), ".json"), Path: filepath.Join(c.dir, name)})
		}
		c.mu.Unlock()
		return okEnvelope(HostAuthListResponse{Files: files})
	case MethodHostAuthGet:
		var req HostAuthGetRequest
		_ = json.Unmarshal(payload, &req)
		raw, err := os.ReadFile(filepath.Join(c.dir, req.AuthIndex))
		if err != nil {
			return nil, err
		}
		return okEnvelope(HostAuthGetResponse{AuthIndex: req.AuthIndex, JSON: raw})
	case MethodHostAuthSave:
		var req HostAuthSaveRequest
		_ = json.Unmarshal(payload, &req)
		if err := os.WriteFile(filepath.Join(c.dir, req.Name), req.JSON, 0o600); err != nil {
			return nil, err
		}
		c.mu.Lock()
		c.saved = append(c.saved, req.Name)
		c.mu.Unlock()
	case MethodHostRoutingResetCooldown:
		var req HostRoutingResetCooldownRequest
		_ = json.Unmarshal(payload, &req)
		c.mu.Lock()
		c.cleared = append(c.cleared, req.AuthIndex)
		c.mu.Unlock()
	case MethodHostHTTPDo:
		var req HostHTTPRequest
		_ = json.Unmarshal(payload, &req)
		c.mu.Lock()
		c.reads++
		c.mu.Unlock()
		if req.Headers.Get("Authorization") != "Bearer signed-in" {
			return okEnvelope(HostHTTPResponse{StatusCode: http.StatusUnauthorized})
		}
		body := fmt.Sprintf(`{"seven_day":{"utilization":40,"resets_at":%q}}`, testNow.Add(48*time.Hour).Format(time.RFC3339))
		return okEnvelope(HostHTTPResponse{StatusCode: http.StatusOK, Body: []byte(body)})
	}
	return okEnvelope(emptyResult)
}

func (c *credentialProxy) counts() (reads int, cleared []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.reads, slices.Clone(c.cleared)
}

// newCredentialPlugin loads the plugin with dir as its auth-dir, as
// oneclaude install sets it.
func newCredentialPlugin(t *testing.T, dir string) (*Plugin, *credentialProxy) {
	t.Helper()
	proxy := &credentialProxy{dir: dir}
	p := New(Options{Name: "oneclaude", NoPoller: true, Host: proxy.call, Now: func() time.Time { return testNow }})
	cfg, _ := json.Marshal(LifecycleRequest{ConfigYAML: []byte("enabled: true\ndata-dir: " + t.TempDir() + "\nauth-dir: " + dir)})
	p.Call(MethodPluginRegister, cfg)
	t.Cleanup(p.Shutdown)
	if err := p.list(); err != nil {
		t.Fatal(err)
	}
	return p, proxy
}

// statusUntil asks for status.json after each change, as the mod does, until
// the status shows what done looks for or the second is up.
func statusUntil(t *testing.T, p *Plugin, done func(Status) bool) (Status, time.Duration) {
	t.Helper()
	asked := time.Now()
	limit := time.After(time.Second)
	st := p.Status()
	for !done(st) {
		select {
		case st = <-statusAfter(t, p, st.Change):
		case <-limit:
			t.Fatalf("the status did not change within a second: %+v", st)
		}
	}
	return st, time.Since(asked)
}

func TestARewrittenCredentialSignsItsAccountInWithinASecondWithNoPollDue(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "claude-ada@x.json")
	writeCredential(t, path, "expired")
	p, _ := newCredentialPlugin(t, dir)
	p.refreshOne(testNow)
	if st := p.Status(); !st.Accounts[0].SignedOut {
		t.Fatalf("ada = %+v, want signed out after Anthropic rejected her login", st.Accounts[0])
	}
	writeCredential(t, path, "signed-in")
	st, took := statusUntil(t, p, func(st Status) bool { return !st.Accounts[0].SignedOut })
	if !st.Accounts[0].Known || st.Accounts[0].Used != 0.4 {
		t.Fatalf("ada = %+v, want her usage read with the new login", st.Accounts[0])
	}
	if last := st.Log[len(st.Log)-1]; last.Text != "Anthropic accepted ada's login again." {
		t.Fatalf("log = %+v, want the new login logged", st.Log)
	}
	t.Logf("signed in %v after the file was written", took)
}

func TestARemovedCredentialDropsItsAccount(t *testing.T) {
	dir := t.TempDir()
	writeCredential(t, filepath.Join(dir, "claude-ada@x.json"), "signed-in")
	writeCredential(t, filepath.Join(dir, "claude-bob@x.json"), "signed-in")
	p, _ := newCredentialPlugin(t, dir)
	if got := len(p.Status().Accounts); got != 2 {
		t.Fatalf("%d accounts, want ada and bob", got)
	}
	if err := os.Remove(filepath.Join(dir, "claude-ada@x.json")); err != nil {
		t.Fatal(err)
	}
	st, _ := statusUntil(t, p, func(st Status) bool { return len(st.Accounts) == 1 })
	if st.Accounts[0].Name != "bob" {
		t.Fatalf("accounts = %+v, want only bob", st.Accounts)
	}
}

func TestARewrittenLoginClearsItsAccountsBlocksBeforeTheBlocksChange(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "claude-ada@x.json")
	writeCredential(t, path, "expired")
	p, proxy := newCredentialPlugin(t, dir)
	p.refreshOne(testNow)
	before := p.Status()
	answered := statusAfter(t, p, before.Change)
	writeCredential(t, path, "signed-in")
	select {
	case st := <-answered:
		_, cleared := proxy.counts()
		if st.BlocksChange <= before.BlocksChange || !slices.Equal(cleared, []string{"claude-ada@x.json"}) {
			t.Fatalf("blocks change %d after %d with %v cleared, want ada's blocks cleared before the blocks change a session reads", st.BlocksChange, before.BlocksChange, cleared)
		}
	case <-time.After(time.Second):
		t.Fatal("the rewrite woke no waiting status ask within a second")
	}
}

func TestAWriteThatFiresCreateThenWriteGivesOneUsageReadAndOneBlocksChange(t *testing.T) {
	dir := t.TempDir()
	p, proxy := newCredentialPlugin(t, dir)
	before := p.Status()
	file, err := os.Create(filepath.Join(dir, "claude-ada@x.json"))
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if _, err := file.WriteString(`{"type":"claude","email":"ada@x","access_token":"expired"}`); err != nil {
		t.Fatal(err)
	}
	file.Close()
	statusUntil(t, p, func(st Status) bool { return len(st.Accounts) == 1 && st.Accounts[0].SignedOut })
	time.Sleep(300 * time.Millisecond)
	reads, _ := proxy.counts()
	if got := p.Status().BlocksChange - before.BlocksChange; reads != 1 || got != 1 {
		t.Fatalf("%d usage reads and %d blocks changes for one new file, want one of each", reads, got)
	}
}

func TestThePluginWatchesTheCredentialFolderItsSettingNamesFromLoad(t *testing.T) {
	dir := t.TempDir()
	proxy := &credentialProxy{dir: dir}
	p := New(Options{Name: "oneclaude", NoPoller: true, Host: proxy.call, Now: func() time.Time { return testNow }})
	cfg, _ := json.Marshal(LifecycleRequest{ConfigYAML: []byte("enabled: true\ndata-dir: " + t.TempDir() + "\nauth-dir: " + dir)})
	p.Call(MethodPluginRegister, cfg)
	t.Cleanup(p.Shutdown)
	writeCredential(t, filepath.Join(dir, "claude-ada@x.json"), "signed-in")
	st, _ := statusUntil(t, p, func(st Status) bool { return len(st.Accounts) == 1 && st.Accounts[0].Known })
	if st.Accounts[0].Name != "ada" {
		t.Fatalf("accounts = %+v, want ada, the pool's first login, read with no list before it", st.Accounts)
	}
}

func TestARequestAnthropicRejectsSignsItsAccountOutUntilItAnswersAgain(t *testing.T) {
	p := newTestPlugin(t, enabled)
	send(t, p, "r1", "s1", "", "claude-opus-5-5", []string{"ada.json"}, nil, http.StatusUnauthorized)
	send(t, p, "r2", "s1", "", "claude-opus-5-5", []string{"ada.json"}, nil, http.StatusUnauthorized)
	if st := p.Status(); !st.Accounts[0].SignedOut || len(st.Log) != 1 || st.Log[0].Text != "Anthropic rejected ada's login (401)." {
		t.Fatalf("ada = %+v, log = %+v, want her signed out and logged once", st.Accounts[0], st.Log)
	}
	send(t, p, "r3", "s1", "", "claude-opus-5-5", []string{"ada.json"}, weekly(0.5, 24*time.Hour), http.StatusOK)
	if st := p.Status(); st.Accounts[0].SignedOut || len(st.Log) != 2 || st.Log[1].Text != "Anthropic accepted ada's login again." {
		t.Fatalf("ada = %+v, log = %+v, want her signed in and logged", st.Accounts[0], st.Log)
	}
}

func TestAnAccountAnthropicRefusesShowsWhyAndThePickSkipsIt(t *testing.T) {
	p := newTestPlugin(t, enabled)
	send(t, p, "r1", "s1", "", "claude-opus-5-5", []string{"ada.json"}, weekly(0.1, 24*time.Hour), http.StatusOK)
	send(t, p, "r2", "s2", "", "claude-opus-5-5", []string{"bob.json"}, weekly(0.5, 24*time.Hour), http.StatusOK)
	reason := "OAuth authentication is currently not allowed for this organization."
	call[struct{}](t, p, MethodUsageHandle, UsageRecord{RequestID: "attempt-r3", TraceID: "r3", Provider: "claude", Model: "claude-opus-5-5", AuthID: "ada.json", Failed: true, Failure: UsageFailure{StatusCode: http.StatusForbidden, Body: `{"type":"error","error":{"type":"permission_error","message":"` + reason + `"}}`}})
	st := p.Status()
	if st.Accounts[0].Name != "ada" || st.Accounts[0].Refused != reason || st.Accounts[0].SignedOut {
		t.Fatalf("ada = %+v, want refused with Anthropic's reason", st.Accounts[0])
	}
	if last := st.Log[len(st.Log)-1]; last.Level != levelWarn || last.Text != "Anthropic refused ada's login (403): "+reason {
		t.Fatalf("log = %+v, want the refusal logged with its reason", st.Log)
	}
	both := []string{"ada.json", "bob.json"}
	if got, _ := send(t, p, "r4", "s1", "", "claude-opus-5-5", both, weekly(0.5, 24*time.Hour), http.StatusOK); got != "bob.json" {
		t.Fatalf("ada's conversation went to %s, want bob, as Anthropic refuses ada", got)
	}
	if got, _ := send(t, p, "r5", "s3", "", "claude-opus-5-5", both, weekly(0.5, 24*time.Hour), http.StatusOK); got != "bob.json" {
		t.Fatalf("a new conversation went to %s, want bob, as Anthropic refuses ada", got)
	}
}

// claudeCodeLoggedIn gives home a Claude Code logged in to ada's account,
// which keeps its tokens in .credentials.json, and keeps the test off the
// Claude Code login of whoever runs it.
func claudeCodeLoggedIn(t *testing.T, home, access, refresh string, expires time.Time) {
	t.Helper()
	t.Setenv("USER", "oneclaude-test")
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	writeJSON(t, filepath.Join(home, ".claude.json"), map[string]any{"oauthAccount": map[string]string{"emailAddress": "ada@x", "accountUuid": "account-a", "organizationUuid": "organization-a"}})
	writeJSON(t, filepath.Join(home, ".claude", ".credentials.json"), map[string]any{"claudeAiOauth": map[string]any{"accessToken": access, "refreshToken": refresh, "expiresAt": expires.UnixMilli()}})
}

func writeJSON(t *testing.T, path string, content any) {
	t.Helper()
	raw, _ := json.Marshal(content)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func readJSON(t *testing.T, path string) map[string]string {
	t.Helper()
	raw, _ := os.ReadFile(path)
	var file map[string]string
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	return file
}

func expiresAt(file map[string]string, want time.Time) bool {
	expired, err := time.Parse(time.RFC3339, file["expired"])
	return err == nil && expired.Equal(want)
}

// newFollowingPlugin loads the plugin with dir as its auth-dir and home as
// the home whose Claude Code login the copy follows.
func newFollowingPlugin(t *testing.T, dir, home string) (*Plugin, *credentialProxy) {
	t.Helper()
	proxy := &credentialProxy{dir: dir}
	p := New(Options{Name: "oneclaude", NoPoller: true, Host: proxy.call, Now: func() time.Time { return testNow }, Home: home})
	cfg, _ := json.Marshal(LifecycleRequest{ConfigYAML: []byte("enabled: true\ndata-dir: " + t.TempDir() + "\nauth-dir: " + dir)})
	p.Call(MethodPluginRegister, cfg)
	t.Cleanup(p.Shutdown)
	if err := p.list(); err != nil {
		t.Fatal(err)
	}
	return p, proxy
}

func (c *credentialProxy) savedNames() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	names := slices.Clone(c.saved)
	slices.Sort(names)
	return names
}

func TestTheCopyOfClaudeCodesLoginTakesItsNewTokenAndLeavesEveryOtherLogin(t *testing.T) {
	dir, home := t.TempDir(), t.TempDir()
	claudeCodeLoggedIn(t, home, "signed-in", "refresh-1", testNow.Add(time.Hour))
	ada := map[string]string{"type": "claude", "email": "ada@x", "access_token": "expired", "account_uuid": "account-a", "organization_uuid": "organization-a"}
	writeJSON(t, filepath.Join(dir, "claude-copy-ada@x.json"), ada)
	ada["refresh_token"] = "refresh-1"
	writeJSON(t, filepath.Join(dir, "claude-earlier-ada@x.json"), ada)
	ada["refresh_token"] = "the proxy's own"
	writeJSON(t, filepath.Join(dir, "claude-own-ada@x.json"), ada)
	writeJSON(t, filepath.Join(dir, "claude-bob@x.json"), map[string]string{"type": "claude", "email": "bob@x", "access_token": "expired", "account_uuid": "account-b", "organization_uuid": "organization-a"})
	own, _ := os.ReadFile(filepath.Join(dir, "claude-own-ada@x.json"))
	bob, _ := os.ReadFile(filepath.Join(dir, "claude-bob@x.json"))
	p, proxy := newFollowingPlugin(t, dir, home)

	p.followClaudeLogin(testNow)
	if got := proxy.savedNames(); !slices.Equal(got, []string{"claude-copy-ada@x.json", "claude-earlier-ada@x.json"}) {
		t.Fatalf("saved %v, want the copy and the earlier install's copy", got)
	}
	for _, name := range []string{"claude-copy-ada@x.json", "claude-earlier-ada@x.json"} {
		file := readJSON(t, filepath.Join(dir, name))
		if token, held := file["refresh_token"]; held || file["access_token"] != "signed-in" || !expiresAt(file, testNow.Add(time.Hour)) || file["email"] != "ada@x" {
			t.Fatalf("%s = %v, want Claude Code's access token and expiry and no refresh token (holds %q)", name, file, token)
		}
	}
	if after, _ := os.ReadFile(filepath.Join(dir, "claude-own-ada@x.json")); !bytes.Equal(after, own) {
		t.Fatalf("the proxy's own login of ada changed: %s", after)
	}
	if after, _ := os.ReadFile(filepath.Join(dir, "claude-bob@x.json")); !bytes.Equal(after, bob) {
		t.Fatalf("bob's login changed: %s", after)
	}
	p.followClaudeLogin(testNow)
	if got := proxy.savedNames(); len(got) != 2 {
		t.Fatalf("saved %v, want nothing more while Claude Code's token stays the same", got)
	}
}

func TestACopySignedOutByA401TakesClaudeCodesTokenAtOnce(t *testing.T) {
	dir, home := t.TempDir(), t.TempDir()
	claudeCodeLoggedIn(t, home, "signed-in", "refresh-1", testNow.Add(time.Hour))
	writeJSON(t, filepath.Join(dir, "claude-ada@x.json"), map[string]string{"type": "claude", "email": "ada@x", "access_token": "expired", "account_uuid": "account-a", "organization_uuid": "organization-a"})
	p, _ := newFollowingPlugin(t, dir, home)
	p.refreshOne(testNow)
	st, took := statusUntil(t, p, func(st Status) bool {
		return len(st.Accounts) == 1 && !st.Accounts[0].SignedOut && st.Accounts[0].Known
	})
	if last := st.Log[len(st.Log)-1]; last.Text != "Anthropic accepted ada's login again." {
		t.Fatalf("log = %+v, want ada rejected, then accepted with Claude Code's token", st.Log)
	}
	t.Logf("signed in %v after the 401", took)
}

func TestSigningTheCopyInGivesThePoolALoginOfItsOwnThatNoLongerFollows(t *testing.T) {
	dir, home := t.TempDir(), t.TempDir()
	path := filepath.Join(dir, "claude-ada@x.json")
	claudeCodeLoggedIn(t, home, "expired", "refresh-1", testNow.Add(-time.Minute))
	writeJSON(t, path, map[string]string{"type": "claude", "email": "ada@x", "access_token": "expired", "account_uuid": "account-a", "organization_uuid": "organization-a"})
	p, proxy := newFollowingPlugin(t, dir, home)
	p.refreshOne(testNow)
	if st := p.Status(); !st.Accounts[0].SignedOut {
		t.Fatalf("ada = %+v, want the copy signed out while Claude Code's token is expired", st.Accounts[0])
	}

	writeJSON(t, path, map[string]string{"type": "claude", "email": "ada@x", "access_token": "signed-in", "refresh_token": "the pool's own", "account_uuid": "account-a", "organization_uuid": "organization-a"})
	statusUntil(t, p, func(st Status) bool { return !st.Accounts[0].SignedOut })
	signedIn, _ := os.ReadFile(path)
	claudeCodeLoggedIn(t, home, "refreshed", "refresh-2", testNow.Add(8*time.Hour))
	p.followClaudeLogin(testNow)
	if after, _ := os.ReadFile(path); !bytes.Equal(after, signedIn) || len(proxy.savedNames()) != 0 {
		t.Fatalf("the pool's own login of ada = %s after Claude Code refreshed, saved %v, want it left as [Sign in] wrote it", after, proxy.savedNames())
	}
}
