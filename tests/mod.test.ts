import { expect, test } from 'bun:test'
import type { HttpResponse, RenderPropsOf } from 'claude-code'
import { PromptHint } from '../node_modules/@cmodjs/core/mod.js'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { oneclaude } from '../src/mod.js'
import { bar, type Status } from '../src/status.js'

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

test('the hint line shows the pool after the engine line', async () => {
  const line = await hintLines(answering({ text: JSON.stringify(status) }))
  expect(line.indexOf('PromptHint')).toBeLessThan(line.indexOf('███'))
  expect(line).toContain('58% · 9% under pace')
  expect(line).toContain('[ 2')
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
  tested.fakes.clock.every = (_ms, fn) => {
    tick = fn
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
  expect(await hintLines(tested)).toContain('58% · 9% under pace')
})

test('/accounts shows the pool, every account and every warning', async () => {
  const tested = answering({ text: JSON.stringify(status) })
  await tested.type('/accounts')
  const pane = (await tested.lines('accounts')).join('\n')
  expect(pane).toContain('58% used · 9% under pace')
  expect(pane).toContain('next refill in 2d frees 11% · 14 agents on 3 accounts · 2 read')
  expect(pane).toContain('40% used · refills in 6d · 9/19 opus, 2/19 haiku')
  expect(pane).toContain('empty · refills in 3h · idle')
  expect(pane).toContain('not read yet')
  expect(pane).toContain('30m ago')
  expect(pane).toContain('subagent refused, every account at its Fable limit')
  expect(pane.indexOf('subagent refused')).toBeLessThan(pane.indexOf('throttled on jordan'))
})

test('the bar marks even pace and fills to the usage', () => {
  expect(bar(0.5, 0.75, 8).map((run) => run.text).join('')).toBe('████░░┃░░')
  expect(bar(0.5, undefined, 8).map((run) => run.text).join('')).toBe('████░░░░')
  expect(bar(1, 0.25, 4).map((run) => run.kind)).toEqual(['fill', 'marker', 'fill'])
})
