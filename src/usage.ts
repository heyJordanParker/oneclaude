import { http } from '../node_modules/@cmodjs/core/mod.js'
import { percent, USAGE_URL } from './status.js'

export type Period = 'today' | 'yesterday' | 'week' | 'month'
export type Breakdown = 'account' | 'model' | 'agent' | 'project' | 'day'
export type Units = 'cost' | 'tokens'

export const PERIODS: readonly (readonly [Period, string])[] = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', '7 days'], ['month', '30 days']]
export const BREAKDOWNS: readonly (readonly [Breakdown, string])[] = [['account', 'Account'], ['model', 'Model'], ['agent', 'Agent'], ['project', 'Project'], ['day', 'Day']]
export const UNITS: readonly (readonly [Units, string])[] = [['cost', 'Cost'], ['tokens', 'Tokens']]

// Tokens and Cost are counted by kind. A cost is in dollars at API list
// prices, the 1-hour rate for cache writes.
export type Tokens = { readonly input: number; readonly output: number; readonly cache_write: number; readonly cache_read: number }
export type Cost = Tokens

// A UsageRow is one row of the Usage table as the plugin labels it. Its key
// is '' for requests whose agent type or project was not recorded.
export type UsageRow = { readonly key: string; readonly label: string; readonly tokens: Tokens; readonly cost: Cost }

// UsageTable is the plugin's Usage table for one period and breakdown, rows
// largest first or newest first by day, and the last 30 days for the chart.
export type UsageTable = {
  readonly today: string
  readonly since?: string
  readonly rows: readonly UsageRow[]
  readonly total: UsageRow
  readonly days: readonly { readonly day: string; readonly rows: readonly UsageRow[] }[]
}

export async function readUsage(period: Period, by: Breakdown, units: Units): Promise<UsageTable | null> {
  const response = await http.fetch(`${USAGE_URL}?period=${period}&by=${by}&units=${units}`).catch(() => undefined)
  if (response === undefined || !response.ok) return null
  try {
    const table = JSON.parse(response.text) as Partial<UsageTable>
    return Array.isArray(table.rows) && Array.isArray(table.days) ? (table as UsageTable) : null
  } catch {
    return null
  }
}

const KINDS = ['input', 'output', 'cache_write', 'cache_read'] as const
const KIND_TITLES = { input: 'Input', output: 'Output', cache_write: 'Cache write', cache_read: 'Cache read' } as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// COLD is the cache share below which a row starts too many conversations or
// subagents cold.
export const COLD = 0.9

export function totalOf(row: { readonly tokens: Tokens; readonly cost: Cost }, units: Units): number {
  const counted = units === 'cost' ? row.cost : row.tokens
  return KINDS.reduce((total, kind) => total + counted[kind], 0)
}

// cachedOf is the share of a row's input that came from the cache.
export function cachedOf(tokens: Tokens): number | undefined {
  const input = tokens.input + tokens.cache_write + tokens.cache_read
  return input === 0 ? undefined : tokens.cache_read / input
}

export function dayLabel(day: string): string {
  const [, month, date] = day.split('-').map(Number)
  return `${MONTHS[(month ?? 1) - 1]} ${date}`
}

export function money(dollars: number): string {
  if (dollars < 0.005) return '$0'
  if (dollars < 1) return `$${dollars.toFixed(2)}`
  return `$${Math.round(dollars).toLocaleString('en-US')}`
}

const COUNT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 })

// tokenCount writes a count in 3 figures: 1.4M, 32.7M, 832M, 1.05B.
export function tokenCount(count: number): string {
  return COUNT.format(count)
}

export function amount(value: number, units: Units): string {
  return units === 'cost' ? money(value) : tokenCount(value)
}

// A TableLine is one line of the Usage table, each cell padded to its
// column: the label, the token kinds when the table is wide, then Cached,
// Share, and Total, last because it matters most. cold marks a cache share
// under COLD.
export type TableLine = { readonly cells: readonly string[]; readonly cold: boolean }

export type UsageLayout = { readonly header: TableLine; readonly rows: readonly TableLine[]; readonly total: TableLine; readonly width: number }

export const GUTTER = '   '

export function usageLayout(table: UsageTable, units: Units, isWide: boolean): UsageLayout {
  const grand = totalOf(table.total, units)
  const columns: [string, (row: UsageRow) => string][] = [
    ...(isWide ? KINDS.map((kind): [string, (row: UsageRow) => string] => [KIND_TITLES[kind], (row) => amount((units === 'cost' ? row.cost : row.tokens)[kind], units)]) : []),
    ['Cached', (row) => { const cached = cachedOf(row.tokens); return cached === undefined ? '' : percent(cached) }],
    ['Share', (row) => (row === table.total ? '' : grand === 0 ? '0%' : percent(totalOf(row, units) / grand))],
    ['Total', (row) => amount(totalOf(row, units), units)],
  ]
  const all = [...table.rows, table.total]
  const labelWidth = Math.max(...all.map((row) => row.label.length))
  const widths = columns.map(([title, cell]) => Math.max(title.length, ...all.map((row) => cell(row).length)))
  const line = (label: string, cells: readonly string[], cold: boolean): TableLine => ({
    cells: [label.padEnd(labelWidth), ...cells.map((cell, index) => cell.padStart(widths[index] ?? 0))],
    cold,
  })
  const rowLine = (row: UsageRow): TableLine => {
    const cached = cachedOf(row.tokens)
    return line(row.label, columns.map(([, cell]) => cell(row)), cached !== undefined && cached < COLD)
  }
  const header = line('', columns.map(([title]) => title), false)
  return { header, rows: table.rows.map(rowLine), total: rowLine(table.total), width: header.cells.join(GUTTER).length }
}

// A DailyChart is 4 rows of cells, one column per day for the last 30 days,
// each bar exact to an eighth of a row; '·' is a day with no request.
export type DailyChart = { readonly peak: string; readonly rows: readonly (readonly string[])[]; readonly first: string; readonly last: string }

const CHART_ROWS = 4
const RISERS = ['', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

export function dailyChart(table: UsageTable, units: Units): DailyChart {
  const totals = table.days.map((day) => (day.rows.length === 0 ? undefined : day.rows.reduce((sum, row) => sum + totalOf(row, units), 0)))
  const peak = Math.max(0, ...totals.map((total) => total ?? 0))
  const eighths = totals.map((total) => (total === undefined ? undefined : peak === 0 ? 0 : Math.max(total > 0 ? 1 : 0, Math.round((total / peak) * CHART_ROWS * 8))))
  const rows = Array.from({ length: CHART_ROWS }, (_, fromTop) => {
    const floor = (CHART_ROWS - 1 - fromTop) * 8
    return eighths.map((height) => {
      if (height === undefined) return fromTop === CHART_ROWS - 1 ? '·' : ' '
      return RISERS[Math.min(8, Math.max(0, height - floor))] || ' '
    })
  })
  return { peak: amount(peak, units), rows, first: dayLabel(table.days[0]?.day ?? table.today), last: dayLabel(table.days.at(-1)?.day ?? table.today) }
}

// optimizePrompt asks Claude, in the person's session, to make the last 30
// days cost less, with the numbers by agent type, project and model.
export function optimizePrompt(agents: UsageTable, projects: UsageTable, models: UsageTable): string {
  const lines = (table: UsageTable): string[] => table.rows.filter((row) => totalOf(row, 'cost') > 0).slice(0, 12).map((row) => {
    const cached = cachedOf(row.tokens)
    return `- ${row.label}: ${money(totalOf(row, 'cost'))} (cache writes ${money(row.cost.cache_write)}, cache reads ${money(row.cost.cache_read)}, output ${money(row.cost.output)}, input ${money(row.cost.input)}), ${tokenCount(totalOf(row, 'tokens'))} tokens${cached === undefined ? '' : `, ${percent(cached)} from cache`}`
  })
  return [
    "Optimize my Claude usage: find where it can cost less without losing quality. These are oneclaude's numbers for the last 30 days, at API list prices.",
    '',
    'By agent type ("Main sessions" are the sessions I talk to):',
    ...lines(agents),
    '',
    'By project:',
    ...lines(projects),
    '',
    'By model:',
    ...lines(models),
    '',
    `Any period and breakdown: ${USAGE_URL}?period=month&by=agent (period today, yesterday, week or month; by account, model, agent, project or day).`,
    '',
    'Read the agent definitions, Skills and settings behind the most expensive rows, find what drives their cache writes and their output, and propose changes ranked by what each would save per day. Change nothing until I approve.',
  ].join('\n')
}
