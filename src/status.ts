import type { Color } from 'claude-code'
import { http } from '../node_modules/@cmodjs/core/mod.js'

export const PROXY = 'http://127.0.0.1:8317'

const RESOURCES = `${PROXY}/v0/resource/plugins/oneclaude`

export const STATUS_URL = `${RESOURCES}/status.json`

// The dashboard page signs the proxy's panel in with oneclaude's management
// key, then opens itself inside the panel, at its accounts for "accounts".
export const DASHBOARD_URL = `${RESOURCES}/dashboard?open=dashboard`

export const ACCOUNTS_URL = `${RESOURCES}/dashboard?open=accounts`

export type Family = 'opus' | 'sonnet' | 'haiku' | 'fable'

export type Pool = {
  readonly used: number
  readonly even: number
  readonly pace: number
  readonly next_refill?: string
  readonly refill_gain: number
  readonly agents: number
  readonly accounts: number
  readonly known: number
}

export type Account = {
  readonly name: string
  readonly plan?: string
  readonly known: boolean
  readonly used: number
  readonly resets_at?: string
  readonly observed_at?: string
  readonly projected: boolean
  readonly empty: boolean
  readonly agents: Readonly<Partial<Record<Family, number>>>
  readonly limits: Readonly<Partial<Record<Family, number>>>
}

export type Warning = {
  readonly at: string
  readonly kind: 'throttled' | 'overloaded' | 'refused' | 'login' | 'limit'
  readonly account?: string
  readonly family?: Family
  readonly agents?: number
  readonly detail: string
}

// A Codex account the proxy holds. oneclaude routes none of its requests and
// shows only its weekly usage.
export type Codex = {
  readonly name: string
  readonly known: boolean
  readonly used: number
  readonly resets_at?: string
  readonly projected: boolean
  readonly empty: boolean
}

export type Status = {
  readonly version: string
  readonly now: string
  readonly pool: Pool
  readonly accounts: readonly Account[]
  readonly codex: readonly Codex[]
  readonly warnings: readonly Warning[]
}

export type Problem = 'proxy-down' | 'plugin-off' | 'unreadable'

export type Reading = { readonly status: Status } | { readonly problem: Problem }

export const PROBLEMS: Readonly<Record<Problem, string>> = {
  'proxy-down': 'oneclaude: proxy down',
  'plugin-off': 'oneclaude: plugin off',
  unreadable: 'oneclaude: status unreadable',
}

export async function read(): Promise<Reading> {
  const response = await http.fetch(STATUS_URL).catch(() => undefined)
  if (response === undefined) return { problem: 'proxy-down' }
  if (response.status === 404) return { problem: 'plugin-off' }
  if (!response.ok) return { problem: 'proxy-down' }
  try {
    return { status: JSON.parse(response.text) as Status }
  } catch {
    return { problem: 'unreadable' }
  }
}

export const FAMILIES: readonly Family[] = ['opus', 'sonnet', 'haiku', 'fable']

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`
}

export function pace(used: number, even: number): string {
  const ahead = used - even
  const points = Math.round(Math.abs(ahead) * 100)
  if (points === 0) return 'on pace'
  return `${points}% ${ahead < 0 ? 'under' : 'over'} pace`
}

export type PaceState = 'on' | 'under' | 'over' | 'far-over'

export function paceState(used: number, even: number): PaceState {
  const ahead = used - even
  if (ahead > 0.25) return 'far-over'
  if (ahead > 0.05) return 'over'
  if (ahead < -0.05) return 'under'
  return 'on'
}

export const NEARLY_EMPTY = 0.95

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export function evenOf(account: { readonly resets_at?: string }, now: string): number | undefined {
  if (account.resets_at === undefined) return undefined
  return clamp(1 - (Date.parse(account.resets_at) - Date.parse(now)) / WEEK_MS)
}

// until says how long until iso: days from 2 days on, days and hours under 2
// days, hours and minutes under a day, and minutes under an hour.
export function until(iso: string | undefined, now: string): string {
  if (iso === undefined) return 'unknown'
  const minutes = Math.round((Date.parse(iso) - Date.parse(now)) / 60_000)
  if (minutes <= 0) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return withRest(`${hours}h`, minutes % 60, 'm')
  if (hours < 48) return withRest('1d', hours % 24, 'h')
  return `${Math.round(minutes / (24 * 60))}d`
}

function withRest(head: string, rest: number, unit: string): string {
  return rest === 0 ? head : `${head} ${rest}${unit}`
}

export function ago(iso: string, now: string): string {
  const passed = until(now, iso)
  return passed === 'now' ? 'just now' : `${passed} ago`
}

// A bar cell holds one color, or two split at an eighth of the cell: the
// glyph fills the left part in color and leaves the background showing.
export type Cell = { readonly text: string; readonly color: Color; readonly background?: Color }

export const BAR_CELLS = 20

const STEPS = 8
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

// The caps are Nerd Font's rounded ends, which round the bar's full height.
export const CAP_LEFT = ''
export const CAP_RIGHT = ''

// bar draws a rounded pill, exact to an eighth of a cell. The fill runs to
// the lower of used and pace, and the color change marks pace: over pace
// fills on in the over color, under pace the headroom shows in a lifted track.
export function bar(used: number, pace: number, cells: number): readonly Cell[] {
  const units = cells * STEPS
  const filled = Math.round(clamp(used) * units)
  const paced = Math.round(clamp(pace) * units)
  const isNearlyEmpty = used >= NEARLY_EMPTY
  const colorAt = (unit: number): Color => {
    if (unit < Math.min(filled, paced)) return isNearlyEmpty ? 'error' : 'inactive'
    if (unit < filled) return isNearlyEmpty ? 'diffRemoved' : 'warning'
    if (unit < paced) return 'promptBorder'
    return 'subtle'
  }
  const drawn: Cell[] = [{ text: CAP_LEFT, color: colorAt(0) }]
  for (let cell = 0; cell < cells; cell++) {
    const left = colorAt(cell * STEPS)
    const right = colorAt(cell * STEPS + STEPS - 1)
    let edge = 1
    while (edge < STEPS && colorAt(cell * STEPS + edge) === left) edge++
    drawn.push(left === right ? { text: '█', color: left } : { text: EIGHTHS[edge] ?? '█', color: left, background: right })
  }
  drawn.push({ text: CAP_RIGHT, color: colorAt(units - 1) })
  return drawn.reduce<Cell[]>((runs, cell) => {
    const last = runs.at(-1)
    if (last !== undefined && last.color === cell.color && last.background === cell.background) runs[runs.length - 1] = { ...last, text: last.text + cell.text }
    else runs.push(cell)
    return runs
  }, [])
}

// GLIDE is how far a bar moves toward its reading each frame, so a change
// eases in over about 0.4 s at 30 frames a second.
export const GLIDE = 0.18

export const FRAME_MS = 33

export type Shown = { readonly used: number; readonly pace: number }

// LINE is the bar under the prompt. The pane's bars are POOL and one per
// account, so opening the pane grows them from 0 and leaves LINE where it is.
export const LINE = 'line'
export const POOL = 'pool'

export const claudeKey = (account: Account): string => `claude:${account.name}`
export const codexKey = (account: Codex): string => `codex:${account.name}`

// paceOf is where an account's bar marks even pace. An empty account shows
// none, because pace means nothing once it is spent.
export function paceOf(account: Account | Codex, now: string): number {
  return account.empty ? account.used : evenOf(account, now) ?? account.used
}

// barsOf is what every bar should show for this status.
export function barsOf(status: Status): Readonly<Record<string, Shown>> {
  const pool = { used: status.pool.used, pace: status.pool.even }
  const bars: Record<string, Shown> = { [LINE]: pool, [POOL]: pool }
  for (const account of status.accounts) if (account.known) bars[claudeKey(account)] = { used: account.used, pace: paceOf(account, status.now) }
  for (const account of status.codex) if (account.known) bars[codexKey(account)] = { used: account.used, pace: paceOf(account, status.now) }
  return bars
}

// glide moves a shown bar one frame toward its reading, and lands on it once
// it is within 0.05%.
export function glide(shown: Shown, target: Shown): Shown {
  const step = (from: number, to: number): number => (Math.abs(to - from) < 0.0005 ? to : from + (to - from) * GLIDE)
  return { used: step(shown.used, target.used), pace: step(shown.pace, target.pace) }
}

function clamp(fraction: number): number {
  return Math.min(1, Math.max(0, fraction))
}

export function agentsOf(account: Account): number {
  return FAMILIES.reduce((sum, family) => sum + (account.agents[family] ?? 0), 0)
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}
