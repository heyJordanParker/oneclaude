import type { RenderElement } from 'claude-code'
import { Text } from '../../node_modules/@cmodjs/core/ui/elements.js'
import { bar, BAR_CELLS, type Cell, type Shown } from '../status.js'

export function poolBar({ used, pace }: Shown): RenderElement[] {
  return drawCells(bar(used, pace, BAR_CELLS))
}

export function drawCells(cells: readonly Cell[]): RenderElement[] {
  return cells.map((cell) => (
    cell.background === undefined
      ? <Text color={cell.color}>{cell.text}</Text>
      : <Text color={cell.color} backgroundColor={cell.background}>{cell.text}</Text>
  ))
}
