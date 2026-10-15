import type { RenderElement } from 'claude-code'
import { definePane } from '../../node_modules/@cmodjs/core/ui/define-pane.js'
import { Box, Text } from '../../node_modules/@cmodjs/core/ui/elements.js'
import { poolBar } from '../components/pool-bar.js'
import type { OneclaudeState } from '../state.js'
import { ago, agentsOf, FAMILIES, pace, percent, plural, PROBLEMS, until, type Account, type Status, type Warning } from '../status.js'

export const accountsPane = definePane<OneclaudeState>({
  id: 'accounts',
  title: 'Accounts',
  closeOnEscape: true,
  render: (mod) => {
    const reading = mod.state.memory.reading
    if (reading === null) return <Text dimColor>Reading the pool</Text>
    if ('problem' in reading) return <Text color="warning">{PROBLEMS[reading.problem]}</Text>
    return (
      <Box flexDirection="column" gap={1}>
        <PoolSection status={reading.status} />
        <AccountsSection status={reading.status} />
        <WarningsSection status={reading.status} />
      </Box>
    )
  },
})

function PoolSection({ status }: { readonly status: Status }): RenderElement {
  const { pool, now } = status
  const refill = pool.next_refill === undefined ? [] : [`next refill in ${until(pool.next_refill, now)} frees ${percent(pool.refill_gain)}`]
  return (
    <Box flexDirection="column">
      <Text bold>Pool</Text>
      <Box gap={2}>
        <Box>{poolBar(pool.used, pool.even, 30)}</Box>
        <Text>{`${percent(pool.used)} used · ${pace(pool)}`}</Text>
      </Box>
      <Text dimColor>{[...refill, `${plural(pool.agents, 'agent')} on ${plural(pool.accounts, 'account')}`, `${pool.known} read`].join(' · ')}</Text>
    </Box>
  )
}

function AccountsSection({ status }: { readonly status: Status }): RenderElement {
  const width = Math.max(...status.accounts.map((account) => account.name.length), 7)
  return (
    <Box flexDirection="column">
      <Text bold>Accounts</Text>
      {status.accounts.map((account) => <AccountRow account={account} now={status.now} width={width} />)}
    </Box>
  )
}

function AccountRow({ account, now, width }: { readonly account: Account; readonly now: string; readonly width: number }): RenderElement {
  const name = <Text>{account.name.padEnd(width)}</Text>
  if (!account.known) return <Box gap={2}>{name}<Text dimColor>not read yet</Text></Box>
  const agents = FAMILIES.filter((family) => (account.agents[family] ?? 0) > 0).map((family) => `${account.agents[family]}/${account.limits[family]} ${family}`)
  const facts = [
    account.empty ? 'empty' : `${percent(account.used)} used`,
    `refills in ${until(account.resets_at, now)}`,
    agentsOf(account) === 0 ? 'idle' : agents.join(', '),
    ...(account.projected ? ['refilled since its last reading'] : []),
  ]
  return (
    <Box gap={2}>
      {name}
      <Box>{poolBar(account.used, undefined, 10)}</Box>
      <Text color={account.empty ? 'warning' : undefined} dimColor={!account.empty}>{facts.join(' · ')}</Text>
    </Box>
  )
}

function WarningsSection({ status }: { readonly status: Status }): RenderElement {
  return (
    <Box flexDirection="column">
      <Text key="warnings" bold>Warnings in the last 24 hours</Text>
      {status.warnings.length === 0
        ? <Text dimColor>None</Text>
        : [...status.warnings].reverse().map((warning) => <WarningRow warning={warning} now={status.now} />)}
    </Box>
  )
}

function WarningRow({ warning, now }: { readonly warning: Warning; readonly now: string }): RenderElement {
  return (
    <Box gap={2}>
      <Text dimColor>{ago(warning.at, now).padEnd(9)}</Text>
      <Text color="warning" wrap="wrap">{warning.detail}</Text>
    </Box>
  )
}
