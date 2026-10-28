package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

// A Filter is a program another mod runs on this computer, which oneclaude
// sends each request of the session that added it, and with Responses each
// successful response, as Envoy's external processing filter does. The mod
// keeps a session's filters in filters/<session id>.json in the data folder,
// in the order it added them.
type Filter struct {
	Name              string `json:"name"`
	URL               string `json:"url"`
	Responses         bool   `json:"responses,omitempty"`
	TimeoutSeconds    int    `json:"timeoutSeconds,omitempty"`
	FailOpen          bool   `json:"failOpen,omitempty"`
	ObservabilityMode bool   `json:"observabilityMode,omitempty"`
}

const (
	filtersFolder = "filters"
	// headerCacheKey keeps the requests a filter gives one value on one
	// account, so they share its prompt cache.
	headerCacheKey = "X-Oneclaude-Cache-Key"
	// filtersKept is how long a session's filters file outlives its last write.
	filtersKept = 30 * 24 * time.Hour
)

var sessionName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

func (f Filter) timeout() time.Duration {
	if f.TimeoutSeconds <= 0 {
		return 2 * time.Second
	}
	return min(time.Duration(f.TimeoutSeconds)*time.Second, 120*time.Second)
}

// isLocal keeps every request on this computer: a filter is a loopback
// address or a unix socket.
func (f Filter) isLocal() bool {
	if strings.HasPrefix(f.URL, "unix:/") {
		return true
	}
	u, err := url.Parse(f.URL)
	if err != nil || u.Scheme != "http" {
		return false
	}
	switch u.Hostname() {
	case "127.0.0.1", "localhost", "::1":
		return true
	}
	return false
}

// filterSet reads a session's filters at most once a second, so a request
// sees a filter within a second of its mod adding it. A file that doesn't
// parse keeps the filters read before it, and its error reports once.
type filterSet struct {
	mu       sync.Mutex
	dir      string
	sessions map[string]*sessionFilters
}

type sessionFilters struct {
	at     time.Time
	list   []Filter
	failed string
}

func (s *filterSet) of(dir, sessionID string, now time.Time) ([]Filter, error) {
	if dir == "" || !sessionName.MatchString(sessionID) {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if dir != s.dir || s.sessions == nil {
		s.dir, s.sessions = dir, map[string]*sessionFilters{}
	}
	read := s.sessions[sessionID]
	if read == nil {
		if len(s.sessions) >= 10000 {
			clear(s.sessions)
		}
		read = &sessionFilters{}
		s.sessions[sessionID] = read
	} else if now.Sub(read.at) < time.Second {
		return read.list, nil
	}
	read.at = now
	var saved []Filter
	if err := readIfThere(filepath.Join(dir, filtersFolder, sessionID+".json"), &saved); err != nil {
		if err.Error() == read.failed {
			return read.list, nil
		}
		read.failed = err.Error()
		return read.list, err
	}
	read.failed = ""
	read.list = slices.DeleteFunc(saved, func(f Filter) bool { return f.Name == "" || !f.isLocal() })
	return read.list, nil
}

func readIfThere(path string, into any) error {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, into); err != nil {
		return fmt.Errorf("%s: %w", filepath.Base(path), err)
	}
	return nil
}

// pruneFilters deletes the filters files of sessions that ended long ago.
func pruneFilters(dir string, now time.Time) {
	entries, err := os.ReadDir(filepath.Join(dir, filtersFolder))
	if err != nil {
		return
	}
	for _, entry := range entries {
		if info, err := entry.Info(); err == nil && now.Sub(info.ModTime()) > filtersKept {
			_ = os.Remove(filepath.Join(dir, filtersFolder, entry.Name()))
		}
	}
}

// filterMessage is what oneclaude sends a filter: one phase of one request,
// as ext_proc's ProcessingRequest.
type filterMessage struct {
	Request  *requestPhase  `json:"request,omitempty"`
	Response *responsePhase `json:"response,omitempty"`
}

type requestPhase struct {
	ID      string            `json:"id"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    json.RawMessage   `json:"body"`
}

// responsePhase is one event of a streamed response, or a whole response
// once, its last.
type responsePhase struct {
	ID          string          `json:"id"`
	Body        json.RawMessage `json:"body"`
	EndOfStream bool            `json:"endOfStream"`
}

type requestAnswer struct {
	Headers           map[string]*string `json:"headers"`
	Body              json.RawMessage    `json:"body"`
	ImmediateResponse *immediateResponse `json:"immediateResponse"`
}

// immediateResponse answers Claude Code in Anthropic's place. Its body is a
// list of events for a streamed request, else one JSON body.
type immediateResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    json.RawMessage   `json:"body"`
}

type responseAnswer struct {
	Body      json.RawMessage `json:"body"`
	ClearBody bool            `json:"clearBody"`
}

// Filters stay on this computer, so a redirect is an answer, never followed.
func local(c *http.Client) *http.Client {
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return c
}

var tcpFilterClient = local(&http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 64, IdleConnTimeout: time.Minute}})

var unixFilterClients sync.Map

func (f Filter) client() (*http.Client, string) {
	path, isUnix := strings.CutPrefix(f.URL, "unix:")
	if !isUnix {
		return tcpFilterClient, f.URL
	}
	if c, ok := unixFilterClients.Load(path); ok {
		return c.(*http.Client), "http://localhost/"
	}
	dial := func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", path)
	}
	c, _ := unixFilterClients.LoadOrStore(path, local(&http.Client{Transport: &http.Transport{DialContext: dial, MaxIdleConnsPerHost: 64, IdleConnTimeout: time.Minute}}))
	return c.(*http.Client), "http://localhost/"
}

// post sends a message to the filter and reads its answer into out. An empty
// answer leaves out as it was.
func (f Filter) post(payload []byte, out any) error {
	ctx, cancel := context.WithTimeout(context.Background(), f.timeout())
	defer cancel()
	client, target := f.client()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("answered %d", resp.StatusCode)
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

func isSet(raw json.RawMessage) bool {
	return len(raw) > 0 && !bytes.Equal(raw, []byte("null"))
}

// A watcher sends one observability-mode filter its messages in order,
// without making the request wait, and stops at its first failure, as a
// filter that fails open does, so a hung filter holds no queue.
type watcher struct {
	p       *Plugin
	f       Filter
	mu      sync.Mutex
	queue   [][]byte
	sending bool
	failed  bool
}

func (w *watcher) send(payload []byte) {
	w.mu.Lock()
	if w.failed {
		w.mu.Unlock()
		return
	}
	w.queue = append(w.queue, payload)
	start := !w.sending
	w.sending = true
	w.mu.Unlock()
	if start {
		w.p.host.spawn(w.drain)
	}
}

func (w *watcher) drain() {
	for {
		w.mu.Lock()
		if len(w.queue) == 0 {
			w.sending = false
			w.mu.Unlock()
			return
		}
		payload := w.queue[0]
		w.queue = w.queue[1:]
		w.mu.Unlock()
		if err := w.f.post(payload, nil); err != nil {
			w.p.filterFailed(w.f, err, "the traffic")
			w.mu.Lock()
			w.failed, w.queue, w.sending = true, nil, false
			w.mu.Unlock()
			return
		}
	}
}

// chain is the filters one request runs through, in the order the session
// added them, with a watcher for each observability-mode filter.
type chain struct {
	filters  []Filter
	watchers map[string]*watcher
}

func (p *Plugin) chainOf(filters []Filter) chain {
	c := chain{filters: filters, watchers: map[string]*watcher{}}
	for _, f := range filters {
		if f.ObservabilityMode {
			c.watchers[f.Name] = &watcher{p: p, f: f}
		}
	}
	return c
}

// filtered is what a request's filters made of it: its body and headers, the
// filters its response runs through, last first, and either a refusal or a
// filter's own answer for Claude Code.
type filtered struct {
	body      []byte
	set       http.Header
	cleared   []string
	cacheKey  string
	responses []Filter
	answer    *RequestInterceptResponse
}

// filterRequest runs the request through the session's filters in order.
func (p *Plugin) filterRequest(req RequestInterceptRequest, c chain) filtered {
	out := filtered{body: req.Body, set: http.Header{}}
	headers := filterHeaders(req.Headers)
	path, _ := req.Metadata["request_path"].(string)
	for _, f := range c.filters {
		payload, _ := json.Marshal(filterMessage{Request: &requestPhase{ID: req.RequestID, Path: path, Headers: headers, Body: out.body}})
		if w := c.watchers[f.Name]; w != nil {
			w.send(payload)
			if f.Responses {
				out.responses = append([]Filter{f}, out.responses...)
			}
			continue
		}
		var answer requestAnswer
		if err := f.post(payload, &answer); err != nil {
			if p.filterFailed(f, err, "the request") {
				refusal := filterRefusal(f, err)
				out.answer = &refusal
				return out
			}
			continue
		}
		if answer.ImmediateResponse != nil {
			immediate := p.answerItself(req.RequestID, *answer.ImmediateResponse, out.responses, c)
			out.answer = &immediate
			return out
		}
		for name, value := range answer.Headers {
			name = http.CanonicalHeaderKey(name)
			if protectedHeaders[name] {
				continue
			}
			if value == nil {
				delete(headers, strings.ToLower(name))
				out.set.Del(name)
				out.cleared = append(out.cleared, name)
				continue
			}
			headers[strings.ToLower(name)] = *value
			out.set.Set(name, *value)
		}
		if isSet(answer.Body) {
			out.body = answer.Body
		}
		if f.Responses {
			out.responses = append([]Filter{f}, out.responses...)
		}
	}
	out.cacheKey = out.set.Get(headerCacheKey)
	out.set.Del(headerCacheKey)
	return out
}

// protectedHeaders are the ones a filter can't set: the credentials, the
// proxy's own, and how the body is framed.
var protectedHeaders = map[string]bool{
	"Authorization":     true,
	"X-Api-Key":         true,
	headerKey:           true,
	headerFamily:        true,
	"Host":              true,
	"Content-Length":    true,
	"Transfer-Encoding": true,
	"Connection":        true,
}

// filterHeaders are Claude Code's headers as a filter reads them, without the
// credentials or oneclaude's own.
func filterHeaders(h http.Header) map[string]string {
	out := make(map[string]string, len(h))
	for name, values := range h {
		switch http.CanonicalHeaderKey(name) {
		case "Authorization", "X-Api-Key", headerKey, headerFamily:
			continue
		}
		out[strings.ToLower(name)] = strings.Join(values, ", ")
	}
	return out
}

// answerItself sends Claude Code a filter's own answer, back through the
// filters before it that asked for responses, as Envoy sends a local reply
// back through its filter chain. An error goes straight to Claude Code, as
// Anthropic's errors do.
func (p *Plugin) answerItself(id string, answer immediateResponse, responses []Filter, c chain) RequestInterceptResponse {
	status := answer.Status
	if status == 0 {
		status = http.StatusOK
	}
	headers := http.Header{}
	for name, value := range answer.Headers {
		headers.Set(name, value)
	}
	var events []json.RawMessage
	isStream := json.Unmarshal(answer.Body, &events) == nil && bytes.HasPrefix(bytes.TrimSpace(answer.Body), []byte("["))
	isOK := status >= 200 && status <= 299
	var body []byte
	if isStream {
		if headers.Get("Content-Type") == "" {
			headers.Set("Content-Type", "text/event-stream")
		}
		r := &response{filters: responses}
		for i, event := range events {
			if isOK {
				var refused []byte
				event, refused = p.filterResponse(id, event, i == len(events)-1, r, c)
				if refused != nil {
					body = append(body, eventChunk(refused)...)
					break
				}
			}
			if event != nil {
				body = append(body, eventChunk(event)...)
			}
		}
	} else {
		if headers.Get("Content-Type") == "" {
			headers.Set("Content-Type", "application/json")
		}
		body = answer.Body
		if isOK {
			if out, refused := p.filterResponse(id, answer.Body, true, &response{filters: responses}, c); refused != nil {
				body, status = refused, http.StatusServiceUnavailable
				headers.Set("Content-Type", "application/json")
				headers.Set("X-Should-Retry", "true")
			} else if out != nil {
				body = out
			}
		}
	}
	return RequestInterceptResponse{ClearHeaders: bridgeHeaders, Terminate: true, StatusCode: status, ResponseHeaders: headers, ResponseBody: body}
}

func failureOf(f Filter, err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Sprintf("didn't answer in %d seconds", int(f.timeout().Seconds()))
	}
	return "failed"
}

// filterFailed logs a filter's failure once per episode and reports whether
// the filter refuses on failure.
func (p *Plugin) filterFailed(f Filter, err error, what string) bool {
	refuses := !f.FailOpen && !f.ObservabilityMode
	now := p.now()
	p.mu.Lock()
	fresh := now.Sub(p.filterFailedAt[f.Name]) >= episode
	p.filterFailedAt[f.Name] = now
	p.mu.Unlock()
	if fresh {
		outcome := "sent " + what + " on unchanged"
		if refuses {
			outcome = "held " + what + " back for Claude Code to retry"
		}
		p.note(levelWarn, "The %s filter %s, so oneclaude %s.", f.Name, failureOf(f, err), outcome)
	}
	return refuses
}

func filterError(f Filter, err error) []byte {
	body, _ := json.Marshal(map[string]any{
		"type":  "error",
		"error": map[string]string{"type": "api_error", "message": fmt.Sprintf("The %s filter %s.", f.Name, failureOf(f, err))},
	})
	return body
}

func filterRefusal(f Filter, err error) RequestInterceptResponse {
	return RequestInterceptResponse{
		ClearHeaders: bridgeHeaders,
		Terminate:    true,
		StatusCode:   http.StatusServiceUnavailable,
		ResponseHeaders: http.Header{
			"Content-Type":   {"application/json"},
			"X-Should-Retry": {"true"},
		},
		ResponseBody: filterError(f, err),
	}
}

// A response is one the filters that asked for responses still rewrite, last
// added first. A filter that fails on it with failOpen leaves it, so a hung
// filter costs one wait per response, and refused is set once one refused, so
// the rest of the stream drops. at is its last event, for a response Claude
// Code cancelled.
type response struct {
	filters []Filter
	chain   chain
	at      time.Time
	refused bool
}

// expectResponse keeps the filters that rewrite the response to request id
// until its last event, or 30 minutes after an event of one that stopped.
func (p *Plugin) expectResponse(id string, filters []Filter, c chain, now time.Time) {
	if id == "" || len(filters) == 0 {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.responses[id] = &response{filters: filters, chain: c, at: now}
	for id, r := range p.responses {
		if now.Sub(r.at) > 30*time.Minute {
			delete(p.responses, id)
		}
	}
	p.responding.Store(int32(len(p.responses)))
}

// takeResponse is the response to request id, ended when last.
func (p *Plugin) takeResponse(id string, last bool) (*response, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	r, ok := p.responses[id]
	if !ok {
		return nil, false
	}
	r.at = p.now()
	if last {
		delete(p.responses, id)
		p.responding.Store(int32(len(p.responses)))
	}
	return r, true
}

// isLast is the event that ends a stream: message_stop, or an error.
func isLast(event json.RawMessage) bool {
	var head struct {
		Type string `json:"type"`
	}
	_ = json.Unmarshal(event, &head)
	return head.Type == "message_stop" || head.Type == "error"
}

// filterResponse runs one event, or a whole response, through the response's
// filters. It answers what Claude Code gets, nil for a dropped event, or the
// error that ends the response when a filter that refuses on failure fails.
func (p *Plugin) filterResponse(id string, body json.RawMessage, last bool, r *response, c chain) (json.RawMessage, []byte) {
	p.mu.Lock()
	filters := slices.Clone(r.filters)
	p.mu.Unlock()
	for _, f := range filters {
		payload, _ := json.Marshal(filterMessage{Response: &responsePhase{ID: id, Body: body, EndOfStream: last}})
		if w := c.watchers[f.Name]; w != nil {
			w.send(payload)
			continue
		}
		var answer responseAnswer
		if err := f.post(payload, &answer); err != nil {
			refuses := p.filterFailed(f, err, "the response")
			p.mu.Lock()
			r.filters = slices.DeleteFunc(r.filters, func(left Filter) bool { return left.Name == f.Name })
			r.refused = r.refused || refuses
			p.mu.Unlock()
			if refuses {
				return nil, filterError(f, err)
			}
			continue
		}
		if answer.ClearBody {
			return nil, nil
		}
		if isSet(answer.Body) {
			body = answer.Body
		}
	}
	return body, nil
}

// interceptChunk runs one event of a streamed response through the filters
// its request asked for. The proxy sends each Claude event as its own chunk.
func (p *Plugin) interceptChunk(payload []byte) ([]byte, error) {
	if p.responding.Load() == 0 {
		return okEnvelope(emptyResult)
	}
	var req StreamChunkInterceptRequest
	if json.Unmarshal(payload, &req) != nil || req.ChunkIndex < 0 {
		return okEnvelope(emptyResult)
	}
	event, isEvent := eventData(req.Body)
	if !isEvent {
		return okEnvelope(emptyResult)
	}
	r, ok := p.takeResponse(req.RequestID, isLast(event))
	if !ok {
		return okEnvelope(emptyResult)
	}
	p.mu.Lock()
	refused := r.refused
	p.mu.Unlock()
	if refused {
		return okEnvelope(StreamChunkInterceptResponse{DropChunk: true})
	}
	out, refusal := p.filterResponse(req.RequestID, event, isLast(event), r, r.chain)
	switch {
	case refusal != nil:
		return okEnvelope(StreamChunkInterceptResponse{Body: eventChunk(refusal)})
	case out == nil:
		return okEnvelope(StreamChunkInterceptResponse{DropChunk: true})
	case bytes.Equal(out, event):
		return okEnvelope(emptyResult)
	}
	return okEnvelope(StreamChunkInterceptResponse{Body: eventChunk(out)})
}

// interceptResponse runs a whole response, one that wasn't streamed, through
// the filters its request asked for.
func (p *Plugin) interceptResponse(payload []byte) ([]byte, error) {
	if p.responding.Load() == 0 {
		return okEnvelope(emptyResult)
	}
	var req ResponseInterceptRequest
	if json.Unmarshal(payload, &req) != nil || !json.Valid(req.Body) {
		return okEnvelope(emptyResult)
	}
	r, ok := p.takeResponse(req.RequestID, true)
	if !ok {
		return okEnvelope(emptyResult)
	}
	out, refusal := p.filterResponse(req.RequestID, req.Body, true, r, r.chain)
	switch {
	case refusal != nil:
		return okEnvelope(ResponseInterceptResponse{Body: refusal})
	case out == nil || bytes.Equal(out, req.Body):
		return okEnvelope(emptyResult)
	}
	return okEnvelope(ResponseInterceptResponse{Body: out})
}

func eventData(chunk []byte) (json.RawMessage, bool) {
	for _, line := range bytes.Split(chunk, []byte("\n")) {
		if data, ok := bytes.CutPrefix(line, []byte("data:")); ok {
			data = bytes.TrimSpace(data)
			return data, json.Valid(data)
		}
	}
	return nil, false
}

// eventChunk writes an event as the server-sent event Anthropic streams it,
// named by its type.
func eventChunk(event json.RawMessage) []byte {
	var head struct {
		Type string `json:"type"`
	}
	_ = json.Unmarshal(event, &head)
	var data bytes.Buffer
	if json.Compact(&data, event) != nil {
		data.Reset()
		data.Write(event)
	}
	return fmt.Appendf(nil, "event: %s\ndata: %s\n\n", head.Type, data.Bytes())
}
