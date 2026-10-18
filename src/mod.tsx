import { defineMod, PromptHint, settings, type Disposable } from '../node_modules/@cmodjs/core/mod.js'
import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'
import { Box } from '../node_modules/@cmodjs/core/ui/elements.js'
import { PoolLine } from './components/pool-line.js'
import { accountsPane, showUsage } from './panes/accounts.js'
import { initialState } from './state.js'
import { barsOf, FRAME_MS, glide, LINE, PROXY, read, type Shown } from './status.js'

export const REFRESH_MS = 15_000

// baseUrlOf is the proxy Claude Code's user settings send it to, if any.
async function baseUrlOf(): Promise<unknown> {
  const env = (await settings.user.read())['env']
  return typeof env === 'object' && env !== null ? (env as Record<string, unknown>)['ANTHROPIC_BASE_URL'] : undefined
}

export const oneclaude = defineMod({
  name: 'oneclaude',
  state: initialState,

  setup(mod) {
    const pane = mod.ui.pane(accountsPane)
    let frames: Disposable | undefined
    const settle = (): void => {
      frames?.dispose()
      frames = undefined
    }
    const frame = (): void => {
      const reading = mod.state.memory.reading
      if (reading === null || 'problem' in reading) return settle()
      const shown: Record<string, Shown> = {}
      let isMoving = false
      for (const [key, target] of Object.entries(barsOf(reading.status))) {
        const next = glide(mod.state.memory.shown[key] ?? target, target)
        shown[key] = next
        isMoving ||= next.used !== target.used || next.pace !== target.pace
      }
      mod.state.memory.shown = shown
      if (!isMoving) settle()
    }
    const animate = (): void => {
      frames ??= mod.every(FRAME_MS, frame)
    }
    // useProxy points Claude Code at the proxy once it answers with
    // oneclaude's status, once a session, so cmod records the value and takes
    // only it back when oneclaude is removed. A base URL the person set to
    // another address stays theirs.
    let isUsingProxy = false
    const useProxy = async (): Promise<void> => {
      if (isUsingProxy) return
      isUsingProxy = true
      const current = await baseUrlOf()
      if (current !== undefined && current !== PROXY) {
        mod.log(`Claude Code's ANTHROPIC_BASE_URL is ${String(current)}, so oneclaude leaves it, and Claude Code does not use the pool.`)
        return
      }
      await settings.user.update({ env: { ANTHROPIC_BASE_URL: PROXY } })
    }
    // refresh reads the status, and the Usage table while the pane shows it.
    const refresh = async (): Promise<void> => {
      const reading = await read()
      mod.state.memory.reading = reading
      if (pane.isOpen) await showUsage(mod)
      if ('status' in reading) await useProxy()
      animate()
    }
    const toggle = async (): Promise<void> => {
      if (!pane.isOpen) {
        await refresh()
        await showUsage(mod)
        mod.state.memory.shown = Object.fromEntries(Object.entries(mod.state.memory.shown).map(([key, shown]) => [key, key === LINE ? shown : { used: 0, pace: 0 }]))
        animate()
      }
      await pane.toggle({ focus: true })
      mod.state.memory.isOpen = pane.isOpen
    }
    const toggleWarnings = async (): Promise<void> => {
      await toggle()
      if (pane.isOpen) await mod.ui.scroll({ to: { key: 'warnings' }, in: accountsPane.id, block: 'start' })
    }

    mod.ui.render(PromptHint, ({ Default }) => {
      const reading = mod.state.memory.reading
      if (reading === null) return <Default />
      return (
        <Box gap={3}>
          <Default />
          <PoolLine reading={reading} shown={mod.state.memory.shown[LINE]} isOpen={mod.state.memory.isOpen} onToggle={toggle} onWarnings={toggleWarnings} />
        </Box>
      )
    })
    mod.use(slashCommand({
      name: 'accounts',
      description: 'Show every Claude account: combined usage, pace, agents and warnings',
      reply: toggle,
    }))
    mod.every(REFRESH_MS, refresh)
    void refresh()
  },
})
