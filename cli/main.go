// Command oneclaude is the CLIProxyAPI plugin behind the oneclaude mod. It
// places every Claude Code agent on the account that most needs spending and
// has room for its model, keeps a conversation on its account while its cache
// is warm, and records usage from the replies agents already get.
//
// This file is the C ABI boundary only. A panic escaping this library kills
// the proxy, so every entry point recovers.
package main

/*
#include <stdint.h>
#include <stdlib.h>

typedef struct {
	void* ptr;
	size_t len;
} cliproxy_buffer;

typedef int (*cliproxy_host_call_fn)(void*, const char*, const uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_host_free_fn)(void*, size_t);

typedef struct {
	uint32_t abi_version;
	void* host_ctx;
	cliproxy_host_call_fn call;
	cliproxy_host_free_fn free_buffer;
} cliproxy_host_api;

typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);

typedef struct {
	uint32_t abi_version;
	cliproxy_plugin_call_fn call;
	cliproxy_plugin_free_fn free_buffer;
	cliproxy_plugin_shutdown_fn shutdown;
} cliproxy_plugin_api;

extern int cliproxyPluginCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxyPluginFree(void*, size_t);
extern void cliproxyPluginShutdown(void);

static const cliproxy_host_api* stored_host;

static void store_host_api(const cliproxy_host_api* host) {
	stored_host = host;
}

static int call_host_api(const char* method, const uint8_t* request, size_t request_len, cliproxy_buffer* response) {
	const cliproxy_host_api* host = stored_host;
	if (host == NULL || host->call == NULL) {
		return 1;
	}
	return host->call(host->host_ctx, method, request, request_len, response);
}

static void free_host_buffer(void* ptr, size_t len) {
	const cliproxy_host_api* host = stored_host;
	if (host != NULL && host->free_buffer != NULL && ptr != NULL) {
		host->free_buffer(ptr, len);
	}
}
*/
import "C"

import (
	"encoding/json"
	"fmt"
	"math"
	"unsafe"

	"github.com/heyJordanParker/oneclaude/cli/internal/runtime"
)

const (
	pluginName    = "oneclaude"
	pluginVersion = "0.4.0"
	pluginAuthor  = "heyJordanParker"
	pluginRepo    = "https://github.com/heyJordanParker/oneclaude"
)

var configFields = []runtime.ConfigField{
	{Name: "limits.enabled", Type: "boolean", Description: "Place new agents only on accounts under their per-model limit, and refuse a new subagent when every account is full. Default true."},
	{Name: "limits.self-correct", Type: "boolean", Description: "Lower a plan's limit after throttles below it on 3 separate days on 2 or more accounts. Default true."},
	{Name: "limits.override", Type: "object", Description: "Per plan and model family, replaces the defaults, e.g. {default_claude_max_20x: {haiku: 30}}."},
	{Name: "subagents.retry-after", Type: "string", Description: "How long a refused subagent is told to wait. Default 3m."},
	{Name: "affinity.ttl", Type: "string", Description: "A conversation idle longer than this can move to another account. Default 1h."},
	{Name: "quota.poll-interval", Type: "string", Description: "An account with no replies for this long gets one usage read. Default 1h."},
}

var plugin = runtime.New(runtime.Options{
	Name:         pluginName,
	Version:      pluginVersion,
	Author:       pluginAuthor,
	Repository:   pluginRepo,
	ConfigFields: configFields,
	Host:         callHost,
})

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(host *C.cliproxy_host_api, api *C.cliproxy_plugin_api) (rc C.int) {
	defer func() {
		if recover() != nil {
			rc = 1
		}
	}()
	if api == nil {
		return 1
	}
	C.store_host_api(host)
	api.abi_version = C.uint32_t(runtime.ABIVersion)
	api.call = C.cliproxy_plugin_call_fn(C.cliproxyPluginCall)
	api.free_buffer = C.cliproxy_plugin_free_fn(C.cliproxyPluginFree)
	api.shutdown = C.cliproxy_plugin_shutdown_fn(C.cliproxyPluginShutdown)
	return 0
}

//export cliproxyPluginCall
func cliproxyPluginCall(method *C.char, request *C.uint8_t, requestLen C.size_t, response *C.cliproxy_buffer) (rc C.int) {
	name := ""
	defer func() {
		if r := recover(); r != nil {
			rc = fail(response, name, "plugin_panic", fmt.Sprintf("recovered: %v", r))
		}
	}()
	if response != nil {
		response.ptr = nil
		response.len = 0
	}
	if method == nil {
		writeResponse(response, errorEnvelope("invalid_method", "method is required"))
		return 1
	}
	name = C.GoString(method)
	if bufferTooLarge(uint64(requestLen)) {
		return fail(response, name, "invalid_request", "request envelope is too large")
	}
	var payload []byte
	if request != nil && requestLen > 0 {
		payload = C.GoBytes(unsafe.Pointer(request), C.int(requestLen))
	}
	raw, ok := plugin.Call(name, payload)
	writeResponse(response, raw)
	if !ok {
		return 1
	}
	return 0
}

//export cliproxyPluginFree
func cliproxyPluginFree(ptr unsafe.Pointer, _ C.size_t) {
	defer func() { _ = recover() }()
	if ptr != nil {
		C.free(ptr)
	}
}

//export cliproxyPluginShutdown
func cliproxyPluginShutdown() {
	defer func() { _ = recover() }()
	plugin.Shutdown()
	C.store_host_api(nil)
}

func fail(response *C.cliproxy_buffer, method, code, message string) C.int {
	raw, ok := runtime.Degrade(method, code, message)
	writeResponse(response, raw)
	if ok {
		return 0
	}
	return 1
}

func errorEnvelope(code, message string) []byte {
	raw, err := json.Marshal(map[string]any{
		"ok":    false,
		"error": map[string]string{"code": code, "message": message},
	})
	if err != nil {
		return []byte(`{"ok":false,"error":{"code":"internal","message":"failed to encode error"}}`)
	}
	return raw
}

func writeResponse(response *C.cliproxy_buffer, raw []byte) {
	if response == nil || len(raw) == 0 {
		return
	}
	ptr := C.CBytes(raw)
	if ptr == nil {
		return
	}
	response.ptr = ptr
	response.len = C.size_t(len(raw))
}

func callHost(method string, payload []byte) ([]byte, error) {
	cMethod := C.CString(method)
	defer C.free(unsafe.Pointer(cMethod))

	var request *C.uint8_t
	if len(payload) > 0 {
		request = (*C.uint8_t)(C.CBytes(payload))
		defer C.free(unsafe.Pointer(request))
	}

	var response C.cliproxy_buffer
	if rc := C.call_host_api(cMethod, request, C.size_t(len(payload)), &response); rc != 0 {
		if response.ptr != nil {
			C.free_host_buffer(response.ptr, response.len)
		}
		return nil, fmt.Errorf("host callback %s failed", method)
	}
	if response.ptr == nil {
		return nil, nil
	}
	defer C.free_host_buffer(response.ptr, response.len)
	if bufferTooLarge(uint64(response.len)) {
		return nil, fmt.Errorf("host callback %s returned an oversized response", method)
	}
	return C.GoBytes(response.ptr, C.int(response.len)), nil
}

// C.GoBytes takes a C int length, so a larger buffer would wrap negative and
// throw a fatal error that no recover catches.
func bufferTooLarge(n uint64) bool {
	return n > math.MaxInt32
}
