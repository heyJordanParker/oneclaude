import type { Color, HttpResponse } from 'claude-code'
import { fs, http, settings, type Mod } from '../node_modules/@cmodjs/core/mod.js'
import type { OneclaudeState } from './state.js'

// LOCAL_POOL is the pool oneclaude installs on this machine, where it points
// Claude Code when nothing else is set.
export const LOCAL_POOL = 'http://127.0.0.1:8317'

// baseUrlOf is the proxy Claude Code's user settings send it to, if any.
export async function baseUrlOf(): Promise<unknown> {
  const env = (await settings.user.read())['env']
  return typeof env === 'object' && env !== null ? (env as Record<string, unknown>)['ANTHROPIC_BASE_URL'] : undefined
}

// poolOf is the pool Claude Code uses, on this machine or another.
export async function poolOf(): Promise<string> {
  const base = await baseUrlOf()
  return typeof base === 'string' && base !== '' ? base.replace(/\/+$/, '') : LOCAL_POOL
}

const resourcesOf = (pool: string): string => `${pool}/v0/resource/plugins/oneclaude`

export const statusUrl = (pool: string): string => `${resourcesOf(pool)}/status.json`

export const usageUrl = (pool: string): string => `${resourcesOf(pool)}/usage.json`

// The panel shows oneclaude's dashboard as its first plugin page, and asks
// for its login first when it holds none.
export const dashboardUrl = (pool: string): string => `${pool}/management.html#/plugin-pages/oneclaude/0`

export const addAccountUrl = (pool: string): string => `${pool}/management.html#/oauth`

// KEY is the file in the mod's data folder that holds the proxy's management
// key, written by oneclaude install or the management-key step once the proxy
// took it. The proxy bans an address for 30 minutes after 5 refused keys, so
// the mod sends no other key, and empties the file at a refusal.
const KEY = 'management-key'

export async function keyOf(mod: Mod<OneclaudeState>): Promise<string | undefined> {
  const key = await fs.read(`${mod.dataFolder}/${KEY}`).then((text) => text.trim(), () => '')
  return key === '' ? undefined : key
}

export async function saveKey(mod: Mod<OneclaudeState>, key: string): Promise<void> {
  await fs.write(`${mod.dataFolder}/${KEY}`, key)
}

// manage sends a request to the pool's management API with key, and answers
// nothing when the pool gives no answer. Claude Code ends every request a mod
// fetches within 30 seconds.
export async function manage(mod: Mod<OneclaudeState>, key: string, path: string, init: { readonly method?: string; readonly body?: string } = {}): Promise<HttpResponse | undefined> {
  const headers = { Authorization: `Bearer ${key}`, ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) }
  const pool = mod.state.memory.pool
  const response = await http.fetch(`${pool}/v0/management${path}`, { ...init, headers }).catch((error: unknown) => {
    mod.log(`${pool} gave no answer to ${path}: ${String(error)}`)
    return undefined
  })
  if (response?.status === 401) await saveKey(mod, '')
  return response
}

export type Family = 'opus' | 'sonnet' | 'haiku' | 'fable'

export type Pool = {
  readonly used: number
  readonly even: number
  readonly pace?: number
  readonly next_refill?: string
  readonly refill_gain: number
  readonly agents: number
  readonly accounts: number
  readonly known: number
  readonly limit_reached: boolean
}

export type Account = {
  readonly name: string
  readonly auth_index?: string
  readonly plan?: string
  readonly known: boolean
  readonly used: number
  readonly resets_at?: string
  readonly observed_at?: string
  readonly projected: boolean
  readonly empty: boolean
  readonly signed_out: boolean
  readonly refused?: string
  readonly throttled_at?: string
  readonly agents: Readonly<Partial<Record<Family, number>>>
  readonly limits: Readonly<Partial<Record<Family, number>>>
}

// A LogEntry is one event that changed where requests go, worded by the
// plugin.
export type LogEntry = {
  readonly at: string
  readonly level: 'WARN' | 'INFO'
  readonly text: string
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

// change counts the changes to the status, and blocks_change the events that
// may have changed the proxy's blocks. answers_within_ms is when the answer
// to status.json?after=<change> comes at the latest. reads_blocks marks the
// one answer per machine whose session reads the blocks of its blocks change.
// The plugin of oneclaude 0.9.3 and earlier sends none of them, and answers
// at once.
export type Status = {
  readonly version: string
  readonly now: string
  readonly change?: number
  readonly blocks_change?: number
  readonly answers_within_ms?: number
  readonly reads_blocks?: boolean
  readonly pool: Pool
  readonly accounts: readonly Account[]
  readonly codex: readonly Codex[]
  readonly log: readonly LogEntry[]
}

// A Block is a cooldown the proxy holds on an account, for one model or for
// all of them, until it ends. Blocks maps each account's auth_index to its
// blocks.
export type Block = { readonly model?: string; readonly until: string; readonly reason: string }

export type Blocks = Readonly<Record<string, readonly Block[]>>

export type Problem = 'proxy-down' | 'plugin-off' | 'unreadable'

export type Reading = { readonly status: Status; readonly blocks: Blocks }

export const PROBLEMS: Readonly<Record<Problem, string>> = {
  'proxy-down': 'pool unreachable',
  'plugin-off': 'plugin off',
  unreadable: 'status unreadable',
}

export function warningOf(problem: Problem, status: Status): string {
  return `${PROBLEMS[problem]} since ${momentOf(status.now, new Date().toISOString())}`
}

// read asks the pool for its status, at once, or after the change after at
// its next change, from the machine device names. A status it brings none of
// names the problem and its cause.
export async function read(pool: string, after: number | undefined, device: string | undefined): Promise<{ readonly status: Status } | { readonly problem: Problem; readonly cause: string }> {
  const query = new URLSearchParams({ ...(after === undefined ? {} : { after: String(after) }), ...(device === undefined ? {} : { device }) }).toString()
  const response = await http.fetch(query === '' ? statusUrl(pool) : `${statusUrl(pool)}?${query}`).catch((error: unknown) => String(error))
  if (typeof response === 'string') return { problem: 'proxy-down', cause: response }
  if (response.status === 404) return { problem: 'plugin-off', cause: 'the proxy answered 404' }
  if (!response.ok) return { problem: 'proxy-down', cause: `the proxy answered ${response.status}` }
  try {
    return { status: JSON.parse(response.text) as Status }
  } catch (error) {
    return { problem: 'unreadable', cause: String(error) }
  }
}

type Cooldown = { readonly scope: string; readonly model_key?: string; readonly reason: string; readonly retry_at: string }

// readBlocks reads every block the proxy holds on a Claude account, and
// fails when the proxy gives no reading.
export async function readBlocks(mod: Mod<OneclaudeState>, key: string): Promise<Blocks> {
  const response = await manage(mod, key, '/auth-files')
  if (response === undefined) throw new Error('the proxy did not answer /auth-files')
  if (!response.ok) throw new Error(`the proxy answered /auth-files with ${response.status}`)
  const { files } = JSON.parse(response.text) as { readonly files?: readonly { readonly auth_index?: string; readonly provider?: string; readonly cooldowns?: readonly Cooldown[] | null }[] }
  const blocks: Record<string, readonly Block[]> = {}
  for (const file of files ?? []) {
    if (file.provider !== 'claude' || file.auth_index === undefined || !file.cooldowns?.length) continue
    blocks[file.auth_index] = file.cooldowns.map((cooldown) => ({
      ...(cooldown.scope === 'model' && cooldown.model_key !== undefined ? { model: cooldown.model_key } : {}),
      until: cooldown.retry_at,
      reason: cooldown.reason,
    }))
  }
  return blocks
}

const BLOCKS = 'blocks.json'
const STATUS = 'status.json'

// lastBlocks is the last reading of the proxy's blocks any session made, with
// the pool's blocks change it was taken at.
async function lastBlocks(mod: Mod<OneclaudeState>): Promise<{ readonly change?: number; readonly blocks: Blocks } | undefined> {
  return fs.read(`${mod.dataFolder}/${BLOCKS}`).then((text) => JSON.parse(text) as { readonly change?: number; readonly blocks: Blocks }).catch(() => undefined)
}

export async function shareStatus(mod: Mod<OneclaudeState>, status: Status): Promise<void> {
  await fs.write(`${mod.dataFolder}/${STATUS}`, JSON.stringify(status)).catch((error: unknown) => mod.log(`oneclaude could not share the pool's status with the other sessions: ${String(error)}`))
}

export async function sharedReading(mod: Mod<OneclaudeState>): Promise<Reading | null> {
  const status = await fs.read(`${mod.dataFolder}/${STATUS}`).then((text) => JSON.parse(text) as Status).catch(() => null)
  if (status === null) return null
  return { status, blocks: (await lastBlocks(mod))?.blocks ?? {} }
}

// sharedBlocks is the proxy's blocks as of the pool's blocks change: the
// reading another session took of that change, or, when this session reads
// it, a fresh one with the management key, which it shares with the other
// sessions. It is undefined while no reading of that change is there.
export async function sharedBlocks(mod: Mod<OneclaudeState>, change: number | undefined, isReader: boolean): Promise<Blocks | undefined> {
  const shared = await lastBlocks(mod)
  if (change !== undefined && shared?.change === change) return shared.blocks
  if (!isReader) return undefined
  const key = await keyOf(mod)
  if (key === undefined) return undefined
  const blocks = await readBlocks(mod, key).catch((error: unknown) => {
    mod.log(`oneclaude could not read the proxy's blocks: ${String(error)}`)
    return undefined
  })
  if (blocks === undefined) return undefined
  await fs.write(`${mod.dataFolder}/${BLOCKS}`, JSON.stringify({ change, blocks })).catch((error: unknown) => mod.log(`oneclaude could not share the proxy's blocks with the other sessions: ${String(error)}`))
  return blocks
}

// retry asks the plugin to clear every block on the account and ask Anthropic
// about it once, and says whether it did.
export async function retry(mod: Mod<OneclaudeState>, account: Account, key: string): Promise<boolean> {
  const response = await manage(mod, key, '/plugins/oneclaude/retry', { method: 'POST', body: JSON.stringify({ auth_index: account.auth_index }) })
  return response?.ok === true
}

// A rate limit's block is a throttle, or a spent week, which the account's row
// already shows, and a login's block is a signed-out account.
const RATE_LIMITS = ['quota', 'credential_quota']
const LOGINS = ['unauthorized', 'invalid_grant']

// heldOn is every block the proxy holds on the account at now. The blocks are
// read only when they may have changed, so one whose time is up is gone.
function heldOn(account: Account, blocks: Blocks, now: string): readonly Block[] {
  const held = account.auth_index === undefined ? [] : blocks[account.auth_index] ?? []
  return held.filter((block) => Date.parse(block.until) > Date.parse(now))
}

export function isSignedOut(account: Account, blocks: Blocks, now: string): boolean {
  return account.signed_out || heldOn(account, blocks, now).some((block) => LOGINS.includes(block.reason))
}

// blocksOf is the account's blocks that no rate limit or login explains.
export function blocksOf(account: Account, blocks: Blocks, now: string): readonly Block[] {
  return heldOn(account, blocks, now).filter((block) => !RATE_LIMITS.includes(block.reason) && !LOGINS.includes(block.reason))
}

// A Trouble is one thing in the pool that needs the person, with the key of
// the Accounts page row it opens at.
export type Trouble = { readonly text: string; readonly key: string }

export const ACCOUNTS = 'accounts'

export const rowKey = (account: Account): string => `account-${account.name}`

export function troublesOf(status: Status, blocks: Blocks): readonly Trouble[] {
  const refused = status.accounts.filter((account) => account.refused !== undefined)
  const signedOut = status.accounts.filter((account) => account.refused === undefined && isSignedOut(account, blocks, status.now))
  const blocked = status.accounts.filter((account) => account.refused === undefined && !isSignedOut(account, blocks, status.now) && blocksOf(account, blocks, status.now).length > 0)
  return [
    ...(refused.length > 0 ? [{ text: `${plural(refused.length, 'account')} refused`, key: rowKey(refused[0]!) }] : []),
    ...(signedOut.length > 0 ? [{ text: `${plural(signedOut.length, 'account')} signed out`, key: rowKey(signedOut[0]!) }] : []),
    ...(blocked.length > 0 ? [{ text: `${plural(blocked.length, 'account')} blocked`, key: rowKey(blocked[0]!) }] : []),
    ...(status.pool.limit_reached ? [{ text: 'agent limit reached', key: ACCOUNTS }] : []),
  ]
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// clockOf is iso's local time of day, as 04:50:12.
export function clockOf(iso: string): string {
  const at = new Date(iso)
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':')
}

// momentOf is when iso falls: its local time, then its day when that is not
// the day of now, as 04:50 or Oct 21 04:50.
export function momentOf(iso: string, now: string): string {
  const at = new Date(iso)
  const time = clockOf(iso).slice(0, 5)
  return at.toDateString() === new Date(now).toDateString() ? time : `${MONTHS[at.getMonth()]} ${at.getDate()} ${time}`
}

export const FAMILIES: readonly Family[] = ['opus', 'sonnet', 'haiku', 'fable']

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`
}

export function pace(ahead: number): string {
  const points = Math.round(Math.abs(ahead) * 100)
  if (points === 0) return 'on pace'
  return `${points}% ${ahead < 0 ? 'under' : 'over'} pace`
}

export type PaceState = 'on' | 'under' | 'over' | 'far-over'

export function paceState(ahead: number): PaceState {
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
// glyph fills the left part in color and leaves the background showing. A
// dim cell draws its color faint.
export type Cell = { readonly text: string; readonly color: Color; readonly background?: Color; readonly isDim?: boolean }

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
  return runsOf(drawn)
}

// runsOf joins neighbouring cells of the same colors into one run.
export function runsOf(cells: readonly Cell[]): Cell[] {
  return cells.reduce<Cell[]>((runs, cell) => {
    const last = runs.at(-1)
    if (last !== undefined && last.color === cell.color && last.background === cell.background && last.isDim === cell.isDim) runs[runs.length - 1] = { ...last, text: last.text + cell.text }
    else runs.push(cell)
    return runs
  }, [])
}

// GLIDE is how far a bar moves toward its reading each frame, so a change
// eases in over about 0.4 s at 30 frames a second.
export const GLIDE = 0.18

export const FRAME_MS = 33

export type Shown = { readonly used: number; readonly pace: number }

// LINE is the bar under the prompt. The Accounts page's bars are POOL and one
// per account, so opening the page grows them from 0 and leaves LINE where it
// is.
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

