# Changelog

What changed in each version of oneclaude, for the people who use it. cmod publish releases the section for the version, and cmod's Settings shows it.

## [0.10.3]

### Fixed
- When the pool clears nothing, `[Retry]` shows `Could not clear <account>'s blocks` with the cause, where it said only `oneclaude could not retry <account>`: no response from the pool, `401 Unauthorized` for a rejected management key, `404 Not Found` with the pool's oneclaude version when the session runs another version, or the proxy's status and error. A session open since before 0.10.1 still shows `[Unblock]`, which the pool no longer answers, until you press Reload on cmod's `Plugins changed` toast.

## [0.10.2]

### Changed
- The pool's pace learns each account's quota per dollar from its last week and this one, where it took the last 3 days. Anthropic fills accounts on the same plan at different rates, up to half again as fast for the same requests, so each account counts at its own. A pace shows from the first request after days idle or after every week reset, where it needed a tenth of a week's quota moved in the last 3 days, and a week the log holds only part of counts from its first reading.
- oneclaude runs on cmod 6.0.2. `[Open dashboard]`, `[Add account]` and `[Sign in]` are buttons that open their page on your own device, and over ssh copy the link.

### Fixed
- Usage prices a subagent's cache writes at the 5-minute rate, the cache Claude Code writes them to, where it charged the 1-hour rate. Subagents spend most of each account's dollars, so Usage, `[Optimize usage]` and the pace overstated them.

## [0.10.1]

### Changed
- Every account in trouble shows what is wrong in a word or two and the one button that fixes it, in `/accounts` and on the dashboard: `signed out` with `[Sign in]`, `refused` with `[Retry]`, and `blocked until 14:00` with `[Retry]`, which replaces `[Unblock]`. `[Retry]` clears the proxy's blocks on the account and asks Anthropic about it once, so an account refused after a failed payment comes back the moment you fix the payment. Before, a refused account offered only `[Sign in]`, which a refusal of the organization never needs, and printed Anthropic's whole reason under the row. The reason stays in the log, and in the dashboard badge's tooltip. A refused account still comes back by itself within 30 minutes.

### Fixed
- An account you add joins the pool within a second. oneclaude asked the proxy for its logins the moment the new login file appeared, before the proxy had read the file itself, so the new account was missing until the proxy wrote the file again or oneclaude listed the logins again, up to 10 minutes later. oneclaude now asks again until the proxy lists it.

## [0.10.0]

### Changed
- The pool's pace is live: how fast your requests of the last 15 minutes spend quota, against what every account has left until its reset. Start more agents and it goes over pace within a minute, stop them and it falls under. Before, it compared the week's usage so far with an even spend, so a few heavy days held it over pace for the rest of the week, whatever ran now. oneclaude reads what a request spends from its list price and each account's quota per dollar over the last 3 days, which on real traffic predicted 3 hours of quota within 10%, half the time. A new install shows no pace until its requests used a tenth of one account's week. The line under the prompt, Combined usage in `/accounts` and the dashboard show it. Each account's row keeps its pace so far this week.

## [0.9.7]

### Fixed
- A new session no longer shows `Hears nothing from session …` or `Changes nothing in session …` as error toasts. oneclaude now runs on cmod 5.13.1, which writes those to the Log as warnings, and its toasts put ✕ at the right end and every other button on the left.

## [0.9.6]

### Fixed
- A request that gets no answer at all logs why, such as `oneclaude couldn't reach Anthropic: the DNS lookup of api.anthropic.com timed out.`, once for the whole pool until 10 minutes pass without one. Before, the log blamed Anthropic with `Anthropic returned 0 to work.`, which named no cause, once for every account the proxy tried, so one dropped internet connection filled it with a line per account every 10 seconds.
- A request the proxy gave up on at its own deadline logs `oneclaude couldn't reach Anthropic: the request timed out.` the same way. Before, the log said `Anthropic returned 504 Gateway Timeout to work.`, though Anthropic never answered. Every other 504, such as one Anthropic sends, still logs as one.

## [0.9.5]

### Changed
- The dashboard's `Add account` and `Sign in` open the panel's OAuth login page, as `[Add account]` and `[Sign in]` in `/accounts` do. The dashboard's own login, with its field for a callback address, is gone.

### Fixed
- Copying your Claude login into the pool no longer logs Claude Code out. The copy held Claude Code's refresh token, so the proxy refreshed the login hours before Claude Code would. Anthropic's refresh tokens work once, so Claude Code's next refresh was refused, Claude Code emptied its own login, and every session stopped with `Login expired · Please run /login`. The copy now holds Claude Code's access token only, and follows each refresh Claude Code makes within a minute, or at once when Anthropic turns the old token away. A copy from an earlier install drops its refresh token at the first minute. While no Claude Code runs past the token's expiry, the copy shows signed out until Claude Code next refreshes; `[Sign in]` on it gives the pool a login of its own.
- An account you sign in again shows signed in under the prompt and in `/accounts` within a second. oneclaude now watches the proxy's login folder, which the install names in the new `auth-dir` setting: a written, added or removed login lists the accounts again, clears the proxy's blocks on a signed-out or refused account whose login changed, and reads at once the usage of each account that is signed out, refused or not read yet. It works from the first login of a new pool. Before, it stayed signed out until its next usage read, up to 30 minutes.
- An account Anthropic refuses, such as with `OAuth authentication is currently not allowed for this organization.`, shows as refused with that reason under the prompt, in `/accounts`, on the dashboard and in the log, and new conversations skip it. Before, it looked healthy with a reading hours old while every request to it failed. A request Anthropic answers 401 now signs its account out the same way.
- An account whose login file is gone leaves the pool. Before, its row stayed.
- The log says `Anthropic accepted work's login again.` when a signed-out or refused account answers again.
- The install edits the config of the proxy Claude Code talks to when that proxy runs with a relative `-config`, such as `dev/config.yaml`. It read the path from the folder the install ran in, so it could edit another folder's config, copy your login into a folder another proxy reads, and put the routing plugin where no proxy loads it. Relative folders in the config now count from the proxy's own folder too.
- The install finds a running proxy's config on Linux without `lsof`, which a minimal Ubuntu lacks.

## [0.9.4]

### Changed
- The line under the prompt and `/accounts` change within a second of the pool's own change, in every open session. Each session asks the pool for its next change, and the pool answers when it comes, or after 20 seconds with no change. Before, each session read the pool every 15 seconds.
- A pool that stops answering shows `pool unreachable` once 25 seconds pass without the answer it promised, and the warning goes within 16 seconds of the pool answering again, with no input. A session asks a pool that failed it again after 1, 2, 4, 8, then every 16 seconds.
- The proxy's blocks are read only after an event that may change them, a failed request, the first answer after one, or an unblock, and by one session per machine, which shares its reading with the others. Before, the open sessions read them every 14 seconds, and the proxy checked the management key with bcrypt for each reading. A block whose time is up leaves the line by itself.
- A session's record goes again at the next status the pool answers when the pool didn't take it, and a record of the session `/clear` starts never waits on an earlier post.

## [0.9.3]

### Fixed
- The line under the prompt stays when the pool stops answering. It keeps the last reading with `pool unreachable since <time>`, and the warning goes away by itself once the pool answers again. Before, the line turned into `oneclaude: proxy down`, and one refresh that never ended froze it, or left it blank, for the rest of the session.
- A session that starts while the pool doesn't answer shows the last reading any session on the machine made.
- Usage labels a conversation's requests with its project and agent types after `/clear`, `/resume`, a fork and `/cd`. Before, a conversation told the pool its folder only as it started, so every request after one of them added up as Not recorded.
- A conversation's record reaches the pool even when one request to it never ends, or the management key is missing for a while. Before, one request that never ended kept every later record from the pool until Claude Code restarted, and a record sent without a key never went.
- After `/clear`, `/resume` or a fork, the line shows the last reading at once. Before, it showed `oneclaude: reading the pool` until the next refresh.
- One failed read of the proxy's blocks keeps the blocks on screen. Before, it cleared them in every open session for 14 seconds.
- Usage counts the requests from before oneclaude once each. Claude Code writes a transcript line for each content block of a response, and since Claude Code 2.1.286 the import counted every line, 2 to 4 times each request, under No account recorded. It also counted requests to GPT models, which never ran on the pool. The first load of this version takes both out of the request log, once.
- The Log shows every error Anthropic returns, such as `Anthropic returned 500 Internal Server Error to work.`, once per account until 10 minutes pass without one. Before, it showed only rate limits, overloads and 404s, and stayed empty while every account failed.

## [0.9.2]

### Fixed
- oneclaude installs on a computer with no GitHub SSH key, such as a server. Claude Code looked up the cmod plugin's versions over SSH and refused the install with `Dependency "cmod@oneclaude" has no git tag satisfying >=5.0.0`. oneclaude's marketplace now lists cmod by its HTTPS address.

## [0.9.1]

### Changed
- oneclaude runs on cmod 5.0.0 or later, which sets a mod up without asking for permissions. The mod now reaches a pool on another machine that `ANTHROPIC_BASE_URL` names, such as `http://homeserver:8317`.
- `[Optimize usage]` always shows, since cmod no longer has a permission that turns it off.

## [0.9.0]

### Added
- oneclaude runs on Linux, on arm64 and x64, as well as on macOS on Apple silicon and Intel. With no CLIProxyAPI, the install step installs the newest release, checked against the digest GitHub keeps for it, and runs it as the systemd user service `cliproxyapi`, which starts again whenever it stops.
- One pool can serve every machine you run Claude Code on. On a machine whose `ANTHROPIC_BASE_URL` names another machine, such as `http://homeserver:8317`, the install step sets up no proxy, and the line under the prompt, `/accounts`, every button, Usage and filters read the pool there. The mod reaches it once cmod lets a mod connect to the host Claude Code sends its requests to, which a coming cmod release adds.

### Changed
- Usage's agent types and projects come from each session's own oneclaude mod, wherever the session runs, instead of the transcripts on the pool's machine. A request from a session that runs no oneclaude mod counts as Not recorded.
- A filter's address is an address on the machine the pool runs on, and `addFilter` rejects with the pool's reason when it isn't one. A filter added while the pool doesn't answer reaches it within a second of the pool answering again.
- The line under the prompt shows the pool Claude Code uses, also when you pointed `ANTHROPIC_BASE_URL` at another address.
- The install step keeps the management key once it checked that the proxy takes it, and the mod sends no other. A proxy with a key of its own asks for it once more in oneclaude's install tab, which checks it with one request to the proxy.
- `[Open dashboard]` and `[Add account]` open the proxy's control panel, which asks for its password, the management key, the first time. Tick Remember password.
- A proxy oneclaude installs listens on the address a shared `ANTHROPIC_BASE_URL` names, and the pool's machine opens its management API to the machines that share it.

## [0.8.1]

### Added
- Another mod can add a filter to a session: a program on this Mac that rewrites, answers, or watches that session's Claude requests and their successful responses, as Envoy's external processing filter does. A filter lasts until its session restarts, so an uninstalled mod leaves none behind, and a filter can keep requests that share text on one account's cache.

### Changed
- `/accounts` opens as a tab in cmod's Sidebar, which `meta+0` shows and hides.
- oneclaude runs on cmod 4.3.2 or newer, and cmod updates itself to it. The line under the prompt is now cmod's widget `Pool usage`, which Settings, under cmod, Widgets, moves to another row or side, onto the Sidebar's Dashboard, or hides.
- The line under the prompt shows as soon as the proxy answers, without waiting for the proxy's blocks, which follow a moment later.
- Open sessions share one reading of the proxy's blocks, so the proxy checks the management key once every 14 seconds instead of once per session every 15 seconds. A new session no longer rewrites Claude Code's settings file when it already points at the proxy, so the other open sessions don't reload their settings.

## [0.7.10]

### Added
- Usage covers the 90 days before you installed oneclaude, from Claude Code's transcripts, as far back as Claude Code keeps them. By account counts those requests as No account recorded, because no transcript says which account answered.
- Usage's Period runs 90 days, 30 days, 7 days, Yesterday, Today, and opens at 30 days. By Time goes by the hour over Today or Yesterday, by the week over 90 days, and by the day otherwise.
- The line under the prompt names what needs you, only while it is true: `1 account signed out`, `1 account blocked`, or `agent limit reached`. The first two open the pane at the account, and the last at the Claude accounts.
- A signed-out account's row has `[Sign in]`, and a blocked account's row says which models the proxy blocked and until when, with `[Unblock]` to clear them.
- After a 404 on an account that answered that model within the last day, with no rate limit, spent week or failed login since, oneclaude clears the proxy's blocks on it, so a resumed conversation no longer takes a model offline for 12 hours.

### Changed
- The warnings are a log: one factual sentence per event, such as `Anthropic rate limited work (429).`, with its time and `WARN` or `INFO`, the last 24 hours in the pane and 7 days on the dashboard. A throttle, overload or 404 logs once per account until 10 minutes pass without one, and cancelled requests are left out.
- Installing or updating oneclaude brings a Homebrew CLIProxyAPI to 8.0.35 or newer before it changes the proxy's config, and restarts it when it runs an older version. Replies the restart drops resend on their own.
- oneclaude keeps its files in its cmod data folder, because the proxy listed them as accounts in its panel. Installing this version moves them there before the proxy loads it.
- A CLIProxyAPI with a management key of its own keeps it. The install pane asks for the key once, and again when it changes, and checks it against the proxy's config on this Mac. oneclaude sets the key `oneclaude` only on a proxy with none, and the dashboard's links keep a panel login you saved.

### Fixed
- The dashboard fits a narrow window: the Usage table scrolls on its own instead of widening the whole page.

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
