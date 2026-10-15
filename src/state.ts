import type { Reading } from './status.js'

export type OneclaudeState = {
  memory: { reading: Reading | null }
}

export const initialState: OneclaudeState = {
  memory: { reading: null },
}
