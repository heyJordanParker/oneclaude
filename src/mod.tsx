import { defineMod, PromptHint } from '../node_modules/@cmodjs/core/mod.js'
import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'
import { Box } from '../node_modules/@cmodjs/core/ui/elements.js'
import { PoolLine } from './components/pool-line.js'
import { accountsPane } from './panes/accounts.js'
import { initialState } from './state.js'
import { read } from './status.js'

export const REFRESH_MS = 15_000

export const oneclaude = defineMod({
  name: 'oneclaude',
  state: initialState,

  setup(mod) {
    const pane = mod.ui.pane(accountsPane)
    const refresh = async (): Promise<void> => {
      mod.state.memory.reading = await read()
    }
    const toggle = async (): Promise<void> => {
      if (!pane.isOpen) await refresh()
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
          <PoolLine reading={reading} isOpen={mod.state.memory.isOpen} onToggle={toggle} onWarnings={toggleWarnings} />
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
