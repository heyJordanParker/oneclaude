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

Warnings in the last 24 hours

None

[Open dashboard]  [Add account]
```

- **Combined usage** is the pool, as the line under the prompt shows it. "frees 17%" is how much of the pool's quota the next refill gives back.
- **Claude accounts** lists each account by the part of its address before the `@`. Each row shows its weekly usage, its pace, when its week resets, and the agents on it by model, such as `2 opus`, or `idle`. An account that used its whole week says `empty`, and new conversations skip it until it refills.
- **Codex accounts** shows each Codex (ChatGPT) account the proxy holds, with its weekly usage. oneclaude shows these accounts only, and routes none of their requests.
- **Warnings in the last 24 hours** lists each subagent oneclaude held back, each throttle Anthropic sent, and each limit oneclaude lowered. [How it works](how-it-works.md) explains each one.

A refill time reads in days from 2 days out, such as `4d`, in days and hours under 2 days, such as `1d 6h`, in hours and minutes under a day, such as `5h 20m`, and in minutes under an hour.

In a narrow pane, each row puts its details on a second line under the bar, as above. A wide pane keeps each row on one line.

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
- each account's requests by the hour for the last 7 days;
- the proxy's traffic, its credential files, and its settings;
- buttons to add an account, turn one off, or log in to one again.

`[Add account]` opens the panel at its OAuth login page, already signed in. Log in to a Claude or Codex account there, and it joins the pool.

The panel's password is `oneclaude`, which the install set. Both links sign in with it, so you never type it.
