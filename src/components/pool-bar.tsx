import type { Color, RenderElement } from 'claude-code'
import { Text } from '../../node_modules/@cmodjs/core/ui/elements.js'
import { bar, BAR_CELLS, type Shown } from '../status.js'

// LIFTED is each bar color one step brighter, drawn while the pointer is over
// the row, which Claude Code applies with no call to the mod.
const LIFTED: Readonly<Record<string, Color>> = {
  subtle: 'promptBorder',
  promptBorder: 'inactive',
  inactive: 'text',
  warning: 'warning',
  error: 'error',
  diffRemoved: 'error',
}

export function poolBar({ used, pace }: Shown): RenderElement[] {
  return bar(used, pace, BAR_CELLS).map((cell) => {
    const lift = (color: Color): Color => LIFTED[color] ?? color
    return cell.background === undefined
      ? <Text color={cell.color} hover={{ color: lift(cell.color) }}>{cell.text}</Text>
      : <Text color={cell.color} backgroundColor={cell.background} hover={{ color: lift(cell.color), backgroundColor: lift(cell.background) }}>{cell.text}</Text>
  })
}
