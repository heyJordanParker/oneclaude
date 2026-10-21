// Command fakeanthropic answers /v1/messages the way Anthropic does for a
// subscription, so the dev proxy runs the plugin without a real account.
// Each API key is one account with its own weekly usage. A prompt containing
// "throttle" gets a 429 with no usage headers, and "slow" streams for 6s.
package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

type account struct {
	used    float64
	resetIn time.Duration
}

var (
	mu       sync.Mutex
	accounts = map[string]*account{
		"fake-key-a": {used: 0.30, resetIn: 72 * time.Hour},
		"fake-key-b": {used: 0.60, resetIn: 20 * time.Hour},
	}
	served = map[string]int{}
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8319", "listen address")
	flag.Parse()
	http.HandleFunc("/v1/messages", messages)
	http.HandleFunc("/served", func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		for key, n := range served {
			fmt.Fprintf(w, "%s %d\n", key, n)
		}
	})
	log.Printf("fake anthropic on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, nil))
}

func messages(w http.ResponseWriter, r *http.Request) {
	key := r.Header.Get("X-Api-Key")
	if key == "" {
		key = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	}
	body, _ := io.ReadAll(r.Body)
	mu.Lock()
	a, ok := accounts[key]
	served[key]++
	mu.Unlock()
	if !ok {
		http.Error(w, `{"type":"error","error":{"type":"authentication_error","message":"unknown key"}}`, http.StatusUnauthorized)
		return
	}
	text := string(body)
	if strings.Contains(text, "throttle") {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}`)
		return
	}
	if strings.Contains(text, "notfound") {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-5-5"}}`)
		return
	}
	mu.Lock()
	a.used += 0.001
	used, reset := a.used, time.Now().Add(a.resetIn).Unix()
	mu.Unlock()
	h := w.Header()
	h.Set("anthropic-ratelimit-unified-status", "allowed")
	h.Set("anthropic-ratelimit-unified-7d-utilization", fmt.Sprintf("%.3f", used))
	h.Set("anthropic-ratelimit-unified-7d-reset", fmt.Sprintf("%d", reset))
	h.Set("anthropic-ratelimit-unified-7d-status", "allowed")
	h.Set("request-id", fmt.Sprintf("req_fake_%d", time.Now().UnixNano()))

	if !strings.Contains(text, `"stream":true`) {
		h.Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"msg_fake","type":"message","role":"assistant","model":"claude-opus-5-5","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}`)
		return
	}
	h.Set("Content-Type", "text/event-stream")
	flusher, _ := w.(http.Flusher)
	chunks := 3
	pause := 50 * time.Millisecond
	if strings.Contains(text, "slow") {
		chunks, pause = 12, 500*time.Millisecond
	}
	write := func(event, data string) {
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
		if flusher != nil {
			flusher.Flush()
		}
	}
	write("message_start", `{"type":"message_start","message":{"id":"msg_fake","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`)
	write("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`)
	for i := 0; i < chunks; i++ {
		time.Sleep(pause)
		write("content_block_delta", fmt.Sprintf(`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"chunk%d "}}`, i))
	}
	write("content_block_stop", `{"type":"content_block_stop","index":0}`)
	write("message_delta", fmt.Sprintf(`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":%d}}`, chunks))
	write("message_stop", `{"type":"message_stop"}`)
}
