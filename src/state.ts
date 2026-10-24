import type { Reading, Shown } from './status.js'
import type { Breakdown, Period, Units, UsageTable } from './usage.js'

// UsageView is what the Usage table shows: its period, its breakdown, and
// whether its cells are dollars or tokens.
export type UsageView = { readonly period: Period; readonly by: Breakdown; readonly units: Units }

// CheckedKey is whether a management key fits the secret in the proxy's
// config, kept so bcrypt runs again only when either changes.
export type CheckedKey = { readonly key: string; readonly secret: string; readonly fits: boolean }

// isConfirming is true while the Usage section asks the person to confirm
// sending the optimize prompt to their session. keyAnswer is what the
// management key step says of the key the person entered. managementKey is
// the proxy's management key the person entered, or null for oneclaude's.
export type OneclaudeState = {
  memory: {
    reading: Reading | null
    isOpen: boolean
    shown: Readonly<Record<string, Shown>>
    usage: UsageView
    table: UsageTable | null
    isConfirming: boolean
    keyAnswer: 'saved' | 'wrong' | null
  }
  global: {
    managementKey: string | null
    checkedKey: CheckedKey | null
  }
}

export const initialState: OneclaudeState = {
  memory: { reading: null, isOpen: false, shown: {}, usage: { period: 'month', by: 'account', units: 'cost' }, table: null, isConfirming: false, keyAnswer: null },
  global: { managementKey: null, checkedKey: null },
}
