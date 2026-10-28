# How it works

oneclaude runs every Claude subscription you have as one pool. Claude Code sends each request to [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) at its `ANTHROPIC_BASE_URL`, `127.0.0.1:8317` on this machine by default, which holds a login for each of your accounts. oneclaude is the proxy's scheduler plugin: for each request, the proxy asks it which account to use.

```text
Claude Code ──request──> CLIProxyAPI at ANTHROPIC_BASE_URL ──one of your logins──> Anthropic
                               │
                               │ asks which account
                               ▼
                         oneclaude plugin ──status.json──> the oneclaude mod in Claude Code
                               ▲
                               └──session record──────── the oneclaude mod in Claude Code
```

The pool can run on another machine, and every machine whose `ANTHROPIC_BASE_URL` names it shares it ([A pool on another machine](installation.md#a-pool-on-another-machine)).

## Which account a conversation gets

A new conversation goes to the account with the most weekly quota left per hour until its week resets. An account with 40% left and a day to go comes before one with 60% left and five days to go, because quota left at a reset is lost. An account oneclaude has no reading for yet counts as a full week left over a full week.

An account that used its whole week, or that Anthropic turned away, gets no new conversations until it refills.

## Why a conversation stays on its account

Claude Code caches each conversation's prompt on Anthropic's side, and the cache belongs to one account. So once a conversation starts on an account, every later request of that conversation goes to the same account, and its cache keeps hitting.

A conversation idle for longer than an hour, `affinity.ttl`, can move to another account, because its cache has gone cold by then. oneclaude knows a conversation by the session and agent ids Claude Code sends with each request. It keeps each conversation's account in `agents.json`, so a reload or an update of the plugin keeps every conversation where it was.

## Why a subagent can wait

An account runs only so many agents of one model at once before Anthropic throttles it. oneclaude keeps a limit for each plan and model family. The defaults for Claude Max 20x are 19 Opus and 6 Fable agents at once, the most one account ran without a throttle in four months of Claude Code transcripts. Sonnet and Haiku take Opus's 19, because Anthropic gives each model its own bucket of the same size. Other plans start from the same numbers.

A new subagent goes only to an account under its limit for the subagent's model. When every account is at its limit, oneclaude answers the subagent with a rate-limit error:

```text
Every Claude account is at its Opus limit of 19 agents. Retry this subagent in 3 minutes.
```

The agent that started the subagent reads that and starts it again later. oneclaude never turns away a main conversation, only new subagents, and a subagent already running keeps its account.

### Limits that correct themselves

Anthropic can throttle an account below its limit. When throttles below a plan's limit for one model come on 3 separate days, across 2 or more accounts, within 14 days, oneclaude lowers that limit to the most agents that ran in any of those throttles, and logs the change. `limits.self-correct: false` turns this off, and `limits.override` sets a limit by hand ([Configuration](configuration.md)).

## Where the usage comes from

Every reply from Anthropic carries the account's weekly usage in its rate-limit headers, so oneclaude reads usage from the replies your agents already get, at no extra cost. An account that answered nothing for an hour, `quota.poll-interval`, gets one small usage read. An account whose login expired shows as signed out until it answers again, and `[Sign in]` on its row in `/accounts` logs it in again.

oneclaude routes no Codex requests. It reads each Codex account's weekly usage from ChatGPT's usage endpoint, `chatgpt.com/backend-api/wham/usage`, so the Accounts tab can show it beside the Claude pool.

## Blocks

The proxy blocks a model on an account, or the whole account, after some failed requests, and sends it nothing until the block ends. A block after Anthropic rate limits an account is right, and its row says `throttled`. Other blocks can outlive their cause: the proxy blocks a model on an account for 12 hours after a 404, even when the account answered that model a minute before.

- After a 404 on an account that answered that model within the last day, with no rate limit, spent week or failed login since, oneclaude clears every block the proxy holds on that account at once. A block like that can't be right.
- The mod reads every other block from the proxy's management API with the proxy's management key, and shows it on the account's row and under the prompt. `[Unblock]` clears every block the proxy holds on that account, through the plugin, which logs it. The mod sends only the key the install or its install tab checked the proxy takes, because the proxy bans an address for 30 minutes after 5 refused keys.

## The log

The plugin logs each event that changed where requests go, one sentence each, and keeps 7 days of it, 500 lines at most. The Accounts tab shows the last 24 hours and the dashboard all of it.

- **Rate limits**: `Anthropic rate limited work (429).` once per account until 10 minutes pass without one.
- **Overloads**: `Anthropic returned 529 Overloaded to work.` once per account the same way.
- **404s**: `Anthropic returned 404 Not Found for Opus 5.5 on work.`, then `oneclaude cleared the proxy's blocks on work, set after a 404 for Opus 5.5.` when oneclaude cleared the blocks that followed, once per account the same way.
- **Cleared blocks**: `oneclaude cleared the proxy's blocks on work on request.` after `[Unblock]`, or any call to the unblock route.
- **Refused subagents**: `oneclaude refused a new Opus subagent: every account reached its limit of 19.` once per refusal spell. The line under the prompt says `agent limit reached` until 3 minutes, `subagents.retry-after`, pass without a refusal.
- **Lowered limits**: `oneclaude lowered the Opus agent limit from 19 to 17 after Anthropic rate limited accounts below 19 on 3 separate days.`
- **Logins**: `Anthropic rejected work's login (401).` once, until the account answers again.

Requests Claude Code cancelled, which the proxy answers 499, are left out. So are other one-off failures.

## Claude Seat Pacer

The proxy asks only one scheduler plugin which account to use. So the install turns off [Claude Seat Pacer](https://github.com/yuya-iwabuchi/cpa-plugin-claude-seat-pacer), another scheduler plugin, when it is on, and removing oneclaude turns it back on.

## What oneclaude keeps

The plugin keeps its files in cmod's data folder for oneclaude, `~/.local/share/cmod/data/oneclaude/`, which the install sets as its `data-dir`. cmod deletes the folder when you remove oneclaude. Versions before 0.7.10 kept them in `~/.cli-proxy-api/plugins/oneclaude/`, where the proxy listed each JSON file as a credential. Installing 0.7.10 moves them over before the proxy loads it. A file the new folder already holds stays, and lines an old version logged after the move go at the end of the log.

- `usage.json`: each account's last weekly usage reading, the log, and whether the request log holds the requests from before it;
- `limits.json`: the limits it lowered, and the throttles behind them;
- `agents.json`: each conversation's account;
- `requests.jsonl`: one line per request, kept for 90 days, with its account, model, agent type, project, and tokens, which Usage and the dashboard's history add up;
- `install.key`: a random salt for the account ids it writes there;
- `sessions/<session id>.json`: each session's record, kept 30 days after its last change.

A request's agent type and project come from its session's record, which the oneclaude mod in that session sends the plugin, from whichever machine it runs on. The record holds the folder the session runs in, the type of each subagent it started, and its filters ([Filters](filters.md)). Claude Code sends a custom agent's type only as `custom`, and no folder, so the requests alone can't say either. The mod sends the record as the session starts, as each subagent starts, and as a filter changes, with the proxy's management key. A request from a session that runs no oneclaude mod counts as Not recorded.

Versions before 0.5.1 logged no agent type or project. The first time 0.5.3 or later loads such a log, it fills them in once, in the background on two cores: each old request takes the agent type, project and model of the one request a transcript records with the same tokens within a minute. It reads only the transcripts written since the log's first request, from their end back to it. A request no transcript records stays Not recorded.

The first time 0.7.10 or later loads a data folder, it adds to the start of the log every request the transcripts record from the 90 days before the log's first request, up to a minute before it, so no request counts twice. Each has its model, tokens, agent type and project, and no account, because no transcript says which account answered, so Usage by account counts them as No account recorded. Claude Code writes a reply's lines as it streams, so each request id counts once, at its final tokens.

The plugin adds up the log when the proxy starts, in the background, and counts each request as it comes in, so Usage never waits on the file.

The install step notes whether it set the management key, whether Seat Pacer was on, and the management key the proxy took, in cmod's data folder for oneclaude, `~/.local/share/cmod/data/oneclaude/`. cmod records the one Claude Code setting the mod changed, `env.ANTHROPIC_BASE_URL`, so removing the mod takes out only that value.

## What leaves your machine

Your requests go to Anthropic, as they did before, through the logins the proxy holds. oneclaude adds three kinds of request, each with the account's own login:

- the usage read for a Claude account with no reply for an hour, to `api.anthropic.com`;
- a read of each Claude account's profile at `api.anthropic.com/api/oauth/profile`, for its plan, once a day;
- the weekly usage read for each Codex account, to `chatgpt.com`.

oneclaude sends nothing else. The proxy's control panel downloads its own page from GitHub the first time it opens, which is CLIProxyAPI's doing.

A proxy oneclaude installs listens on `127.0.0.1`, so only this machine reaches it, or on the address a shared `ANTHROPIC_BASE_URL` names, so the machines that share it reach it there. A proxy that was running before keeps its own `server.host` ([Installation](installation.md#1-finding-cliproxyapi)).

## What the proxy serves

The plugin adds these addresses to the proxy, which answer anyone who reaches the proxy, with no key:

- `/v0/resource/plugins/oneclaude/status.json`: the pool, every account, and the last 24 hours of the log, which the mod reads. Each account shows as the part of its address before the `@`.
- `/v0/resource/plugins/oneclaude/history.json`: each account's requests by the hour, and the log, for the last 7 days.
- `/v0/resource/plugins/oneclaude/usage.json`: the Usage table for `?period=quarter`, `month`, `week`, `yesterday`, or `today`, by `?by=account`, `model`, `agent`, `project`, or `time`, which steps by the hour over a day, the week over 90 days, and the day otherwise, sorted by `?units=cost` or `tokens`, with the last 30 days for the chart. The Accounts tab, the dashboard, and `[Optimize usage]` read it.
- `/v0/resource/plugins/oneclaude/dashboard`: the dashboard page, which the control panel shows under oneclaude in its plugin menu.

`POST /v0/management/plugins/oneclaude/unblock` with `{"auth_index": "<the account's>"}` clears every block on that account and logs it. `POST /v0/management/plugins/oneclaude/session` with `{"session", "project", "agents", "filters"}` keeps a session's record, and refuses a filter that isn't an address on the pool's machine. Both need the proxy's management key.
