// Starts a Claude Code session in tmux against the dev proxy that
// dev/config.yaml runs, which can never reach your own Claude login. Every
// dev session shares one home in .target/dev/home, as the sessions of one
// machine do: its Claude Code config, and its cmod store, which holds
// oneclaude's install record and a program that refuses to install, so cmod
// runs no install step. The home holds no Claude login.
//
// bun dev/session.ts <name> [mod folder]
//
// The mod folder is this checkout unless given. The session works in
// .target/dev/sessions/<name>, and writes its debug log beside it. Attach
// with tmux -L oneclaude-dev attach -t <name>.
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { readSteps, scriptsSha256, writeRecord } from '../node_modules/@cmodjs/core/records.js'

const root = resolve(import.meta.dir, '..')
const [name, folder] = process.argv.slice(2)
if (name === undefined || !/^[\w-]+$/.test(name)) throw new Error('Usage: bun dev/session.ts <name> [mod folder], with a name of letters, digits, - and _')
const mod = resolve(folder ?? root)
const home = join(root, '.target/dev/home')
const project = join(root, '.target/dev/sessions', name)
const store = join(home, '.local/share/cmod')

const config = Bun.YAML.parse(await readFile(join(root, 'dev/config.yaml'), 'utf8')) as { server: { port: number } }
const pool = `http://127.0.0.1:${config.server.port}`
const { version } = JSON.parse(await readFile(join(mod, '.claude-plugin/plugin.json'), 'utf8')) as { version: string }
const steps = readSteps(JSON.parse(await readFile(join(mod, 'package.json'), 'utf8')))
if (steps === undefined) throw new Error(`${mod}/package.json has no cmod steps`)

const real = (await Bun.$`cmod --version`.text()).trim()
const cmodBinary = join(homedir(), '.local/share/cmod/bin/cmod', real, 'cmod')
const cmodPlugin = (Object.entries((JSON.parse(await readFile(join(homedir(), '.claude/plugins/installed_plugins.json'), 'utf8')) as { plugins: Record<string, { installPath: string }[]> }).plugins)
  .find(([id]) => id === 'cmod@cmod') ?? [])[1]?.[0]?.installPath
if (cmodPlugin === undefined) throw new Error('Claude Code has no cmod plugin installed from the cmod marketplace')
const claude = Bun.which('claude')
if (claude === null) throw new Error('claude is not on PATH')

const write = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}
const link = async (target: string, path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await rm(path, { force: true })
  await symlink(target, path)
}
const filesBelow = async (path: string): Promise<string[]> => {
  const entries = await readdir(path, { withFileTypes: true })
  const names = await Promise.all(entries.map(async (entry) => (entry.isDirectory() ? (await filesBelow(join(path, entry.name))).map((below) => `${entry.name}/${below}`) : [entry.name])))
  return names.flat()
}

await mkdir(project, { recursive: true })
await link(join(homedir(), '.local/share/cmod/bin/cmod/cmod'), join(store, 'bin/cmod/cmod'))
await link(cmodBinary, join(store, 'bin/cmod', real, 'cmod'))
await link(join(store, 'bin/cmod/cmod'), join(store, 'programs/cmod'))
const program = join(store, 'bin/oneclaude', version, 'oneclaude')
await write(program, '#!/bin/sh\necho "oneclaude: a dev session never runs oneclaude $*, so it never touches a proxy or a login" >&2\nexit 1\n')
await chmod(program, 0o755)
await link(program, join(store, 'programs/oneclaude'))
await write(join(store, 'data/oneclaude/management-key'), 'dev')
const installedAt = new Date((await stat(program)).mtimeMs + 1000).toISOString()
const scripts = await scriptsSha256(steps, {
  read: (path) => readFile(join(mod, path), 'utf8').catch(() => undefined),
  list: (path) => filesBelow(join(mod, path)),
})
await writeRecord(write, store, { name: 'oneclaude', version, root: mod, installedAt, scriptsSha256: scripts, uninstall: null, program: 'oneclaude', keys: {}, permissions: [], grantedOnUpdate: [] })
await write(join(home, '.claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: pool, ANTHROPIC_AUTH_TOKEN: 'dev-client', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }, model: 'claude-opus-5-5' }, null, 2))
const state = join(home, '.claude/.claude.json')
const known = (await readFile(state, 'utf8').then((text) => JSON.parse(text) as { projects?: Record<string, object> }, () => ({ projects: {} })))
await write(state, JSON.stringify({ ...known, hasCompletedOnboarding: true, projects: { ...known.projects, [project]: { hasTrustDialogAccepted: true } } }, null, 2))

const log = `${project}.log`
const environment = { HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), PATH: `${join(store, 'programs')}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }
const command = ['env', '-i', ...Object.entries(environment).map(([key, value]) => `${key}=${value}`), claude, '--plugin-dir', cmodPlugin, '--plugin-dir', mod, '--debug-file', log].map((part) => `'${part}'`).join(' ')
await Bun.$`tmux -L oneclaude-dev new-session -d -s ${name} -x 160 -y 45 -c ${project} ${command}`
console.log(`${name}: Claude Code on ${pool}, the mod from ${mod}, its debug log in ${log}`)
