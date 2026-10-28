import type { RenderElement } from 'claude-code'
import { Box, Button, Text } from '../../node_modules/@cmodjs/core/ui/elements.js'
import { pace, paceState, percent, plural, PROBLEMS, troublesOf, until, type PaceState, type Reading, type Shown } from '../status.js'
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

// Facts draws the facts on one line, cut at the end, or wrapped between facts,
// so a fact such as "18 agents" never splits across lines.
export function Facts({ facts, color, wrap = 'wrap' }: { readonly facts: readonly Fact[]; readonly color?: string; readonly wrap?: 'wrap' | 'truncate-end' }): RenderElement {
  const draw = (fact: Fact): RenderElement | string => {
    if (typeof fact === 'string') return fact
    const paceColor = PACE_COLORS[paceState(fact.used, fact.even)]
    return paceColor === undefined ? pace(fact.used, fact.even) : <Text color={paceColor} dimColor={false}>{pace(fact.used, fact.even)}</Text>
  }
  if (wrap === 'wrap') {
    return (
      <Box flexWrap="wrap" columnGap={1}>
        {facts.map((fact, index) => <Box flexShrink={0}><Text color={color} dimColor={color === undefined}>{index === 0 ? [draw(fact)] : ['· ', draw(fact)]}</Text></Box>)}
      </Box>
    )
  }
  const parts = facts.flatMap((fact, index) => (index === 0 ? [draw(fact)] : [' · ', draw(fact)]))
  return <Text color={color} dimColor={color === undefined} wrap={wrap}>{parts}</Text>
}

export function PoolLine({ reading, shown, isOpen, onToggle, onTrouble }: { readonly reading: Reading; readonly shown?: Shown; readonly isOpen: boolean; readonly onToggle: () => unknown; readonly onTrouble: (key: string) => unknown }): RenderElement {
  if ('problem' in reading) return <Text color="warning">{PROBLEMS[reading.problem]}</Text>
  const { pool, now } = reading.status
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
      <Box flexShrink={0}>{poolBar(shown ?? { used: pool.used, pace: pool.even })}</Box>
      <Box gap={1}>
        <Facts facts={facts} wrap="truncate-end" />
        {troublesOf(reading.status, reading.blocks).map((trouble) => (
          <Box flexShrink={0}>
            <Button key={`trouble-${trouble.key}`} plain onPress={() => onTrouble(trouble.key)}>
              <Text color="warning">{`· ${trouble.text}`}</Text>
            </Button>
          </Box>
        ))}
        <Box flexShrink={0}>
          <Button key="accounts" plain dimColor onPress={onToggle}>{isOpen ? '[-]' : '[+]'}</Button>
        </Box>
      </Box>
    </Box>
  )
}
