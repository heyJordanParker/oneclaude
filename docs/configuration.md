# Configuration

oneclaude works with no settings. Its routing plugin reads a few from its block in the proxy config, `plugins.configs.oneclaude`. The install finds that file ([Installation](installation.md#1-finding-cliproxyapi)), Homebrew keeps it at `/opt/homebrew/etc/cliproxyapi.conf`, and the Linux install at `~/.cli-proxy-api/config.yaml`. The proxy's control panel shows the `limits`, `subagents`, `affinity`, and `quota` settings on oneclaude's plugin page, and saves them to the same block.

```yaml
plugins:
  enabled: true
  configs:
    oneclaude:
      enabled: true
      store:
        version: 0.4.0               # the install sets this, leave it
      limits:
        enabled: true
        self-correct: true
        override:
          default_claude_max_20x:
            opus: 12
      subagents:
        retry-after: 3m
      affinity:
        ttl: 1h
      quota:
        poll-interval: 1h
```

## Settings

### `enabled`

Whether oneclaude routes at all. The install sets it to `true`, and removing oneclaude sets it to `false`. With it off, the proxy picks accounts by its own `routing.strategy`.

### `limits.enabled`

Default `true`. With it on, a new subagent goes only to an account under its limit for the subagent's model, and waits when every account is full ([How it works](how-it-works.md#why-a-subagent-can-wait)). With it off, oneclaude never holds a subagent back.

### `limits.self-correct`

Default `true`. With it on, oneclaude lowers a plan's limit for one model after throttles below it on 3 separate days on 2 or more accounts. Turn it off to keep the limits fixed.

### `limits.override`

Replaces the limit for a plan and a model family, by the most agents of that model one account runs at once. The plan is the name `status.json` gives each account, such as `default_claude_max_20x`. The families are `opus`, `sonnet`, `haiku`, and `fable`.

```yaml
limits:
  override:
    default_claude_max_20x:
      opus: 12
      fable: 4
```

An override wins over both the default and a limit oneclaude lowered.

### `subagents.retry-after`

Default `3m`, at least `1m`. How long a held-back subagent is told to wait before it starts again.

### `affinity.ttl`

Default `1h`, at least `1m`. A conversation idle for longer than this can move to another account. Anthropic keeps a prompt cache for an hour at most, so a shorter time can move a conversation whose cache still hits.

### `quota.poll-interval`

Default `1h`, at least `10m`. An account with no reply for this long gets one usage read.

### `data-dir`

The folder oneclaude keeps its files in ([How it works](how-it-works.md#what-oneclaude-keeps)). The install sets it to cmod's data folder for oneclaude, `~/.local/share/cmod/data/oneclaude`. With none set, oneclaude keeps no files.

Durations read as Go writes them, such as `90s`, `5m`, or `1h30m`. A duration below its floor, or one that doesn't read, falls back to the default.
