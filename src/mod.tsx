import { defineMod, PromptHint, settings, type Disposable, type Mod } from '../node_modules/@cmodjs/core/mod.js'
import { defineStep } from '../node_modules/@cmodjs/core/installer.js'
import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'
import { Box, Input, Text } from '../node_modules/@cmodjs/core/ui/elements.js'
import { PoolLine } from './components/pool-line.js'
import { accountsPane, showUsage } from './panes/accounts.js'
import { initialState, type OneclaudeState } from './state.js'
import { barsOf, fits, FRAME_MS, glide, keyOf, LINE, PROXY, proxySecret, read, readBlocks, type Shown } from './status.js'

export const REFRESH_MS = 15_000

// saveKey keeps the key the person entered once it fits the proxy's config.
async function saveKey(mod: Mod<OneclaudeState>, key: string): Promise<void> {
  const secret = await proxySecret(mod.dataFolder)
  const isRight = secret !== undefined && (await fits(key, secret))
  if (isRight) mod.state.global.managementKey = key
  mod.state.memory.keyAnswer = isRight ? 'saved' : 'wrong'
}

// askKey asks for the proxy's management key when the one oneclaude holds
// doesn't fit the proxy's config: CLIProxyAPI was installed with a key of its
// own, or the key changed since.
export const askKey = defineStep<OneclaudeState>({
  id: 'management-key',
  title: "CLIProxyAPI's management key",
  render: (mod) => (
    <Box flexDirection="column">
      <Text>oneclaude reads and clears the proxy's blocks with the management key you set for CLIProxyAPI.</Text>
      <Input key="management-key" label="› " submitLabel="save" onSubmit={(key) => void saveKey(mod, key)} />
      {mod.state.memory.keyAnswer === 'saved' ? <Text color="success">✔ saved</Text>
        : mod.state.memory.keyAnswer === 'wrong' ? <Text color="error">That is not the key in the proxy's config.</Text>
        : <Text>{''}</Text>}
    </Box>
  ),
  isDone: async (mod) => (await proxySecret(mod.dataFolder)) === undefined || (await keyOf(mod)) !== undefined,
})

// baseUrlOf is the proxy Claude Code's user settings send it to, if any.
async function baseUrlOf(): Promise<unknown> {
  const env = (await settings.user.read())['env']
  return typeof env === 'object' && env !== null ? (env as Record<string, unknown>)['ANTHROPIC_BASE_URL'] : undefined
}

export const oneclaude = defineMod({
  name: 'oneclaude',
  state: initialState,
  installer: [askKey],

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
    // refresh reads the status with the proxy's blocks, and the Usage table
    // while the pane shows it.
    const refresh = async (): Promise<void> => {
      const reading = await read()
      if ('problem' in reading) {
        mod.state.memory.reading = reading
        return
      }
      const key = await keyOf(mod)
      mod.state.memory.reading = { ...reading, blocks: key === undefined ? {} : await readBlocks(key) }
      if (pane.isOpen) await showUsage(mod)
      await useProxy()
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
    const showTrouble = async (key: string): Promise<void> => {
      if (!pane.isOpen) await toggle()
      await mod.ui.scroll({ to: { key }, in: accountsPane.id, block: 'start' })
    }

    mod.ui.render(PromptHint, ({ Default }) => {
      const reading = mod.state.memory.reading
      if (reading === null) return <Default />
      return (
        <Box gap={3}>
          <Default />
          <PoolLine reading={reading} shown={mod.state.memory.shown[LINE]} isOpen={mod.state.memory.isOpen} onToggle={toggle} onTrouble={showTrouble} />
        </Box>
      )
    })
    mod.use(slashCommand({
      name: 'accounts',
      description: 'Show every Claude account: combined usage, pace, agents and the log',
      reply: toggle,
    }))
    mod.every(REFRESH_MS, refresh)
    void refresh()
  },
})
