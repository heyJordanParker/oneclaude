import type { RenderElement } from 'claude-code'
import { Box, Button, Text } from '../../node_modules/@cmodjs/core/ui/elements.js'
import { pace, percent, plural, PROBLEMS, until, type Reading } from '../status.js'
import { poolBar } from './pool-bar.js'

export function PoolLine({ reading, onOpen, onWarnings }: { readonly reading: Reading; readonly onOpen: () => unknown; readonly onWarnings: () => unknown }): RenderElement {
  if ('problem' in reading) return <Text color="warning">{PROBLEMS[reading.problem]}</Text>
  const { pool, warnings, now } = reading.status
  const facts = pool.known === 0
    ? ['reading accounts', plural(pool.agents, 'agent')]
    : [
        percent(pool.used),
        pace(pool),
        ...(pool.next_refill === undefined ? [] : [`next refill in ${until(pool.next_refill, now)}`]),
        plural(pool.agents, 'agent'),
      ]
  return (
    <Box gap={2}>
      <Button key="pool" plain onPress={onOpen}>
        {poolBar(pool.used, pool.even, 20)}
      </Button>
      <Text dimColor wrap="truncate-end">{facts.join(' · ')}</Text>
      {warnings.length > 0 ? (
        <Button key="warnings" plain onPress={onWarnings}>
          <Text color="warning">{`[ ${plural(warnings.length, 'warning')} ]`}</Text>
        </Button>
      ) : null}
    </Box>
  )
}
