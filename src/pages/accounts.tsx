import type { RenderElement } from 'claude-code'
import { Prompt, sessions, type Mod, type PageInit } from '../../node_modules/@cmodjs/core/mod.js'
import { Box, Button, Link, Text } from '../../node_modules/@cmodjs/core/ui/elements.js'
import { poolBar } from '../components/pool-bar.js'
import { Facts, factText, type Fact } from '../components/pool-line.js'
import { calendarOf, WeeklyResets } from '../components/weekly-resets.js'
import type { OneclaudeState, UsageView } from '../state.js'
import { ACCOUNTS, addAccountUrl, ago, agentsOf, BAR_CELLS, blocksOf, claudeKey, clockOf, codexKey, dashboardUrl, evenOf, FAMILIES, freshBlocks, isSignedOut, keyOf, modelName, momentOf, paceOf, percent, plural, POOL, PROBLEMS, rowKey, unblock, until, type Account, type Block, type Blocks, type Codex, type LogEntry, type Shown, type Status } from '../status.js'
import { BREAKDOWNS, dailyChart, GUTTER, optimizePrompt, PERIODS, readUsage, UNITS, usageLayout, type TableLine, type UsageTable } from '../usage.js'

const COMBINED = 'Combined usage'
const GAP = 2
const INSET = 3
const CONTROL = 7

// showUsage reads the Usage table for the view, after a change to it, and
// keeps the answer only while the view is still the one asked for. A table
// that does not come keeps the last one on screen.
export async function showUsage(mod: Mod<OneclaudeState>, change: Partial<UsageView> = {}): Promise<void> {
  const view = { ...mod.state.memory.usage, ...change }
  mod.state.memory.usage = view
  const table = await readUsage(mod.state.memory.pool, view.period, view.by, view.units)
  const { period, by, units } = mod.state.memory.usage
  if (table !== null && period === view.period && by === view.by && units === view.units) mod.state.memory.table = table
}

// A Row is one bar: its name, the bar, then its facts, the first of which is
// how full it is, then what needs the person on it. A Sidebar too narrow for
// every row on one line puts each row's facts but the first on a second line,
// under the bar.
type Row = { readonly key?: string; readonly name: string; readonly shown?: Shown; readonly facts: readonly Fact[]; readonly color?: string; readonly trouble?: RenderElement }

const LOG_SHOWN = 10

export const accountsPage: PageInit<OneclaudeState> = {
  id: 'accounts',
  title: 'Accounts',
  render: (mod, { columns }) => {
    const reading = mod.state.memory.reading
    if (reading === null) return <Text dimColor>Reading your accounts</Text>
    if ('problem' in reading) return <Text color="warning">{PROBLEMS[reading.problem]}</Text>
    const { status, blocks } = reading
    const shown = mod.state.memory.shown
    const combined = combinedRow(status, shown[POOL])
    const claude = status.accounts.map((account) => claudeRow(mod, account, blocks, status.now, shown[claudeKey(account)]))
    const codex = status.codex.map((account) => codexRow(account, status.now, shown[codexKey(account)]))
    const rows = [combined, ...claude, ...codex]
    const width = Math.max(...rows.map((row) => row.name.length))
    const isNarrow = rows.some((row) => INSET * 2 + width + GAP + BAR_CELLS + 2 + GAP + factText(row.facts).length > columns)
    const draw = (row: Row): RenderElement => <RowView row={row} width={width} isNarrow={isNarrow} />
    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column">
          {draw(combined)}
        </Box>
        <Section key={ACCOUNTS} title="Claude accounts">{claude.map(draw)}</Section>
        {codex.length > 0 ? <Section title="Codex accounts">{codex.map(draw)}</Section> : null}
        <ResetsSection accounts={status.accounts} now={status.now} width={width} columns={columns - INSET * 2} />
        <UsageSection mod={mod} table={mod.state.memory.table} view={mod.state.memory.usage} columns={columns - INSET * 2} />
        {mod.state.memory.table === null ? null : <ChartSection table={mod.state.memory.table} view={mod.state.memory.usage} />}
        {status.log.length === 0 ? null : <LogSection log={status.log} />}
        <Box paddingX={2} gap={2}>
          <Text dimColor>[<Link href={dashboardUrl(mod.state.memory.pool)}>Open dashboard</Link>]</Text>
          <Text dimColor>[<Link href={addAccountUrl(mod.state.memory.pool)}>Add account</Link>]</Text>
        </Box>
      </Box>
    )
  },
}

// A Section is a bold title, an empty line, then its rows, one empty line
// apart, because full-height bars on adjoining lines touch.
function Section({ key, title, children }: { readonly key?: string; readonly title: string; readonly children: readonly RenderElement[] }): RenderElement {
  return (
    <Box key={key} flexDirection="column" gap={1} paddingX={2}>
      <Text bold>{title}</Text>
      <Box flexDirection="column" gap={1}>{children}</Box>
    </Box>
  )
}

function ResetsSection({ accounts, now, width, columns }: { readonly accounts: readonly Account[]; readonly now: string; readonly width: number; readonly columns: number }): RenderElement | null {
  const calendar = calendarOf(accounts, now, columns - width - GAP)
  if (calendar.lanes.length === 0) return null
  return <Section title="Weekly resets">{[<WeeklyResets calendar={calendar} width={width} />]}</Section>
}

// RowView draws a row, and its trouble on a line of its own under the bar,
// or after the name of a row with no bar.
function RowView({ row, width, isNarrow }: { readonly row: Row; readonly width: number; readonly isNarrow: boolean }): RenderElement {
  const name = <Box flexShrink={0}><Text>{row.name.padEnd(width)}</Text></Box>
  const trouble = row.trouble === undefined ? null : <Box paddingLeft={width + GAP}>{row.trouble}</Box>
  if (row.shown === undefined) {
    return (
      <Box key={row.key} gap={GAP}>
        {name}
        {row.facts.length === 0 ? null : <Facts facts={row.facts} color={row.color} />}
        {row.trouble ?? null}
      </Box>
    )
  }
  const bar = <Box flexShrink={0}>{poolBar(row.shown)}</Box>
  if (!isNarrow) {
    return (
      <Box key={row.key} flexDirection="column">
        <Box gap={GAP}>
          {name}
          {bar}
          <Facts facts={row.facts} color={row.color} />
        </Box>
        {trouble}
      </Box>
    )
  }
  const [first, ...rest] = row.facts
  return (
    <Box key={row.key} flexDirection="column">
      <Box gap={GAP}>
        {name}
        {bar}
        <Facts facts={first === undefined ? [] : [first]} color={row.color} />
      </Box>
      <Box paddingLeft={width + GAP}>
        <Facts facts={rest} color={row.color} />
      </Box>
      {trouble}
    </Box>
  )
}

function combinedRow(status: Status, shown: Shown | undefined): Row {
  const { pool, now } = status
  const unread = pool.accounts - pool.known
  return {
    name: COMBINED,
    shown: shown ?? { used: pool.used, pace: pool.even },
    facts: [
      percent(pool.used),
      { used: pool.used, even: pool.even },
      ...(pool.next_refill === undefined ? [] : [`next refill in ${until(pool.next_refill, now)} frees ${percent(pool.refill_gain)}`]),
      plural(pool.agents, 'agent'),
      ...(unread > 0 ? [`${plural(unread, 'account')} not read yet`] : []),
    ],
  }
}

// claudeRow is one Claude account. A signed-out account shows only that, with
// the login that signs it back in, and a blocked one says until when, with
// the button that clears its blocks.
function claudeRow(mod: Mod<OneclaudeState>, account: Account, blocks: Blocks, now: string, shown: Shown | undefined): Row {
  const key = rowKey(account)
  if (isSignedOut(account, blocks)) {
    return {
      key,
      name: account.name,
      facts: [],
      trouble: (
        <Box gap={2}>
          <Text color="warning">signed out</Text>
          <Text dimColor>[<Link href={addAccountUrl(mod.state.memory.pool)}>Sign in</Link>]</Text>
        </Box>
      ),
    }
  }
  const blocked = blocksOf(account, blocks)
  const trouble = blocked.length === 0 ? undefined : <BlockedView mod={mod} account={account} blocked={blocked} now={now} />
  if (!account.known) return { key, name: account.name, facts: ['not read yet'], trouble }
  const agents = FAMILIES.filter((family) => (account.agents[family] ?? 0) > 0).map((family) => `${account.agents[family]} ${family}`)
  return {
    key,
    name: account.name,
    shown: shown ?? { used: account.used, pace: paceOf(account, now) },
    color: account.empty ? 'error' : undefined,
    facts: [
      ...usageFacts(account, now),
      ...(account.throttled_at === undefined ? [] : [`throttled ${ago(account.throttled_at, now)}`]),
      agentsOf(account) === 0 ? 'idle' : agents.join(', '),
      ...(account.projected ? ['refilled since its last reading'] : []),
    ],
    trouble,
  }
}

function BlockedView({ mod, account, blocked, now }: { readonly mod: Mod<OneclaudeState>; readonly account: Account; readonly blocked: readonly Block[]; readonly now: string }): RenderElement {
  const models = [...new Set(blocked.flatMap((block) => (block.model === undefined ? [] : [modelName(block.model)])))]
  const last = blocked.map((block) => block.until).sort().at(-1) ?? now
  const what = models.length === 0 || blocked.some((block) => block.model === undefined) ? 'blocked' : `blocked for ${models.join(', ')}`
  const clear = async (): Promise<void> => {
    const key = await keyOf(mod)
    if (key === undefined || !(await unblock(mod, account, key))) {
      mod.toast.error(`oneclaude could not clear the blocks on ${account.name}`)
      return
    }
    const blocks = await freshBlocks(mod, key)
    const reading = mod.state.memory.reading
    if (reading !== null && 'status' in reading) mod.state.memory.reading = { ...reading, blocks }
  }
  return (
    <Box gap={2}>
      <Text color="warning">{`${what} until ${momentOf(last, now)}`}</Text>
      <Button key={`unblock-${account.name}`} plain dimColor onPress={clear}>[Unblock]</Button>
    </Box>
  )
}

function codexRow(account: Codex, now: string, shown: Shown | undefined): Row {
  if (!account.known) return { name: account.name, facts: ['not read yet'] }
  return {
    name: account.name,
    shown: shown ?? { used: account.used, pace: paceOf(account, now) },
    color: account.empty ? 'error' : undefined,
    facts: [
      ...usageFacts(account, now),
      ...(account.projected ? ['refilled since its last reading'] : []),
    ],
  }
}

function usageFacts(account: Account | Codex, now: string): Fact[] {
  const even = evenOf(account, now)
  return [
    account.empty ? 'empty' : percent(account.used),
    ...(account.empty || even === undefined ? [] : [{ used: account.used, even }]),
    `refills in ${until(account.resets_at, now)}`,
  ]
}

// Choices is one row of the Usage controls: its name, then a button per
// choice, the chosen one bright in brackets.
function Choices<Choice extends string>({ name, choices, chosen, onChoose }: { readonly name: string; readonly choices: readonly (readonly [Choice, string])[]; readonly chosen: Choice; readonly onChoose: (choice: Choice) => void }): RenderElement {
  return (
    <Box>
      <Box flexShrink={0}><Text dimColor>{name.padEnd(CONTROL)}</Text></Box>
      <Box gap={1} flexWrap="wrap">
        {choices.map(([choice, label]) => (
          <Button key={`${name.toLowerCase()}-${choice}`} plain dimColor={choice !== chosen} onPress={() => onChoose(choice)}>
            {choice === chosen ? `[${label}]` : ` ${label} `}
          </Button>
        ))}
      </Box>
    </Box>
  )
}

// TableRow draws one line of the Usage table. Total, the last column, is in
// Claude's color, and a cache share under 90% in the warning color, so the
// eye lands on what each row costs and on where it starts cold.
function TableRow({ line, isHeader = false, isTotal = false }: { readonly line: TableLine; readonly isHeader?: boolean; readonly isTotal?: boolean }): RenderElement {
  const last = line.cells.length - 1
  const cached = last - 2
  const cells = line.cells.map((cell, index) => {
    const text = index === 0 ? cell : `${GUTTER}${cell}`
    if (isHeader) return text
    if (index === last) return <Text color="claude">{text}</Text>
    if (index === cached && line.cold) return <Text color="warning">{text}</Text>
    return text
  })
  return <Text dimColor={isHeader} bold={isTotal}>{cells}</Text>
}

function UsageSection({ mod, table, view, columns }: { readonly mod: Mod<OneclaudeState>; readonly table: UsageTable | null; readonly view: UsageView; readonly columns: number }): RenderElement {
  if (table === null) return <Section title="Usage">{[<Text dimColor>Reading the request log</Text>]}</Section>
  const wide = usageLayout(table, view.units, true)
  const layout = wide.width <= columns ? wide : usageLayout(table, view.units, false)
  const isUnrecorded = (view.by === 'agent' || view.by === 'project') && table.rows.some((row) => row.key === '')
  return (
    <Section key="usage" title="Usage">
      {[
        <Box flexDirection="column">
          <Choices name="Period" choices={PERIODS} chosen={view.period} onChoose={(period) => void showUsage(mod, { period })} />
          <Choices name="By" choices={BREAKDOWNS} chosen={view.by} onChoose={(by) => void showUsage(mod, { by })} />
          <Choices name="Show" choices={UNITS} chosen={view.units} onChoose={(units) => void showUsage(mod, { units })} />
        </Box>,
        <Box flexDirection="column">
          <TableRow line={layout.header} isHeader />
          {layout.rows.map((line) => <TableRow line={line} />)}
          <TableRow line={layout.total} isTotal />
        </Box>,
        ...(isUnrecorded ? [<Text dimColor wrap="wrap">Not recorded: requests from before oneclaude recorded agent types and projects.</Text>] : []),
        <Optimize mod={mod} />,
      ]}
    </Section>
  )
}

// Optimize asks the person's agent to optimize their usage. It asks first,
// in its own place, because the prompt becomes a turn in the conversation
// they are in.
function Optimize({ mod }: { readonly mod: Mod<OneclaudeState> }): RenderElement {
  if (!mod.state.memory.isConfirming) {
    return <Box><Button key="optimize" plain dimColor onPress={() => { mod.state.memory.isConfirming = true }}>[Optimize usage]</Button></Box>
  }
  const send = async (): Promise<void> => {
    const [agents, projects, models] = await Promise.all((['agent', 'project', 'model'] as const).map((by) => readUsage(mod.state.memory.pool, 'month', by, 'cost')))
    mod.state.memory.isConfirming = false
    if (!agents || !projects || !models) {
      mod.toast.error('oneclaude could not read the usage, so nothing was sent')
      return
    }
    await sessions.current.send({ type: Prompt, text: optimizePrompt(mod.state.memory.pool, agents, projects, models) })
  }
  return (
    <Box flexDirection="column">
      <Text bold>Ask your agent to optimize your usage?</Text>
      <Text dimColor wrap="wrap">We'll send it your last 30 days of usage, by agent, project and model.</Text>
      <Box gap={2}>
        <Button key="optimize-send" plain onPress={send}><Text color="claude">[Ask your agent]</Text></Button>
        <Button key="optimize-cancel" plain dimColor onPress={() => { mod.state.memory.isConfirming = false }}>[Cancel]</Button>
      </Box>
    </Box>
  )
}

function ChartSection({ table, view }: { readonly table: UsageTable; readonly view: UsageView }): RenderElement {
  const chart = dailyChart(table, view.units)
  const pad = ' '.repeat(chart.peak.length)
  const span = chart.rows[0]!.length * 2 - 1
  return (
    <Section title="Usage per day, last 30 days">
      {[
        <Box flexDirection="column">
          {chart.rows.map((cells, index) => (
            <Text>
              <Text dimColor>{index === 0 ? chart.peak : pad}</Text>
              {GUTTER}
              {cells.map((cell, day) => {
                const text = day === 0 ? cell : ` ${cell}`
                if (cell === '·') return <Text dimColor>{text}</Text>
                return cell === ' ' ? text : <Text color="claude">{text}</Text>
              })}
            </Text>
          ))}
          <Text dimColor>{`${pad}${GUTTER}${chart.first}${chart.last.padStart(span - chart.first.length)}`}</Text>
        </Box>,
      ]}
    </Section>
  )
}

// LogSection is the last 24 hours of the log, newest first: the time, the
// level, and what happened. The dashboard holds the rest of the week.
function LogSection({ log }: { readonly log: readonly LogEntry[] }): RenderElement {
  const shown = [...log].reverse().slice(0, LOG_SHOWN)
  return (
    <Section key="log" title="Log">
      {[
        <Box flexDirection="column">
          {shown.map((entry) => (
            <Box gap={2}>
              <Box flexShrink={0}><Text dimColor>{clockOf(entry.at)}</Text></Box>
              <Box flexShrink={0}><Text color={entry.level === 'WARN' ? 'warning' : undefined} dimColor={entry.level === 'INFO'}>{entry.level}</Text></Box>
              <Text wrap="wrap">{entry.text}</Text>
            </Box>
          ))}
          {log.length > LOG_SHOWN ? <Text dimColor>{`${plural(log.length - LOG_SHOWN, 'earlier line')} on the dashboard`}</Text> : null}
        </Box>,
      ]}
    </Section>
  )
}
