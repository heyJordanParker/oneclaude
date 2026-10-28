# Contributing

## Layout

```text
oneclaude/
├── cli/                     the oneclaude program and the routing plugin, in Go
│   ├── main.go              the plugin's C boundary, the library CLIProxyAPI loads
│   ├── internal/            routing, limits, usage, the status, and the dashboard
│   ├── cmd/oneclaude/       the program cmod runs to install and remove the plugin
│   ├── cmd/fakeanthropic/   a stand-in for Anthropic that the dev proxy talks to
│   └── Makefile             build, dist, test, and vet
├── src/                     the Claude Code mod: the line under the prompt and the Accounts tab
├── hooks/                   registers the mod with Claude Code
├── setup/                   the install and uninstall steps cmod runs
├── tests/                   the mod's tests
├── dev/config.yaml          the dev proxy's config
└── docs/                    the documentation
```

## What you need

- macOS on Apple silicon, with the Xcode command line tools for cgo
- [Go](https://go.dev) 1.25 or later: `brew install go`
- [zig](https://ziglang.org), which builds the routing plugin for Linux: `brew install zig`
- [Bun](https://bun.sh) 1.2 or later
- [Claude Code](https://code.claude.com), and cmod: `npm install -g @cmodjs/cli`

## Run oneclaude from a checkout

```bash
git clone https://github.com/heyJordanParker/oneclaude
cd oneclaude
bun install
cmod link .
```

`cmod link .` builds the `oneclaude` program for this machine with `make dist` in `cli/`, links it into cmod's programs folder and `~/.local/bin`, loads the checkout as the oneclaude mod in every new Claude Code session, and runs the install step against the proxy Claude Code talks to. To try a change, raise `version` in `.claude-plugin/plugin.json` and `pluginVersion` in `cli/main.go` together, then run `cmod link .` again. The proxy loads the new plugin with no dropped reply. A version already in place is never overwritten, because the proxy may have it loaded.

`cmod unlink .` stops loading the checkout and runs the uninstall step, as a removal does: oneclaude leaves the proxy, and Claude Code talks to Anthropic directly again.

## Run the gate

Every change passes both, from the repository root:

```bash
make -C cli test
cmod check .
```

- `make -C cli test` builds the routing plugin, copies it into `cli/cmd/oneclaude/` where the program embeds it, and runs every Go test with the race detector. A bare `go test ./...` fails until that copy exists.
- `cmod check .` checks the mod's layout, steps, permissions, and imports, validates it with Claude Code, type-checks and lints it, and runs `bun test`. It has Claude Code write `.claude-plugin/types/`, which git ignores, when it is missing.

## Test against a dev proxy

The dev proxy is a second CLIProxyAPI on port 8318, which talks to a stand-in for Anthropic on port 8319, so routing tests never spend a real account. Run each command from the repository root, in its own terminal:

```bash
make -C cli build
mkdir -p .target/dev/plugins/darwin/arm64
cp .target/dist/darwin-arm64/oneclaude-v*.dylib .target/dev/plugins/darwin/arm64/
go run -C cli ./cmd/fakeanthropic
MANAGEMENT_PASSWORD=dev "$(brew --prefix)/opt/cliproxyapi/bin/cliproxyapi" -config dev/config.yaml
```

Then run the routing tests against it:

```bash
cd cli
ONECLAUDE_DEV_PROXY=1 go test -run DevProxy -v .
```

`dev/config.yaml` names its folders relative to the repository root, so the proxy runs from there. It keeps its logins in `~/.cli-proxy-api-dev`, and downloads its control panel into `dev/static/`, which git ignores. The subagent test needs 5 minutes after an earlier run, while that run's agents still count as active.

## Change the mod

`node_modules/@cmodjs/core/docs/` holds the cmod documentation for the installed version. Every change to what the mod shows gets a test in `tests/mod.test.ts`, which draws the mod in cmod's test kit at 80 columns.

A tmux text capture drops the Nerd Font glyphs at each end of a bar, so check a bar's ends on screen, never in a capture.

## Write the changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com). Its sections are the release notes, and Claude Code's update notice shows them to the people who use oneclaude, so write what changed for them, not for the code. [Releasing](docs/releasing.md) publishes a version.
