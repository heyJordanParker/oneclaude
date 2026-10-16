import { expect, test } from 'bun:test'
import type { HttpResponse, RenderPropsOf } from 'claude-code'
import { PromptHint } from '../node_modules/@cmodjs/core/mod.js'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { oneclaude, REFRESH_MS } from '../src/mod.js'
import { bar, evenOf, glide, paceState, PROXY, until, type Cell, type Status } from '../src/status.js'

const hint: RenderPropsOf['PromptHint'] = { isDraft: false, isWorking: false, hint: '? for shortcuts' }

const now = '2026-10-15T16:00:00Z'

const status: Status = {
  version: '0.1.0',
  now,
  pool: { used: 0.58, even: 0.67, pace: -0.09, next_refill: '2026-10-17T16:00:00Z', refill_gain: 0.11, agents: 14, accounts: 3, known: 2 },
  accounts: [
    { name: 'jordan', plan: 'default_claude_max_20x', known: true, used: 0.4, resets_at: '2026-10-21T16:00:00Z', projected: false, empty: false, agents: { opus: 9, haiku: 2 }, limits: { opus: 19, sonnet: 19, haiku: 19, fable: 6 } },
    { name: 'jordan4', known: true, used: 1, resets_at: '2026-10-15T19:00:00Z', projected: false, empty: true, agents: {}, limits: { opus: 19, sonnet: 19, haiku: 19, fable: 6 } },
    { name: 'jarvis', known: false, used: 0, projected: false, empty: false, agents: {}, limits: { opus: 19, sonnet: 19, haiku: 19, fable: 6 } },
  ],
  codex: [
    { name: 'ada', known: true, used: 0.3, resets_at: '2026-10-16T21:30:00Z', projected: false, empty: false },
  ],
  warnings: [
    { at: '2026-10-15T13:00:00Z', kind: 'throttled', account: 'jordan', family: 'opus', agents: 12, detail: 'throttled on jordan with 12 opus agents on the account' },
    { at: '2026-10-15T15:30:00Z', kind: 'refused', family: 'fable', agents: 6, detail: 'subagent refused, every account at its Fable limit, told to retry in 3 minutes' },
  ],
}

function answering(response: Partial<HttpResponse> | Error) {
  const tested = testMod(oneclaude)
  tested.fakes.http.fetch = async () => {
    if (response instanceof Error) throw response
    return { status: 200, ok: true, headers: {}, text: '', ...response }
  }
  return tested
}

async function hintLines(tested: ReturnType<typeof testMod>): Promise<string> {
  await tested.settle()
  return (await tested.lines(PromptHint, hint)).join('\n')
}

const BAR = /[█▏▎▍▌▋▊▉]/

test('the hint line shows the pool after the engine line', async () => {
  const line = await hintLines(answering({ text: JSON.stringify(status) }))
  expect(line.indexOf('PromptHint')).toBeLessThan(line.search(BAR))
  expect(line).toContain('58% · 9% under')
  expect(line).toContain('[ 2 warnings ]')
  expect(line).toMatch(/\S \[\+\]/)
})

test('the toggle after the line shows [-] while the accounts pane is open', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await tested.type('/accounts')
  expect(await hintLines(tested)).toContain('[-]')
  await tested.type('/accounts')
  expect(await hintLines(tested)).toContain('[+]')
})

test('the hint line leaves warnings out when there are none', async () => {
  const line = await hintLines(answering({ text: JSON.stringify({ ...status, warnings: [] }) }))
  expect(line).not.toContain('warning')
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

test('/accounts shows the combined usage, every account with its pace, and every warning', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await tested.type('/accounts')
  const pane = (await tested.lines('accounts')).join('\n')
  expect(pane).toContain('9% under pace · next refill in 2d frees 11% · 14 agents')
  expect(pane).toContain('26% over pace · refills in 6d · 9 opus, 2 haiku')
  expect(pane).not.toContain('/19')
  expect(pane.trimStart().startsWith('✻ oneclaude\n\n')).toBe(true)
  expect(pane).toContain('Combined usage')
  expect(pane).toContain('[Open dashboard]')
  expect(pane).toContain('[Manage accounts]')
  expect(pane).toContain('refills in 3h · idle')
  expect(pane).toContain('not read yet')
  expect(pane).toContain('30m ago')
  expect(pane).toContain('subagent refused, every account at its Fable limit')
  expect(pane.indexOf('subagent refused')).toBeLessThan(pane.indexOf('throttled on jordan'))
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
  expect(pane).toContain('Claude accounts\n\njordan ')
  expect(pane).toContain('Codex accounts\n\nada ')
  expect(pane).toContain('Warnings in the last 24 hours\n\n')
  const barRows = pane.split('\n').map((row, index) => (BAR.test(row) ? index : -1)).filter((index) => index >= 0)
  expect(barRows).toHaveLength(4)
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
  const jordan = rows.findIndex((row) => row.includes('jordan ') && barStart(row) >= 0)
  expect(rows[jordan]!.trimEnd().endsWith('40%')).toBe(true)
  expect(rows[jordan + 1]!.indexOf('26% over pace')).toBe(barStart(rows[jordan]!))
  for (const name of ['jordan ', 'jordan4', 'ada ']) {
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
  expect(drawn).toHaveLength(20)
  expect(drawn.slice(0, 5).every((cell) => cell.text === '█' && cell.color === 'inactive')).toBe(true)
  expect(drawn[5]).toEqual({ text: '▊', color: 'inactive', background: 'warning' })
  expect(drawn.slice(6, 10).every((cell) => cell.text === '█' && cell.color === 'warning')).toBe(true)
  expect(drawn[10]).toEqual({ text: '▎', color: 'warning', background: 'subtle' })
  expect(drawn.slice(11).every((cell) => cell.text === '█' && cell.color === 'subtle')).toBe(true)
})

test('under pace the headroom shows in a lifted track, and a nearly empty bar turns red', () => {
  const under = columns(bar(0.25, 0.5, 4))
  expect(under.map((cell) => cell.color)).toEqual(['inactive', 'promptBorder', 'subtle', 'subtle'])
  const spent = columns(bar(1, 1, 4))
  expect(spent.every((cell) => cell.color === 'error' && cell.background === undefined)).toBe(true)
  const nearly = columns(bar(0.96, 0.5, 4))
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

test('pace is on within 5 points, and far over past 25', () => {
  expect(paceState(0.5, 0.46)).toBe('on')
  expect(paceState(0.4, 0.5)).toBe('under')
  expect(paceState(0.6, 0.5)).toBe('over')
  expect(paceState(0.8, 0.5)).toBe('far-over')
})
