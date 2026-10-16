import type { RenderElement } from 'claude-code'
import { Box, Button, Text } from '../../node_modules/@cmodjs/core/ui/elements.js'
import { pace, paceState, percent, plural, PROBLEMS, until, type PaceState, type Reading, type Shown } from '../status.js'
import { poolBar } from './pool-bar.js'

const PACE_COLORS: Readonly<Record<PaceState, string | undefined>> = {
  on: undefined,
  under: 'success',
  over: 'claude',
  'far-over': 'error',
}

export type Fact = string | { readonly used: number; readonly even: number }

// factText is the facts as one line of plain text, the width they take.
export function factText(facts: readonly Fact[]): string {
  return facts.map((fact) => (typeof fact === 'string' ? fact : pace(fact.used, fact.even))).join(' · ')
}

export function Facts({ facts, color, wrap = 'wrap' }: { readonly facts: readonly Fact[]; readonly color?: string; readonly wrap?: 'wrap' | 'truncate-end' }): RenderElement {
  const parts = facts.flatMap((fact, index) => {
    const separator = index === 0 ? [] : [' · ']
    if (typeof fact === 'string') return [...separator, fact]
    const paceColor = PACE_COLORS[paceState(fact.used, fact.even)]
    return [...separator, paceColor === undefined ? pace(fact.used, fact.even) : <Text color={paceColor} dimColor={false}>{pace(fact.used, fact.even)}</Text>]
  })
  return <Text color={color} dimColor={color === undefined} wrap={wrap}>{parts}</Text>
}

export function PoolLine({ reading, shown, isOpen, onToggle, onWarnings }: { readonly reading: Reading; readonly shown?: Shown; readonly isOpen: boolean; readonly onToggle: () => unknown; readonly onWarnings: () => unknown }): RenderElement {
  if ('problem' in reading) return <Text color="warning">{PROBLEMS[reading.problem]}</Text>
  const { pool, warnings, now } = reading.status
  const facts: Fact[] = pool.known === 0
    ? ['reading accounts', plural(pool.agents, 'agent')]
    : [
        percent(pool.used),
        { used: pool.used, even: pool.even },
        ...(pool.next_refill === undefined ? [] : [`next refill in ${until(pool.next_refill, now)}`]),
        plural(pool.agents, 'agent'),
      ]
  return (
    <Box gap={2}>
      <Box key="pool" flexShrink={0}>{poolBar(shown ?? { used: pool.used, pace: pool.even })}</Box>
      <Box gap={1}>
        <Facts facts={facts} wrap="truncate-end" />
        {warnings.length > 0 ? (
          <Box flexShrink={0}>
            <Button key="warnings" plain onPress={onWarnings}>
              <Text color="warning">{`[ ${plural(warnings.length, 'warning')} ]`}</Text>
            </Button>
          </Box>
        ) : null}
        <Box flexShrink={0}>
          <Button key="accounts" plain dimColor onPress={onToggle}>{isOpen ? '[-]' : '[+]'}</Button>
        </Box>
      </Box>
    </Box>
  )
}
