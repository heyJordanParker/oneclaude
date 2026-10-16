import type { RenderElement } from 'claude-code'
import { definePane } from '../../node_modules/@cmodjs/core/ui/define-pane.js'
import { Box, Text } from '../../node_modules/@cmodjs/core/ui/elements.js'
import { poolBar } from '../components/pool-bar.js'
import type { OneclaudeState } from '../state.js'
import { ago, agentsOf, evenOf, FAMILIES, pace, percent, plural, PROBLEMS, until, type Account, type Status, type Warning } from '../status.js'

const BAR = 20

export const accountsPane = definePane<OneclaudeState>({
  id: 'accounts',
  title: 'Accounts',
  closeOnEscape: true,
  onClose: (mod) => {
    mod.state.memory.isOpen = false
  },
  render: (mod) => {
    const reading = mod.state.memory.reading
    if (reading === null) return <Text dimColor>Reading your accounts</Text>
    if ('problem' in reading) return <Text color="warning">{PROBLEMS[reading.problem]}</Text>
    const { status } = reading
    const width = Math.max(...status.accounts.map((account) => account.name.length), 'oneclaude'.length)
    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box borderStyle="round" borderDimColor paddingX={1}>
          <Header status={status} width={width} />
        </Box>
        <Box flexDirection="column" paddingX={2}>
          <Text bold>Claude accounts</Text>
          {status.accounts.map((account) => <AccountRow account={account} now={status.now} width={width} />)}
        </Box>
        <Box paddingX={2}>
          <WarningsSection status={status} />
        </Box>
      </Box>
    )
  },
})

function Row({ name, bar, facts, color, dimColor = true }: { readonly name: string; readonly bar?: RenderElement[]; readonly facts: readonly string[]; readonly color?: 'error'; readonly dimColor?: boolean }): RenderElement {
  return (
    <Box gap={2}>
      <Box flexShrink={0}><Text>{name}</Text></Box>
      {bar === undefined ? null : <Box flexShrink={0}>{bar}</Box>}
      <Text color={color} dimColor={color === undefined && dimColor} wrap="wrap">{facts.join(' · ')}</Text>
    </Box>
  )
}

function Header({ status, width }: { readonly status: Status; readonly width: number }): RenderElement {
  const { pool, now } = status
  const unread = pool.accounts - pool.known
  return (
    <Row
      name={'oneclaude'.padEnd(width)}
      dimColor={false}
      bar={poolBar(pool.used, pool.even, BAR)}
      facts={[
        percent(pool.used),
        pace(pool.used, pool.even),
        ...(pool.next_refill === undefined ? [] : [`next refill in ${until(pool.next_refill, now)} frees ${percent(pool.refill_gain)}`]),
        plural(pool.agents, 'agent'),
        ...(unread > 0 ? [`${plural(unread, 'account')} not read yet`] : []),
      ]}
    />
  )
}

function AccountRow({ account, now, width }: { readonly account: Account; readonly now: string; readonly width: number }): RenderElement {
  const name = account.name.padEnd(width)
  if (!account.known) return <Row name={name} facts={['not read yet']} />
  const even = evenOf(account, now)
  const agents = FAMILIES.filter((family) => (account.agents[family] ?? 0) > 0).map((family) => `${account.agents[family]} ${family}`)
  return (
    <Row
      name={name}
      bar={poolBar(account.used, even, BAR)}
      color={account.empty ? 'error' : undefined}
      facts={[
        account.empty ? 'empty' : percent(account.used),
        ...(account.empty || even === undefined ? [] : [pace(account.used, even)]),
        `refills in ${until(account.resets_at, now)}`,
        agentsOf(account) === 0 ? 'idle' : agents.join(', '),
        ...(account.projected ? ['refilled since its last reading'] : []),
      ]}
    />
  )
}

function WarningsSection({ status }: { readonly status: Status }): RenderElement {
  return (
    <Box key="warnings" flexDirection="column">
      <Text bold>Warnings in the last 24 hours</Text>
      {status.warnings.length === 0
        ? <Text dimColor>None</Text>
        : [...status.warnings].reverse().map((warning) => <WarningRow warning={warning} now={status.now} />)}
    </Box>
  )
}

function WarningRow({ warning, now }: { readonly warning: Warning; readonly now: string }): RenderElement {
  return (
    <Box gap={2}>
      <Box flexShrink={0}><Text dimColor>{ago(warning.at, now).padEnd(9)}</Text></Box>
      <Text color="warning" wrap="wrap">{warning.detail}</Text>
    </Box>
  )
}
