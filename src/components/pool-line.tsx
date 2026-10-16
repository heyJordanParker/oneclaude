import type { RenderElement } from 'claude-code'
import { Box, Button, Text } from '../../node_modules/@cmodjs/core/ui/elements.js'
import { pace, percent, plural, PROBLEMS, until, type Reading } from '../status.js'
import { poolBar } from './pool-bar.js'

export function PoolLine({ reading, isOpen, onToggle, onWarnings }: { readonly reading: Reading; readonly isOpen: boolean; readonly onToggle: () => unknown; readonly onWarnings: () => unknown }): RenderElement {
  if ('problem' in reading) return <Text color="warning">{PROBLEMS[reading.problem]}</Text>
  const { pool, warnings, now } = reading.status
  const facts = pool.known === 0
    ? ['reading accounts', plural(pool.agents, 'agent')]
    : [
        percent(pool.used),
        pace(pool.used, pool.even),
        ...(pool.next_refill === undefined ? [] : [`next refill in ${until(pool.next_refill, now)}`]),
        plural(pool.agents, 'agent'),
      ]
  return (
    <Box gap={2}>
      <Box flexShrink={0}>{poolBar(pool.used, pool.even, 20)}</Box>
      <Text dimColor wrap="truncate-end">{facts.join(' · ')}</Text>
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
  )
}
