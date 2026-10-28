# Releasing

A push to `main` that raises the version releases it. The [CI workflow](../.github/workflows/ci.yml) tests the push, then runs `cmod publish`, which builds the `oneclaude` program, attaches it to a GitHub release, and points the mod's marketplace at the new version. Claude Code then updates everyone who installed oneclaude.

## Release a version

1. Raise `version` in `.claude-plugin/plugin.json` and `pluginVersion` in `cli/main.go` to the same number. CI fails when they differ.
2. Add a `## [<version>]` section to `CHANGELOG.md` with what changed for the people who use oneclaude. `cmod publish` refuses a version without one.
3. Run `make -C cli test` and `cmod check .`, then commit.
4. Push to `main`.

CI then:

1. runs `make -C cli test` and `cmod check .`;
2. skips the release when the tag `v<version>` exists, so a push that keeps the version releases nothing;
3. runs `cmod publish .`, which:
   - builds the mod's release from the committed files `package.json` `files` lists, bundles its hooks, and validates it with `claude plugin validate --strict`;
   - runs `make dist` in `cli/` for every machine `package.json`'s `os` and `cpu` allow, which builds `oneclaude-darwin-arm64`, `oneclaude-darwin-x64`, `oneclaude-linux-arm64`, and `oneclaude-linux-x64`, each with its machine's routing plugin inside it;
   - writes `SHA256SUMS` for the release archive and the program;
   - commits `.claude-plugin/marketplace.json`, tags `v<version>`, pushes the tag and the `release` branch, and creates the GitHub release with every file attached and the version's changelog section as its notes.

## Release from your Mac

With Go, zig, Bun, Claude Code, cmod, and `gh` logged in with push access:

```bash
cmod publish --dry-run .
```

The dry run builds the release into a temporary folder and prints what it would release. It changes no tracked file and pushes nothing. Then:

```bash
cmod publish .
```

## Check a release

```bash
gh release view --repo heyJordanParker/oneclaude
cmod update oneclaude
oneclaude --version
```
