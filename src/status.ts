import { http } from '../node_modules/@cmodjs/core/mod.js'

export const PROXY = 'http://127.0.0.1:8317'

export const STATUS_URL = `${PROXY}/v0/resource/plugins/oneclaude/status.json`

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

export function pace(pool: Pool): string {
  const points = Math.round(Math.abs(pool.pace) * 100)
  if (points === 0) return 'on pace'
  return `${points}% ${pool.pace < 0 ? 'under' : 'over'} pace`
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

const BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

export function bar(used: number, even: number | undefined, cells: number): readonly Run[] {
  const eighths = Math.round(clamp(used) * cells * 8)
  const fill = '█'.repeat(Math.floor(eighths / 8)) + BLOCKS[eighths % 8]
  const glyphs: Run[] = [...fill].map((text) => ({ kind: 'fill', text }))
  while (glyphs.length < cells) glyphs.push({ kind: 'empty', text: '░' })
  if (even !== undefined) glyphs.splice(Math.round(clamp(even) * cells), 0, { kind: 'marker', text: '┃' })
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
