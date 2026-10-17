# How it works

oneclaude runs every Claude subscription you have as one pool. Claude Code sends each request to [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) on this Mac, which holds a login for each of your accounts. oneclaude is the proxy's scheduler plugin: for each request, the proxy asks it which account to use.

```text
Claude Code ──request──> CLIProxyAPI on 127.0.0.1:8317 ──one of your logins──> Anthropic
                               │
                               │ asks which account
                               ▼
                         oneclaude plugin ──status.json──> the oneclaude mod in Claude Code
```

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

Anthropic can throttle an account below its limit. When throttles below a plan's limit for one model come on 3 separate days, across 2 or more accounts, within 14 days, oneclaude lowers that limit to the most agents that ran in any of those throttles. The pane then lists the change under its warnings. `limits.self-correct: false` turns this off, and `limits.override` sets a limit by hand ([Configuration](configuration.md)).

## Where the usage comes from

Every reply from Anthropic carries the account's weekly usage in its rate-limit headers, so oneclaude reads usage from the replies your agents already get, at no extra cost. An account that answered nothing for an hour, `quota.poll-interval`, gets one small usage read. An account whose login expired raises a warning that names it, and you log it in again with `[Add account]` in `/accounts`.

oneclaude routes no Codex requests. It reads each Codex account's weekly usage from ChatGPT's usage endpoint, `chatgpt.com/backend-api/wham/usage`, so the pane can show it beside the Claude pool.

## The warnings

The pane and the dashboard list the warnings of the last 24 hours:

- **throttled**: Anthropic throttled an account, with the number of that model's agents running on it.
- **overloaded**: Anthropic answered that it was overloaded, with the same count.
- **refused**: oneclaude held back a new subagent, because every account was at its limit for the subagent's model.
- **limit**: oneclaude lowered a plan's limit after throttles below it.
- **login**: an account's login expired.

## Claude Seat Pacer

The proxy asks only one scheduler plugin which account to use. So the install turns off [Claude Seat Pacer](https://github.com/yuya-iwabuchi/cpa-plugin-claude-seat-pacer), another scheduler plugin, when it is on, and removing oneclaude turns it back on.

## What oneclaude keeps

The plugin keeps its files in `~/.cli-proxy-api/plugins/oneclaude/`, or in its `data-dir` setting:

- `usage.json`: each account's last weekly usage reading;
- `limits.json`: the limits it lowered, and the throttles behind them;
- `agents.json`: each conversation's account;
- `requests.jsonl`: one line per request, kept for 90 days, which the dashboard's 7 days of history reads;
- `install.key`: a random salt for the account ids it writes there.

The install step keeps the management key it replaced, and whether Seat Pacer was on, in cmod's data folder for oneclaude, `~/.local/share/cmod/data/oneclaude/`. cmod records the one Claude Code setting the mod changed, `env.ANTHROPIC_BASE_URL`, so removing the mod takes out only that value.

## What leaves your Mac

Your requests go to Anthropic, as they did before, through the logins the proxy holds. oneclaude adds three kinds of request, each with the account's own login:

- the usage read for a Claude account with no reply for an hour, to `api.anthropic.com`;
- a read of each Claude account's profile at `api.anthropic.com/api/oauth/profile`, for its plan, once a day;
- the weekly usage read for each Codex account, to `chatgpt.com`.

oneclaude sends nothing else. The proxy's control panel downloads its own page from GitHub the first time it opens, which is CLIProxyAPI's doing.

A proxy oneclaude installs listens on `127.0.0.1`, so only this Mac reaches it. A proxy that was running before keeps its own `server.host` ([Installation](installation.md#1-finding-cliproxyapi)).

## What the proxy serves

The plugin adds these addresses to the proxy, which answer anyone who reaches the proxy, with no key:

- `/v0/resource/plugins/oneclaude/status.json`: the pool, every account, and the warnings, which the mod reads. Each account shows as the part of its address before the `@`.
- `/v0/resource/plugins/oneclaude/history.json`: each account's requests by the hour for the last 7 days.
- `/v0/resource/plugins/oneclaude/dashboard`: the dashboard page, which the control panel shows under oneclaude in its plugin menu.
