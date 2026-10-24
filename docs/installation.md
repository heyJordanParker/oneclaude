# Installation

oneclaude is a [cmod](https://github.com/heyJordanParker/cmod) mod: a Claude Code plugin that runs its own install step, with your consent, and ships its own program.

## Requirements

- macOS on Apple silicon. oneclaude ships one build, `oneclaude-darwin-arm64`, and cmod refuses to set it up on any other machine.
- [Claude Code](https://code.claude.com).
- One or more Claude Pro or Max subscriptions.
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 8 or later listening on `127.0.0.1:8317`, its default port. With no CLIProxyAPI, the install step installs it with [Homebrew](https://brew.sh).
- Node.js with npm, or Bun, to install cmod.

## Install

```bash
npm install -g @cmodjs/cli
cmod install heyJordanParker/oneclaude
```

`bun add -g @cmodjs/cli` installs cmod as well. In Claude Code, these two commands do the same as `cmod install`:

```text
/plugin marketplace add heyJordanParker/oneclaude
/plugin install oneclaude@oneclaude
```

`cmod install` adds oneclaude's marketplace to Claude Code and installs the oneclaude plugin and the cmod plugin it needs. Then it asks before it changes anything. It lists the commands it runs, `./setup/install.sh` now and `./setup/uninstall.sh` when you remove oneclaude, the `oneclaude` program it installs, and what oneclaude asks to do:

- connect to `127.0.0.1`, where the proxy listens;
- change `env.ANTHROPIC_BASE_URL` in your Claude Code settings;
- add text Claude reads and start turns, which `[Optimize usage]` uses to send Claude your usage, once you confirm ([Usage](usage.md#usage)).

An update from a version before 0.5.2 asks only for the last one.

In a terminal it ends with `Set up oneclaude? [y/N]`. In Claude Code the same list opens as the `Install oneclaude` tab in cmod's Sidebar, with `Accept` and `Not now`, and adds `Update oneclaude automatically from the oneclaude marketplace` when you haven't chosen an update setting for it yet.

Once you agree, cmod downloads `oneclaude-darwin-arm64` from the GitHub release that matches the plugin's version and checks it against the release's `SHA256SUMS`. It keeps the program in `~/.local/share/cmod/bin/oneclaude/<version>/`, and links it as `~/.local/share/cmod/programs/oneclaude` and `~/.local/bin/oneclaude`. The program carries the routing plugin inside it.

Start a new Claude Code session, or run `/reload-plugins` in a running one.

## What the install step changes

The install step runs `oneclaude install`. A progress bar in Claude Code, or the terminal for `cmod install`, shows each step.

### 1. Finding CLIProxyAPI

oneclaude looks for the config of the proxy Claude Code talks to, in this order:

1. the `-config` file of the process listening on the port in Claude Code's `ANTHROPIC_BASE_URL`, or on 8317;
2. `/opt/homebrew/etc/cliproxyapi.conf`, `/usr/local/etc/cliproxyapi.conf`, and `/home/linuxbrew/.linuxbrew/etc/cliproxyapi.conf`, where Homebrew keeps it;
3. `~/.cli-proxy-api/config.yaml`.

oneclaude leaves the `server` block of a proxy it finds as it is. CLIProxyAPI listens on every network interface when `server.host` is empty, and the addresses oneclaude adds answer without a key, so anyone on your network could read your accounts' usage. Set `server.host: "127.0.0.1"` in that config to keep the proxy on this Mac.

### 2. Installing CLIProxyAPI

This step runs only when no config turns up. oneclaude runs `brew install cliproxyapi`, then edits Homebrew's example config so the proxy is safe to run:

- `server.host` becomes `127.0.0.1`, so only this Mac reaches the proxy;
- the example's placeholder client keys, `your-api-key-1` and its siblings, are removed. Claude Code sends no client key of its own.

### 3. Starting the proxy

When the proxy is Homebrew's, oneclaude keeps it on the version it was tested with, CLIProxyAPI 8.0.35 or newer, before it changes the proxy's config:

- an older one gets `brew upgrade cliproxyapi`;
- when nothing listens on its port, oneclaude runs `brew services start cliproxyapi`, so the proxy also starts at every login;
- when the running proxy started before Homebrew put the installed version in place, oneclaude runs `brew services restart cliproxyapi`. Claude Code resends a reply the restart drops, and every conversation keeps its account.

A proxy that isn't Homebrew's stays as it is, so keep it on 8.0.35 or newer yourself.

### 4. Adding oneclaude

oneclaude rewrites only two blocks of the proxy config, `plugins` and `management`, and keeps every other byte of the file, its comments included. A config that is a symbolic link stays one.

- It moves the plugin's files from the folder the config named before, or `~/.cli-proxy-api/plugins/oneclaude/` where versions before 0.7.10 kept them, into its data folder, `~/.local/share/cmod/data/oneclaude/`. `oneclaude install --data <folder>` names another.
- It writes the routing plugin to `<plugins.dir>/darwin/arm64/oneclaude-v<version>.dylib`. `plugins.dir` defaults to `~/.cli-proxy-api/plugins`.
- It sets `plugins.enabled` and `plugins.configs.oneclaude.enabled` to `true`, `plugins.configs.oneclaude.data-dir` to its data folder, and `plugins.configs.oneclaude.store.version` to the new version. The proxy loads the new version without dropping a reply.
- It turns off Claude Seat Pacer, `plugins.configs.claude-seat-pacer`, when it is on. The proxy asks only one scheduler plugin which account to use.
- When the proxy has no management key, the password of its control panel, it sets one, `oneclaude`, saved as a bcrypt hash. The dashboard and `[Add account]` sign in with it. The panel answers only this Mac while `management.allow-remote` is `false`, the proxy's default, so keep it that way: the key `oneclaude` is public.
- A proxy with a management key of its own keeps it. oneclaude's install tab in cmod's Sidebar then asks for it once, and again whenever it changes. It checks the key against the hash in the proxy's config, on this Mac, so the proxy never refuses it. Until you enter it, the Accounts tab shows no blocks.

oneclaude notes whether it set the management key, and whether Seat Pacer was on, in its data folder, `~/.local/share/cmod/data/oneclaude/`, so removing it takes the key out and turns Seat Pacer back on.

### 5. Bringing over your Claude login

When Claude Code is logged in to a Claude account, oneclaude copies that login into the proxy as its first account. It reads the account from `~/.claude.json` and the login from Claude Code's keychain item, `Claude Code-credentials`. It writes the file the proxy's own login writes, `claude-<id>-<email>.json` in the proxy's `oauth.auth-dir`, readable by you only. An account the proxy already holds stays as it is.

### At the next session start

Once the proxy answers with oneclaude's status, the mod sets `env.ANTHROPIC_BASE_URL` to `http://127.0.0.1:8317` in `~/.claude/settings.json`, and keeps every other value there. A base URL you set to another address stays as it is, and the mod logs that it left it.

## Add your other accounts

Run `/accounts` and press `[Add account]`. The proxy's control panel opens at its OAuth login page, signed in with the management key. Log in to each Claude subscription you have. A Codex account logged in there shows its weekly usage in the Accounts tab too.

## Update

oneclaude's setup turns on Claude Code's automatic updates for its marketplace, unless you already chose, so Claude Code downloads each new version in the background and loads it at the next launch. To update now:

```bash
cmod update oneclaude
```

Each new version runs the install step again, which adds the new routing plugin beside the old one and switches the proxy to it.

## Remove

```bash
cmod remove oneclaude
```

`/plugin uninstall oneclaude@oneclaude` in Claude Code does the same, and cmod runs the uninstall step at the next session start. Removing oneclaude:

- turns the routing plugin off in the proxy config and deletes its libraries;
- turns Claude Seat Pacer back on, when oneclaude turned it off;
- takes out the management key oneclaude set;
- takes `env.ANTHROPIC_BASE_URL` out of `~/.claude/settings.json`, when it still points at the proxy, so Claude Code talks to Anthropic directly again.

CLIProxyAPI and every account it holds stay, so nothing you logged in to is lost. `brew uninstall cliproxyapi` removes the proxy.

The proxy refreshes the login it copied from Claude Code. If Claude Code says its login expired after you remove oneclaude, run `/login`.

## Check the install

```bash
oneclaude --version
curl -s http://127.0.0.1:8317/v0/resource/plugins/oneclaude/status.json
```

The status answers the version the proxy runs, the pool, and every account. `cmod list` shows whether cmod set oneclaude up.
