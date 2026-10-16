# WHY

oneclaude runs every Claude subscription account a person has as one pool: a CLIProxyAPI plugin places each Claude Code agent on an account, and a cmod mod shows the pool's status under the prompt.

# Facts

- `plugin/` is the CLIProxyAPI plugin, a Go library built with `-buildmode=c-shared`. `make -C plugin build` writes `.target/dist/oneclaude-v<version>.dylib`, and `make -C plugin test` runs its tests.
- The proxy loads a plugin from `<plugins.dir>/darwin/arm64/<id>-v<version>.dylib`, and the plugin id `oneclaude` comes from that file name. A plugin with no `plugins.configs.oneclaude` block in the proxy config stays off.
- The proxy picks up a new plugin file only on a config reload or a restart, and then hot reloads it with no dropped reply. It deletes older versions of a plugin's file at startup. Never overwrite a loaded library in place: copy the new build under a new version name.
- The proxy loads the version `plugins.configs.oneclaude.store.version` names, as its Plugin Store does. cmod runs `setup/install.sh` on install and on every new version: it builds the plugin, then `plugin/cmd/install` copies it into the proxy's plugin folder and sets that key, so a version bump in `plugin/main.go` and `.claude-plugin/plugin.json` together, then `cmod link .`, takes a build live.
- `plugin/cmd/install` finds the proxy config from the `-config` of the process on `ANTHROPIC_BASE_URL`'s port, else Homebrew's `etc/cliproxyapi.conf`, and rewrites only the config's `plugins` block, leaving every other byte as it was.
- The proxy consults only one scheduler plugin, the first by priority and then by id, so Seat Pacer must be off for oneclaude to route.
- `plugin/main.go` and `plugin/internal/runtime/{wire,envelope,host}.go` adapt Seat Pacer's MIT-licensed C boundary, credited in `plugin/NOTICE`.
- The plugin serves its status without a key at `/v0/resource/plugins/oneclaude/status.json`, with account names cut to the local part of their address.
- The plugin keeps `usage.json`, `limits.json`, `agents.json`, `install.key`, and `requests.jsonl` in `~/.cli-proxy-api/plugins/oneclaude/`, or in its `data-dir` setting. `agents.json` holds each conversation's account, so a reload keeps its cache.
- The repository root is a cmod mod: `src/mod.tsx` is the `defineMod`, `hooks/register.ts` only registers it, and `tests/` holds its `bun test` suite. `node_modules/@cmodjs/core/docs/` is the cmod documentation for the installed version.
- `cmod check .` runs every check on the mod. It skips `.target/`, so every build output and the dev proxy live there.
- The dev proxy is CLIProxyAPI v8.0.0 built from source into `.target/dev/cliproxyapi`, run with `dev/config.yaml` on port 8318 against `plugin/cmd/fakeanthropic` on port 8319. `ONECLAUDE_DEV_PROXY=1 go test -run DevProxy` in `plugin/` checks routing through it.
- The live proxy on port 8317 serves the Architect's running agents. Plugin builds go to the dev proxy first.
