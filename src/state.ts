import type { Reading } from './status.js'

export type OneclaudeState = {
  memory: { reading: Reading | null; isOpen: boolean }
}

export const initialState: OneclaudeState = {
  memory: { reading: null, isOpen: false },
}
