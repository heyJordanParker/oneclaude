# Changelog

What changed in each version of oneclaude, for the people who use it. cmod publish releases the section for the version, and the Updated toast and /mods show it.

## [Unreleased]

### Added
- On a machine with no CLIProxyAPI, installing oneclaude installs it with Homebrew, keeps it on this machine only, and starts it.

### Changed
- A bar's color shows its usage, gray until the last 5% and red after. The pace text shows the pace: no color within 5 points, green under, orange over, red more than 25 points over.
- The line under the prompt draws thin-line bars, and the accounts pane half-height bars.

## [0.2.1]

### Fixed
- An update of oneclaude keeps every running conversation on its account, so its prompt cache keeps hitting.

## [0.2.0]

### Added
- Installing oneclaude adds its routing plugin to the CLIProxyAPI that Claude Code talks to, and each update switches the proxy to the new version without dropping a reply.
- Each account shows its own pace, and the bar of an empty account is red.
- `[+]` after the line under the prompt opens the accounts pane, and `[-]` closes it.

### Changed
- The accounts pane leads with oneclaude's total usage, and an account's agents read as `3 opus`.

## [0.1.0]

### Added
- Every Claude account runs as one pool: each new conversation goes to the account with the most weekly quota left per hour until its reset, and stays there while its cache is warm.
- A new subagent waits when every account is at its limit for its model, and the agent that started it is told to retry in 3 minutes.
- A bar under the prompt shows the pool's weekly usage, its pace, the next refill, and the agents running.
- /accounts shows the pool, every account, and the warnings of the last 24 hours.
