import type { RenderElement } from 'claude-code'
import { definePane } from '../../node_modules/@cmodjs/core/ui/define-pane.js'
import { Box, Link, Text } from '../../node_modules/@cmodjs/core/ui/elements.js'
import { poolBar } from '../components/pool-bar.js'
import { Facts, factText, type Fact } from '../components/pool-line.js'
import type { OneclaudeState } from '../state.js'
import { ACCOUNTS_URL, ago, agentsOf, BAR_CELLS, claudeKey, codexKey, DASHBOARD_URL, evenOf, FAMILIES, paceOf, percent, plural, POOL, PROBLEMS, until, type Account, type Codex, type Shown, type Status, type Warning } from '../status.js'

const COMBINED = 'Combined usage'
const GAP = 2
const INSET = 3

// A Row is one bar: its name, the bar, then its facts, the first of which is
// how full it is. A pane too narrow for every row on one line puts each
// row's facts but the first on a second line, under the bar.
type Row = { readonly key: string; readonly name: string; readonly shown?: Shown; readonly facts: readonly Fact[]; readonly color?: string }

export const accountsPane = definePane<OneclaudeState>({
  id: 'accounts',
  title: 'Accounts',
  closeOnEscape: true,
  onClose: (mod) => {
    mod.state.memory.isOpen = false
  },
  render: (mod, { bodyColumns }) => {
    const reading = mod.state.memory.reading
    if (reading === null) return <Text dimColor>Reading your accounts</Text>
    if ('problem' in reading) return <Text color="warning">{PROBLEMS[reading.problem]}</Text>
    const { status } = reading
    const shown = mod.state.memory.shown
    const combined = combinedRow(status, shown[POOL])
    const claude = status.accounts.map((account) => claudeRow(account, status.now, shown[claudeKey(account)]))
    const codex = status.codex.map((account) => codexRow(account, status.now, shown[codexKey(account)]))
    const rows = [combined, ...claude, ...codex]
    const width = Math.max(...rows.map((row) => row.name.length))
    const isNarrow = rows.some((row) => INSET * 2 + width + GAP + BAR_CELLS + 2 + GAP + factText(row.facts).length > bodyColumns)
    const draw = (row: Row): RenderElement => <RowView row={row} width={width} isNarrow={isNarrow} />
    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column" gap={1}>
          <Text bold><Text color="claude">✻</Text> oneclaude</Text>
          {draw(combined)}
        </Box>
        <Section title="Claude accounts">{claude.map(draw)}</Section>
        {codex.length > 0 ? <Section title="Codex accounts">{codex.map(draw)}</Section> : null}
        <Section key="warnings" title="Warnings in the last 24 hours">
          {status.warnings.length === 0
            ? [<Text dimColor>None</Text>]
            : [...status.warnings].reverse().map((warning) => <WarningRow warning={warning} now={status.now} />)}
        </Section>
        <Box paddingX={2} gap={2}>
          <Text dimColor>[<Link href={DASHBOARD_URL}>Open dashboard</Link>]</Text>
          <Text dimColor>[<Link href={ACCOUNTS_URL}>Manage accounts</Link>]</Text>
        </Box>
      </Box>
    )
  },
})

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

function RowView({ row, width, isNarrow }: { readonly row: Row; readonly width: number; readonly isNarrow: boolean }): RenderElement {
  const name = <Box flexShrink={0}><Text>{row.name.padEnd(width)}</Text></Box>
  const bar = row.shown === undefined ? null : <Box flexShrink={0}>{poolBar(row.shown)}</Box>
  if (!isNarrow || row.shown === undefined) {
    return (
      <Box key={row.key} gap={GAP}>
        {name}
        {bar}
        <Facts facts={row.facts} color={row.color} />
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
    </Box>
  )
}

function combinedRow(status: Status, shown: Shown | undefined): Row {
  const { pool, now } = status
  const unread = pool.accounts - pool.known
  return {
    key: POOL,
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

function claudeRow(account: Account, now: string, shown: Shown | undefined): Row {
  const key = claudeKey(account)
  if (!account.known) return { key, name: account.name, facts: ['not read yet'] }
  const agents = FAMILIES.filter((family) => (account.agents[family] ?? 0) > 0).map((family) => `${account.agents[family]} ${family}`)
  return {
    key,
    name: account.name,
    shown: shown ?? { used: account.used, pace: paceOf(account, now) },
    color: account.empty ? 'error' : undefined,
    facts: [
      ...usageFacts(account, now),
      agentsOf(account) === 0 ? 'idle' : agents.join(', '),
      ...(account.projected ? ['refilled since its last reading'] : []),
    ],
  }
}

function codexRow(account: Codex, now: string, shown: Shown | undefined): Row {
  const key = codexKey(account)
  if (!account.known) return { key, name: account.name, facts: ['not read yet'] }
  return {
    key,
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

function WarningRow({ warning, now }: { readonly warning: Warning; readonly now: string }): RenderElement {
  return (
    <Box gap={2}>
      <Box flexShrink={0}><Text dimColor>{ago(warning.at, now).padEnd(9)}</Text></Box>
      <Text color="warning" wrap="wrap">{warning.detail}</Text>
    </Box>
  )
}
