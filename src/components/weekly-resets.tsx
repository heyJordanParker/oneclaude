import type { Color, RenderElement } from 'claude-code'
import { Box, Text } from '../../node_modules/@cmodjs/core/ui/elements.js'
import { CAP_LEFT, CAP_RIGHT, NEARLY_EMPTY, percent, runsOf, until, type Account, type Cell } from '../status.js'
import { drawCells } from './pool-bar.js'

const DAYS = 8
const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS
const GAP = 2
const MOST_CELLS = 8
const FEWEST_CELLS = 4
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const NOW_LINE = '│'
const NOW_COLOR: Color = 'text'

// A Lane is one account's weeks on the calendar, a rounded bar each, then
// how long until its week resets and how much it has left until then.
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
      const edges = [resets - WEEK_MS, resets, resets + WEEK_MS].map((time) => edgeOf(Math.round(cellAt(time)), nowCell))
      return { name: account.name, cells: weeksOf(edges, nowCell, DAYS * perDay, isNearlyEmpty), reset: reset.padEnd(resetWidth), remaining, isNearlyEmpty }
    }),
  }
}

// edgeOf keeps a week's first cell off the cells around now, so the line of
// now never takes the place of a rounded end.
function edgeOf(cell: number, nowCell: number): number {
  return cell > nowCell ? Math.max(cell, nowCell + 2) : Math.min(cell, nowCell - 1)
}

// weeksOf draws each week as a rounded bar from its first cell, its ends
// square where it runs off the calendar. The week of now is gray up to now
// and in Claude's color after, all red once the account is nearly empty.
// Weeks before it are gray, and the week after it is faint.
function weeksOf(edges: readonly number[], nowCell: number, cells: number, isNearlyEmpty: boolean): Cell[] {
  const weekOf = (cell: number): number => edges.filter((edge) => edge <= cell).length
  const current = weekOf(nowCell)
  const colorOf = (cell: number): Color => {
    const week = weekOf(cell)
    if (week < current) return 'inactive'
    if (week > current) return 'subtle'
    if (isNearlyEmpty) return 'error'
    return cell < nowCell ? 'inactive' : 'claude'
  }
  return runsOf(Array.from({ length: cells }, (_, cell): Cell => {
    const color = colorOf(cell)
    if (cell === nowCell) return { text: NOW_LINE, color: NOW_COLOR, background: color }
    if (cell > 0 && edges.includes(cell)) return { text: CAP_LEFT, color }
    if (cell < cells - 1 && edges.includes(cell + 1)) return { text: CAP_RIGHT, color }
    return { text: '█', color }
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
