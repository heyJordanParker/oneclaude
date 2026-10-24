import { compare } from '../node_modules/bcrypt-ts/dist/browser.js'
import type { Color } from 'claude-code'
import { fs, http, type Mod } from '../node_modules/@cmodjs/core/mod.js'
import type { OneclaudeState } from './state.js'

export const PROXY = 'http://127.0.0.1:8317'

const RESOURCES = `${PROXY}/v0/resource/plugins/oneclaude`

export const STATUS_URL = `${RESOURCES}/status.json`

export const USAGE_URL = `${RESOURCES}/usage.json`

// The dashboard page signs the proxy's panel in with oneclaude's management
// key, then opens the panel at the dashboard, or at its OAuth login page to
// add an account.
export const DASHBOARD_URL = `${RESOURCES}/dashboard?open=dashboard`

export const ADD_ACCOUNT_URL = `${RESOURCES}/dashboard?open=add-account`

// The proxy's management API takes the proxy's management key: the one
// oneclaude install sets on a proxy with none, or the one the person set. The
// proxy bans an address for 30 minutes after 5 refused keys, so the mod sends
// a key only once it fits the hash in the proxy's config.
const MANAGEMENT = `${PROXY}/v0/management`
export const MANAGEMENT_KEY = 'oneclaude'

// PROXY_CONFIG is the file in the mod's data folder where oneclaude install
// writes the path of the proxy's config.
const PROXY_CONFIG = 'proxy-config'

// secretKeyOf reads management.secret-key, or remote-management's, from the
// proxy's config.
export function secretKeyOf(config: string): string | undefined {
  let isManagement = false
  for (const line of config.split('\n')) {
    if (/^\S/.test(line)) isManagement = /^(remote-)?management:\s*(#.*)?$/.test(line)
    const value = isManagement ? /^\s+secret-key:\s*(.*)$/.exec(line)?.[1] : undefined
    if (value !== undefined) return value.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2') || undefined
  }
  return undefined
}

// proxySecret is the management key as the proxy's config keeps it, or
// undefined when the config can't be read or has none.
export async function proxySecret(dataFolder: string): Promise<string | undefined> {
  try {
    return secretKeyOf(await fs.read((await fs.read(`${dataFolder}/${PROXY_CONFIG}`)).trim()))
  } catch {
    return undefined
  }
}

// fits says whether key is the one the proxy keeps: as a bcrypt hash, or as
// plain text the proxy has not hashed yet.
export function fits(key: string, secret: string): Promise<boolean> {
  return /^\$2[aby]\$/.test(secret) ? compare(key, secret) : Promise.resolve(key === secret)
}

// keyOf is the management key to send: the person's, or oneclaude's, once it
// fits the proxy's config, so the proxy never refuses it.
export async function keyOf(mod: Mod<OneclaudeState>): Promise<string | undefined> {
  const secret = await proxySecret(mod.dataFolder)
  if (secret === undefined) return undefined
  const key = mod.state.global.managementKey ?? MANAGEMENT_KEY
  let checked = mod.state.global.checkedKey
  if (checked?.key !== key || checked.secret !== secret) {
    checked = { key, secret, fits: await fits(key, secret) }
    mod.state.global.checkedKey = checked
  }
  return checked.fits ? key : undefined
}

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

export type Status = {
  readonly version: string
  readonly now: string
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

export type Reading = { readonly status: Status; readonly blocks: Blocks } | { readonly problem: Problem }

export const PROBLEMS: Readonly<Record<Problem, string>> = {
  'proxy-down': 'oneclaude: proxy down',
  'plugin-off': 'oneclaude: plugin off',
  unreadable: 'oneclaude: status unreadable',
}

export async function read(): Promise<{ readonly status: Status } | { readonly problem: Problem }> {
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

type Cooldown = { readonly scope: string; readonly model_key?: string; readonly reason: string; readonly retry_at: string }

// readBlocks reads every block the proxy holds on a Claude account.
export async function readBlocks(key: string): Promise<Blocks> {
  const response = await http.fetch(`${MANAGEMENT}/auth-files`, { headers: { Authorization: `Bearer ${key}` } }).catch(() => undefined)
  if (response === undefined || !response.ok) return {}
  try {
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
  } catch {
    return {}
  }
}

const BLOCKS = 'blocks.json'
const SHARED_MS = 14_000

export async function sharedBlocks(mod: Mod<OneclaudeState>, key: string): Promise<Blocks> {
  const shared = await fs.read(`${mod.dataFolder}/${BLOCKS}`).then((text) => JSON.parse(text) as { readonly at: number; readonly blocks: Blocks }).catch(() => undefined)
  if (shared !== undefined && Date.now() - shared.at < SHARED_MS) return shared.blocks
  return freshBlocks(mod, key)
}

export async function freshBlocks(mod: Mod<OneclaudeState>, key: string): Promise<Blocks> {
  const blocks = await readBlocks(key)
  await fs.write(`${mod.dataFolder}/${BLOCKS}`, JSON.stringify({ at: Date.now(), blocks })).catch((error: unknown) => mod.log(`oneclaude could not share the proxy's blocks with the other sessions: ${String(error)}`))
  return blocks
}

// unblock asks the plugin to clear every block on the account, and says
// whether it did.
export async function unblock(account: Account, key: string): Promise<boolean> {
  const response = await http.fetch(`${MANAGEMENT}/plugins/oneclaude/unblock`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_index: account.auth_index }),
  }).catch(() => undefined)
  return response?.ok === true
}

// A rate limit's block is a throttle, or a spent week, which the account's row
// already shows, and a login's block is a signed-out account.
const RATE_LIMITS = ['quota', 'credential_quota']
const LOGINS = ['unauthorized', 'invalid_grant']

// heldOn is every block the proxy holds on the account.
function heldOn(account: Account, blocks: Blocks): readonly Block[] {
  return account.auth_index === undefined ? [] : blocks[account.auth_index] ?? []
}

export function isSignedOut(account: Account, blocks: Blocks): boolean {
  return account.signed_out || heldOn(account, blocks).some((block) => LOGINS.includes(block.reason))
}

// blocksOf is the account's blocks that no rate limit or login explains.
export function blocksOf(account: Account, blocks: Blocks): readonly Block[] {
  return heldOn(account, blocks).filter((block) => !RATE_LIMITS.includes(block.reason) && !LOGINS.includes(block.reason))
}

// A Trouble is one thing in the pool that needs the person, with the key of
// the Accounts page row it opens at.
export type Trouble = { readonly text: string; readonly key: string }

export const ACCOUNTS = 'accounts'

export const rowKey = (account: Account): string => `account-${account.name}`

export function troublesOf(status: Status, blocks: Blocks): readonly Trouble[] {
  const signedOut = status.accounts.filter((account) => isSignedOut(account, blocks))
  const blocked = status.accounts.filter((account) => !isSignedOut(account, blocks) && blocksOf(account, blocks).length > 0)
  return [
    ...(signedOut.length > 0 ? [{ text: `${plural(signedOut.length, 'account')} signed out`, key: rowKey(signedOut[0]!) }] : []),
    ...(blocked.length > 0 ? [{ text: `${plural(blocked.length, 'account')} blocked`, key: rowKey(blocked[0]!) }] : []),
    ...(status.pool.limit_reached ? [{ text: 'agent limit reached', key: ACCOUNTS }] : []),
  ]
}

// modelName is a model id as Anthropic names it: claude-opus-5-5 is Opus 5.5.
export function modelName(id: string): string {
  const [family = id, ...version] = id.replace(/^claude-/, '').split('-')
  const numbers = version.filter((part) => /^\d{1,2}$/.test(part))
  return [family.charAt(0).toUpperCase() + family.slice(1), numbers.join('.')].filter(Boolean).join(' ')
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

