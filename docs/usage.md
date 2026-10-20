# Usage

oneclaude needs nothing from you once it is installed. Every new conversation goes to the account that most needs spending, and every running conversation stays where it is. This page explains what oneclaude shows.

## The line under the prompt

```text
████████▊███▋███████  63% · 19% over pace · next refill in 2d · 14 agents [+]
```

- **The bar** is the pool's weekly usage. [The bars](#the-bars) explains its colors.
- **63%** is how much of the week's quota the pool has used: the average of every Claude account oneclaude has a reading for.
- **19% over pace** compares that usage with an even spend. Each account's week has run for some share of its time. The pool is 19 points ahead of that share, so it spends faster than one week of quota lasts. "Under pace" means quota will be left over at the refill. The text turns green under pace and orange over it, red more than 25 points over, and stays plain within 5 points.
- **next refill in 2d** is when the next account's week resets.
- **14 agents** is how many Claude Code conversations and subagents run on the pool now.
- **`[+]`** opens the pane, and **`[-]`** closes it.

When oneclaude can't read the pool, the line says why instead:

- `oneclaude: proxy down` means nothing answers on `127.0.0.1:8317`, or the proxy answered with an error. Start the proxy with `brew services start cliproxyapi`, or read its log.
- `oneclaude: plugin off` means the proxy runs without oneclaude's plugin. Run `oneclaude install --data ~/.local/share/cmod/data/oneclaude`, the install step, to add it again.
- `oneclaude: status unreadable` means the proxy answered something oneclaude doesn't understand.

## The accounts pane

`/accounts`, or `[+]`, opens the pane beside the conversation.

```text
Combined usage    ████████▊███▋███████  63%
                  19% over pace · next refill in 2d frees 17% · 14 agents

Claude accounts

work              ██████████▉█████████  70%
                  15% over pace · refills in 3d · 2 opus

spare             ████████████████████  empty
                  refills in 2d · idle

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

Period  [Today]  Yesterday   7 days   30 days
By      [Account]  Model   Agent   Project   Day
Show    [Cost]  Tokens

               Input   Output   Cache write   Cache read   Cached   Share   Total
work              $5      $48          $257         $208      97%     62%    $518
spare             $2      $13          $232          $68      82%     38%    $315
All accounts      $7      $61          $489         $276      94%            $833

[Optimize usage]

Usage per day, last 30 days

$3,053                                                    █ █
                                                          █ █ ▅
                                                          █ █ █
       · · · · · · · · · · · · · · · · · · · · · · · · · █ █ █ █
       Sep 19                                                Oct 18

Warnings in the last 24 hours

None

[Open dashboard]  [Add account]
```

- **Combined usage** is the pool, as the line under the prompt shows it. "frees 17%" is how much of the pool's quota the next refill gives back.
- **Claude accounts** lists each account by the part of its address before the `@`. Each row shows its weekly usage, its pace, when its week resets, and the agents on it by model, such as `2 opus`, or `idle`. An account that used its whole week says `empty`, and new conversations skip it until it refills.
- **Codex accounts** shows each Codex (ChatGPT) account the proxy holds, with its weekly usage. oneclaude shows these accounts only, and routes none of their requests.
- **Weekly resets** lays 8 days, from yesterday's midnight, under the names and dates of the days, one lane per Claude account, soonest reset first. Each lane is the account's current week as one rounded bar, from when the week opened to when it resets, on a faint line that runs across the rest of the lane. It is dark up to now, gray while the account's quota lasts at its pace so far this week, and faint from where that pace would empty it until the reset. The gray is red in the last 5% of the week's quota, as the usage bar is. A white line marks now through every lane. Each lane ends with how long until the week resets and how much the account has left until then. A narrower pane gives each day fewer cells, down to 6 hours a cell, and names only the weekday.
- **Usage** is what the pool's requests used. [Usage](#usage) explains it.
- **Usage per day** is one column a day for the last 30 days, in Claude's color: the whole pool's cost, or its tokens when Usage shows tokens. A dot is a day with no request.
- **Warnings in the last 24 hours** lists each subagent oneclaude held back, each throttle Anthropic sent, and each limit oneclaude lowered. [How it works](how-it-works.md) explains each one.

A refill time reads in days from 2 days out, such as `4d`, in days and hours under 2 days, such as `1d 6h`, in hours and minutes under a day, such as `5h 20m`, and in minutes under an hour.

In a narrow pane, each row puts its details on a second line under the bar, as above. A wide pane keeps each row on one line.

## Usage

The Usage table adds up every request the pool answered, from oneclaude's request log:

- **Period** is today, yesterday, the last 7 days, or the last 30 days. Days start at midnight on your Mac. When the log starts inside the period, the table says when.
- **By** splits the period into one row per account, per model such as Opus 5.5, per agent type, per project, or per day. An agent type is a subagent's type, such as `code-reviewer`, and every conversation you talk to adds up as Main sessions. A project is the folder its session runs in. Requests from before oneclaude recorded agent types and projects add up as Not recorded, and the table says so under it.
- **Show** writes every cell as dollars or as tokens.

Each row splits into input, output, cache writes, and cache reads. Then come **Cached**, how much of its input came from the cache, cache reads out of all input; its **Share** of the period's total; and its **Total**, last and in Claude's color, because it matters most. A Cached share under 90% shows in the warning color: it marks conversations and subagents that start cold, and so write their whole prompt to the cache again.

A dollar figure is what the same tokens cost on the Claude API at [Anthropic's list prices](https://platform.claude.com/docs/en/about-claude/pricing), with cache writes at the 1-hour rate, the cache Claude Code writes. Your subscriptions are flat-priced, so it shows what they give you, not what you pay. A model with no list price adds its tokens and no dollars.

The pane asks for the table's width when it docks beside the conversation. A pane narrower than the table leaves out the four token kinds.

`[Optimize usage]` asks your agent, in the conversation you are in, to optimize your usage. It asks you first, in its place:

```text
Ask your agent to optimize your usage?
We'll send it your last 30 days of usage, by agent, project and model.
[Ask your agent]  [Cancel]
```

The prompt holds the last 30 days by agent type, project, and model, with every column. It asks Claude to read the agent definitions, Skills, and settings behind the most expensive rows, to propose changes ranked by what each saves per day, and to change nothing until you approve. Claude Code holds the prompt until the conversation is idle. The button needs the mod's permission to add text Claude reads, which you can turn off in `/mods oneclaude`, and then it hides.

## The bars

Every bar is 20 cells wide and exact to an eighth of a cell. It fills to the account's usage, and the color change marks pace, where an even spend would be by now:

- **Under pace**, the bar fills in gray to the usage, and a lighter track runs on to the pace mark. That lighter part is quota you could spend now and still be on pace.
- **Over pace**, the bar fills in gray to the pace mark, then in orange to the usage. The orange part is how far ahead of pace the account is.
- **In the last 5% of the week's quota**, the bar turns red.

An empty account has no pace mark, because pace means nothing once the week is spent. Bars glide to each new reading, and the pane's bars grow from zero when it opens.

The rounded ends of each bar are [Nerd Font](https://www.nerdfonts.com) glyphs. A terminal font without them shows a blank or a box at each end.

## The dashboard

`[Open dashboard]` opens the dashboard inside the proxy's control panel, already signed in. The panel lists it under oneclaude in its plugin menu. It shows:

- the pool and every account's usage, pace, refill, and agents;
- the warnings;
- the Usage table, with the same choices as the pane, and every day of the last 30 stacked by the breakdown's largest rows;
- each account's requests by the hour for the last 7 days;
- the proxy's traffic, its credential files, and its settings;
- buttons to add an account, turn one off, or log in to one again.

`[Add account]` opens the panel at its OAuth login page, already signed in. Log in to a Claude or Codex account there, and it joins the pool.

The panel's password is `oneclaude`, which the install set. Both links sign in with it, so you never type it.
