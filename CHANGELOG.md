# Changelog

What changed in each version of oneclaude, for the people who use it. cmod publish releases the section for the version, and the Updated toast and /mods show it.

## [0.6.1]

### Changed
- Weekly resets draws only each account's current week, as one bar on a faint line across the days: dark up to now, gray while the account's quota lasts at its pace so far this week, and faint from where it would run out until the reset. The orange is gone, and red again means only a nearly empty account.

## [0.6.0]

### Added
- Weekly resets in `/accounts` draws each Claude account's weeks as rounded bars on the days around now, cut at each reset, with a line at now through every account, soonest reset first, and how long until the reset and how much the account has left until then.

## [0.5.3]

### Fixed
- Usage names the agent type and project of requests logged before oneclaude recorded them, from Claude Code's transcripts, once, in the background. Requests no transcript records stay Not recorded.

## [0.5.2]

### Added
- Usage in `/accounts` adds up what the pool used today, yesterday, or over 7 or 30 days, by account, model, agent type, project, or day. Each row splits into input, output, cache writes, and cache reads, then how much of its input came from the cache, its share, and its total, in dollars at API list prices or in tokens.
- Usage per day in `/accounts` draws the last 30 days, one column a day.
- `[Optimize usage]` asks your agent to optimize your usage, with your last 30 days of usage, after you confirm. It asks for one new permission: to add text Claude reads.
- The dashboard shows the same Usage table and a daily chart stacked by the chosen breakdown.
- The request log records each request's model, subagent type, and project, and usage.json serves the Usage table for any period and breakdown.

## [0.4.0]

### Added
- oneclaude installs on any Mac with Apple silicon: `cmod install heyJordanParker/oneclaude` downloads one program from the GitHub release, checked against its `SHA256SUMS`, with nothing to build.
- `oneclaude install` and `oneclaude remove` in a terminal add the routing plugin to the proxy and take it out again, and `oneclaude --version` names the version.
- Documentation for installing, using, and configuring oneclaude, and how it picks an account.

### Fixed
- An expired login's warning says to log it in again with `[Add account]` in `/accounts`.

## [0.3.3]

### Changed
- oneclaude runs on cmod 2.0.

## [0.3.2]

### Changed
- The accounts pane's `[Add account]` opens the proxy panel's OAuth login, signed in, in place of a second link to the dashboard.
- Bars no longer brighten under the pointer, because nothing happens when they are pressed.

## [0.3.1]

### Added
- Installing oneclaude points Claude Code at the proxy, running sessions included, and removing it points Claude Code back. Every other environment setting stays as it was.
- Installing oneclaude brings the account Claude Code is logged in to into the proxy as its first account.
- The proxy's management key becomes `oneclaude`, and `[Open dashboard]` and `[Manage accounts]` open the panel already signed in. Removing oneclaude puts the old key back.
- The accounts pane shows each Codex account's weekly usage and refill.

### Changed
- Every bar is a rounded two-tone pill, exact to an eighth of a cell, and the color change marks pace. Bars glide to a new reading, grow when the pane opens, and brighten under the pointer.
- A refill reads in days and hours under 2 days, and in hours and minutes under a day.
- An empty account's bar shows no pace.
- Each section title has an empty line under it, and a narrow pane puts each account's details under its bar.

## [0.2.2]

### Added
- A web dashboard in the proxy's panel: the pool, every account's usage, pace, refill and agents, warnings, 7 days of requests, the proxy's traffic, credentials and settings, and adding, disabling or logging in an account again.
- The accounts pane opens the dashboard and the panel's accounts page.
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
