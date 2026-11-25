import { Progress } from '../../node_modules/@cmodjs/core/ui/components.js'
import { Text } from '../../node_modules/@cmodjs/core/ui/elements.js'
import { BAR_WIDTH, NEARLY_EMPTY, type Cell, type Shown } from '../status.js'

// poolBar fills to the lower of used and pace, and the color change marks
// pace: over pace fills on in the over color, under pace the headroom shows
// as Progress's buffer, a lifted track. A nearly empty bar turns red, and its
// part over pace a darker red.
export function poolBar({ used, pace }: Shown): JSX.Element {
  const isNearlyEmpty = used >= NEARLY_EMPTY
  const over = Math.max(0, used - pace) * 100
  return (
    <Progress
      width={BAR_WIDTH}
      buffer={pace * 100}
      sections={[{ value: Math.min(used, pace) * 100, tone: isNearlyEmpty ? 'critical' : 'neutral' }, isNearlyEmpty ? { value: over, color: 'diffRemoved' } : { value: over, tone: 'warning' }]}
    />
  )
}

export function drawCells(cells: readonly Cell[]): JSX.Element[] {
  return cells.map((cell) => <Text color={cell.color} backgroundColor={cell.background} dimColor={cell.isDim}>{cell.text}</Text>)
}
