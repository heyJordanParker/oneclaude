# oneclaude

**Every Claude subscription you have, as one pool.** oneclaude sends each new Claude Code conversation to the account that most needs spending: the one with the most weekly quota left per hour until its week resets, so no account's quota goes to waste at its reset. It keeps each conversation on its account while its prompt cache is warm, and shows the whole pool under the prompt.

```text
████████▊███▋███████  63% · 19% over pace · next refill in 2d · 14 agents [+]
```

`/accounts` opens the pool in a pane beside the conversation:

```text
Combined usage    ████████▊███▋███████  63%
                  19% over pace · next refill in 2d frees 17% · 14 agents

Claude accounts

work              ██████████▉█████████  70%
                  15% over pace · refills in 3d · 2 opus

personal          ███████▋███▎████████  56%
                  18% over pace · refills in 4d · idle

spare             ████████████████████  empty
                  refills in 2d · idle

Codex accounts

work              █▋████▌█████████████  8%
                  24% under pace · refills in 5d

Warnings in the last 24 hours

None

[Open dashboard]  [Add account]
```

oneclaude has two parts:

- **A routing plugin for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)**, the local proxy that holds your accounts. The plugin picks the account for each conversation, holds back a new subagent when every account is full, and serves a dashboard inside the proxy's own control panel.
- **A Claude Code mod** built with [cmod](https://github.com/heyJordanParker/cmod). It points Claude Code at the proxy and draws the pool under the prompt.

## Install

You need:

- macOS on Apple silicon
- [Claude Code](https://code.claude.com)
- one or more Claude Pro or Max subscriptions
- [Homebrew](https://brew.sh), unless CLIProxyAPI is already running
- Node.js with npm, or Bun, to install cmod

Install cmod once, then oneclaude:

```bash
npm install -g @cmodjs/cli
cmod install heyJordanParker/oneclaude
```

cmod lists what oneclaude will change and asks you to agree. Then it downloads the `oneclaude` program from this repository's release and checks it against the release's `SHA256SUMS`, and the install step:

1. finds CLIProxyAPI, or installs it with Homebrew and keeps it on this machine only;
2. adds the routing plugin to the proxy;
3. copies the Claude account Claude Code is logged in to into the proxy, as its first account;
4. starts the proxy.

Start a new Claude Code session. oneclaude points Claude Code at the proxy, and the pool shows under the prompt.

You can also install it from inside Claude Code:

```text
/plugin marketplace add heyJordanParker/oneclaude
/plugin install oneclaude@oneclaude
```

[Installation](docs/installation.md) covers each step, what it changes on your machine, updates, and removal.

## Add your other accounts

Run `/accounts` and press `[Add account]`. The proxy's control panel opens, already signed in, at its OAuth login page. Log in to each Claude subscription you have. A Codex (ChatGPT) account added there shows its weekly usage too.

## Use it

Nothing changes in how you work. Every new conversation goes to the account that most needs spending, and a running conversation stays where it is.

- **The line under the prompt** shows the pool's weekly usage, how far ahead or behind an even pace it is, the next refill, and the agents running now. `[+]` opens the pane.
- **`/accounts`** shows each account, the Codex accounts, the pool's usage, and the warnings of the last 24 hours.
- **Usage** in `/accounts` adds up what the pool used today, yesterday, or over 7 or 30 days, by account, model, agent type, project, or day: input, output, cache writes, and cache reads, at API prices or in tokens. `[Optimize usage]` asks Claude to make it cost less.
- **`[Open dashboard]`** opens the dashboard in the proxy's control panel: usage, 7 days of requests, each account's agents, the proxy's traffic, and adding, turning off, or logging in again to an account.

[Usage](docs/usage.md) explains every number on screen.

## Documentation

- [Installation](docs/installation.md): what the install changes, updates, and removal
- [Usage](docs/usage.md): the line under the prompt, the pane, its Usage table, and the dashboard
- [How it works](docs/how-it-works.md): how oneclaude picks an account, holds back subagents, and reads usage
- [Configuration](docs/configuration.md): every setting of the routing plugin
- [Contributing](CONTRIBUTING.md): build, test, and run oneclaude from a checkout
- [Releasing](docs/releasing.md): publish a version

## License

[MIT](LICENSE). The proxy plugin's C boundary is adapted from [cpa-plugin-claude-seat-pacer](https://github.com/yuya-iwabuchi/cpa-plugin-claude-seat-pacer), credited in [cli/NOTICE](cli/NOTICE).
