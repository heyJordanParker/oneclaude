import { BelowPrompt, Dashboard, defineMod, http, sessions, settings, type Mod, type Step, type Timer } from '../node_modules/@cmodjs/core/mod.js'
import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'
import { Box, Input, Text } from '../node_modules/@cmodjs/core/ui/elements.js'
import type { OneclaudeFilter } from '../types/index.js'
import { PoolLine } from './components/pool-line.js'
import { accountsPage, showUsage } from './pages/accounts.js'
import { recordOf } from './record.js'
import { initialState, type OneclaudeState } from './state.js'
import { barsOf, baseUrlOf, FRAME_MS, glide, keyOf, LINE, LOCAL_POOL, poolOf, read, saveKey, sharedBlocks, type Shown } from './status.js'

export const REFRESH_MS = 15_000

// checkKey asks the pool once whether it takes the key the person entered,
// and keeps it once it does.
async function checkKey(mod: Mod<OneclaudeState>, key: string): Promise<void> {
  mod.state.memory.pool = await poolOf()
  const response = await http.fetch(`${mod.state.memory.pool}/v0/management/plugins/oneclaude/status`, { headers: { Authorization: `Bearer ${key}` } }).catch(() => undefined)
  if (response?.ok === true) await saveKey(mod, key)
  mod.state.memory.keyAnswer = response?.ok === true ? 'saved' : response?.status === 401 ? 'wrong' : 'unanswered'
}

// askKey asks for the proxy's management key when oneclaude holds none the
// proxy took: CLIProxyAPI was installed with a key of its own, or the key
// changed since.
export const askKey: Step<OneclaudeState> = {
  id: 'management-key',
  title: "CLIProxyAPI's management key",
  render: (mod) => (
    <Box flexDirection="column">
      <Text>oneclaude reads and clears the proxy's blocks, and tells it each session's project, agents and filters, with the management key you set for CLIProxyAPI.</Text>
      <Input key="management-key" label="› " submitLabel="save" onSubmit={(key) => void checkKey(mod, key)} />
      {mod.state.memory.keyAnswer === 'saved' ? <Text color="success">✔ saved</Text>
        : mod.state.memory.keyAnswer === 'wrong' ? <Text color="error">The proxy at {mod.state.memory.pool} refused that key.</Text>
        : mod.state.memory.keyAnswer === 'unanswered' ? <Text color="error">The proxy at {mod.state.memory.pool} didn't answer.</Text>
        : <Text>{''}</Text>}
    </Box>
  ),
  isDone: async (mod) => (await keyOf(mod)) !== undefined,
}

export const oneclaude = defineMod({
  name: 'oneclaude',
  state: initialState,
  installer: [askKey],

  async setup(mod) {
    const page = mod.sidebar.add(accountsPage)
    let frames: Timer | undefined
    const settle = (): void => {
      frames?.stop()
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
    // useProxy points Claude Code at the local pool once it answers with
    // oneclaude's status, once a session and only while it points nowhere, so
    // cmod records the value and takes only it back when oneclaude is removed.
    let isUsingProxy = false
    const useProxy = async (): Promise<void> => {
      if (isUsingProxy) return
      isUsingProxy = true
      if ((await baseUrlOf()) === undefined) await settings.user.update({ env: { ANTHROPIC_BASE_URL: LOCAL_POOL } })
    }
    // refresh draws the status of the pool Claude Code uses as soon as it
    // arrives, then the proxy's blocks, and the Usage table while the
    // Accounts page is open.
    const refresh = async (): Promise<void> => {
      mod.state.memory.pool = await poolOf()
      const reading = await read(mod.state.memory.pool)
      if ('problem' in reading) {
        mod.state.memory.reading = reading
        return
      }
      const earlier = mod.state.memory.reading
      mod.state.memory.reading = { ...reading, blocks: earlier !== null && 'blocks' in earlier ? earlier.blocks : {} }
      animate()
      const key = await keyOf(mod)
      const blocks = key === undefined ? {} : await sharedBlocks(mod, key)
      const latest = mod.state.memory.reading
      if (latest !== null && 'status' in latest) mod.state.memory.reading = { ...latest, blocks }
      mod.state.memory.isOpen = page.isOpen
      if (page.isOpen) await showUsage(mod)
      await useProxy()
    }
    // toggle opens or closes the page. cmod shows a page only once the
    // command or press that asked for it ends, so the toggle line follows
    // what was asked, and each refresh what the Sidebar shows, as after its ×.
    const toggle = async (): Promise<void> => {
      const isOpening = !page.isOpen
      if (isOpening) {
        mod.state.memory.isConfirming = false
        await refresh()
        await showUsage(mod)
        mod.state.memory.shown = Object.fromEntries(Object.entries(mod.state.memory.shown).map(([key, shown]) => [key, key === LINE ? shown : { used: 0, pace: 0 }]))
        animate()
      }
      await page.toggle({ focus: true })
      mod.state.memory.isOpen = isOpening
    }
    const showTrouble = async (key: string): Promise<void> => {
      if (!page.isOpen) await toggle()
      await page.scrollTo({ key }, { block: 'start' })
    }

    mod.widgets.add({
      id: 'pool',
      title: 'Pool usage',
      areas: [BelowPrompt, Dashboard],
      render: (current) => {
        const reading = current.state.memory.reading
        if (reading === null) return undefined
        return <PoolLine reading={reading} shown={current.state.memory.shown[LINE]} isOpen={current.state.memory.isOpen} onToggle={toggle} onTrouble={showTrouble} />
      },
    })
    mod.use(slashCommand({
      name: 'accounts',
      description: 'Show every Claude account: combined usage, pace, agents and the log',
      reply: toggle,
    }))
    mod.every(REFRESH_MS, refresh)
    const record = recordOf(mod)
    sessions.current.onTaskStart((task) => {
      if (task.owner.agentType !== undefined) void record.addAgent(task.id, task.owner.agentType)
    })
    mod.state.memory.pool = await poolOf()
    void refresh()
    void record.send()
    return {
      addFilter: (input: OneclaudeFilter) => record.addFilter(input),
      removeFilter: (input: { name: string }) => record.removeFilter(input),
    }
  },
})
