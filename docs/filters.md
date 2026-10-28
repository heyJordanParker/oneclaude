# Filters

Every Claude Code request from every session that uses the pool goes through oneclaude. A filter lets another mod rewrite, answer, or watch the requests of a session it chose, and their successful responses. It works the way Envoy's external processing filter does: oneclaude sends the filter each request, then each event of the response, and applies its answers.

A filter is a program your mod runs, at an address on the machine the pool runs on. oneclaude runs nothing itself. A session on another machine that uses the pool, such as a Mac whose `ANTHROPIC_BASE_URL` is `http://devbox:8317`, adds the address of its program on the pool's machine.

## Add a filter

List oneclaude as a dependency in your mod's `.claude-plugin/plugin.json`:

```json
"dependencies": [{ "name": "cmod", "version": ">=4.3.2" }, { "name": "oneclaude", "version": ">=0.9.0" }]
```

Then add your program's address in the session it should filter:

```ts
await mod.dependencies.oneclaude.addFilter({
  name: 'memory',
  url: 'unix:/Users/you/.local/share/cmod/data/memory/memory.sock',
  responses: true,
  timeoutSeconds: 120,
})
```

- `name` is your mod's name, which oneclaude's log uses when the filter fails.
- `url` is your program's address on the pool's machine: `http://127.0.0.1:<port>/…`, `http://localhost:<port>/…`, or `unix:<socket path>`. The pool refuses any other address, so no request leaves its machine for a filter, and `addFilter` rejects with the reason.
- `responses: true` also sends the filter each successful response. It is off by default.
- `timeoutSeconds` is how long oneclaude waits for each answer: 2 by default, up to 120.
- `failOpen: true` sends the traffic on unchanged when your program doesn't answer in time, can't be reached, or answers with an error or a redirect, and skips your program for the rest of that response. By default a failure answers Claude Code with a 503 error it retries, and ends a response in progress with an error event.
- `observabilityMode: true` sends your program each request and response event in order, without waiting for it, and ignores its answers. When your program fails, oneclaude skips it for the rest of that response.

`removeFilter({ name })` takes the filter out of the session.

oneclaude sends the pool the session's filters with its management key ([Installation](installation.md#3-adding-oneclaude)). A filter added while the pool doesn't answer reaches it within a second of the pool answering again, and `addFilter` doesn't wait for that.

## Which traffic a filter sees

A filter covers only the session that added it, and its subagents, which share the session's id. A mod that adds its filter in `setup` covers every session, because cmod starts each mod in every session. A request from no session that added a filter, such as your program's own model calls, passes every filter.

A filter lasts until its session restarts, resumes, or reloads its mods, as cmod takes back everything a mod adds when it stops. Add your filter again each time your mod starts. A mod that is uninstalled never adds its filter again, so it leaves none behind. Adding a filter again under its name replaces it in place, and costs nothing when nothing changed.

Requests go through a session's filters in the order its mods added them, and each filter sees what the one before it changed. Responses go through them in reverse, so the first filter to change a request is the last to change its response. oneclaude picks the account after the last filter.

A filter sees only successful responses. An error from Anthropic reaches Claude Code as Anthropic sent it, because the proxy writes errors without calling any plugin.

## Answer a request

oneclaude posts each request to your address as JSON, every endpoint Claude Code calls included:

```json
{
  "request": {
    "id": "…",
    "path": "/v1/messages",
    "headers": { "x-claude-code-session-id": "…", "anthropic-version": "2023-06-01" },
    "body": { "model": "claude-opus-5-5", "stream": true, "system": "…", "messages": [] }
  }
}
```

`id` stays the same across the proxy's own retries, and its response carries it. `path` is the endpoint, such as `/v1/messages` or `/v1/messages/count_tokens`. `headers` are Claude Code's, with lowercase names, without the key Claude Code sends the proxy.

Answer `{}` or nothing to send the request on as it is. Change it with `body`, the body to send instead, and `headers`, which sets each header you name and removes each one you set to `null`:

```json
{ "headers": { "anthropic-beta": "context-1m-2025-08-07", "x-trace": null }, "body": { "model": "claude-opus-5-5", "messages": [] } }
```

A filter can't set the credentials, `host`, `content-length`, `transfer-encoding`, or `connection`.

Or answer the request yourself, and Anthropic is never called:

```json
{ "immediateResponse": { "status": 403, "body": { "type": "error", "error": { "type": "permission_error", "message": "…" } } } }
```

For a streamed request, a successful `body` is the list of events Claude Code reads, in order. An error, or the answer to a request that isn't streamed, is one JSON body. A successful answer goes back through the filters before yours that asked for responses.

## Keep requests on one account's cache

oneclaude keeps each session on one account while its prompt cache is warm. A filter that makes requests from several sessions share text, such as one conversation for every session, keeps them on one account with a header:

```json
{ "headers": { "x-oneclaude-cache-key": "memory-4f2a" } }
```

oneclaude places every request with the same value on one account, as one agent, and moves it to another account only when that account is full. It removes the header before Anthropic sees it. Usage still counts each request under its own session.

## Answer a response

With `responses: true`, oneclaude posts each event of a streamed response before Claude Code reads it, and a response that wasn't streamed once, whole:

```json
{ "response": { "id": "…", "body": { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "Hi" } }, "endOfStream": false } }
```

`id` is the request's. `endOfStream` is true on the last event, `message_stop` or `error`, and on a whole response.

Answer `{}` or nothing to pass it on, `{ "body": … }` with the event, or the whole body, Claude Code reads in its place, or `{ "clearBody": true }` to drop a streamed event.

## When a filter fails

The log says when a filter fails, once per filter until 10 minutes pass without a failure, such as `The memory filter didn't answer in 120 seconds, so oneclaude held the request back for Claude Code to retry.`
