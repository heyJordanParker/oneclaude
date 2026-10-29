# Installation

oneclaude is a [cmod](https://github.com/heyJordanParker/cmod) mod: a Claude Code plugin that runs its own install step, with your consent, and ships its own program.

## Requirements

- macOS 13 or later, or Linux with systemd, on arm64 or x64. oneclaude ships a build for each: `oneclaude-darwin-arm64`, `oneclaude-darwin-x64`, `oneclaude-linux-arm64`, and `oneclaude-linux-x64`.
- [Claude Code](https://code.claude.com).
- One or more Claude Pro or Max subscriptions.
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 8 or later listening on `127.0.0.1:8317`, its default port, or on another machine that Claude Code's `ANTHROPIC_BASE_URL` names ([A pool on another machine](#a-pool-on-another-machine)). With no CLIProxyAPI, the install step installs it: with [Homebrew](https://brew.sh) on macOS, and from CLIProxyAPI's own release on Linux.
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

`cmod install` adds oneclaude's marketplace to Claude Code and installs the oneclaude plugin and the cmod plugin it needs, which runs on cmod 5.0.0 or later. Then it sets oneclaude up without asking: it runs `./setup/install.sh`, and `./setup/uninstall.sh` once you remove oneclaude. In Claude Code, a toast above the prompt shows the setup with a progress bar, and in a terminal `cmod install` prints each step. cmod also turns on automatic updates for oneclaude's marketplace, unless you chose otherwise in `/plugin`, Marketplaces.

cmod downloads the build for your machine, such as `oneclaude-darwin-arm64`, from the GitHub release that matches the plugin's version and checks it against the release's `SHA256SUMS`. It keeps the program in `~/.local/share/cmod/bin/oneclaude/<version>/`, and links it as `~/.local/share/cmod/programs/oneclaude` and `~/.local/bin/oneclaude`. The program carries the routing plugin inside it.

A Claude Code session that already runs cmod loads oneclaude by itself once its running turn ends. In any other session, start a new one, or run `/reload-plugins`.

## What the install step changes

The install step runs `oneclaude install`. A progress bar in Claude Code, or the terminal for `cmod install`, shows each step.

### A pool on another machine

One pool can serve every machine you run Claude Code on. Run CLIProxyAPI and oneclaude on one machine, such as a server on your Tailscale network named `devbox`, and set `ANTHROPIC_BASE_URL` to `http://devbox:8317` on each machine.

On a machine whose `ANTHROPIC_BASE_URL` names another machine, the install step prints `Claude Code uses the pool at http://devbox:8317, so oneclaude sets up no proxy here.` and sets up nothing on it. It checks the management key `oneclaude` with one request to that pool, and keeps it once the pool takes it. The line under the prompt, `/accounts`, every button, Usage, and filters then use the pool there.

On the pool's machine, the install step sets `management.allow-remote` to `true`, so the other machines can read and clear blocks and send each session's record.

### 1. Finding CLIProxyAPI

oneclaude looks for the config of the proxy Claude Code talks to, in this order:

1. the `-config` file of the process listening on the port in Claude Code's `ANTHROPIC_BASE_URL`, or on 8317;
2. `/opt/homebrew/etc/cliproxyapi.conf`, `/usr/local/etc/cliproxyapi.conf`, and `/home/linuxbrew/.linuxbrew/etc/cliproxyapi.conf`, where Homebrew keeps it;
3. `~/.cli-proxy-api/config.yaml`.

oneclaude leaves the `server` block of a proxy it finds as it is. CLIProxyAPI listens on every network interface when `server.host` is empty, and the addresses oneclaude adds answer without a key, so anyone on your network could read your accounts' usage. Set `server.host: "127.0.0.1"` in that config to keep the proxy on this machine.

### 2. Installing CLIProxyAPI

This step runs only when no config turns up.

On macOS, oneclaude runs `brew install cliproxyapi` and uses Homebrew's example config.

On Linux, oneclaude downloads the newest CLIProxyAPI release for the machine, `CLIProxyAPI_<version>_linux_<amd64|aarch64>.tar.gz`, and checks it against the SHA-256 digest GitHub keeps for it. It unpacks the proxy into `~/.local/share/cliproxyapi/<version>/`, points `~/.local/share/cliproxyapi/current` at it, and copies the release's example config to `~/.cli-proxy-api/config.yaml`. The systemd user service `cliproxyapi`, in `~/.config/systemd/user/cliproxyapi.service`, runs the proxy and starts it again whenever it stops, and `loginctl enable-linger` keeps it running while you are logged out.

Then oneclaude edits the example config so the proxy is safe to run:

- `server.host` becomes `127.0.0.1`, so only this machine reaches the proxy. When `ANTHROPIC_BASE_URL` names this machine by an address the other machines use too, such as `http://devbox:8317`, `server.host` becomes that address, so they reach the proxy there;
- the example's placeholder client keys, `your-api-key-1` and its siblings, are removed. Claude Code sends no client key of its own;
- `plugins.dir` becomes `~/.cli-proxy-api/plugins`. The example's `plugins` resolves against whichever folder a program runs in, so the proxy and oneclaude would each look in a different folder.

### 3. Adding oneclaude

oneclaude rewrites only two blocks of the proxy config, `plugins` and `management`, and keeps every other byte of the file, its comments included. A config that is a symbolic link stays one.

- It moves the plugin's files from the folder the config named before, or `~/.cli-proxy-api/plugins/oneclaude/` where versions before 0.7.10 kept them, into its data folder, `~/.local/share/cmod/data/oneclaude/`. `oneclaude install --data <folder>` names another.
- It writes the routing plugin to `<plugins.dir>/<os>/<arch>/oneclaude-v<version>.<dylib|so>`, such as `darwin/arm64/oneclaude-v0.9.0.dylib` on a Mac and `linux/amd64/oneclaude-v0.9.0.so` on Linux. `plugins.dir` defaults to `~/.cli-proxy-api/plugins`.
- It sets `plugins.enabled` and `plugins.configs.oneclaude.enabled` to `true`, `plugins.configs.oneclaude.data-dir` to its data folder, and `plugins.configs.oneclaude.store.version` to the new version. The proxy loads the new version without dropping a reply.
- It turns off Claude Seat Pacer, `plugins.configs.claude-seat-pacer`, when it is on. The proxy asks only one scheduler plugin which account to use.
- When the proxy has no management key, the password of its control panel, it sets one, `oneclaude`, saved as a bcrypt hash. The panel answers only this machine while `management.allow-remote` is `false`, the proxy's default.
- A proxy with a management key of its own keeps it.
- It keeps the management key in `management-key` in its data folder once it checked that the proxy takes it: `oneclaude`, when the hash in the proxy's config fits it. The mod sends only that key, because the proxy bans an address for 30 minutes after 5 refused keys. With no key kept, oneclaude's install tab in cmod's Sidebar asks for yours, and checks it with one request to the proxy. A key the proxy refuses later is dropped, and the tab asks again. Until it has a key, the Accounts tab shows no blocks, filters don't run, and Usage counts the session's requests as Not recorded.

oneclaude notes whether it set the management key, and whether Seat Pacer was on, in its data folder, `~/.local/share/cmod/data/oneclaude/`, so removing it takes the key out and turns Seat Pacer back on.

### 4. Bringing over your Claude login

When Claude Code is logged in to a Claude account, oneclaude copies that login into the proxy as its first account. It reads the account from `~/.claude.json`, and the login from Claude Code's keychain item, `Claude Code-credentials`, on macOS, and from `~/.claude/.credentials.json` on Linux. It writes the file the proxy's own login writes, `claude-<id>-<email>.json` in the proxy's `oauth.auth-dir`, readable by you only. An account the proxy already holds stays as it is. A Claude Code that is signed out brings nothing.

### 5. Starting the proxy

The proxy starts last, so it starts with oneclaude and your login in place.

When the proxy is Homebrew's, oneclaude keeps it on the version it was tested with, CLIProxyAPI 8.0.35 or newer:

- an older one gets `brew upgrade cliproxyapi`;
- when nothing listens on its port, oneclaude runs `brew services start cliproxyapi`, so the proxy also starts at every login;
- when the running proxy started before Homebrew put the installed version in place, oneclaude runs `brew services restart cliproxyapi`. Claude Code resends a reply the restart drops, and every conversation keeps its account.

When the proxy is the one oneclaude installed on Linux, an older one than 8.0.35 gets the newest release and `systemctl --user restart cliproxyapi`. Otherwise oneclaude runs `systemctl --user start cliproxyapi`, which leaves a running proxy as it is.

Any other proxy stays as it is, so keep it on 8.0.35 or newer yourself.

### At the next session start

Once the proxy answers with oneclaude's status, the mod sets `env.ANTHROPIC_BASE_URL` to `http://127.0.0.1:8317` in `~/.claude/settings.json`, and keeps every other value there. A base URL you set to another address stays as it is, and the mod shows the pool there.

## Add your other accounts

Run `/accounts` and press `[Add account]`. The proxy's control panel opens at its OAuth login page. The first time, it asks for its password, the management key, `oneclaude` unless you set your own: tick Remember password. Log in to each Claude subscription you have. On a machine that uses a pool on another machine, the login sends your browser to an address on `localhost` that doesn't load: copy that whole address into the panel's Callback URL field and submit it. A Codex account logged in there shows its weekly usage in the Accounts tab too.

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

CLIProxyAPI and every account it holds stay, so nothing you logged in to is lost. `brew uninstall cliproxyapi` removes the proxy on macOS. On Linux, `systemctl --user disable --now cliproxyapi` stops it, and deleting `~/.local/share/cliproxyapi/` and `~/.config/systemd/user/cliproxyapi.service` removes it.

The proxy refreshes the login it copied from Claude Code. If Claude Code says its login expired after you remove oneclaude, run `/login`.

## Check the install

```bash
oneclaude --version
curl -s http://127.0.0.1:8317/v0/resource/plugins/oneclaude/status.json
```

The status answers the version the proxy runs, the pool, and every account. `cmod list` shows whether cmod set oneclaude up.
