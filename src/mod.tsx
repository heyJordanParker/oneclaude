import { BelowPrompt, Dashboard, defineMod, device, http, sessions, settings, type Mod, type Step, type Timer } from '../node_modules/@cmodjs/core/mod.js'
import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'
import { Box, Input, Text } from '../node_modules/@cmodjs/core/ui/elements.js'
import type { OneclaudeFilter } from '../types/index.js'
import { PoolLine } from './components/pool-line.js'
import { accountsPage, showUsage } from './pages/accounts.js'
import { recordOf } from './record.js'
import { initialState, type OneclaudeState } from './state.js'
import { barsOf, baseUrlOf, FRAME_MS, glide, keyOf, LINE, LOCAL_POOL, poolOf, read, saveKey, sharedBlocks, sharedReading, shareStatus, type Blocks, type Shown, type Status } from './status.js'

// RETRY_MS are the waits before the mod asks a pool that failed it again,
// doubling from 1 to 16 seconds, as cmod restarts a program, then 16 seconds
// on. A plugin that holds no ask for its next change answers at once, so the
// mod asks it again after the first.
export const RETRY_MS = [1000, 2000, 4000, 8000, 16_000]

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
      if (reading === null) return settle()
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
    const record = recordOf(mod)
    // showBlocks draws the proxy's blocks as of the newest status's blocks
    // change, one reading at a time: the reading another session of this
    // machine took, or its own when the pool named this session the reader
    // of that change. A plugin with no blocks change has the blocks read
    // once. A change with no reading yet is drawn at a later status.
    let blocksShown: { readonly change: number | undefined; readonly blocks: Blocks } | undefined
    let blocksWanted: { readonly change: number | undefined; readonly isReader: boolean } = { change: undefined, isReader: false }
    let isReadingBlocks = false
    const showBlocks = async (status: Status): Promise<void> => {
      const isReader = status.reads_blocks === true || status.blocks_change === undefined
      blocksWanted = { change: status.blocks_change, isReader: isReader || (blocksWanted.change === status.blocks_change && blocksWanted.isReader) }
      if (isReadingBlocks) return
      isReadingBlocks = true
      try {
        while (blocksShown === undefined || blocksShown.change !== blocksWanted.change) {
          const wanted = blocksWanted
          const blocks = await sharedBlocks(mod, wanted.change, wanted.isReader)
          if (blocks === undefined) return
          const reading = mod.state.memory.reading
          if (reading !== null) mod.state.memory.reading = { ...reading, blocks }
          blocksShown = { change: wanted.change, blocks }
        }
      } finally {
        isReadingBlocks = false
      }
    }
    let usageReading: Promise<void> | undefined
    // draw shows a status the pool answered with the blocks this session
    // drew, which /clear keeps, then the blocks of its blocks change, and the
    // Usage table while the Accounts page is open, and sends the record the
    // pool lacks.
    const draw = (status: Status): void => {
      mod.state.memory.problem = null
      mod.state.memory.reading = { status, blocks: blocksShown?.blocks ?? mod.state.memory.reading?.blocks ?? {} }
      animate()
      void shareStatus(mod, status)
      void showBlocks(status)
      void record.send()
      void useProxy()
      mod.state.memory.isOpen = page.isOpen
      if (page.isOpen) usageReading ??= showUsage(mod).finally(() => {
        usageReading = undefined
      })
    }
    const machine = device.read().then(({ id }) => id, (error: unknown) => {
      mod.log(`oneclaude names no machine to the pool, so this session reads every blocks change itself: ${String(error)}`)
      return undefined
    })
    // ask asks the pool Claude Code uses for its status after the change
    // after, naming this machine. A pool that brings none shows the problem,
    // and so does one that sends nothing by the time the last status named,
    // while the ask waits on.
    const ask = async (after: number | undefined): Promise<Status | undefined> => {
      const pool = await poolOf()
      mod.state.memory.pool = pool
      const within = mod.state.memory.reading?.status.answers_within_ms
      const silence = within === undefined ? undefined : mod.after(within, () => {
        mod.log(`${pool} sent no status within ${within} ms`)
        mod.state.memory.problem = 'proxy-down'
      })
      const answer = await read(pool, after, await machine).finally(() => silence?.stop())
      if (!('problem' in answer)) return answer.status
      mod.log(`${pool} brought no status: ${answer.cause}`)
      mod.state.memory.problem = answer.problem
      return undefined
    }
    const pause = (ms: number): Promise<void> => new Promise((resolve) => void mod.after(ms, resolve))
    // follow asks for the status after the change it last drew, so the pool
    // answers at its next change, and asks again at each answer. A failed
    // ask keeps the last status on screen, and the next ask waits the next of
    // RETRY_MS and asks for the status at once.
    const follow = async (): Promise<void> => {
      let after: number | undefined
      let failures = 0
      for (;;) {
        const status = await ask(after).catch((error: unknown) => {
          mod.log(`oneclaude could not ask the pool for its status: ${String(error)}`)
          return undefined
        })
        if (status === undefined) {
          after = undefined
          await pause(RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]!)
          continue
        }
        failures = 0
        after = status.change
        draw(status)
        if (after === undefined) await pause(RETRY_MS[0]!)
      }
    }
    // toggle opens or closes the page. cmod shows a page only once the
    // command or press that asked for it ends, so the toggle line follows
    // what was asked, and each status what the Sidebar shows, as after its ×.
    const toggle = async (): Promise<void> => {
      const isOpening = !page.isOpen
      if (isOpening) {
        mod.state.memory.isConfirming = false
        void showUsage(mod)
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
      render: (current) => <PoolLine reading={current.state.memory.reading} problem={current.state.memory.problem} shown={current.state.memory.shown[LINE]} isOpen={current.state.memory.isOpen} onToggle={toggle} onTrouble={showTrouble} />,
    })
    mod.use(slashCommand({
      name: 'accounts',
      description: 'Show every Claude account: combined usage, pace, agents and the log',
      reply: toggle,
    }))
    sessions.current.onTaskStart((task) => {
      if (task.owner.agentType !== undefined) void record.addAgent(task.id, task.owner.agentType)
    })
    // start begins each session the mod runs in: this one, and each one
    // /clear, /resume or a fork starts, which empty the memory.
    const start = async (): Promise<void> => {
      const shared = await sharedReading(mod)
      mod.state.memory.reading ??= shared
      mod.state.memory.pool = await poolOf()
      void record.send()
    }
    sessions.current.onSessionStart({ source: /^(clear|resume|fork)$/ }, start)
    sessions.current.onCwdChange(() => void record.send())
    await start()
    void follow()
    return {
      addFilter: (input: OneclaudeFilter) => record.addFilter(input),
      removeFilter: (input: { name: string }) => record.removeFilter(input),
    }
  },
})
