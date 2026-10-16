import type { Reading, Shown } from './status.js'

export type OneclaudeState = {
  memory: { reading: Reading | null; isOpen: boolean; shown: Readonly<Record<string, Shown>> }
}

export const initialState: OneclaudeState = {
  memory: { reading: null, isOpen: false, shown: {} },
}
