import type { RenderElement } from 'claude-code'
import { Text } from '../../node_modules/@cmodjs/core/ui/elements.js'
import { bar, NEARLY_EMPTY, type BarStyle } from '../status.js'

export function poolBar(used: number, even: number | undefined, cells: number, style: BarStyle): RenderElement[] {
  const fill = used >= NEARLY_EMPTY ? 'error' : 'inactive'
  return bar(used, even, cells, style).map((run) => {
    if (run.kind === 'marker') return <Text color="text" bold>{run.text}</Text>
    if (run.kind === 'fill') return <Text color={fill}>{run.text}</Text>
    return <Text color="inactive" dimColor>{run.text}</Text>
  })
}
