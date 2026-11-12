# Usage

oneclaude needs nothing from you once it is installed. Every new conversation goes to the account that most needs spending, and every running conversation stays where it is. This page explains what oneclaude shows.

## The line under the prompt

```text
████████▊███▋███████  63% · 19% over pace · next refill in 2d · 14 agents [+]
```

- **The bar** is the pool's weekly usage. [The bars](#the-bars) explains its colors.
- **63%** is how much of the week's quota the pool has used: the average of every Claude account oneclaude has a reading for.
- **19% over pace** is how fast the pool spends right now: the quota its requests of the last 15 minutes used, against the quota every account has left until its reset. 19% over means that rate would run out before the refills, and under pace means quota would be left over. Start more agents and it rises within a minute, stop them and it falls to 100% under within 15 minutes. oneclaude reads what a request uses from its list price and how much quota each account's requests used per dollar over its last week and this one, because Anthropic sizes accounts on the same plan differently: the same requests can fill one account half again as fast as another. An account that used no quota in those weeks counts at the pool's rate, and a new install shows a pace from its first request after an account's reading rises. The text turns green under pace and orange over it, red more than 25% over, and stays plain within 5%.
- **next refill in 2d** is when the next account's week resets.
- **14 agents** is how many Claude Code conversations and subagents run on the pool now.
- **`[+]`** opens the Accounts tab, and **`[-]`** closes it.

The line is cmod's widget `Pool usage`. Open Settings with `/mods`, then go to cmod, Widgets, to move it to another row or side, onto the Sidebar's Dashboard, or hide it.

The line names what needs you, and only while it is true:

```text
████████▊███▋███████  63% · 19% over pace · next refill in 2d · 14 agents · 1 account signed out [+]
```

- **`1 account refused`** means Anthropic refuses the account's organization, as after a failed payment, and the log says why. oneclaude asks Anthropic again every 30 minutes, and the account comes back by itself at the first answer that accepts it. Its row's `[Retry]` asks at once, as after you fix the payment.
- **`1 account signed out`** means Anthropic rejects the login. It stays until the account answers again, and goes within a second of a sign-in. Its row has `[Sign in]`.
- **`1 account blocked`** means the proxy holds a block on an account that no rate limit explains, such as one it set after a failed request. It stays until the block ends or you press the row's `[Retry]`.
- **`agent limit reached`** means every account runs as many agents of a model as it can, so oneclaude holds new subagents back. It stays until 3 minutes, `subagents.retry-after`, pass without a refusal.

Each of them opens the Accounts tab at the account it names, and `agent limit reached` at the Claude accounts.

The mod reads the proxy's blocks with the proxy's management key: `oneclaude`, which the install sets on a proxy with none, or the key you set for CLIProxyAPI, which the install asks for ([Installation](installation.md#3-adding-oneclaude)). It reads them only after an event that may change them: a request Anthropic failed, the first answer after one, a retry, or a sign-in. One session on each machine reads them, and every other session there shows its reading. A block whose time is up goes from the line by itself. When the proxy doesn't answer for its blocks, every session keeps showing the last blocks it read.

The line shows the pool Claude Code sends its requests to, its `ANTHROPIC_BASE_URL`, on this machine or another ([A pool on another machine](installation.md#a-pool-on-another-machine)). When oneclaude can't read that pool, the line keeps the last reading and says why, with the time that reading is from:

```text
████████▊███▋███████  63% · 19% over pace · next refill in 2d · 14 agents · pool unreachable since 14:02 [+]
```

The line follows the pool as it changes: each session asks the pool for its next change, and the pool answers within a second of it, or after 20 seconds with no change. The warning goes away by itself at the first reading the pool answers, in every open session. A session asks a pool that failed it again after 1, 2, 4, 8, then every 16 seconds, so the warning goes within 16 seconds of the pool answering again. A session that starts while the pool doesn't answer shows the last reading any session on this machine made, with the warning. A machine that never read the pool shows only the warning, as `oneclaude: pool unreachable`.

- `pool unreachable` means nothing answers at `ANTHROPIC_BASE_URL`, `127.0.0.1:8317` by default, the proxy answered with an error, or no answer came by the time the pool's last reading promised one, 25 seconds. Start the proxy with `brew services start cliproxyapi` on macOS or `systemctl --user start cliproxyapi` on Linux, or read its log.
- `plugin off` means the proxy runs without oneclaude's plugin. Run `oneclaude install`, the install step, to add it again.
- `status unreadable` means the proxy answered something oneclaude doesn't understand.

## The Accounts tab

`/accounts`, or `[+]`, opens the Accounts tab in cmod's Sidebar, beside the conversation. `meta+0` shows and hides the Sidebar.

```text
Combined usage    ████████▊███▋███████  63%
                  19% over pace · next refill in 2d frees 17% · 14 agents

Claude accounts

work              ██████████▉█████████  70%
                  15% over pace · refills in 3d · throttled 12m ago · 2 opus
                  blocked until 04:50  [Retry]

spare             ████████████████████  empty
                  refills in 2d · idle

jarvis            signed out  [Sign in]

lab               refused  [Retry]

Codex accounts

work              █▋████▌█████████████  8%
                  24% under pace · refills in 5d

Weekly resets

                  Sun 18 Mon 19 Tue 20 Wed 21 Thu 22 Fri 23 Sat 24 Sun 25
                              │
spare             ████████████│█████████████╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌  in 2d  empty
                              │
work              ████████████│████████████████████╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌  in 3d  30% left

Usage

Period  90 days  [30 days]  7 days   Yesterday   Today
By      [Account]  Model   Agent   Project   Time
Show    [Cost]  Tokens

                      Input   Output   Cache write   Cache read   Cached   Share   Total
No account recorded     $71     $890       $11,204       $3,912      94%     95%  $16,077
work                     $5      $48          $257         $208      97%      3%    $518
spare                    $2      $13          $232          $68      82%      2%    $315
All accounts            $78     $951       $11,693       $4,188      94%         $16,910

[Optimize usage]

Usage per day, last 30 days

$3,053                                                    █ █
                                                          █ █ ▅
                                                          █ █ █
       · · · · · · · · · · · · · · · · · · · · · · · · · █ █ █ █
       Sep 19                                                Oct 18

Log

18:09:12  WARN  Anthropic rate limited work (429).
16:50:22  INFO  oneclaude cleared the proxy's block on Opus 5.5 for spare, set after a 404.
16:50:22  WARN  Anthropic returned 404 Not Found for Opus 5.5 on spare.

[Open dashboard]  [Add account]
```

- **Combined usage** is the pool, as the line under the prompt shows it. "frees 17%" is how much of the pool's quota the next refill gives back.
- **Claude accounts** lists each account by the part of its address before the `@`. Each row shows its weekly usage, its pace so far this week, how many points its usage is ahead of or behind the share of its week that has passed, when its week resets, and the agents on it by model, such as `2 opus`, or `idle`. An account that used its whole week says `empty`, and new conversations skip it until it refills. `throttled 12m ago` shows for an hour after Anthropic rate limited the account. An account in trouble shows what is wrong in a word or two and the one button that fixes it. A signed-out account shows `signed out` and `[Sign in]`, which opens the proxy's login. A refused account shows `refused` and `[Retry]`, and a blocked one `blocked until` when the proxy's last block on it ends, and `[Retry]`. The log holds Anthropic's reason. New conversations skip a signed-out or refused account while another account can take them. A sign-in shows within a second, and a removed login's row goes as fast. `[Retry]` clears every block the proxy holds on the account and asks Anthropic about it once. A press while that ask runs asks nothing more. A block that was right comes back with the next failed request, and a refusal that holds stays until oneclaude's next ask, 30 minutes later.
- **Codex accounts** shows each Codex (ChatGPT) account the proxy holds, with its weekly usage. oneclaude shows these accounts only, and routes none of their requests.
- **Weekly resets** lays 8 days, from yesterday's midnight, under the names and dates of the days, one lane per Claude account, soonest reset first. Each lane is the account's current week as one rounded bar, from when the week opened to when it resets, on a faint line that runs across the rest of the lane. It is dark up to now, gray while the account's quota lasts at its pace so far this week, and faint from where that pace would empty it until the reset. The gray is red in the last 5% of the week's quota, as the usage bar is. A white line marks now through every lane. Each lane ends with how long until the week resets and how much the account has left until then. A narrower Sidebar gives each day fewer cells, down to 6 hours a cell, and names only the weekday.
- **Usage** is what the pool's requests used. [Usage](#usage) explains it.
- **Usage per day** is one column a day for the last 30 days, in Claude's color: the whole pool's cost, or its tokens when Usage shows tokens. A dot is a day with no request.
- **Log** lists the last 24 hours of what changed where requests go, newest first: the time, `WARN` or `INFO`, and what happened. It logs throttles, overloads and every other error Anthropic returned once per account until 10 minutes pass without one, requests that got no answer at all, with why, once for the whole pool the same way, 404s, blocks oneclaude or you cleared, subagents oneclaude held back, limits it lowered, accounts Anthropic rejected or refused, and each that answered again. It leaves out requests Claude Code cancelled, such as when you press Esc. The tab shows the newest 10 lines, and the dashboard the last 7 days. With nothing to log, the section is gone. [How it works](how-it-works.md) explains each event.

A refill time reads in days from 2 days out, such as `4d`, in days and hours under 2 days, such as `1d 6h`, in hours and minutes under a day, such as `5h 20m`, and in minutes under an hour.

In a narrow Sidebar, each row puts its details on a second line under the bar, as above. A wide Sidebar keeps each row on one line.

`[Sign in]`, `[Add account]` and `[Open dashboard]` open their page in your browser, in every terminal. In a session over ssh, or on a Linux machine with no display, they copy the page's link instead and say so, because no browser there can show it. Paste the link in your own browser.

## Usage

The Usage table adds up every request the pool answered, from oneclaude's request log. The first time oneclaude loads, it adds the requests to Claude that Claude Code's transcripts record from the 90 days before, so the table covers the time before you installed it, as far back as Claude Code keeps transcripts. Claude Code deletes them after 30 days unless its `cleanupPeriodDays` setting says otherwise. The import counts each response once, though Claude Code writes a line for each of its content blocks, and leaves out requests to other models, such as GPT. An import by oneclaude 0.9.2 or earlier counted a response once per content block and kept those requests, so the first load of a later version takes them out of the request log, once.

- **Period** is the last 90 days, the last 30 days, the last 7 days, yesterday, or today, 30 days at first. Days start at midnight on your Mac.
- **By** splits the period into one row per account, per model such as Opus 5.5, per agent type, per project, or by Time: per hour for Today or Yesterday, per week for 90 days, and per day for 7 or 30 days. An agent type is a subagent's type, such as `code-reviewer`, and every conversation you talk to adds up as Main sessions. A project is the folder its session runs in. Each conversation tells the pool its folder as it starts, and again after `/clear`, `/resume`, a fork and `/cd`. Two kinds of request add up as Not recorded, and the table says so under it: those from before oneclaude recorded agent types and projects, and those from conversations whose record never reached the pool, such as every request after a `/clear`, `/resume` or fork before this version.
- **By account** adds up the requests oneclaude did not log, the ones from before you installed it, as No account recorded, because no transcript says which account answered them. Every breakdown has the same total.
- **Show** writes every cell as dollars or as tokens.

Each row splits into input, output, cache writes, and cache reads. Then come **Cached**, how much of its input came from the cache, cache reads out of all input; its **Share** of the period's total; and its **Total**, last and in Claude's color, because it matters most. A Cached share under 90% shows in the warning color: it marks conversations and subagents that start cold, and so write their whole prompt to the cache again.

A dollar figure is what the same tokens cost on the Claude API at [Anthropic's list prices](https://platform.claude.com/docs/en/about-claude/pricing), with cache writes at the rate of the cache Claude Code writes them to: the 1-hour rate for a main session, and the 5-minute rate for a subagent. Your subscriptions are flat-priced, so it shows what they give you, not what you pay. A model with no list price adds its tokens and no dollars.

A Sidebar narrower than the table leaves out the four token kinds.

`[Optimize usage]` asks your agent, in the conversation you are in, to optimize your usage. It asks you first, in its place:

```text
Ask your agent to optimize your usage?
We'll send it your last 30 days of usage, by agent, project and model.
[Ask your agent]  [Cancel]
```

The prompt holds the last 30 days by agent type, project, and model, with every column. It asks Claude to read the agent definitions, Skills, and settings behind the most expensive rows, to propose changes ranked by what each saves per day, and to change nothing until you approve. Claude Code holds the prompt until the conversation is idle.

## The bars

Every bar is 20 cells wide and exact to an eighth of a cell. It fills to the account's usage, and the color change marks where an even spend over the week would be by now:

- **Behind an even spend**, the bar fills in gray to the usage, and a lighter track runs on to the mark. That lighter part is quota you could spend now and still be even.
- **Ahead of an even spend**, the bar fills in gray to the mark, then in orange to the usage. The orange part is how far ahead of an even spend the account is.
- **In the last 5% of the week's quota**, the bar turns red.

An empty account has no mark, because an even spend means nothing once the week is spent. Bars glide to each new reading, and the Accounts tab's bars grow from zero when it opens.

The rounded ends of each bar are [Nerd Font](https://www.nerdfonts.com) glyphs. A terminal font without them shows a blank or a box at each end.

## The dashboard

`[Open dashboard]` opens the dashboard inside the proxy's control panel. The panel lists it under oneclaude in its plugin menu. It shows:

- the pool and every account's usage, pace, refill, and agents;
- the Usage table, with the same choices as the Accounts tab, and every day of the last 30 stacked by the breakdown's largest rows;
- each account's requests by the hour for the last 7 days;
- the log of the last 7 days;
- the proxy's traffic, its credential files, and its settings;
- buttons to add an account, turn one off, or sign in to one again.

`Add account`, and `Sign in` on a signed-out account, open the panel at its OAuth login page, as `[Add account]` and `[Sign in]` in the Accounts tab do. Log in to a Claude or Codex account there, and it joins the pool, or signs in again, within a second. A refused or unavailable account has `Retry`, as `[Retry]` in the Accounts tab, and its badge's tooltip holds Anthropic's reason or the proxy's.

The panel's password is the proxy's management key, `oneclaude` unless you set your own. The panel asks for it the first time either link opens it in a browser. Tick Remember password, and it opens signed in from then on.
