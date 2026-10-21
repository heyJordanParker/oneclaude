import { expect, test } from 'bun:test'
import { hashSync } from '../node_modules/bcrypt-ts/dist/browser.js'
import type { HttpResponse, RenderPropsOf } from 'claude-code'
import { PromptHint } from '../node_modules/@cmodjs/core/mod.js'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { calendarOf } from '../src/components/weekly-resets.js'
import { oneclaude, REFRESH_MS } from '../src/mod.js'
import { bar, CAP_LEFT, CAP_RIGHT, clockOf, evenOf, fits, glide, modelName, momentOf, paceState, PROXY, secretKeyOf, troublesOf, until, type Cell, type Status } from '../src/status.js'
import { dailyChart, GUTTER, money, tokenCount, usageLayout, type TableLine, type Tokens, type UsageRow, type UsageTable } from '../src/usage.js'

const hint: RenderPropsOf['PromptHint'] = { isDraft: false, isWorking: false, hint: '? for shortcuts' }

const now = '2026-10-15T16:00:00Z'

const status: Status = {
  version: '0.1.0',
  now,
  pool: { used: 0.58, even: 0.67, pace: -0.09, next_refill: '2026-10-17T16:00:00Z', refill_gain: 0.11, agents: 14, accounts: 3, known: 2, limit_reached: false },
  accounts: [
    { name: 'turing', auth_index: 't1', plan: 'default_claude_max_20x', known: true, used: 0.4, resets_at: '2026-10-21T16:00:00Z', projected: false, empty: false, signed_out: false, agents: { opus: 9, haiku: 2 }, limits: { opus: 19, sonnet: 19, haiku: 19, fable: 6 } },
    { name: 'lamport', auth_index: 'l1', known: true, used: 1, resets_at: '2026-10-15T19:00:00Z', projected: false, empty: true, signed_out: false, agents: {}, limits: { opus: 19, sonnet: 19, haiku: 19, fable: 6 } },
    { name: 'jarvis', auth_index: 'j1', known: false, used: 0, projected: false, empty: false, signed_out: false, agents: {}, limits: { opus: 19, sonnet: 19, haiku: 19, fable: 6 } },
  ],
  codex: [
    { name: 'ada', known: true, used: 0.3, resets_at: '2026-10-16T21:30:00Z', projected: false, empty: false },
  ],
  log: [
    { at: '2026-10-15T13:00:00Z', level: 'WARN', text: 'Anthropic rate limited turing (429).' },
    { at: '2026-10-15T15:30:00Z', level: 'INFO', text: "oneclaude cleared the proxy's blocks on lamport, set after a 404 for Opus 5.5." },
  ],
}

// proxyFiles is a proxy config whose management key is key, where oneclaude
// install names it.
function proxyFiles(key: string): Record<string, string> {
  return {
    '/test/home/.local/share/cmod/data/oneclaude/proxy-config': '/test/proxy.yaml\n',
    '/test/proxy.yaml': `server:\n  port: 8317\nmanagement:\n  secret-key: "${hashSync(key, 4)}" # hashed by the proxy\n`,
  }
}

// answering serves every request the mod makes: the status, and the proxy's
// credentials with cooldowns when given.
function answering(response: Partial<HttpResponse> | Error, cooldowns: Readonly<Record<string, readonly object[]>> = {}) {
  const tested = testMod(oneclaude, { files: proxyFiles('oneclaude') })
  tested.fakes.http.fetch = async (url) => {
    if (response instanceof Error) throw response
    if (url.endsWith('/auth-files')) {
      const files = Object.entries(cooldowns).map(([auth_index, list]) => ({ auth_index, provider: 'claude', cooldowns: list }))
      return { status: 200, ok: true, headers: {}, text: JSON.stringify({ files }) }
    }
    return { status: 200, ok: true, headers: {}, text: '', ...response }
  }
  return tested
}

async function hintLines(tested: ReturnType<typeof testMod>): Promise<string> {
  await tested.settle()
  return (await tested.lines(PromptHint, hint)).join('\n')
}

const BAR = /[█▏▎▍▌▋▊▉]/

test('the hint line shows the pool after the engine line', async () => {
  const line = await hintLines(answering({ text: JSON.stringify(status) }))
  expect(line.indexOf('PromptHint')).toBeLessThan(line.search(BAR))
  expect(line).toContain('58% · 9% under')
  expect(line).not.toContain('warning')
  expect(line).toMatch(/\S \[\+\]/)
})

test('the hint line names only what needs the person: a signed-out account, a blocked one, the agent limit', async () => {
  const troubled = {
    ...status,
    pool: { ...status.pool, limit_reached: true },
    accounts: status.accounts.map((account) => (account.name === 'jarvis' ? { ...account, signed_out: true } : account)),
  }
  const blocks = {
    t1: [{ scope: 'model', model_key: 'claude-opus-5-5', reason: 'not_found', retry_at: '2026-10-15T20:50:00Z' }],
    l1: [{ scope: 'model', model_key: 'claude-opus-5-5', reason: 'quota', retry_at: '2026-10-15T19:00:00Z' }],
  }
  const line = await hintLines(answering({ text: JSON.stringify(troubled) }, blocks))
  expect(line).toContain('· 1 account signed out')
  expect(line).toContain('· 1 account blocked')
  expect(line).toContain('· agent limit reached')
  expect(line).not.toContain('2 accounts blocked')
})

test('the toggle after the line shows [-] while the accounts pane is open', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await tested.type('/accounts')
  expect(await hintLines(tested)).toContain('[-]')
  await tested.type('/accounts')
  expect(await hintLines(tested)).toContain('[+]')
})

test('the hint line says when the proxy does not answer', async () => {
  expect(await hintLines(answering(new Error('connection refused')))).toContain('oneclaude: proxy down')
})

test('the hint line says when the proxy runs without the plugin', async () => {
  expect(await hintLines(answering({ status: 404, ok: false, text: '{"error":"unknown path"}' }))).toContain('oneclaude: plugin off')
})

test('the hint line says when the status cannot be read', async () => {
  expect(await hintLines(answering({ text: '<html>' }))).toContain('oneclaude: status unreadable')
})

test('the hint line refreshes on its timer', async () => {
  const tested = testMod(oneclaude)
  let tick: (() => unknown) | undefined
  tested.fakes.clock.every = (ms, fn) => {
    if (ms === REFRESH_MS) tick = fn
    return { cancel() {} }
  }
  let answer: Error | HttpResponse = new Error('connection refused')
  tested.fakes.http.fetch = async () => {
    if (answer instanceof Error) throw answer
    return answer
  }
  expect(await hintLines(tested)).toContain('oneclaude: proxy down')
  answer = { status: 200, ok: true, headers: {}, text: JSON.stringify(status) }
  await tick?.()
  expect(await hintLines(tested)).toContain('58% · 9% under')
})

test('/accounts shows the combined usage, every account with its pace, and the log newest first', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await tested.type('/accounts')
  const pane = (await tested.lines('accounts')).join('\n')
  expect(pane).toContain('9% under pace · next refill in 2d frees 11% · 14 agents')
  expect(pane).toContain('26% over pace · refills in 6d · 9 opus, 2 haiku')
  expect(pane).not.toContain('/19')
  expect(pane.trimStart().startsWith('✻ oneclaude\n\n')).toBe(true)
  expect(pane).toContain('Combined usage')
  expect(pane).toContain('[Open dashboard]')
  expect(pane).toContain('[Add account]')
  expect(pane).toContain('refills in 3h · idle')
  expect(pane).toContain('not read yet')
  expect(pane).toContain(`${clockOf('2026-10-15T15:30:00Z')}  INFO  oneclaude cleared the proxy's blocks on lamport`)
  expect(pane).toContain(`${clockOf('2026-10-15T13:00:00Z')}  WARN  Anthropic rate limited turing (429).`)
  expect(pane.indexOf("oneclaude cleared the proxy's blocks")).toBeLessThan(pane.indexOf('Anthropic rate limited'))
})

test('/accounts puts each account\'s trouble on its row, with what fixes it', async () => {
  const troubled = {
    ...status,
    accounts: status.accounts.map((account) => (
      account.name === 'jarvis' ? { ...account, signed_out: true } : account.name === 'lamport' ? { ...account, throttled_at: '2026-10-15T15:48:00Z' } : account
    )),
  }
  const blocks = { t1: [{ scope: 'model', model_key: 'claude-opus-5-5', reason: 'not_found', retry_at: '2026-10-15T20:50:00Z' }] }
  const tested = answering({ text: JSON.stringify(troubled) }, blocks)
  await tested.type('/accounts')
  const pane = (await tested.lines('accounts')).join('\n')
  expect(pane).toMatch(/jarvis +signed out {2}\[Sign in\]/)
  expect(pane).toContain(`blocked for Opus 5.5 until ${momentOf('2026-10-15T20:50:00Z', now)}  [Unblock]`)
  expect(pane).toContain('throttled 12m ago')
})

test('[Unblock] asks the plugin to clear the account\'s blocks, with oneclaude\'s key, and the row clears', async () => {
  const tested = testMod(oneclaude, { files: proxyFiles('oneclaude') })
  const asked: { url: string; method?: string; key?: string; body?: string }[] = []
  tested.fakes.http.fetch = async (url, init) => {
    if (url.endsWith('/unblock')) {
      asked.push({ url, method: init?.method, key: init?.headers?.['Authorization'], body: init?.body })
      return { status: 200, ok: true, headers: {}, text: '{"status":"ok"}' }
    }
    if (url.endsWith('/auth-files')) {
      const files = [{ auth_index: 't1', provider: 'claude', cooldowns: [{ scope: 'model', model_key: 'claude-opus-5-5', reason: 'not_found', retry_at: '2026-10-15T20:50:00Z' }] }]
      return { status: 200, ok: true, headers: {}, text: JSON.stringify({ files }) }
    }
    return { status: 200, ok: true, headers: {}, text: JSON.stringify(status) }
  }
  await tested.type('/accounts')
  await tested.press('accounts', 'unblock-turing')
  expect(asked).toEqual([{ url: `${PROXY}/v0/management/plugins/oneclaude/unblock`, method: 'POST', key: 'Bearer oneclaude', body: '{"auth_index":"t1"}' }])
  expect((await tested.lines('accounts')).join('\n')).not.toContain('[Unblock]')
})

// sentKeys starts the mod against a proxy whose management key is proxyKey,
// holding the key the person entered, and answers the keys the mod sent.
async function sentKeys(proxyKey: string, entered: string | null): Promise<readonly (string | undefined)[]> {
  const tested = testMod(oneclaude, { files: proxyFiles(proxyKey), state: { global: { managementKey: entered } } })
  const sent: (string | undefined)[] = []
  tested.fakes.http.fetch = async (url, init) => {
    if (url.endsWith('/auth-files')) {
      sent.push(init?.headers?.['Authorization'])
      return { status: 200, ok: true, headers: {}, text: '{"files":[]}' }
    }
    return { status: 200, ok: true, headers: {}, text: JSON.stringify(status) }
  }
  await hintLines(tested)
  return sent
}

test('the mod sends only a management key that fits the proxy\'s config, so the proxy never refuses it', async () => {
  expect(await sentKeys('oneclaude', null)).toEqual(['Bearer oneclaude'])
  expect(await sentKeys('their own key', null)).toEqual([])
  expect(await sentKeys('their own key', 'their own key')).toEqual(['Bearer their own key'])
  expect(await sentKeys('a changed key', 'their own key')).toEqual([])
})

test('the management key is read from the proxy config\'s management block, hashed or not', async () => {
  expect(secretKeyOf('server:\n  port: 8317\nmanagement:\n  secret-key: "$2a$10$abc" # hashed\n')).toBe('$2a$10$abc')
  expect(secretKeyOf("remote-management:\n  allow-remote: false\n  secret-key: 'plain'\n")).toBe('plain')
  expect(secretKeyOf('management:\n  secret-key: ""\nother:\n  secret-key: x\n')).toBeUndefined()
  expect(await fits('their own key', hashSync('their own key', 4))).toBe(true)
  expect(await fits('oneclaude', hashSync('their own key', 4))).toBe(false)
  expect(await fits('plain', 'plain')).toBe(true)
})

test('each trouble under the prompt opens /accounts at the row of the account it names, or at the accounts', () => {
  const troubled = {
    ...status,
    pool: { ...status.pool, limit_reached: true },
    accounts: status.accounts.map((account) => (account.name === 'jarvis' ? { ...account, signed_out: true } : account)),
  }
  const blocks = { t1: [{ model: 'claude-opus-5-5', until: '2026-10-15T20:50:00Z', reason: 'not_found' }] }
  expect(troublesOf(troubled, blocks)).toEqual([
    { text: '1 account signed out', key: 'account-jarvis' },
    { text: '1 account blocked', key: 'account-turing' },
    { text: 'agent limit reached', key: 'accounts' },
  ])
})

test('/accounts shows the newest 10 log lines and counts the rest', async () => {
  const log = Array.from({ length: 12 }, (_, i) => ({ at: new Date(Date.parse(now) - (12 - i) * 60_000).toISOString(), level: 'WARN' as const, text: `Anthropic rate limited turing (429). ${i}` }))
  const tested = answering({ text: JSON.stringify({ ...status, log }) })
  await tested.type('/accounts')
  const pane = (await tested.lines('accounts')).join('\n')
  expect(pane).toContain('(429). 11')
  expect(pane).toContain('(429). 2')
  expect(pane).not.toContain('(429). 1\n')
  expect(pane).toContain('2 earlier lines on the dashboard')
})

test('/accounts leaves the log out when nothing happened', async () => {
  const tested = answering({ text: JSON.stringify({ ...status, log: [] }) })
  await tested.type('/accounts')
  expect((await tested.lines('accounts')).join('\n')).not.toContain('Log')
})

test('/accounts shows each Codex account apart from the Claude pool', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await tested.type('/accounts')
  const pane = (await tested.lines('accounts')).join('\n')
  expect(pane.indexOf('Claude accounts')).toBeLessThan(pane.indexOf('Codex accounts'))
  expect(pane).toContain('52% under pace · refills in 1d 5h')
})

test('every section title has an empty line under it, and every bar an empty line between it and the next', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await tested.type('/accounts')
  const pane = (await tested.lines('accounts')).map((row) => row.trim()).join('\n')
  expect(pane).toContain('Claude accounts\n\nturing ')
  expect(pane).toContain('Codex accounts\n\nada ')
  expect(pane).toContain('Log\n\n')
  expect(pane).toContain('Weekly resets\n\n')
  const barRows = pane.split('\n').map((row, index) => (BAR.test(row) ? index : -1)).filter((index) => index >= 0)
  expect(barRows).toHaveLength(6)
  for (let i = 1; i < barRows.length; i++) expect(barRows[i]! - barRows[i - 1]!).toBeGreaterThan(1)
})

test('a pane too narrow for one line puts each row\'s facts under its bar, and every bar starts in its column', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await tested.type('/accounts')
  const rows = await tested.lines('accounts')
  const barStart = (row: string): number => row.search(BAR)
  const borderTheTestKitLeavesOut = 1
  const header = rows.find((row) => row.includes('Combined usage'))!
  expect(header.trimEnd().endsWith('58%')).toBe(true)
  const turing = rows.findIndex((row) => row.includes('turing ') && barStart(row) >= 0)
  expect(rows[turing]!.trimEnd().endsWith('40%')).toBe(true)
  expect(rows[turing + 1]!.indexOf('26% over pace')).toBe(barStart(rows[turing]!))
  for (const name of ['turing ', 'lamport', 'ada ']) {
    const row = rows.find((each) => each.includes(name) && barStart(each) >= 0)!
    expect(barStart(row)).toBe(barStart(header) + borderTheTestKitLeavesOut)
  }
})

test('the hint line points Claude Code at the proxy once the proxy answers, and only that setting', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await hintLines(tested)
  expect(settingsUpdates(tested)).toEqual([{ env: { ANTHROPIC_BASE_URL: PROXY } }])
})

// settingsUpdates is every settings change the mod asked cmod to make.
function settingsUpdates(tested: ReturnType<typeof testMod>): unknown[] {
  return tested.calls.flatMap(({ call, args }) => {
    const [request] = args as [{ method?: string; input?: { values?: unknown } }]
    return call === 'cmod.call' && request.method === 'updateSettings' ? [request.input?.values] : []
  })
}

test('the hint line leaves a base URL the person pointed elsewhere', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  tested.fakes.settings.read = async () => ({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9000' } })
  await hintLines(tested)
  expect(settingsUpdates(tested)).toEqual([])
})

test('the hint line leaves Claude Code alone while the proxy is down', async () => {
  const tested = answering(new Error('connection refused'))
  await hintLines(tested)
  expect(settingsUpdates(tested)).toEqual([])
})

test('/accounts closes the pane it opened', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await tested.type('/accounts')
  expect(await tested.lines('accounts')).not.toHaveLength(0)
  await tested.type('/accounts')
  await expect(tested.lines('accounts')).rejects.toThrow()
})

test('/accounts lays each read Claude account\'s week on the days around now, soonest reset first, after every account', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await tested.type('/accounts')
  const rows = await tested.lines('accounts')
  const pane = rows.join('\n')
  expect(pane.indexOf('Codex accounts')).toBeLessThan(pane.indexOf('Weekly resets'))
  expect(pane.indexOf('Weekly resets')).toBeLessThan(pane.indexOf('Usage'))
  expect(pane).toMatch(/lamport +█+│\S+ {2}in 3h {2}empty/)
  expect(pane).toMatch(/turing +\S+ {2}in 6d {2}60% left/)
  expect(pane.indexOf('in 3h  empty')).toBeLessThan(pane.indexOf('in 6d  60% left'))
  expect(pane).not.toMatch(/jarvis .*│/)
  const lanes = rows.flatMap((row, index) => (/(lamport|turing) .*│/.test(row) ? [index] : []))
  expect(lanes).toHaveLength(2)
  for (const lane of lanes) expect(rows[lane - 1]!.indexOf('│')).toBe(rows[lane]!.indexOf('│'))
})

test('the calendar draws the week as one bar, dark up to now, gray while its quota lasts and faint after, on a line across the lane, in the plugin\'s time', () => {
  const account = { ...status.accounts[0]!, used: 0.94, resets_at: '2026-10-20T19:59:59Z' }
  const wide = calendarOf([account], '2026-10-19T11:46:17.45+03:00', 84)
  expect(wide.days).toBe('Sun 18  Mon 19  Tue 20  Wed 21  Thu 22  Fri 23  Sat 24  Sun 25')
  expect(wide.now).toBe(11)
  expect(wide.lanes[0]).toMatchObject({ reset: 'in 1d 11h', remaining: '6% left', isNearlyEmpty: false })
  expect(wide.lanes[0]!.cells).toEqual([
    { text: '█'.repeat(11), color: 'subtle' },
    { text: '│', color: 'text', background: 'inactive' },
    { text: '███', color: 'inactive' },
    { text: `${'█'.repeat(8)}${CAP_RIGHT}${'╌'.repeat(40)}`, color: 'inactive', isDim: true },
  ])
  const narrow = calendarOf([account], '2026-10-19T11:46:17.45+03:00', 62)
  expect(narrow.days).toBe('Sun  Mon  Tue  Wed  Thu  Fri  Sat  Sun')
  expect(narrow.now).toBe(7)
})

test('a week that opened inside the calendar starts there, and an empty account is faint red from now to its reset', () => {
  const account = { ...status.accounts[1]!, resets_at: '2026-10-25T06:00:00Z' }
  const calendar = calendarOf([account], '2026-10-19T11:46:17.45+03:00', 84)
  expect(calendar.lanes[0]!.cells).toEqual([
    { text: '╌╌╌', color: 'inactive', isDim: true },
    { text: `${CAP_LEFT}${'█'.repeat(7)}`, color: 'subtle' },
    { text: '│', color: 'text', background: 'error' },
    { text: `${'█'.repeat(46)}${CAP_RIGHT}`, color: 'error', isDim: true },
    { text: '╌'.repeat(5), color: 'inactive', isDim: true },
  ])
})

test('an account marks its own even pace', () => {
  expect(evenOf(status.accounts[0]!, now)).toBeCloseTo(1 / 7)
  expect(evenOf(status.accounts[2]!, now)).toBeUndefined()
})

// columns spreads a bar's runs back into one cell per column.
function columns(cells: readonly Cell[]): Cell[] {
  return cells.flatMap((cell) => [...cell.text].map((text) => ({ ...cell, text })))
}

test('the bar is exact to an eighth of a cell, and the color change marks pace', () => {
  const drawn = columns(bar(0.51, 0.29, 20))
  expect(drawn).toHaveLength(22)
  expect(drawn[0]).toEqual({ text: CAP_LEFT, color: 'inactive' })
  const cells = drawn.slice(1, 21)
  expect(cells.slice(0, 5).every((cell) => cell.text === '█' && cell.color === 'inactive')).toBe(true)
  expect(cells[5]).toEqual({ text: '▊', color: 'inactive', background: 'warning' })
  expect(cells.slice(6, 10).every((cell) => cell.text === '█' && cell.color === 'warning')).toBe(true)
  expect(cells[10]).toEqual({ text: '▎', color: 'warning', background: 'subtle' })
  expect(cells.slice(11).every((cell) => cell.text === '█' && cell.color === 'subtle')).toBe(true)
  expect(drawn[21]).toEqual({ text: CAP_RIGHT, color: 'subtle' })
})

test('under pace the headroom shows in a lifted track, and a nearly empty bar turns red', () => {
  const under = columns(bar(0.25, 0.5, 4))
  expect(under.map((cell) => cell.color)).toEqual(['inactive', 'inactive', 'promptBorder', 'subtle', 'subtle', 'subtle'])
  const spent = columns(bar(1, 1, 4))
  expect(spent.every((cell) => cell.color === 'error' && cell.background === undefined)).toBe(true)
  const nearly = columns(bar(0.96, 0.5, 4)).slice(1, 5)
  expect(nearly.map((cell) => cell.color)).toEqual(['error', 'error', 'diffRemoved', 'diffRemoved'])
  expect(nearly[3]).toEqual({ text: '▉', color: 'diffRemoved', background: 'subtle' })
})

test('a bar glides toward its reading and lands on it', () => {
  let shown = { used: 0, pace: 0 }
  const target = { used: 0.5, pace: 0.3 }
  shown = glide(shown, target)
  expect(shown.used).toBeCloseTo(0.09)
  for (let frame = 0; frame < 60; frame++) shown = glide(shown, target)
  expect(shown).toEqual(target)
})

test('a refill reads in days, then days and hours under 2 days, then hours and minutes under a day', () => {
  const at = (minutes: number): string => new Date(Date.parse(now) + minutes * 60_000).toISOString()
  expect(until(at(4 * 24 * 60 + 300), now)).toBe('4d')
  expect(until(at(30 * 60), now)).toBe('1d 6h')
  expect(until(at(24 * 60), now)).toBe('1d')
  expect(until(at(5 * 60 + 20), now)).toBe('5h 20m')
  expect(until(at(180), now)).toBe('3h')
  expect(until(at(20), now)).toBe('20m')
  expect(until(at(-1), now)).toBe('now')
})

test('a block names its model as Anthropic does, and its day only when it ends on another day', () => {
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('claude-haiku-5-20261001')).toBe('Haiku 5')
  const noon = new Date(2026, 9, 15, 12, 0).toISOString()
  expect(momentOf(new Date(2026, 9, 15, 14, 5).toISOString(), noon)).toBe('14:05')
  expect(momentOf(new Date(2026, 9, 22, 9, 30).toISOString(), noon)).toBe('Oct 22 09:30')
})

const OPUS = { input: 4, output: 20, cache_write: 8, cache_read: 0.2 }

// row is a Usage row the plugin would send for these tokens of Opus 5.5.
function row(key: string, label: string, tokens: Tokens): UsageRow {
  return {
    key,
    label,
    tokens,
    cost: { input: tokens.input * OPUS.input / 1e6, output: tokens.output * OPUS.output / 1e6, cache_write: tokens.cache_write * OPUS.cache_write / 1e6, cache_read: tokens.cache_read * OPUS.cache_read / 1e6 },
  }
}

const NONE = { input: 0, output: 0, cache_write: 0, cache_read: 0 }
const chartDays = Array.from({ length: 30 }, (_, index) => {
  const day = new Date(Date.UTC(2026, 8, 16 + index)).toISOString().slice(0, 10)
  const spent: Record<string, Tokens> = { '2026-10-03': { ...NONE, output: 1_000_000 }, '2026-10-14': { input: 1_000_000, output: 100_000, cache_write: 1_000_000, cache_read: 20_000_000 }, '2026-10-15': { input: 2, output: 254, cache_write: 87_088, cache_read: 1_000_000 } }
  return { day, rows: spent[day] === undefined ? [] : [row('turing', 'turing', spent[day]!)] }
})

function table(rows: readonly UsageRow[], total: string): UsageTable {
  const sum = (kind: keyof Tokens, of: 'tokens' | 'cost'): number => rows.reduce((all, each) => all + each[of][kind], 0)
  const kinds = (of: 'tokens' | 'cost'): Tokens => ({ input: sum('input', of), output: sum('output', of), cache_write: sum('cache_write', of), cache_read: sum('cache_read', of) })
  return { today: '2026-10-15', rows, total: { key: '', label: total, tokens: kinds('tokens'), cost: kinds('cost') }, days: chartDays }
}

const tables: Record<string, UsageTable> = {
  'month account': table([row('turing', 'turing', { input: 2, output: 254, cache_write: 87_088, cache_read: 0 }), row('lamport', 'lamport', { ...NONE, cache_read: 500_000 }), row('jarvis', 'jarvis', NONE)], 'All accounts'),
  'today time': table([row('2026-10-15 17', '17:00', { ...NONE, output: 10_000 }), row('2026-10-15 09', '09:00', { ...NONE, output: 30_000 })], 'All hours'),
  'month time': table([row('2026-10-15', 'Oct 15', { input: 2, output: 254, cache_write: 87_088, cache_read: 1_000_000 }), row('2026-10-14', 'Oct 14', { input: 1_000_000, output: 100_000, cache_write: 1_000_000, cache_read: 20_000_000 }), row('2026-10-03', 'Oct 3', { ...NONE, output: 1_000_000 })], 'All days'),
  'month agent': table([row('explorer', 'explorer', { ...NONE, output: 1_000_000 }), row('', 'Not recorded', { ...NONE, cache_write: 1_000_000, input: 100_000 }), row('main', 'Main sessions', { input: 2, output: 254, cache_write: 87_088, cache_read: 1_000_000 })], 'All agents'),
  'month project': table([row('dotfiles', 'dotfiles', { ...NONE, output: 40_000 })], 'All projects'),
  'month model': table([row('claude-opus-5-5', 'Opus 5.5', { ...NONE, output: 1_950_000 })], 'All models'),
}

// withUsage answers the status, and each Usage table the plugin would serve,
// and keeps every Usage address the mod asked for.
function withUsage(permissions?: readonly string[]) {
  const tested = testMod(oneclaude, permissions === undefined ? undefined : { permissions })
  const asked: string[] = []
  tested.fakes.http.fetch = async (url) => {
    if (!url.includes('usage.json')) return { status: 200, ok: true, headers: {}, text: JSON.stringify(status) }
    asked.push(url)
    const query = new URL(url).searchParams
    const answer = tables[`${query.get('period')} ${query.get('by')}`]
    return answer === undefined ? { status: 404, ok: false, headers: {}, text: '' } : { status: 200, ok: true, headers: {}, text: JSON.stringify(answer) }
  }
  return { tested, asked }
}

async function usagePane(tested: ReturnType<typeof testMod>): Promise<string> {
  if (!tested.shown.openPanes.has('accounts')) await tested.type('/accounts')
  return (await tested.lines('accounts')).map((line) => line.trimEnd()).join('\n')
}

test('/accounts shows the last 30 days of usage by account, with the total last in each row', async () => {
  const { tested, asked } = withUsage()
  const pane = await usagePane(tested)
  expect(asked[0]).toContain('usage.json?period=month&by=account&units=cost')
  expect(pane).toMatch(/Period +90 days +\[30 days\] +7 days +Yesterday +Today\n/)
  expect(pane).toContain('[Account]')
  expect(pane).toContain('[Cost]')
  expect(pane).toMatch(/Input +Output +Cache write +Cache read +Cached +Share +Total\n/)
  expect(pane).toMatch(/turing +\$0 +\$0\.01 +\$0\.70 +\$0 +0% +88% +\$0\.70\n/)
  expect(pane).toMatch(/lamport +\$0 +\$0 +\$0 +\$0\.10 +100% +12% +\$0\.10\n/)
  expect(pane).toMatch(/jarvis( +\$0){4} +0% +\$0\n/)
  expect(pane).toMatch(/All accounts +\$0 +\$0\.01 +\$0\.70 +\$0\.10 +85% +\$0\.80\n/)
  expect(pane.indexOf('Claude accounts')).toBeLessThan(pane.indexOf('Usage'))
  expect(pane.indexOf('Usage per day, last 30 days')).toBeLessThan(pane.indexOf('Log\n'))
})

test('the Usage controls read the table for the chosen period, breakdown and units', async () => {
  const { tested, asked } = withUsage()
  await usagePane(tested)
  await tested.press('accounts', 'by-time')
  const pane = await usagePane(tested)
  expect(asked.at(-1)).toContain('period=month&by=time&units=cost')
  expect(pane).toContain('[Time]')
  expect(pane).toMatch(/Oct 15( +\S+){5} +2% +\$0\.90\n +Oct 14( +\S+){5} +46% +\$18\n +Oct 3( +\S+){4} +51% +\$20\n/)
  await tested.press('accounts', 'show-tokens')
  await tested.settle()
  expect(asked.at(-1)).toContain('period=month&by=time&units=tokens')
})

test('the By row stays the same for every period, and Time over a day goes by the hour', async () => {
  const { tested, asked } = withUsage()
  await usagePane(tested)
  await tested.press('accounts', 'by-time')
  const before = await usagePane(tested)
  await tested.press('accounts', 'period-today')
  const pane = await usagePane(tested)
  expect(asked.at(-1)).toContain('period=today&by=time&units=cost')
  for (const shown of [before, pane]) expect(shown).toMatch(/By +Account +Model +Agent +Project +\[Time\]\n/)
  expect(pane).toMatch(/17:00( +\S+){6}\n +09:00( +\S+){6}\n +All hours/)
})

test('Usage says what Not recorded means when a row has no agent type or project', async () => {
  const { tested } = withUsage()
  await usagePane(tested)
  await tested.press('accounts', 'period-month')
  await tested.press('accounts', 'by-agent')
  const pane = await usagePane(tested)
  expect(pane).toMatch(/Not recorded( +\S+){6}/)
  expect(pane).toContain('Not recorded: requests from before oneclaude recorded agent types and projects.')
})

test('a wide Usage table puts Cached, Share and Total after the token kinds, each column aligned', () => {
  const layout = usageLayout(tables['month time']!, 'cost', true)
  const text = (line: TableLine): string => line.cells.join(GUTTER)
  expect(text(layout.header)).toMatch(/^ +Input +Output +Cache write +Cache read +Cached +Share +Total$/)
  expect(text(layout.rows[1]!)).toMatch(/^Oct 14 +\$4 +\$2 +\$8 +\$4 +91% +46% +\$18$/)
  for (const line of [...layout.rows, layout.total]) expect(text(line).length).toBe(layout.width)
  expect(layout.rows[2]!.cold).toBe(false)
  expect(usageLayout(tables['month agent']!, 'cost', true).rows[1]!.cold).toBe(true)
})

test('a narrow Usage table keeps the cache, the share and the total, and leaves out the token kinds', () => {
  const layout = usageLayout(tables['month account']!, 'cost', false)
  expect(layout.header.cells.join(GUTTER)).toMatch(/^ +Cached +Share +Total$/)
  expect(layout.rows[0]!.cells.join(GUTTER)).toMatch(/^turing +0% +88% +\$0\.70$/)
})

test('the daily chart stands each day on the baseline, exact to an eighth, with a dot for a day with no request', () => {
  const chart = dailyChart(tables['month account']!, 'cost')
  expect(chart.peak).toBe('$20')
  expect(chart.rows).toHaveLength(4)
  const bottom = chart.rows[3]!
  expect(bottom).toHaveLength(30)
  expect(bottom.filter((cell) => cell === '·')).toHaveLength(27)
  expect([bottom[17], chart.rows[0]![17], chart.rows[0]![28], bottom[29]]).toEqual(['█', '█', '▅', '▁'])
  expect([chart.first, chart.last]).toEqual(['Sep 16', 'Oct 15'])
})

test('[Optimize usage] asks before it sends this session the last 30 days by agent type, project and model', async () => {
  const { tested } = withUsage()
  await usagePane(tested)
  await tested.press('accounts', 'optimize')
  const asking = await usagePane(tested)
  expect(asking).toContain('Ask your agent to optimize your usage?')
  expect(asking).toContain("We'll send it your last 30 days of usage, by agent, project and model.")
  expect(asking).toContain('[Ask your agent]')
  expect(tested.shown.prompts).toHaveLength(0)
  await tested.press('accounts', 'optimize-cancel')
  expect(await usagePane(tested)).toContain('[Optimize usage]')
  await tested.press('accounts', 'optimize')
  await tested.press('accounts', 'optimize-send')
  const [prompt] = tested.shown.prompts
  expect(prompt).toContain('Optimize my Claude usage')
  expect(prompt).toContain('- explorer: $20 (cache writes $0, cache reads $0, output $20, input $0), 1M tokens')
  expect(prompt).toContain('- Not recorded: $8')
  expect(prompt).toContain('- dotfiles: $0.80')
  expect(prompt).toContain('- Opus 5.5: $39')
  expect(prompt).toContain('Change nothing until I approve.')
  expect(await usagePane(tested)).toContain('[Optimize usage]')
})

test('[Optimize usage] stays hidden while the person has the prompt permission off', async () => {
  const { tested } = withUsage(['network:127.0.0.1', 'config:env.ANTHROPIC_BASE_URL'])
  const pane = await usagePane(tested)
  expect(pane).toContain('All accounts')
  expect(pane).not.toContain('Optimize usage')
})

test('a count reads in 3 figures, and dollars in whole dollars from $1', () => {
  expect([1_400_000, 32_700_000, 832_000_000, 1_050_000_000, 999, 0].map(tokenCount)).toEqual(['1.4M', '32.7M', '832M', '1.05B', '999', '0'])
  expect([0, 0.104, 5.4, 1193.2].map(money)).toEqual(['$0', '$0.10', '$5', '$1,193'])
})

test('pace is on within 5 points, and far over past 25', () => {
  expect(paceState(0.5, 0.46)).toBe('on')
  expect(paceState(0.4, 0.5)).toBe('under')
  expect(paceState(0.6, 0.5)).toBe('over')
  expect(paceState(0.8, 0.5)).toBe('far-over')
})
