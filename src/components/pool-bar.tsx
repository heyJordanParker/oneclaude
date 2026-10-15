import type { RenderElement } from 'claude-code'
import { Text } from '../../node_modules/@cmodjs/core/ui/elements.js'
import { bar } from '../status.js'

export function poolBar(used: number, even: number | undefined, cells: number): RenderElement[] {
  const fill = used >= 1 || (even !== undefined && used > even) ? 'warning' : 'success'
  return bar(used, even, cells).map((run) => (
    <Text color={run.kind === 'fill' ? fill : run.kind === 'marker' ? 'text' : 'inactive'}>{run.text}</Text>
  ))
}
