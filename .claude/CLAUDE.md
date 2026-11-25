# WHY

oneclaude runs every Claude subscription account a person has as one pool: a CLIProxyAPI plugin places each Claude Code agent on an account, and a cmod mod shows the pool's status under the prompt.

# Facts

- The repository root is the cmod mod, with its `bun test` suite in `tests/`, and `cli/` is the Go plugin and the `oneclaude` program. `node_modules/@cmodjs/core/docs/` documents the installed cmod.
- `cmod check .` runs every check on the mod and skips `.target/`, where every build output and the dev proxy live.
- `cmd/oneclaude` embeds `cli/cmd/oneclaude/plugin.lib`, which git ignores and `make -C cli build` writes, so a bare `go test ./...` fails before a build.
- The live proxy on port 8317 serves the Architect's running agents.
- The proxy loads a new plugin file only on a config reload or a restart, and deletes older versions at startup. `oneclaude install` never replaces a library already in the plugin folder, so a fix goes live only under a new version in `cli/main.go` and `.claude-plugin/plugin.json`.
- `cliproxyapi` run without `-config dev/config.yaml`, even with `--version`, loads the live config and deletes the older plugin libraries in its plugin folder.
- The proxy consults only one scheduler plugin, so Seat Pacer must be off for oneclaude to route.
- The proxy tells plugins of no credential change and hands its `auth-dir` only to provider plugins, so the plugin watches that folder itself. It lists every JSON file under `auth-dir` as a credential, so the plugin keeps its own files in its `data-dir`.
- Anthropic's refresh tokens work once, so Claude Code stays the only program that refreshes its login. A copy of that login in the pool carries no refresh token, and the plugin never runs Claude Code, as `claude auth status` can spend the refresh token without saving the new one.
- The proxy bans an address for 30 minutes after 5 refused management keys, and checks each key with bcrypt, about 144 ms per request. So the mod sends only a key the install checked, and reads `/v0/management/auth-files` only when the plugin names a new blocks change.
- Plugin routes answer only under `/v0/management`, not the panel's `/v8/management`.
- The proxy HTML-escapes the strings of a plugin's management answers, so an error the mod shows holds no quote, ampersand, or angle bracket.
- The proxy writes Anthropic's errors without calling any plugin, so filters never see them. A response's interceptor calls share one lifecycle `RequestID`, while each upstream attempt's usage record gets a new one.
- Claude Code ends every `$.http.fetch` of a mod at 30 seconds.
- Claude Code sends a custom subagent's type as `custom` and no project, so each session's mod posts a session record that labels its requests.
- Anthropic fills accounts on the same plan at different rates, so `pace` counts each account at its own quota per dollar.
- The plugin writes `usage.json` back from memory on every save, so a hand edit to it holds only if it lands just before a new version loads.
- The Architect's sessions run the mod linked from this checkout. An edit under `src/` reaches an open session only after Reload on its `Plugins changed` toast, so open sessions can run an older mod than the pool's plugin.
- Herdr draws the Accounts view in a proportional font, so its columns align with a Box's `minWidth`, never with spaces.
- A tmux capture of Claude Code drops the Nerd Font glyphs Ghostty draws, so a capture never proves a glyph is missing.
- macOS lets a process reach a local network address, such as an OrbStack machine's `192.168.139.x`, by the Local Network access of the terminal app that started its process tree, and refuses with `EHOSTUNREACH`. `/usr/bin/curl` reaches the address regardless, so curl proves nothing for oneclaude.
- `README.md` links every page of `docs/`, the user documentation.

# Dev proxy

- The dev proxy is Homebrew's `cliproxyapi` run from the repository root with `-config dev/config.yaml` on port 8318, against `cli/cmd/fakeanthropic` on port 8319. Start it with `MANAGEMENT_PASSWORD=dev`, which its session records and management panel need, and `CLAUDE_CONFIG_DIR=.target/dev/home/.claude`, so its first load imports no real transcripts and follows no real login.
- `ONECLAUDE_DEV_PROXY=1 go test -run DevProxy` in `cli/` checks routing through it. Its subagent test needs 5 minutes since the last run, and its throttle test cools every Opus credential, so run the filter tests apart with `-run DevProxyAFilter`.
- A dev Claude Code session starts only through `bun dev/session.ts <name> [mod folder] [--pool <url>]`, which gives it a home with no Claude login.
- `fakeanthropic` answers a request holding `throttle` with 429 and one holding `oauthrefused` with Anthropic's 403 `permission_error`.
- A `claude-*` file in `.target/dev/auth` sends its requests to `api.anthropic.com`, so a test login only ever answers 401. The dev proxy's api-key credentials have no auth file, so blocks show only for OAuth accounts.

### Run a plugin build on the dev proxy before the live one

### Change the page in `docs/` that describes a change in the same commit
