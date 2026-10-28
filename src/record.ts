import { sessions, type Mod, type Timer } from '../node_modules/@cmodjs/core/mod.js'
import type { OneclaudeFilter } from '../types/index.js'
import type { OneclaudeState } from './state.js'
import { keyOf, manage } from './status.js'

// A SessionRecord is what this session tells the pool about itself, from
// whichever machine it runs on: the folder it runs in, the type of each
// subagent it started, and the filters its mods added, in order. Claude
// Code's requests name the session and the agent, but not the folder, nor a
// custom agent's type.
export type SessionRecord = {
  addFilter(input: OneclaudeFilter): Promise<void>
  removeFilter(input: { name: string }): Promise<void>
  addAgent(id: string, agentType: string): Promise<void>
  send(): Promise<void>
}

function checked(input: OneclaudeFilter): OneclaudeFilter {
  const { name, url, responses, timeoutSeconds, failOpen, observabilityMode } = input
  if (typeof name !== 'string' || name === '') throw new Error('a filter needs its mod\'s name')
  if (typeof url !== 'string' || url === '') throw new Error(`the ${name} filter needs its url`)
  if (timeoutSeconds !== undefined && (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120)) throw new Error(`the ${name} filter's timeoutSeconds must be a whole number from 1 to 120`)
  return {
    name,
    url,
    ...(responses === true ? { responses } : {}),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(failOpen === true ? { failOpen } : {}),
    ...(observabilityMode === true ? { observabilityMode } : {}),
  }
}

// recordOf starts the session with no filters, as cmod takes back what a mod
// adds when it stops, so a mod that is gone leaves no filter behind. Each
// change sends the whole record, after the sends before it, so the pool keeps
// the newest. A pool that doesn't answer gets it again every second until it
// does, and the plugin keeps the agents of the records before.
export function recordOf(mod: Mod<OneclaudeState>): SessionRecord {
  let filters: readonly OneclaudeFilter[] = []
  let agents: Readonly<Record<string, string>> = {}
  let queue: Promise<string | undefined> = Promise.resolve(undefined)
  let retry: Timer | undefined

  const post = async (): Promise<string | undefined> => {
    const key = await keyOf(mod)
    if (key === undefined) return undefined
    const body = JSON.stringify({ session: sessions.current.id, project: sessions.current.project, agents, filters })
    const response = await manage(mod, key, '/plugins/oneclaude/session', { method: 'POST', body })
    if (response?.status === 400) return (JSON.parse(response.text) as { readonly error?: string }).error ?? response.text
    if (response === undefined || response.status >= 500) retry ??= mod.after(1000, () => {
      retry = undefined
      void send()
    })
    return undefined
  }
  // send answers the pool's refusal of the record, or undefined.
  const send = (): Promise<string | undefined> => {
    queue = queue.then(post, post)
    return queue
  }
  const change = async (next: readonly OneclaudeFilter[]): Promise<void> => {
    if (JSON.stringify(next) === JSON.stringify(filters)) return
    const before = filters
    filters = next
    const refusal = await send()
    if (refusal !== undefined) {
      filters = before
      throw new Error(refusal)
    }
  }

  return {
    addFilter: async (input) => {
      const filter = checked(input)
      const at = filters.findIndex((saved) => saved.name === filter.name)
      await change(at === -1 ? [...filters, filter] : filters.with(at, filter))
    },
    removeFilter: async ({ name }) => change(filters.filter((saved) => saved.name !== name)),
    addAgent: async (id, agentType) => {
      if (agents[id] === agentType) return
      agents = { ...agents, [id]: agentType }
      await send()
    },
    send: async () => {
      await send()
    },
  }
}
