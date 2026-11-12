import { expect, test } from 'bun:test'
import { BelowPrompt, type HttpOptions, type HttpResponse } from '../node_modules/@cmodjs/core/mod.js'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { calendarOf } from '../src/components/weekly-resets.js'
import { oneclaude, RETRY_MS } from '../src/mod.js'
import { bar, CAP_LEFT, CAP_RIGHT, clockOf, evenOf, glide, LOCAL_POOL, momentOf, paceState, troublesOf, until, type Cell, type Status } from '../src/status.js'
import { dailyChart, GUTTER, money, tokenCount, usageLayout, type TableLine, type Tokens, type UsageRow, type UsageTable } from '../src/usage.js'

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

const KEY_FILE = '/test/home/.local/share/cmod/data/oneclaude/management-key'

// stored is the management key oneclaude install or the key step stored.
function stored(key: string): Record<string, string> {
  return { [KEY_FILE]: key }
}

// answering serves every request the mod makes: the status, and the proxy's
// credentials with cooldowns when given.
function answering(response: Partial<HttpResponse> | Error, cooldowns: Readonly<Record<string, readonly object[]>> = {}) {
  const tested = testMod(oneclaude, { files: stored('oneclaude') })
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

// textOf is a body the mod sent, which is always text.
function textOf(body: NonNullable<HttpOptions['body']>): string {
  if (typeof body !== 'string') throw new Error('the mod sent a body that is not text')
  return body
}

async function hintLines(tested: ReturnType<typeof testMod>): Promise<string> {
  await tested.settle()
  return (await tested.lines(BelowPrompt)).join('\n')
}

const BAR = /[█▏▎▍▌▋▊▉]/

test('the hint line shows the pool\'s bar, usage and pace', async () => {
  const line = await hintLines(answering({ text: JSON.stringify(status) }))
  expect(line.search(BAR)).toBe(0)
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

test('the toggle after the line shows [-] while the Accounts page is open', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await tested.type('/accounts')
  expect(await hintLines(tested)).toContain('[-]')
  await tested.type('/accounts')
  expect(await hintLines(tested)).toContain('[+]')
})

test('the hint line says when the proxy does not answer', async () => {
  expect(await hintLines(answering(new Error('connection refused')))).toContain('oneclaude: pool unreachable')
})

test('the hint line says when the proxy runs without the plugin', async () => {
  expect(await hintLines(answering({ status: 404, ok: false, text: '{"error":"unknown path"}' }))).toContain('oneclaude: plugin off')
})

test('the hint line says when the status cannot be read', async () => {
  expect(await hintLines(answering({ text: '<html>' }))).toContain('oneclaude: status unreadable')
})

const STATUS_FILE = '/test/home/.local/share/cmod/data/oneclaude/status.json'

const since = `pool unreachable since ${momentOf(now, new Date().toISOString())}`

const answered = (text: object): HttpResponse => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(text) })

// pooled starts the mod against a pool whose status.json answer the test
// changes, as the plugin answers it: an ask after the change the pool's
// status holds waits until change answers it, and any other ask gets the
// answer at once. Every other address answers other. asked keeps the change
// each status.json ask named after, or null, and devices the machine it
// named, and timers the length of each wait the mod started on its clock.
// lapse ends every wait of ms.
function pooled(answer: Status | Error | Promise<HttpResponse>, options: { readonly files?: Record<string, string>; readonly other?: (url: string, init?: HttpOptions) => HttpResponse | Promise<HttpResponse> } = {}) {
  const tested = testMod(oneclaude, { files: options.files ?? {} })
  const waits: { readonly ms: number; readonly fn: () => unknown }[] = []
  const held: ((response: HttpResponse) => void)[] = []
  const pool = {
    answer,
    asked: [] as (string | null)[],
    devices: [] as (string | null)[],
    timers: [] as number[],
    lapse(ms: number): void {
      for (const wait of waits.filter((each) => each.ms === ms)) {
        waits.splice(waits.indexOf(wait), 1)
        void wait.fn()
      }
    },
    change(next: Status): void {
      pool.answer = next
      for (const answer of held.splice(0)) answer(answered(next))
    },
  }
  tested.fakes.clock.after = (ms, fn) => {
    const wait = { ms, fn }
    waits.push(wait)
    pool.timers.push(ms)
    return {
      cancel() {
        if (waits.includes(wait)) waits.splice(waits.indexOf(wait), 1)
      },
    }
  }
  tested.fakes.http.fetch = async (url, init) => {
    if (!url.includes('/status.json')) return (options.other ?? (() => ({ status: 200, ok: true, headers: {}, text: '{"files":[]}' })))(url, init)
    const query = new URL(url).searchParams
    pool.asked.push(query.get('after'))
    pool.devices.push(query.get('device'))
    const current = pool.answer
    if (current instanceof Error) throw current
    if (current instanceof Promise) return current
    if (current.change !== undefined && query.get('after') === String(current.change)) return new Promise<HttpResponse>((resolve) => held.push(resolve))
    return answered(current)
  }
  return { tested, pool }
}

test('the line keeps the last status and warns while the pool doesn\'t answer', async () => {
  const { tested, pool } = pooled(status)
  expect(await hintLines(tested)).toContain('58% · 9% under')
  pool.answer = new Error('connection refused')
  pool.lapse(RETRY_MS[0]!)
  const line = await hintLines(tested)
  expect(line.search(BAR)).toBe(0)
  expect(line).toContain('58% · 9% under')
  expect(line).toContain(since)
  await tested.type('/accounts')
  const page = (await tested.shown.page.lines()).join('\n')
  expect(page).toContain(since)
  expect(page).toContain('9% under pace · next refill in 2d frees 11%')
})

// following is a status of a plugin that counts its changes: change 1 of
// the status and of the blocks, its answer due within 25 seconds.
const following: Status = { ...status, change: 1, blocks_change: 1, answers_within_ms: 25_000 }

test('the newest answer wins: each change the pool answers replaces the line at once, and the next ask waits for the change after it', async () => {
  const { tested, pool } = pooled(following)
  expect(await hintLines(tested)).toContain('58% · 9% under')
  expect(pool.asked).toEqual([null, '1'])
  pool.change({ ...following, change: 2, pool: { ...status.pool, used: 0.7, pace: 0.03 } })
  expect(await hintLines(tested)).toContain('70% · 3% over')
  pool.change({ ...following, change: 3, pool: { ...status.pool, used: 0.75, pace: 0.08 } })
  expect(await hintLines(tested)).toContain('75% · 8% over')
  expect(pool.asked).toEqual([null, '1', '2', '3'])
  expect(new Set(pool.devices)).toEqual(new Set(['5f0e8c2a9b7d4e31a6c4d2b0e8f71a93']))
})

test('a pool silent past the time its last status named shows unreachable then, and its late answer clears the warning by itself', async () => {
  const { tested, pool } = pooled(following)
  expect(await hintLines(tested)).not.toContain('unreachable')
  pool.lapse(25_000)
  const line = await hintLines(tested)
  expect(line).toContain('58% · 9% under')
  expect(line).toContain(since)
  expect(tested.shown.debug.join('\n')).toContain(`${LOCAL_POOL} sent no status within 25000 ms`)
  pool.change({ ...following, change: 2, pool: { ...status.pool, used: 0.7, pace: 0.03 } })
  const cleared = await hintLines(tested)
  expect(cleared).toContain('70% · 3% over')
  expect(cleared).not.toContain('unreachable')
})

test('a failed ask asks again after 1, 2, 4, 8, then every 16 seconds, at once after the pool answers', async () => {
  const { tested, pool } = pooled(new Error('connection refused'))
  expect(await hintLines(tested)).toContain('oneclaude: pool unreachable')
  for (const ms of [1000, 2000, 4000, 8000, 16_000]) {
    pool.lapse(ms)
    await tested.settle()
  }
  expect(pool.timers.filter((ms) => RETRY_MS.includes(ms))).toEqual([1000, 2000, 4000, 8000, 16_000, 16_000])
  expect(pool.asked).toHaveLength(6)
  pool.answer = following
  pool.lapse(16_000)
  expect(await hintLines(tested)).toContain('58% · 9% under')
  expect(pool.asked.slice(-2)).toEqual([null, '1'])
})

test('a plugin that answers at once, as 0.9.3 does, is asked again a second after each answer', async () => {
  const { tested, pool } = pooled(status)
  await hintLines(tested)
  expect(pool.asked).toEqual([null])
  pool.answer = { ...status, pool: { ...status.pool, used: 0.7, pace: 0.03 } }
  pool.lapse(1000)
  expect(await hintLines(tested)).toContain('70% · 3% over')
  expect(pool.asked).toEqual([null, null])
})

test('a status still on its way holds back nothing: the Accounts page opens with the Usage table, and the record goes', async () => {
  const records: string[] = []
  const { tested, pool } = pooled(following, {
    files: stored('oneclaude'),
    other: (url, init) => {
      if (url.endsWith('/session')) records.push(textOf(init?.body ?? ''))
      if (url.includes('usage.json')) return answered(tables['month account']!)
      return { status: 200, ok: true, headers: {}, text: '{"files":[]}' }
    },
  })
  await hintLines(tested)
  await tested.startSession({ source: 'clear', id: 'cleared-session' })
  await tested.type('/accounts')
  await tested.settle()
  expect((await tested.shown.page.lines({ columns: 110 })).join('\n')).toMatch(/All accounts +\$0 +\$0\.01/)
  expect(records.map((record) => (JSON.parse(record) as SentRecord).session)).toEqual(['test-session', 'cleared-session'])
})

test('a session that starts while the pool doesn\'t answer shows the last status any session read, and warns', async () => {
  const { tested: first } = pooled(status)
  await hintLines(first)
  const shared = first.calls.filter(({ call, args }) => call === 'fs.write' && args[0] === STATUS_FILE).at(-1)?.args[1] as string
  const tested = testMod(oneclaude, { files: { [STATUS_FILE]: shared } })
  tested.fakes.http.fetch = async () => {
    throw new Error('connection refused')
  }
  const line = await hintLines(tested)
  expect(line).toContain('58% · 9% under')
  expect(line).toContain(since)
})

test('after /clear the line shows the last status while the pool holds the ask for its next change', async () => {
  const { tested } = pooled(following)
  await hintLines(tested)
  await tested.startSession({ source: 'clear', id: 'cleared-session' })
  expect(await hintLines(tested)).toContain('58% · 9% under')
})

test('/accounts shows the combined usage, every account with its pace, and the log newest first', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await tested.type('/accounts')
  const pane = (await tested.shown.page.lines()).join('\n')
  expect(pane).toContain('9% under pace · next refill in 2d frees 11% · 14 agents')
  expect(pane).toContain('26% over pace · refills in 6d · 9 opus, 2 haiku')
  expect(pane).not.toContain('/19')
  expect(pane).toMatch(/^\s*╭─+╮\n\s*│ Combined usage /)
  expect(pane).toContain('Combined usage')
  expect(pane).toContain('[Open dashboard]')
  expect(pane).toContain('[Add account]')
  expect(pane).toContain('refills in 3h · idle')
  expect(pane).toContain('not read yet')
  expect(pane).toContain(`${clockOf('2026-10-15T15:30:00Z')}  INFO  oneclaude cleared the proxy's blocks on lamport`)
  expect(pane).toContain(`${clockOf('2026-10-15T13:00:00Z')}  WARN  Anthropic rate limited turing (429).`)
  expect(pane.indexOf("oneclaude cleared the proxy's blocks")).toBeLessThan(pane.indexOf('Anthropic rate limited'))
})

test('/accounts puts each account\'s trouble on its row in a word or two, with the one button that fixes it', async () => {
  const reason = 'OAuth authentication is currently not allowed for this organization.'
  const troubled = {
    ...status,
    accounts: [
      ...status.accounts.map((account) => (
        account.name === 'jarvis' ? { ...account, signed_out: true } : account.name === 'lamport' ? { ...account, throttled_at: '2026-10-15T15:48:00Z' } : account
      )),
      { ...status.accounts[0]!, name: 'hopper', auth_index: 'h1', refused: reason },
    ],
  }
  const blocks = { t1: [{ scope: 'model', model_key: 'claude-opus-5-5', reason: 'not_found', retry_at: '2026-10-15T20:50:00Z' }] }
  const tested = answering({ text: JSON.stringify(troubled) }, blocks)
  await tested.type('/accounts')
  const pane = (await tested.shown.page.lines()).join('\n')
  expect(pane).toMatch(/jarvis +signed out {2}\[Sign in\]\n/)
  expect(pane).toMatch(/hopper +refused {2}\[Retry\]\n/)
  expect(pane).not.toContain(reason)
  expect(pane).toContain(`blocked until ${momentOf('2026-10-15T20:50:00Z', now)}  [Retry]`)
  expect(pane).toContain('throttled 12m ago')
})

// ranOn answers uname with system and records each program the mod runs.
const ranOn = (system: string, ran: (readonly string[])[]) => async (argv: readonly string[]) => (ran.push(argv), { exitCode: 0, stdout: argv[0] === 'uname' ? `${system}\n` : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

test('[Sign in], [Add account] and [Open dashboard] open the proxy\'s pages in the browser', async () => {
  const tested = answering({ text: JSON.stringify({ ...status, accounts: status.accounts.map((account) => (account.name === 'jarvis' ? { ...account, signed_out: true } : account)) }) })
  const ran: (readonly string[])[] = []
  tested.fakes.process.run = ranOn('Darwin', ran)
  await tested.type('/accounts')
  await tested.shown.page.press('sign-in-jarvis')
  await tested.shown.page.press('add-account')
  await tested.shown.page.press('open-dashboard')
  await tested.settle()
  expect(ran.filter((argv) => argv[0] === 'open')).toEqual([
    ['open', `${LOCAL_POOL}/management.html#/oauth`],
    ['open', `${LOCAL_POOL}/management.html#/oauth`],
    ['open', `${LOCAL_POOL}/management.html#/plugin-pages/oneclaude/0`],
  ])
})

test('[Sign in] copies the login page\'s link where the computer has no browser to open', async () => {
  const tested = answering({ text: JSON.stringify({ ...status, accounts: status.accounts.map((account) => (account.name === 'jarvis' ? { ...account, signed_out: true } : account)) }) })
  tested.fakes.process.run = ranOn('Linux', [])
  await tested.type('/accounts')
  await tested.shown.page.press('sign-in-jarvis')
  await tested.settle()
  expect(tested.calls.filter((call) => call.call === 'ui.copy').map((call) => call.args)).toEqual([[{ text: `${LOCAL_POOL}/management.html#/oauth`, surface: 'terminal' }]])
})

test('[Retry] asks the plugin to retry the account, with oneclaude\'s key, and the row clears at the blocks change it counts', async () => {
  const asked: { url: string; method?: string; key?: string; body?: string }[] = []
  const { tested, pool } = pooled({ ...following, reads_blocks: true }, {
    files: stored('oneclaude'),
    other: (url, init) => {
      if (url.endsWith('/retry')) {
        asked.push({ url, method: init?.method, key: init?.headers?.['Authorization'], body: textOf(init?.body ?? '') })
        return { status: 200, ok: true, headers: {}, text: '{"status":"ok"}' }
      }
      const cooldowns = asked.length === 0 ? [{ scope: 'model', model_key: 'claude-opus-5-5', reason: 'not_found', retry_at: '2026-10-15T20:50:00Z' }] : []
      return { status: 200, ok: true, headers: {}, text: JSON.stringify({ files: [{ auth_index: 't1', provider: 'claude', cooldowns }] }) }
    },
  })
  await tested.type('/accounts')
  expect((await tested.shown.page.lines()).join('\n')).toContain('[Retry]')
  await tested.shown.page.press('retry-turing')
  expect(asked).toEqual([{ url: `${LOCAL_POOL}/v0/management/plugins/oneclaude/retry`, method: 'POST', key: 'Bearer oneclaude', body: '{"auth_index":"t1"}' }])
  pool.change({ ...following, change: 2, blocks_change: 2, reads_blocks: true })
  await tested.settle()
  expect((await tested.shown.page.lines()).join('\n')).not.toContain('[Retry]')
})

// sentKeys starts the mod holding the stored key, if any, against a pool
// that answers the management API with answer, and answers the keys the mod
// sent to the management API, then what the key file holds.
async function sentKeys(key: string | undefined, answer = 200): Promise<{ readonly sent: readonly (string | undefined)[]; readonly file: string | undefined }> {
  const tested = testMod(oneclaude, { files: key === undefined ? {} : stored(key) })
  const sent: (string | undefined)[] = []
  tested.fakes.http.fetch = async (url, init) => {
    if (url.includes('/v0/management/')) {
      sent.push(init?.headers?.['Authorization'])
      return { status: answer, ok: answer === 200, headers: {}, text: answer !== 200 ? '{"error":"invalid management key"}' : url.endsWith('/auth-files') ? '{"files":[]}' : '{}' }
    }
    return { status: 200, ok: true, headers: {}, text: JSON.stringify(status) }
  }
  await hintLines(tested)
  const writes = tested.calls.filter(({ call, args }) => call === 'fs.write' && args[0] === KEY_FILE)
  return { sent, file: writes.at(-1)?.args[1] as string | undefined }
}

test('the mod sends only the management key oneclaude stored once the proxy took it', async () => {
  for (const key of ['oneclaude', 'their own key']) {
    const { sent } = await sentKeys(key)
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.filter((each) => each !== `Bearer ${key}`)).toEqual([])
  }
  expect((await sentKeys(undefined)).sent).toEqual([])
})

test('a key the proxy refuses is emptied, so no session sends it again and the key step asks', async () => {
  const refused = await sentKeys('a changed key', 401)
  expect(refused.sent.length).toBeGreaterThan(0)
  expect(refused.sent.filter((each) => each !== 'Bearer a changed key')).toEqual([])
  expect(refused.file).toBe('')
  expect((await sentKeys('', 401)).sent).toEqual([])
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
  const pane = (await tested.shown.page.lines()).join('\n')
  expect(pane).toContain('(429). 11')
  expect(pane).toContain('(429). 2')
  expect(pane).not.toContain('(429). 1\n')
  expect(pane).toContain('2 earlier lines on the dashboard')
})

test('/accounts leaves the log out when nothing happened', async () => {
  const tested = answering({ text: JSON.stringify({ ...status, log: [] }) })
  await tested.type('/accounts')
  expect((await tested.shown.page.lines()).join('\n')).not.toContain('Log')
})

test('/accounts shows each Codex account apart from the Claude pool', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await tested.type('/accounts')
  const pane = (await tested.shown.page.lines()).join('\n')
  expect(pane.indexOf('Claude accounts')).toBeLessThan(pane.indexOf('Codex accounts'))
  expect(pane).toContain('52% under pace · refills in 1d 5h')
})

test('every section title has an empty line under it, and every bar an empty line between it and the next', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await tested.type('/accounts')
  const pane = (await tested.shown.page.lines()).map((row) => row.trim()).join('\n')
  expect(pane).toContain('Claude accounts\n\nturing ')
  expect(pane).toContain('Codex accounts\n\nada ')
  expect(pane).toContain('Log\n\n')
  expect(pane).toContain('Weekly resets\n\n')
  const barRows = pane.split('\n').map((row, index) => (BAR.test(row) ? index : -1)).filter((index) => index >= 0)
  expect(barRows).toHaveLength(6)
  for (let i = 1; i < barRows.length; i++) expect(barRows[i]! - barRows[i - 1]!).toBeGreaterThan(1)
})

test('a Sidebar too narrow for one line puts each row\'s facts under its bar, and every bar starts in its column', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await tested.type('/accounts')
  const rows = await tested.shown.page.lines()
  const barStart = (row: string): number => row.search(BAR)
  const header = rows.find((row) => row.includes('Combined usage'))!
  expect(header.replace(/│\s*$/, '').trimEnd().endsWith('58%')).toBe(true)
  const turing = rows.findIndex((row) => row.includes('turing ') && barStart(row) >= 0)
  expect(rows[turing]!.trimEnd().endsWith('40%')).toBe(true)
  expect(rows[turing + 1]!.indexOf('26% over pace')).toBe(barStart(rows[turing]!))
  for (const name of ['turing ', 'lamport', 'ada ']) {
    const row = rows.find((each) => each.includes(name) && barStart(each) >= 0)!
    expect(barStart(row)).toBe(barStart(header))
  }
})

test('the hint line points Claude Code at the proxy once the proxy answers, and only that setting', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await hintLines(tested)
  expect(settingsUpdates(tested)).toEqual([{ env: { ANTHROPIC_BASE_URL: LOCAL_POOL } }])
})

// settingsUpdates is every settings change the mod asked cmod to make.
function settingsUpdates(tested: ReturnType<typeof testMod>): unknown[] {
  return tested.calls.flatMap(({ call, args }) => {
    const [request] = args as [{ method?: string; input?: { values?: unknown } }]
    return call === 'cmod.call' && request.method === 'updateSettings' ? [request.input?.values] : []
  })
}

test('everything reads the pool Claude Code uses, on another machine too, and leaves its setting', async () => {
  const tested = testMod(oneclaude, { files: stored('oneclaude') })
  tested.fakes.settings.read = async () => ({ env: { ANTHROPIC_BASE_URL: 'http://homeserver:8317/' } })
  const asked: string[] = []
  tested.fakes.http.fetch = async (url) => {
    asked.push(url)
    return { status: 200, ok: true, headers: {}, text: url.endsWith('/auth-files') ? '{"files":[]}' : JSON.stringify(status) }
  }
  expect(await hintLines(tested)).toContain('58% · 9% under')
  await tested.type('/accounts')
  const pane = (await tested.shown.page.lines()).join('\n')
  expect(pane).toContain('[Open dashboard]')
  expect(asked.length).toBeGreaterThan(2)
  expect(asked.filter((url) => !url.startsWith('http://homeserver:8317/'))).toEqual([])
  expect(asked).toContain('http://homeserver:8317/v0/management/auth-files')
  expect(settingsUpdates(tested)).toEqual([])
})

test('the hint line leaves Claude Code\'s settings file unwritten when it already points at the proxy', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  tested.fakes.settings.read = async () => ({ env: { ANTHROPIC_BASE_URL: LOCAL_POOL } })
  await hintLines(tested)
  expect(settingsUpdates(tested)).toEqual([])
})

test('the hint line shows the pool while the proxy\'s blocks are still on their way', async () => {
  const tested = testMod(oneclaude, { files: stored('oneclaude') })
  tested.fakes.http.fetch = async (url) => {
    if (url.endsWith('/auth-files')) return new Promise<HttpResponse>(() => {})
    return { status: 200, ok: true, headers: {}, text: JSON.stringify(status) }
  }
  expect(await hintLines(tested)).toContain('58% · 9% under')
})

const BLOCKS_FILE = '/test/home/.local/share/cmod/data/oneclaude/blocks.json'

// blocksFile is blocks.json as a session wrote it at the pool's blocks
// change, with one block no rate limit explains.
function blocksFile(change: number): string {
  return JSON.stringify({ change, blocks: { t1: [{ model: 'claude-opus-5-5', until: '2026-10-15T20:50:00Z', reason: 'not_found' }] } })
}

// readingBlocks starts the mod with blocks.json of blocks change 1 in its
// data folder, and counts the mod's requests for the proxy's blocks, which
// hold none.
function readingBlocks(first: Status) {
  const reads = { count: 0 }
  const { tested, pool } = pooled(first, {
    files: { ...stored('oneclaude'), [BLOCKS_FILE]: blocksFile(1) },
    other: (url) => {
      if (url.endsWith('/auth-files')) reads.count++
      return { status: 200, ok: true, headers: {}, text: '{"files":[]}' }
    },
  })
  return { tested, pool, reads }
}

test('blocks are read only on a blocks change, by the one session the pool names on each machine, and the others take its reading', async () => {
  const { tested, pool, reads } = readingBlocks(following)
  expect(await hintLines(tested)).toContain('1 account blocked')
  pool.change({ ...following, change: 2, pool: { ...status.pool, used: 0.7, pace: 0.03 } })
  expect(await hintLines(tested)).toContain('1 account blocked')
  pool.change({ ...following, change: 3, blocks_change: 2 })
  expect(await hintLines(tested)).toContain('1 account blocked')
  expect(reads.count).toBe(0)
  pool.change({ ...following, change: 4, blocks_change: 3, reads_blocks: true })
  expect(await hintLines(tested)).not.toContain('blocked')
  expect(reads.count).toBe(1)
  expect(tested.calls.filter(({ call, args }) => call === 'fs.write' && args[0] === BLOCKS_FILE).map(({ args }) => JSON.parse(args[1] as string))).toEqual([{ change: 3, blocks: {} }])
  pool.change({ ...following, change: 5, blocks_change: 3 })
  await tested.settle()
  expect(reads.count).toBe(1)
})

test('a block whose time is up is gone, though no blocks change came since', async () => {
  const { tested } = readingBlocks({ ...following, now: '2026-10-15T21:00:00Z' })
  expect(await hintLines(tested)).not.toContain('blocked')
})

test('a failed read of the proxy\'s blocks keeps the last blocks, in this session and the others, and reads them at the next status', async () => {
  const failures: readonly (HttpResponse | Error)[] = [new Error('connection refused'), { status: 503, ok: false, headers: {}, text: 'busy' }, { status: 200, ok: true, headers: {}, text: '<html>' }]
  for (const failure of failures) {
    let reads = 0
    const { tested, pool } = pooled({ ...following, blocks_change: 2, reads_blocks: true }, {
      files: { ...stored('oneclaude'), [STATUS_FILE]: JSON.stringify(following), [BLOCKS_FILE]: blocksFile(1) },
      other: (url) => {
        if (!url.endsWith('/auth-files')) return { status: 200, ok: true, headers: {}, text: '{"status":"ok"}' }
        reads++
        if (failure instanceof Error) throw failure
        return failure
      },
    })
    expect(await hintLines(tested)).toContain('1 account blocked')
    expect(tested.calls.filter(({ call, args }) => call === 'fs.write' && args[0] === BLOCKS_FILE)).toEqual([])
    expect(tested.shown.debug.join('\n')).toContain('oneclaude could not read the proxy\'s blocks')
    pool.change({ ...following, change: 2, blocks_change: 2 })
    await tested.settle()
    expect(reads).toBe(2)
  }
})

test('the hint line leaves Claude Code alone while the proxy is down', async () => {
  const tested = answering(new Error('connection refused'))
  await hintLines(tested)
  expect(settingsUpdates(tested)).toEqual([])
})

test('a row\'s details wrap between facts, never inside one', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await tested.type('/accounts')
  const pane = (await tested.shown.page.lines({ columns: 60 })).join('\n')
  expect(pane).toContain('14 agents')
  expect(pane).toContain('1 account not read yet')
  expect(pane).toContain('next refill in 2d frees 11%')
})

test('/accounts closes the Sidebar page it opened', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await tested.type('/accounts')
  expect(await tested.shown.page.lines()).not.toHaveLength(0)
  await tested.type('/accounts')
  await expect(tested.shown.page.lines()).rejects.toThrow()
})

test('/accounts lays each read Claude account\'s week on the days around now, soonest reset first, after every account', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await tested.type('/accounts')
  const rows = await tested.shown.page.lines()
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

test('a block names its day only when it ends on another day', () => {
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
function withUsage() {
  const tested = testMod(oneclaude)
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

// usagePane opens the page in a Sidebar wide enough for every Usage column.
async function usagePane(tested: ReturnType<typeof testMod>): Promise<string> {
  if ((await tested.shown.page.lines().catch(() => null)) === null) await tested.type('/accounts')
  return (await tested.shown.page.lines({ columns: 110 })).map((line) => line.trimEnd()).join('\n')
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
  await tested.shown.page.press('by-time')
  const pane = await usagePane(tested)
  expect(asked.at(-1)).toContain('period=month&by=time&units=cost')
  expect(pane).toContain('[Time]')
  expect(pane).toMatch(/Oct 15( +\S+){5} +2% +\$0\.90\n +Oct 14( +\S+){5} +46% +\$18\n +Oct 3( +\S+){4} +51% +\$20\n/)
  await tested.shown.page.press('show-tokens')
  await tested.settle()
  expect(asked.at(-1)).toContain('period=month&by=time&units=tokens')
})

test('the By row stays the same for every period, and Time over a day goes by the hour', async () => {
  const { tested, asked } = withUsage()
  await usagePane(tested)
  await tested.shown.page.press('by-time')
  const before = await usagePane(tested)
  await tested.shown.page.press('period-today')
  const pane = await usagePane(tested)
  expect(asked.at(-1)).toContain('period=today&by=time&units=cost')
  for (const shown of [before, pane]) expect(shown).toMatch(/By +Account +Model +Agent +Project +\[Time\]\n/)
  expect(pane).toMatch(/17:00( +\S+){6}\n +09:00( +\S+){6}\n +All hours/)
})

test('Usage says what Not recorded means when a row has no agent type or project', async () => {
  const { tested } = withUsage()
  await usagePane(tested)
  await tested.shown.page.press('period-month')
  await tested.shown.page.press('by-agent')
  const pane = await usagePane(tested)
  expect(pane).toMatch(/Not recorded( +\S+){6}/)
  expect(pane.replace(/\s+/g, ' ')).toContain('Not recorded: requests from before oneclaude recorded agent types and projects, and from conversations whose record never reached the pool.')
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
  await tested.shown.page.press('optimize')
  const asking = await usagePane(tested)
  expect(asking).toContain('Ask your agent to optimize your usage?')
  expect(asking).toContain("We'll send it your last 30 days of usage, by agent, project and model.")
  expect(asking).toContain('[Ask your agent]')
  expect(tested.shown.prompts).toHaveLength(0)
  await tested.shown.page.press('optimize-cancel')
  expect(await usagePane(tested)).toContain('[Optimize usage]')
  await tested.shown.page.press('optimize')
  await tested.shown.page.press('optimize-send')
  const [prompt] = tested.shown.prompts
  expect(prompt).toContain('Optimize my Claude usage')
  expect(prompt).toContain('- explorer: $20 (cache writes $0, cache reads $0, output $20, input $0), 1M tokens')
  expect(prompt).toContain('- Not recorded: $8')
  expect(prompt).toContain('- dotfiles: $0.80')
  expect(prompt).toContain('- Opus 5.5: $39')
  expect(prompt).toContain('Change nothing until I approve.')
  expect(await usagePane(tested)).toContain('[Optimize usage]')
})

test('a count reads in 3 figures, and dollars in whole dollars from $1', () => {
  expect([1_400_000, 32_700_000, 832_000_000, 1_050_000_000, 999, 0].map(tokenCount)).toEqual(['1.4M', '32.7M', '832M', '1.05B', '999', '0'])
  expect([0, 0.104, 5.4, 1193.2].map(money)).toEqual(['$0', '$0.10', '$5', '$1,193'])
})

test('pace is on within 5%, and far over past 25%', () => {
  expect(paceState(0.04)).toBe('on')
  expect(paceState(-0.1)).toBe('under')
  expect(paceState(0.1)).toBe('over')
  expect(paceState(0.3)).toBe('far-over')
})

test('the line shows the pace the pool spends at now, and none while the pool can\'t know it', async () => {
  const spending = await hintLines(answering({ text: JSON.stringify({ ...status, pool: { ...status.pool, used: 0.83, even: 0.68, pace: -0.06 } }) }))
  expect(spending).toContain('83% · 6% under pace')
  const learning = await hintLines(answering({ text: JSON.stringify({ ...status, pool: { ...status.pool, pace: undefined } }) }))
  expect(learning).toContain('58% · next refill in 2d')
  expect(learning).not.toContain('pace')
})

type SentRecord = { readonly session: string; readonly project: string; readonly agents: Readonly<Record<string, string>>; readonly filters: readonly object[] }

// recording starts the mod against a pool, the local one unless given, that
// answers each session record with answer, and keeps every record the mod
// sent, with the key it sent. Nothing answers at any other address.
function recording(answer: (record: SentRecord) => HttpResponse | Error = () => ({ status: 200, ok: true, headers: {}, text: '{"status":"ok"}' }), pool = LOCAL_POOL) {
  const tested = testMod(oneclaude, { files: stored('oneclaude'), projectRoot: '/Users/turing/dotfiles' })
  if (pool !== LOCAL_POOL) tested.fakes.settings.read = async () => ({ env: { ANTHROPIC_BASE_URL: pool } })
  const records: { record: SentRecord; key?: string }[] = []
  tested.fakes.http.fetch = async (url, init) => {
    if (!url.startsWith(pool)) throw new Error('connection refused')
    if (url === `${pool}/v0/management/plugins/oneclaude/session`) {
      const record = JSON.parse(textOf(init?.body ?? '{}')) as SentRecord
      records.push({ record, key: init?.headers?.['Authorization'] })
      const response = answer(record)
      if (response instanceof Error) throw response
      return response
    }
    return { status: 200, ok: true, headers: {}, text: url.endsWith('/auth-files') ? '{"files":[]}' : JSON.stringify(status) }
  }
  return { tested, records }
}

async function addFilter(tested: ReturnType<typeof testMod>, input: object): Promise<unknown> {
  return tested.fire('cmod.call', { to: 'oneclaude', method: 'addFilter', input })
}

test('a session tells the pool its project as it starts, with no filters, so a mod that is gone leaves none behind', async () => {
  const { tested, records } = recording()
  await tested.type('/accounts')
  expect(records[0]).toEqual({ record: { session: 'test-session', project: '/Users/turing/dotfiles', agents: {}, filters: [] }, key: 'Bearer oneclaude' })
  expect((await tested.shown.page.lines()).join('\n')).not.toContain('memory')
})

test('a mod adds its filter to this session, and adding it again replaces it in its place', async () => {
  const { tested, records } = recording()
  expect(await addFilter(tested, { name: 'memory', url: 'http://127.0.0.1:4100/', responses: true, timeoutSeconds: 120 })).toEqual({ value: undefined })
  await addFilter(tested, { name: 'inspect', url: 'unix:/tmp/inspect.sock', observabilityMode: true })
  await addFilter(tested, { name: 'memory', url: 'http://127.0.0.1:4200/', responses: true, timeoutSeconds: 120, failOpen: true })
  expect(records.at(-1)?.record.filters).toEqual([
    { name: 'memory', url: 'http://127.0.0.1:4200/', responses: true, timeoutSeconds: 120, failOpen: true },
    { name: 'inspect', url: 'unix:/tmp/inspect.sock', observabilityMode: true },
  ])
  const sent = records.length
  await addFilter(tested, { name: 'inspect', url: 'unix:/tmp/inspect.sock', observabilityMode: true })
  expect(records.length).toBe(sent)
  await tested.fire('cmod.call', { to: 'oneclaude', method: 'removeFilter', input: { name: 'memory' } })
  expect(records.at(-1)?.record.filters).toEqual([{ name: 'inspect', url: 'unix:/tmp/inspect.sock', observabilityMode: true }])
})

test('the pool\'s refusal of a filter reaches the mod that added it, and the record keeps the filters before it', async () => {
  const refusal = { status: 400, ok: false, headers: {}, text: '{"error":"the url of the memory filter must be an address on the machine the pool runs on, as http://127.0.0.1:4100/ or unix:/path/to/socket"}' }
  const { tested, records } = recording((record) => (JSON.stringify(record.filters).includes('example.com') ? refusal : { status: 200, ok: true, headers: {}, text: '{}' }))
  expect(await addFilter(tested, { name: 'memory', url: 'https://example.com/filter' })).toEqual({ deny: expect.stringContaining('the url of the memory filter must be an address on the machine the pool runs on') })
  expect(await addFilter(tested, { name: 'memory', url: 'http://127.0.0.1:4100/', timeoutSeconds: 300 })).toEqual({ deny: expect.stringContaining('from 1 to 120') })
  await addFilter(tested, { name: 'inspect', url: 'unix:/tmp/inspect.sock' })
  expect(records.at(-1)?.record.filters).toEqual([{ name: 'inspect', url: 'unix:/tmp/inspect.sock' }])
})

test('a filter added while the pool is down reaches it once it answers', async () => {
  let isUp = false
  const { tested, records } = recording(() => (isUp ? { status: 200, ok: true, headers: {}, text: '{}' } : new Error('connection refused')))
  const timers: (() => unknown)[] = []
  tested.fakes.clock.after = (ms, fn) => {
    if (ms === 1000) timers.push(fn)
    return { cancel() {} }
  }
  expect(await addFilter(tested, { name: 'memory', url: 'http://127.0.0.1:4100/' })).toEqual({ value: undefined })
  isUp = true
  await timers.shift()?.()
  await tested.settle()
  expect(records.at(-1)?.record.filters).toEqual([{ name: 'memory', url: 'http://127.0.0.1:4100/' }])
})

test('each subagent the session starts reaches the pool with its type, so Usage names custom agents', async () => {
  const { tested, records } = recording()
  await tested.start()
  const id = await tested.startTask({ title: 'Review the diff', agentType: 'code-reviewer' })
  await tested.settle()
  expect(records.at(-1)?.record.agents).toEqual({ [id]: 'code-reviewer' })
})

test('after /clear, /resume or a fork the pool receives the record of the new session, with its filters', async () => {
  for (const source of ['clear', 'resume', 'fork'] as const) {
    const { tested, records } = recording(undefined, 'http://homeserver:8317')
    await addFilter(tested, { name: 'memory', url: 'http://127.0.0.1:4100/' })
    await tested.startSession({ source, id: `${source}-session` })
    await tested.settle()
    expect(records.at(-1)?.record).toEqual({ session: `${source}-session`, project: '/Users/turing/dotfiles', agents: {}, filters: [{ name: 'memory', url: 'http://127.0.0.1:4100/' }] })
  }
})

test('a session that moves to another project tells the pool, and a cd inside the project sends nothing', async () => {
  const { tested, records } = recording()
  await tested.moveTo('/Users/turing/cmod')
  await tested.settle()
  expect(records.at(-1)?.record.project).toBe('/Users/turing/cmod')
  const sent = records.length
  await tested.moveTo('/Users/turing/cmod', '/Users/turing/cmod/src')
  await tested.settle()
  expect(records.length).toBe(sent)
})

test('a record the pool refuses is logged with the refusal', async () => {
  const { tested } = recording(() => ({ status: 403, ok: false, headers: {}, text: '{"error":"remote management disabled"}' }))
  await tested.start()
  await tested.settle()
  expect(tested.shown.debug.join('\n')).toContain('the pool refused the record of session test-session with 403: {"error":"remote management disabled"}')
})

test('a record post still on its way holds back no record of the session /clear starts', async () => {
  const tested = testMod(oneclaude, { files: stored('oneclaude'), projectRoot: '/Users/turing/dotfiles' })
  tested.fakes.clock.after = () => ({ cancel() {} })
  const sent: string[] = []
  tested.fakes.http.fetch = async (url, init) => {
    if (url !== `${LOCAL_POOL}/v0/management/plugins/oneclaude/session`) return { status: 404, ok: false, headers: {}, text: '' }
    sent.push((JSON.parse(textOf(init?.body ?? '{}')) as SentRecord).session)
    if (sent.length === 1) return new Promise<HttpResponse>(() => {})
    return { status: 200, ok: true, headers: {}, text: '{"status":"ok"}' }
  }
  await tested.start()
  await tested.startSession({ source: 'clear', id: 'cleared-session' })
  await tested.settle()
  expect(sent).toEqual(['test-session', 'cleared-session'])
})

test('records sent while a post is on its way go as one post of the newest record once it ends', async () => {
  const tested = testMod(oneclaude, { files: stored('oneclaude'), projectRoot: '/Users/turing/dotfiles' })
  tested.fakes.clock.after = () => ({ cancel() {} })
  const sent: SentRecord[] = []
  let end: (error: Error) => void = () => {}
  tested.fakes.http.fetch = async (url, init) => {
    if (url !== `${LOCAL_POOL}/v0/management/plugins/oneclaude/session`) return { status: 404, ok: false, headers: {}, text: '' }
    sent.push(JSON.parse(textOf(init?.body ?? '{}')) as SentRecord)
    if (sent.length === 1) return new Promise<HttpResponse>((_resolve, reject) => {
      end = reject
    })
    return { status: 200, ok: true, headers: {}, text: '{"status":"ok"}' }
  }
  await tested.start()
  await tested.settle()
  const first = await tested.startTask({ title: 'Review', agentType: 'code-reviewer' })
  const second = await tested.startTask({ title: 'Explore', agentType: 'Explore' })
  await tested.settle()
  expect(sent.length).toBe(1)
  end(new Error('aborted: no complete answer within 30000ms'))
  await tested.settle()
  expect(sent.map((record) => record.agents)).toEqual([{}, { [first]: 'code-reviewer', [second]: 'Explore' }])
})

test('a record waits for a missing management key and goes once the key is entered', async () => {
  let key = ''
  const tested = testMod(oneclaude, { projectRoot: '/Users/turing/dotfiles' })
  tested.fakes.fs.read = async (path) => {
    if (path === KEY_FILE) return key
    throw new Error(`ENOENT: ${path}`)
  }
  const retries: (() => unknown)[] = []
  tested.fakes.clock.after = (ms, fn) => {
    if (ms === 1000) retries.push(fn)
    return { cancel() {} }
  }
  const sent: SentRecord[] = []
  tested.fakes.http.fetch = async (url, init) => {
    if (url === `${LOCAL_POOL}/v0/management/plugins/oneclaude/session`) sent.push(JSON.parse(textOf(init?.body ?? '{}')) as SentRecord)
    return { status: 200, ok: true, headers: {}, text: url.endsWith('/auth-files') ? '{"files":[]}' : JSON.stringify(status) }
  }
  await tested.start()
  await tested.settle()
  expect(sent).toEqual([])
  await retries.shift()?.()
  await tested.settle()
  expect(sent).toEqual([])
  key = 'oneclaude'
  await retries.shift()?.()
  await tested.settle()
  expect(sent).toEqual([{ session: 'test-session', project: '/Users/turing/dotfiles', agents: {}, filters: [] }])
})
