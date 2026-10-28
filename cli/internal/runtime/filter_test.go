package runtime

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func addFilters(t *testing.T, p *Plugin, sessionID string, filters ...Filter) {
	t.Helper()
	raw, _ := json.Marshal(filters)
	dir := filepath.Join(p.settings().DataDir, filtersFolder)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, sessionID+".json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

type posts struct {
	mu   sync.Mutex
	list []filterMessage
}

func (p *posts) all() []filterMessage {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.list)
}

// filterServer answers each message with answer(the message), recording every
// message.
func filterServer(t *testing.T, answer func(filterMessage) any) (*httptest.Server, *posts) {
	t.Helper()
	got := &posts{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var message filterMessage
		_ = json.NewDecoder(r.Body).Decode(&message)
		got.mu.Lock()
		got.list = append(got.list, message)
		got.mu.Unlock()
		if out := answer(message); out != nil {
			_ = json.NewEncoder(w).Encode(out)
		}
	}))
	t.Cleanup(server.Close)
	return server, got
}

func interceptSession(t *testing.T, p *Plugin, sessionID, body string) RequestInterceptResponse {
	t.Helper()
	headers := agentHeaders(sessionID, "")
	headers.Set("Authorization", "Bearer proxy-key")
	headers.Set("Anthropic-Beta", "claude-code-20250219")
	return call[RequestInterceptResponse](t, p, MethodRequestInterceptBefore, RequestInterceptRequest{
		RequestID: "r1", TraceID: "t1", Model: "claude-opus-5-5", Headers: headers, Body: []byte(body),
		Metadata: map[string]any{"request_path": "/v1/messages"},
	})
}

func intercept(t *testing.T, p *Plugin, body string) RequestInterceptResponse {
	t.Helper()
	return interceptSession(t, p, "s1", body)
}

func TestFiltersRunInOrderOnTheSessionThatAddedThem(t *testing.T) {
	p := newTestPlugin(t, enabled)
	first, firstPosts := filterServer(t, func(filterMessage) any {
		return map[string]any{"body": map[string]string{"system": "first"}}
	})
	second, secondPosts := filterServer(t, func(filterMessage) any { return map[string]any{} })
	addFilters(t, p, "s1", Filter{Name: "first", URL: first.URL}, Filter{Name: "second", URL: second.URL})

	in := intercept(t, p, `{"system":"claude code"}`)

	if string(in.Body) != `{"system":"first"}` {
		t.Fatalf("body = %s, want the first filter's", in.Body)
	}
	if seen := secondPosts.all()[0].Request; string(seen.Body) != `{"system":"first"}` {
		t.Fatalf("the second filter saw %s, want the first filter's body", seen.Body)
	}
	sent := firstPosts.all()[0].Request
	if sent.ID != "r1" || sent.Path != "/v1/messages" {
		t.Fatalf("the filter got id %q and path %q", sent.ID, sent.Path)
	}
	if sent.Headers["x-claude-code-session-id"] != "s1" || sent.Headers["authorization"] != "" {
		t.Fatalf("headers = %v, want Claude Code's without the proxy's key", sent.Headers)
	}
	if in.Headers.Get(headerKey) != "s1" {
		t.Fatal("a filtered request lost its place in the pool")
	}

	if other := interceptSession(t, p, "s2", `{"system":"claude code"}`); other.Body != nil || len(firstPosts.all()) != 1 {
		t.Fatal("a session that added no filter went through one")
	}
}

func TestAFilterThatAnswersNothingLeavesTheRequestAsItWas(t *testing.T) {
	p := newTestPlugin(t, enabled)
	server, _ := filterServer(t, func(filterMessage) any { return nil })
	addFilters(t, p, "s1", Filter{Name: "quiet", URL: server.URL})

	if in := intercept(t, p, `{"a":1}`); in.Body != nil || in.Terminate {
		t.Fatalf("got body %s terminate %v, want the request unchanged", in.Body, in.Terminate)
	}
}

func TestAFilterSetsAndRemovesHeadersButNeverTheCredentials(t *testing.T) {
	p := newTestPlugin(t, enabled)
	first, _ := filterServer(t, func(filterMessage) any {
		return map[string]any{"headers": map[string]any{"anthropic-beta": "context-1m", "x-trace": "on", "authorization": "Bearer stolen"}}
	})
	second, secondPosts := filterServer(t, func(filterMessage) any {
		return map[string]any{"headers": map[string]any{"x-trace": nil}}
	})
	addFilters(t, p, "s1", Filter{Name: "first", URL: first.URL}, Filter{Name: "second", URL: second.URL})

	in := intercept(t, p, `{"a":1}`)

	if in.Headers.Get("Anthropic-Beta") != "context-1m" || in.Headers.Get("Authorization") != "" {
		t.Fatalf("headers = %v, want the beta set and the credentials untouched", in.Headers)
	}
	if in.Headers.Get("X-Trace") != "" || !slices.Contains(in.ClearHeaders, "X-Trace") {
		t.Fatalf("headers = %v, cleared %v, want x-trace removed", in.Headers, in.ClearHeaders)
	}
	if seen := secondPosts.all()[0].Request.Headers; seen["anthropic-beta"] != "context-1m" || seen["x-trace"] != "on" {
		t.Fatalf("the second filter saw %v, want the first filter's headers", seen)
	}
}

func TestACacheKeyPlacesEveryRequestThatSharesItAsOneAgent(t *testing.T) {
	p := newTestPlugin(t, enabled)
	server, _ := filterServer(t, func(filterMessage) any {
		return map[string]any{"headers": map[string]any{"x-oneclaude-cache-key": "memory-4f2a"}}
	})
	addFilters(t, p, "s1", Filter{Name: "memory", URL: server.URL})
	addFilters(t, p, "s2", Filter{Name: "memory", URL: server.URL})

	for _, sessionID := range []string{"s1", "s2"} {
		in := interceptSession(t, p, sessionID, `{"a":1}`)
		if in.Headers.Get(headerKey) != "cache/memory-4f2a" {
			t.Fatalf("%s placed as %q, want the cache key", sessionID, in.Headers.Get(headerKey))
		}
		if in.Headers.Get(headerCacheKey) != "" || !slices.Contains(in.ClearHeaders, headerCacheKey) {
			t.Fatal("the cache key header would reach Anthropic")
		}
	}
	p.mu.Lock()
	r := p.requests["t1"]
	p.mu.Unlock()
	if r.key != "cache/memory-4f2a" || r.id.Session != "s2" {
		t.Fatalf("recorded %+v, want the cache key placed and the session kept for usage", r)
	}
}

func TestAFailingFilterRefusesUnlessItFailsOpen(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(1500 * time.Millisecond)
	}))
	t.Cleanup(slow.Close)

	open := newTestPlugin(t, enabled)
	addFilters(t, open, "s1", Filter{Name: "memory", URL: slow.URL, TimeoutSeconds: 1, FailOpen: true})
	if in := intercept(t, open, `{"a":1}`); in.Terminate || in.Body != nil {
		t.Fatalf("a filter that fails open changed the request: %+v", in)
	}

	closed := newTestPlugin(t, enabled)
	addFilters(t, closed, "s1", Filter{Name: "memory", URL: slow.URL, TimeoutSeconds: 1})
	in := intercept(t, closed, `{"a":1}`)
	if !in.Terminate || in.StatusCode != http.StatusServiceUnavailable || in.ResponseHeaders.Get("X-Should-Retry") != "true" {
		t.Fatalf("got %+v, want a 503 Claude Code retries", in)
	}
	if !strings.Contains(string(in.ResponseBody), "The memory filter didn't answer in 1 seconds.") {
		t.Fatalf("refusal = %s", in.ResponseBody)
	}
	if log := closed.events; len(log) != 1 || log[0].Text != "The memory filter didn't answer in 1 seconds, so oneclaude held the request back for Claude Code to retry." {
		t.Fatalf("log = %+v", log)
	}
}

func TestOnlyLocalFiltersRun(t *testing.T) {
	p := newTestPlugin(t, enabled)
	addFilters(t, p, "s1", Filter{Name: "remote", URL: "http://example.com/filter"})
	if in := intercept(t, p, `{"a":1}`); in.Body != nil || in.Terminate {
		t.Fatalf("a remote filter ran: %+v", in)
	}
}

func TestAFilterOnAUnixSocketRewritesTheRequest(t *testing.T) {
	socket := filepath.Join(os.TempDir(), "oneclaude-filter-test.sock")
	_ = os.Remove(socket)
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"body":{"via":"socket"}}`))
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })

	p := newTestPlugin(t, enabled)
	addFilters(t, p, "s1", Filter{Name: "memory", URL: "unix:" + socket})
	if in := intercept(t, p, `{"a":1}`); string(in.Body) != `{"via":"socket"}` {
		t.Fatalf("body = %s", in.Body)
	}
}

func TestAFilterAnswersARequestItselfBackThroughTheFiltersBeforeIt(t *testing.T) {
	p := newTestPlugin(t, enabled)
	earlier, earlierPosts := filterServer(t, func(m filterMessage) any {
		if m.Response == nil {
			return nil
		}
		return map[string]any{"body": map[string]string{"type": "renamed"}}
	})
	answering, _ := filterServer(t, func(filterMessage) any {
		return map[string]any{"immediateResponse": map[string]any{"status": 200, "body": []map[string]string{{"type": "message_start"}, {"type": "message_stop"}}}}
	})
	addFilters(t, p, "s1", Filter{Name: "earlier", URL: earlier.URL, Responses: true}, Filter{Name: "answering", URL: answering.URL})

	in := intercept(t, p, `{"stream":true}`)

	if !in.Terminate || in.StatusCode != 200 || in.ResponseHeaders.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("got %+v, want the filter's streamed answer", in)
	}
	if want := "event: renamed\ndata: {\"type\":\"renamed\"}\n\nevent: renamed\ndata: {\"type\":\"renamed\"}\n\n"; string(in.ResponseBody) != want {
		t.Fatalf("body = %q, want each event through the earlier filter", in.ResponseBody)
	}
	if got := earlierPosts.all(); len(got) != 3 || !got[2].Response.EndOfStream {
		t.Fatalf("the earlier filter got %+v", got)
	}

	refusing := newTestPlugin(t, enabled)
	refuser, _ := filterServer(t, func(filterMessage) any {
		return map[string]any{"immediateResponse": map[string]any{"status": 403, "body": map[string]string{"type": "error"}}}
	})
	addFilters(t, refusing, "s1", Filter{Name: "earlier", URL: earlier.URL, Responses: true}, Filter{Name: "policy", URL: refuser.URL})
	in = intercept(t, refusing, `{"a":1}`)
	if in.StatusCode != 403 || string(in.ResponseBody) != `{"type":"error"}` || in.ResponseHeaders.Get("Content-Type") != "application/json" {
		t.Fatalf("got %+v, want the error straight to Claude Code", in)
	}
}

func chunk(t *testing.T, p *Plugin, requestID, event string) StreamChunkInterceptResponse {
	t.Helper()
	return call[StreamChunkInterceptResponse](t, p, MethodStreamChunkIntercept, StreamChunkInterceptRequest{RequestID: requestID, Body: []byte(event), ChunkIndex: 0})
}

func TestResponsesRunThroughTheFiltersInReverse(t *testing.T) {
	p := newTestPlugin(t, enabled)
	var order []string
	var mu sync.Mutex
	answer := func(name string, rename map[string]string) func(filterMessage) any {
		return func(m filterMessage) any {
			if m.Response == nil {
				return nil
			}
			mu.Lock()
			order = append(order, name)
			mu.Unlock()
			if strings.Contains(string(m.Response.Body), "ping") {
				return map[string]any{"clearBody": true}
			}
			body := string(m.Response.Body)
			for from, to := range rename {
				body = strings.ReplaceAll(body, from, to)
			}
			return map[string]any{"body": json.RawMessage(body)}
		}
	}
	first, _ := filterServer(t, answer("first", map[string]string{"mcp__memory__zoom": "zoom"}))
	second, _ := filterServer(t, answer("second", map[string]string{"tool_use": "tool_use"}))
	addFilters(t, p, "s1", Filter{Name: "first", URL: first.URL, Responses: true}, Filter{Name: "second", URL: second.URL, Responses: true})
	intercept(t, p, `{"a":1}`)

	out := chunk(t, p, "r1", "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"tool_use\",\"name\":\"mcp__memory__zoom\"}}\n\n")

	if want := "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"tool_use\",\"name\":\"zoom\"}}\n\n"; string(out.Body) != want {
		t.Fatalf("chunk = %q, want %q", out.Body, want)
	}
	if strings.Join(order, ",") != "second,first" {
		t.Fatalf("order = %v, want the last filter added first", order)
	}
	if out := chunk(t, p, "r1", "event: ping\ndata: {\"type\":\"ping\"}\n\n"); !out.DropChunk {
		t.Fatal("a cleared event still reached Claude Code")
	}
	chunk(t, p, "r1", "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	if p.responding.Load() != 0 {
		t.Fatal("an ended response is still kept")
	}
}

func TestAFilterRewritesAWholeResponse(t *testing.T) {
	p := newTestPlugin(t, enabled)
	server, posts := filterServer(t, func(m filterMessage) any {
		if m.Response == nil {
			return nil
		}
		return map[string]any{"body": json.RawMessage(`{"type":"message","text":"rewritten"}`)}
	})
	addFilters(t, p, "s1", Filter{Name: "memory", URL: server.URL, Responses: true})
	intercept(t, p, `{"a":1}`)

	out := call[ResponseInterceptResponse](t, p, MethodResponseInterceptAfter, ResponseInterceptRequest{RequestID: "r1", Body: []byte(`{"type":"message","text":"raw"}`)})

	if string(out.Body) != `{"type":"message","text":"rewritten"}` {
		t.Fatalf("body = %s", out.Body)
	}
	if got := posts.all()[1].Response; got.ID != "r1" || !got.EndOfStream || string(got.Body) != `{"type":"message","text":"raw"}` {
		t.Fatalf("the filter got %+v", got)
	}
	if p.responding.Load() != 0 {
		t.Fatal("a whole response is still kept")
	}
}

func TestAFilterThatFailsMidStreamEndsItWithAnError(t *testing.T) {
	p := newTestPlugin(t, enabled)
	var failing atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if failing.Load() {
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	t.Cleanup(server.Close)
	addFilters(t, p, "s1", Filter{Name: "memory", URL: server.URL, Responses: true})
	intercept(t, p, `{"a":1}`)
	failing.Store(true)

	out := chunk(t, p, "r1", "event: ping\ndata: {\"type\":\"ping\"}\n\n")
	if !strings.HasPrefix(string(out.Body), "event: error\ndata: {\"error\":{\"message\":\"The memory filter failed.") {
		t.Fatalf("chunk = %q, want an error event", out.Body)
	}
	if out := chunk(t, p, "r1", "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"); !out.DropChunk {
		t.Fatal("the response went on after the filter refused it")
	}
}

func TestAFilterThatFailsOpenAndHangsCostsOneWaitPerResponse(t *testing.T) {
	p := newTestPlugin(t, enabled)
	var calls atomic.Int32
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) > 1 {
			time.Sleep(1500 * time.Millisecond)
		}
	}))
	t.Cleanup(slow.Close)
	addFilters(t, p, "s1", Filter{Name: "memory", URL: slow.URL, Responses: true, TimeoutSeconds: 1, FailOpen: true})
	intercept(t, p, `{"a":1}`)

	started := time.Now()
	for range 5 {
		if out := chunk(t, p, "r1", "event: ping\ndata: {\"type\":\"ping\"}\n\n"); out.Body != nil || out.DropChunk {
			t.Fatalf("a filter that failed open changed the response: %+v", out)
		}
	}
	if took := time.Since(started); took > 1800*time.Millisecond || calls.Load() != 2 {
		t.Fatalf("5 events took %s and %d posts, want one wait", took, calls.Load())
	}
}

func TestAnObservingFilterSeesTrafficInOrderWithoutAWait(t *testing.T) {
	p := newTestPlugin(t, enabled)
	server, posts := filterServer(t, func(filterMessage) any {
		time.Sleep(200 * time.Millisecond)
		return map[string]any{"body": map[string]string{"ignored": "yes"}}
	})
	addFilters(t, p, "s1", Filter{Name: "inspect", URL: server.URL, Responses: true, ObservabilityMode: true})

	started := time.Now()
	in := intercept(t, p, `{"a":1}`)
	first := chunk(t, p, "r1", "event: ping\ndata: {\"type\":\"ping\"}\n\n")
	last := chunk(t, p, "r1", "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	if time.Since(started) > 150*time.Millisecond || in.Body != nil || first.Body != nil || last.Body != nil {
		t.Fatal("an observing filter made the traffic wait or changed it")
	}
	deadline := time.Now().Add(3 * time.Second)
	for len(posts.all()) < 3 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	got := posts.all()
	if len(got) != 3 || got[0].Request == nil || !strings.Contains(string(got[1].Response.Body), "ping") || !got[2].Response.EndOfStream {
		t.Fatalf("the observer got %+v, want the request then each event in order", got)
	}
}

func TestAnObservingFilterThatHangsIsSkippedForTheRestOfTheResponse(t *testing.T) {
	p := newTestPlugin(t, enabled)
	var calls atomic.Int32
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		time.Sleep(1500 * time.Millisecond)
	}))
	t.Cleanup(slow.Close)
	addFilters(t, p, "s1", Filter{Name: "inspect", URL: slow.URL, Responses: true, TimeoutSeconds: 1, ObservabilityMode: true})
	intercept(t, p, `{"a":1}`)
	for range 5 {
		chunk(t, p, "r1", "event: ping\ndata: {\"type\":\"ping\"}\n\n")
	}

	time.Sleep(2500 * time.Millisecond)
	if got := calls.Load(); got != 1 {
		t.Fatalf("the hung observer got %d posts, want 1 and the rest skipped", got)
	}
}

func TestARequestWithoutResponseFiltersSkipsTheStream(t *testing.T) {
	p := newTestPlugin(t, enabled)
	if out := chunk(t, p, "r1", "event: ping\ndata: {\"type\":\"ping\"}\n\n"); out.Body != nil || out.DropChunk {
		t.Fatalf("an unfiltered response changed: %+v", out)
	}
}

func TestAFiltersFileThatDoesNotParseKeepsTheFiltersBeforeIt(t *testing.T) {
	p := newTestPlugin(t, enabled)
	server, _ := filterServer(t, func(filterMessage) any { return nil })
	addFilters(t, p, "s1", Filter{Name: "memory", URL: server.URL})
	dir := p.settings().DataDir
	if list, err := p.filters.of(dir, "s1", testNow); len(list) != 1 || err != nil {
		t.Fatalf("filters = %v, %v", list, err)
	}
	if err := os.WriteFile(filepath.Join(dir, filtersFolder, "s1.json"), []byte(`[{"name":"memory",`), 0o600); err != nil {
		t.Fatal(err)
	}
	list, err := p.filters.of(dir, "s1", testNow.Add(2*time.Second))
	if len(list) != 1 || err == nil {
		t.Fatalf("a broken file gave filters %v and error %v, want the filter before it and the error", list, err)
	}
	if _, again := p.filters.of(dir, "s1", testNow.Add(4*time.Second)); again != nil {
		t.Fatalf("the same error reported twice: %v", again)
	}
	if list, _ := p.filters.of(dir, "../s1", testNow); list != nil {
		t.Fatal("a session id read a file outside the filters folder")
	}
}

func TestAFilterThatRedirectsIsNeverFollowed(t *testing.T) {
	p := newTestPlugin(t, enabled)
	elsewhere, posts := filterServer(t, func(filterMessage) any { return map[string]any{"body": map[string]int{"b": 2}} })
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere.URL, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirect.Close)
	addFilters(t, p, "s1", Filter{Name: "memory", URL: redirect.URL, FailOpen: true})
	if in := intercept(t, p, `{"a":1}`); in.Body != nil || len(posts.all()) != 0 {
		t.Fatalf("the redirect was followed: %+v", in)
	}
}

func TestFiltersFilesOfLongEndedSessionsGo(t *testing.T) {
	p := newTestPlugin(t, enabled)
	addFilters(t, p, "old", Filter{Name: "memory", URL: "http://127.0.0.1:1/"})
	addFilters(t, p, "new", Filter{Name: "memory", URL: "http://127.0.0.1:1/"})
	dir := p.settings().DataDir
	long := time.Now().Add(-filtersKept - time.Hour)
	if err := os.Chtimes(filepath.Join(dir, filtersFolder, "old.json"), long, long); err != nil {
		t.Fatal(err)
	}
	pruneFilters(dir, time.Now())
	if _, err := os.Stat(filepath.Join(dir, filtersFolder, "old.json")); !os.IsNotExist(err) {
		t.Fatal("a long-ended session's filters stayed")
	}
	if _, err := os.Stat(filepath.Join(dir, filtersFolder, "new.json")); err != nil {
		t.Fatal("a recent session's filters went")
	}
}
