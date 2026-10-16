package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

type HostFunc func(method string, payload []byte) ([]byte, error)

// host bridges HostFunc. Host callbacks are synchronous and take no context,
// so one with a deadline runs on a tracked goroutine and is abandoned at the
// deadline; shutdown waits for the tracked ones because the host unloads this
// library as soon as shutdown returns.
type host struct {
	call    HostFunc
	tracker *callTracker
}

func newHost(call HostFunc) host {
	return host{call: call, tracker: newCallTracker()}
}

type callTracker struct {
	mu   sync.Mutex
	live int
	idle chan struct{}
}

func newCallTracker() *callTracker {
	t := &callTracker{idle: make(chan struct{})}
	close(t.idle)
	return t
}

func (t *callTracker) begin() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.live == 0 {
		t.idle = make(chan struct{})
	}
	t.live++
}

func (t *callTracker) end() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.live--
	if t.live == 0 {
		close(t.idle)
	}
}

func (t *callTracker) idleC() <-chan struct{} {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.idle
}

func (h host) invoke(method string, payload any, out any) error {
	if h.call == nil {
		return fmt.Errorf("%s: host callbacks are unavailable", method)
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode %s request: %w", method, err)
	}
	raw, err := h.call(method, encoded)
	if err != nil {
		return err
	}
	if err := unwrapEnvelope(raw, out); err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	return nil
}

func (h host) invokeCtx(ctx context.Context, method string, payload any, out any) error {
	if h.call == nil {
		return fmt.Errorf("%s: host callbacks are unavailable", method)
	}
	type outcome struct {
		result json.RawMessage
		err    error
	}
	done := make(chan outcome, 1)
	h.spawn(func() {
		defer func() {
			if r := recover(); r != nil {
				done <- outcome{err: fmt.Errorf("%s panicked: %v", method, r)}
			}
		}()
		var result json.RawMessage
		err := h.invoke(method, payload, &result)
		done <- outcome{result: result, err: err}
	})
	select {
	case got := <-done:
		if got.err != nil {
			return got.err
		}
		if out == nil || len(got.result) == 0 {
			return nil
		}
		return json.Unmarshal(got.result, out)
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (h host) spawn(fn func()) {
	run := func() {
		defer func() { _ = recover() }()
		fn()
	}
	if h.tracker == nil {
		go run()
		return
	}
	h.tracker.begin()
	go func() {
		defer h.tracker.end()
		run()
	}()
}

func (h host) drain(timeout time.Duration) {
	if h.tracker == nil {
		return
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-h.tracker.idleC():
	case <-timer.C:
	}
}

func (h host) log(level, message string, fields map[string]any) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = h.invokeCtx(ctx, MethodHostLog, HostLogRequest{Level: level, Message: message, Fields: fields}, nil)
}

func (h host) authList(ctx context.Context) ([]HostAuthFileEntry, error) {
	var resp HostAuthListResponse
	if err := h.invokeCtx(ctx, MethodHostAuthList, HostAuthListRequest{}, &resp); err != nil {
		return nil, err
	}
	return resp.Files, nil
}

// credential is what a usage reading needs from a credential file: its token,
// and for Codex the ChatGPT account it belongs to.
type credential struct {
	AccessToken string `json:"access_token"`
	AccountID   string `json:"account_id"`
}

func (h host) credential(ctx context.Context, authIndex string) (credential, error) {
	var resp HostAuthGetResponse
	if err := h.invokeCtx(ctx, MethodHostAuthGet, HostAuthGetRequest{AuthIndex: authIndex}, &resp); err != nil {
		return credential{}, err
	}
	var file credential
	if err := json.Unmarshal(resp.JSON, &file); err != nil || file.AccessToken == "" {
		return credential{}, fmt.Errorf("credential %s has no access token", authIndex)
	}
	return file, nil
}

func (h host) get(ctx context.Context, url string, headers http.Header) (int, []byte, error) {
	var resp HostHTTPResponse
	err := h.invokeCtx(ctx, MethodHostHTTPDo, HostHTTPRequest{
		Method:  http.MethodGet,
		URL:     url,
		Headers: headers,
	}, &resp)
	if err != nil {
		return 0, nil, err
	}
	return resp.StatusCode, resp.Body, nil
}
