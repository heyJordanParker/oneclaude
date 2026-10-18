import type { Reading, Shown } from './status.js'
import type { Breakdown, Period, Units, UsageTable } from './usage.js'

// UsageView is what the Usage table shows: its period, its breakdown, and
// whether its cells are dollars or tokens.
export type UsageView = { readonly period: Period; readonly by: Breakdown; readonly units: Units }

// isConfirming is true while the Usage section asks the person to confirm
// sending the optimize prompt to their session.
export type OneclaudeState = {
  memory: {
    reading: Reading | null
    isOpen: boolean
    shown: Readonly<Record<string, Shown>>
    usage: UsageView
    table: UsageTable | null
    isConfirming: boolean
  }
}

export const initialState: OneclaudeState = {
  memory: { reading: null, isOpen: false, shown: {}, usage: { period: 'today', by: 'account', units: 'cost' }, table: null, isConfirming: false },
}
