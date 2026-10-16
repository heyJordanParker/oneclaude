import { http } from '../node_modules/@cmodjs/core/mod.js'

export const PROXY = 'http://127.0.0.1:8317'

export const STATUS_URL = `${PROXY}/v0/resource/plugins/oneclaude/status.json`

export const DASHBOARD_URL = `${PROXY}/management.html#/plugin-pages/oneclaude/0`

export const ACCOUNTS_URL = `${PROXY}/management.html#/auth-files`

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

export type Status = {
  readonly version: string
  readonly now: string
  readonly pool: Pool
  readonly accounts: readonly Account[]
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

export function evenOf(account: Account, now: string): number | undefined {
  if (account.resets_at === undefined) return undefined
  return clamp(1 - (Date.parse(account.resets_at) - Date.parse(now)) / WEEK_MS)
}

export function until(iso: string | undefined, now: string): string {
  if (iso === undefined) return 'unknown'
  const ms = Date.parse(iso) - Date.parse(now)
  if (ms <= 0) return 'now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export function ago(iso: string, now: string): string {
  const passed = until(now, iso)
  return passed === 'now' ? 'just now' : `${passed} ago`
}

export type Run = { readonly kind: 'fill' | 'empty' | 'marker'; readonly text: string }

export type BarStyle = 'line' | 'half'

const GLYPHS: Readonly<Record<BarStyle, Readonly<Record<Run['kind'], string>>>> = {
  line: { fill: '━', empty: '─', marker: '┃' },
  half: { fill: '▄', empty: '▁', marker: '┃' },
}

export function bar(used: number, even: number | undefined, cells: number, style: BarStyle): readonly Run[] {
  const glyph = GLYPHS[style]
  const filled = Math.round(clamp(used) * cells)
  const glyphs: Run[] = Array.from({ length: cells }, (_, cell) => (cell < filled ? { kind: 'fill', text: glyph.fill } : { kind: 'empty', text: glyph.empty }))
  if (even !== undefined) glyphs[Math.min(cells - 1, Math.floor(clamp(even) * cells))] = { kind: 'marker', text: glyph.marker }
  return glyphs.reduce<Run[]>((runs, glyph) => {
    const last = runs.at(-1)
    if (last?.kind === glyph.kind) runs[runs.length - 1] = { kind: last.kind, text: last.text + glyph.text }
    else runs.push(glyph)
    return runs
  }, [])
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
