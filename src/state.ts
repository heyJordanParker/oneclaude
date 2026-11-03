import { LOCAL_POOL, type Problem, type Reading, type Shown } from './status.js'
import type { Breakdown, Period, Units, UsageTable } from './usage.js'

// UsageView is what the Usage table shows: its period, its breakdown, and
// whether its cells are dollars or tokens.
export type UsageView = { readonly period: Period; readonly by: Breakdown; readonly units: Units }

// pool is the address of the pool Claude Code uses, read at each refresh.
// reading is the last status any session read from it, and problem why the
// latest read brought none. isConfirming is true while the Usage section
// asks the person to confirm sending the optimize prompt to their session.
// keyAnswer is what the pool said of the management key the person entered.
export type OneclaudeState = {
  memory: {
    pool: string
    reading: Reading | null
    problem: Problem | null
    isOpen: boolean
    shown: Readonly<Record<string, Shown>>
    usage: UsageView
    table: UsageTable | null
    isConfirming: boolean
    keyAnswer: 'saved' | 'wrong' | 'unanswered' | null
  }
}

export const initialState: OneclaudeState = {
  memory: { pool: LOCAL_POOL, reading: null, problem: null, isOpen: false, shown: {}, usage: { period: 'month', by: 'account', units: 'cost' }, table: null, isConfirming: false, keyAnswer: null },
}
