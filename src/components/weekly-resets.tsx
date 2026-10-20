import type { Color, RenderElement } from 'claude-code'
import { Box, Text } from '../../node_modules/@cmodjs/core/ui/elements.js'
import { CAP_LEFT, CAP_RIGHT, NEARLY_EMPTY, percent, runsOf, until, type Account, type Cell } from '../status.js'
import { drawCells } from './pool-bar.js'

const DAYS = 8
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS
const GAP = 2
const MOST_CELLS = 8
const FEWEST_CELLS = 4
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const NOW_LINE = '│'
const NOW_COLOR: Color = 'text'

// A Lane is one account's week on the calendar as a rounded bar, then how
// long until it resets and how much it has left until then.
export type Lane = {
  readonly name: string
  readonly cells: readonly Cell[]
  readonly reset: string
  readonly remaining: string
  readonly isNearlyEmpty: boolean
}

// A Calendar is 8 days from yesterday's midnight, at the most cells per day
// that fit the room, the cell of now, and a lane per account, soonest reset
// first.
export type Calendar = { readonly days: string; readonly now: number; readonly lanes: readonly Lane[] }

export function calendarOf(accounts: readonly Account[], now: string, room: number): Calendar {
  const at = Date.parse(now)
  const offset = offsetOf(now)
  const start = at + offset - ((at + offset) % DAY_MS) - DAY_MS - offset
  const read = accounts
    .flatMap((account) => (account.known && account.resets_at !== undefined ? [{ account, resets: Date.parse(account.resets_at) }] : []))
    .sort((a, b) => a.resets - b.resets)
    .map(({ account, resets }) => {
      const left = until(account.resets_at, now)
      return { account, resets, reset: left === 'now' ? left : `in ${left}`, remaining: account.empty ? 'empty' : `${percent(1 - account.used)} left` }
    })
  const resetWidth = Math.max(0, ...read.map(({ reset }) => reset.length))
  const label = resetWidth + GAP + Math.max(0, ...read.map(({ remaining }) => remaining.length))
  const perDay = Math.min(MOST_CELLS, Math.max(FEWEST_CELLS, Math.floor((room - GAP - label) / DAYS)))
  const cellAt = (time: number): number => ((time - start) / DAY_MS) * perDay
  const nowCell = Math.floor(cellAt(at))
  const days = Array.from({ length: DAYS }, (_, day) => {
    const date = new Date(start + offset + day * DAY_MS)
    const name = WEEKDAYS[date.getUTCDay()]!
    return (perDay > `${name} 00`.length ? `${name} ${date.getUTCDate()}` : name).padEnd(perDay)
  })
  return {
    days: days.join('').trimEnd(),
    now: nowCell,
    lanes: read.map(({ account, resets, reset, remaining }) => {
      const isNearlyEmpty = account.empty || account.used >= NEARLY_EMPTY
      const opened = resets - WEEK_MS
      const open = edgeOf(Math.round(cellAt(opened)), nowCell)
      const close = edgeOf(Math.round(cellAt(resets)), nowCell)
      const runsOut = account.empty ? at : runsOutAt(account.used, opened, at)
      const out = Math.min(close, Math.max(nowCell + 1, Math.round(cellAt(runsOut))))
      return { name: account.name, cells: weekOf({ open, out, close }, nowCell, DAYS * perDay, isNearlyEmpty), reset: reset.padEnd(resetWidth), remaining, isNearlyEmpty }
    }),
  }
}

// edgeOf keeps a week's first cell off the cells around now, so the line of
// now never takes the place of a rounded end.
function edgeOf(cell: number, nowCell: number): number {
  return cell > nowCell ? Math.max(cell, nowCell + 2) : Math.min(cell, nowCell - 1)
}

// runsOutAt is when an account's quota runs out at the pace of its week so far.
function runsOutAt(used: number, opened: number, now: number): number {
  const pace = used / Math.max(now - opened, HOUR_MS)
  return pace === 0 ? Infinity : now + (1 - used) / pace
}

// weekOf draws the week as one rounded bar from the cell it opened to the
// cell it resets, its ends square where it runs off the calendar, on a faint
// line across the rest of the lane. It is dark up to now, gray while its
// quota lasts, red when the account is nearly empty, and faint from where its
// quota would run out.
function weekOf({ open, out, close }: { readonly open: number; readonly out: number; readonly close: number }, nowCell: number, cells: number, isNearlyEmpty: boolean): Cell[] {
  return runsOf(Array.from({ length: cells }, (_, cell): Cell => {
    if (cell < open || cell >= close) return { text: '╌', color: 'inactive', isDim: true }
    const color: Color = cell < nowCell ? 'subtle' : isNearlyEmpty ? 'error' : 'inactive'
    if (cell === nowCell) return { text: NOW_LINE, color: NOW_COLOR, background: color }
    const text = cell === open && cell > 0 ? CAP_LEFT : cell === close - 1 && close < cells ? CAP_RIGHT : '█'
    return cell >= out ? { text, color, isDim: true } : { text, color }
  }))
}

function offsetOf(iso: string): number {
  const match = /([+-])(\d\d):(\d\d)$/.exec(iso)
  if (match === null) return 0
  const minutes = Number(match[2]) * 60 + Number(match[3])
  return (match[1] === '-' ? -minutes : minutes) * 60_000
}

// WeeklyResets draws the days, then each lane under a row that carries only
// the line of now, so the line runs through every lane.
export function WeeklyResets({ calendar, width }: { readonly calendar: Calendar; readonly width: number }): RenderElement {
  const gap = ' '.repeat(GAP)
  const indent = ' '.repeat(width + GAP)
  const line = <Text color={NOW_COLOR}>{`${indent}${' '.repeat(calendar.now)}${NOW_LINE}`}</Text>
  return (
    <Box flexDirection="column">
      <Text dimColor>{`${indent}${calendar.days}`}</Text>
      {calendar.lanes.flatMap((lane) => [
        line,
        <Text>
          {`${lane.name.padEnd(width)}${gap}`}
          {drawCells(lane.cells)}
          <Text color={lane.isNearlyEmpty ? 'error' : undefined}>
            {`${gap}${lane.reset}${gap}`}
            <Text dimColor={!lane.isNearlyEmpty}>{lane.remaining}</Text>
          </Text>
        </Text>,
      ])}
    </Box>
  )
}
