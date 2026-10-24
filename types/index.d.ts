export type OneclaudeFilter = {
  name: string
  url: string
  responses?: boolean
  timeoutSeconds?: number
  failOpen?: boolean
  observabilityMode?: boolean
}

export type Oneclaude = {
  addFilter(input: OneclaudeFilter): Promise<void>
  removeFilter(input: { name: string }): Promise<void>
}

declare module 'claude-code' {
  interface CmodDependencies {
    oneclaude: Oneclaude
  }
}
