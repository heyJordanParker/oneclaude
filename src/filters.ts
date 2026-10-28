import { fs, sessions, type Mod } from '../node_modules/@cmodjs/core/mod.js'
import type { OneclaudeFilter } from '../types/index.js'
import type { OneclaudeState } from './state.js'

// Each session's filters are filters/<session id>.json in the data folder, in
// the order its mods added them, which the plugin reads for that session's
// requests. Only the session itself writes its file, so no two sessions race.
const LOCAL = /^(unix:\/|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$))/

function fileOf(mod: Mod<OneclaudeState>): string {
  return `${mod.dataFolder}/filters/${sessions.current.id}.json`
}

async function read(path: string): Promise<OneclaudeFilter[]> {
  if (!(await fs.exists(path))) return []
  try {
    return JSON.parse(await fs.read(path)) as OneclaudeFilter[]
  } catch (error) {
    throw new Error(`${path} does not parse: ${String(error)}`)
  }
}

async function change(mod: Mod<OneclaudeState>, edit: (filters: readonly OneclaudeFilter[]) => readonly OneclaudeFilter[]): Promise<void> {
  const path = fileOf(mod)
  const before = await read(path)
  const after = edit(before)
  if (JSON.stringify(before) === JSON.stringify(after)) return
  await fs.write(path, JSON.stringify(after, null, 2))
}

function checked(input: OneclaudeFilter): OneclaudeFilter {
  const { name, url, responses, timeoutSeconds, failOpen, observabilityMode } = input
  if (typeof name !== 'string' || name === '') throw new Error('a filter needs its mod\'s name')
  if (typeof url !== 'string' || !LOCAL.test(url)) throw new Error(`the ${name} filter's url must be on this computer: http://127.0.0.1:<port>/… or unix:<socket path>`)
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

// addFilter puts this session's requests through the filter, after the ones
// added before it, or replaces the one with its name in place.
export async function addFilter(mod: Mod<OneclaudeState>, input: OneclaudeFilter): Promise<void> {
  const filter = checked(input)
  await change(mod, (filters) => {
    const at = filters.findIndex((saved) => saved.name === filter.name)
    return at === -1 ? [...filters, filter] : filters.with(at, filter)
  })
}

export async function removeFilter(mod: Mod<OneclaudeState>, { name }: { name: string }): Promise<void> {
  await change(mod, (filters) => filters.filter((saved) => saved.name !== name))
}

// clearFilters takes back every filter of this session as oneclaude starts in
// it, as cmod takes back what a mod adds when it stops, so a mod that is gone
// leaves no filter behind. A mod still here adds its filter again.
export async function clearFilters(mod: Mod<OneclaudeState>): Promise<void> {
  const path = fileOf(mod)
  if ((await fs.exists(path)) && (await fs.read(path)).trim() !== '[]') await fs.write(path, '[]')
}
