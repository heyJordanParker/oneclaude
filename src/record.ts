import { sessions, type Mod } from '../node_modules/@cmodjs/core/mod.js'
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

// A Line is one session's posts: the one under way, and the next, which
// every send made meanwhile shares and which posts the record as it is when
// it starts.
type Line = { readonly session: string; last: Promise<string | undefined>; next?: Promise<string | undefined> }

// recordOf starts the session with no filters, as cmod takes back what a mod
// adds when it stops, so a mod that is gone leaves no filter behind. Each
// send posts the whole record as it is, so the pool keeps the newest, one
// post at a time per session, and a new session's record never waits on an
// older session's post. It posts nothing when the pool already took that
// record. A record the pool did not take goes at the next send, which each
// status the pool answers makes. The plugin keeps the agents of the records
// before, and a refusal is logged.
export function recordOf(mod: Mod<OneclaudeState>): SessionRecord {
  let filters: readonly OneclaudeFilter[] = []
  let agents: Readonly<Record<string, string>> = {}
  let taken: string | undefined
  let line: Line = { session: '', last: Promise.resolve(undefined) }

  const post = async (session: string): Promise<string | undefined> => {
    const key = await keyOf(mod)
    if (key === undefined) return undefined
    const body = JSON.stringify({ session, project: sessions.current.project, agents, filters })
    const sent = `${mod.state.memory.pool} ${body}`
    if (sent === taken) return undefined
    const response = await manage(mod, key, '/plugins/oneclaude/session', { method: 'POST', body })
    if (response === undefined || response.ok) {
      if (response?.ok === true) taken = sent
      return undefined
    }
    mod.log(`the pool refused the record of session ${session} with ${response.status}: ${response.text}`)
    return response.status === 400 ? (JSON.parse(response.text) as { readonly error?: string }).error ?? response.text : undefined
  }
  // send answers the pool's refusal of the record, or undefined.
  const send = (): Promise<string | undefined> => {
    const session = sessions.current.id
    if (line.session !== session) line = { session, last: Promise.resolve(undefined) }
    const current = line
    const start = (): Promise<string | undefined> => {
      current.next = undefined
      return post(session)
    }
    current.next ??= current.last.then(start, start)
    current.last = current.next
    return current.next
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
