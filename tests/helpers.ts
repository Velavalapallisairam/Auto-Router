// The world beneath the mod, for tests: an in-memory file system, clock,
// store and environment, and a stand-in for each engine event the mod passes
// on. Nothing here touches the disk, the network or a model.

import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { RouterConfig } from '../types'
import { defaultConfig, serializeConfig } from '../hooks/engine/config.ts'

export const HOME = '/home/test'
export const DIR = `${HOME}/.claude/auto-router`
export const CONFIG = `${DIR}/config.json`
export const SESSION = 'test-session'
export const T0 = Date.UTC(2026, 10, 13, 9, 0, 0)

/** One spelling for a path whatever the platform hands back. */
export function norm(path: string): string {
  return path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
}

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

export type Step = { model: string; effort: unknown; agentId?: string }
export type Spawn = { type: string; model?: string; prompt: string }
type ToolAnswer = { result: unknown; isError?: true; text?: string } | { deny: string }

export type World = {
  clock: MockClock
  files: Map<string, { text: string; mtime: number }>
  writes: string[]
  runs: string[][]
  store: Map<string, unknown>
  commands: string[]
  tools: string[]
  opened: Record<string, unknown>[]
  statuses: (string | undefined)[]
  envWrites: string[]
  prompts: { text: string; context: string[] }[]
  steps: Step[]
  spawns: Spawn[]
  toolRuns: string[]
  settings: Record<string, unknown>
  agentList: { id: string; description: string; type: string; status: string }[]
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  isPlaced: boolean
  isMoveBroken: boolean
  /** The conversation `$.session.messages()` answers with. */
  messages: { role: 'user' | 'assistant'; text: string; toolUses: never[] }[]
  /** Prompts the judge model was asked about. */
  judged: string[]
  /** The judge model's reply text; undefined: the call fails and the rules stand. */
  judge: (prompt: string) => string | undefined
  usageFor: (step: Step) => Usage | null
  toolAnswer: (tool: string, input: Record<string, unknown>) => ToolAnswer | undefined
  checkAnswer: (tool: string) => 'allow' | 'ask' | 'deny'
  read: (path: string) => string | undefined
  config: () => RouterConfig
}

export type WorldOptions = {
  config?: (config: RouterConfig) => void
  files?: Record<string, string>
  env?: Record<string, string>
  settings?: Record<string, unknown>
  store?: Record<string, unknown>
  model?: string
  version?: string
  isPlaced?: boolean
}

/** The id the API would report for what the request named. */
export function actualOf(model: string): string {
  if (model.startsWith('claude-')) return model
  if (model === 'fable') return 'claude-fable-5-2'
  return `claude-${model}-5-5`
}

export function world(on: On, options: WorldOptions = {}): World {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME, ...(options.env ?? {}) })
  let tick = 0
  let agentSeq = 0
  const w: World = {
    clock,
    files: new Map(),
    writes: [],
    runs: [],
    store: new Map(Object.entries(options.store ?? {})),
    commands: [],
    tools: [],
    opened: [],
    statuses: [],
    envWrites: [],
    prompts: [],
    steps: [],
    spawns: [],
    toolRuns: [],
    settings: options.settings ?? {},
    agentList: [],
    rateLimits: [],
    isPlaced: options.isPlaced ?? true,
    isMoveBroken: false,
    messages: [],
    judged: [],
    judge: () => undefined,
    usageFor: step => ({
      input_tokens: 1200,
      output_tokens: 300,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 4000,
      model: actualOf(step.model),
    }),
    toolAnswer: () => undefined,
    checkAnswer: () => 'allow',
    read: path => w.files.get(norm(path))?.text,
    config: () => JSON.parse(w.read(CONFIG) ?? '{}') as RouterConfig,
  }
  const put = (path: string, text: string): void => {
    tick += 1
    w.files.set(norm(path), { text, mtime: clock.now() + tick })
  }
  if (options.config !== undefined) {
    const config = defaultConfig()
    options.config(config)
    put(CONFIG, serializeConfig(config))
  }
  for (const [path, text] of Object.entries(options.files ?? {})) put(path, text)

  on('fs.exists', (_, e) => ({ value: w.files.has(norm(e.path)) }))
  on('fs.read', (_, e) => {
    const file = w.files.get(norm(e.path))
    return file === undefined ? { deny: `ENOENT: ${e.path}` } : { value: file.text }
  })
  on('fs.write', (_, e) => {
    w.writes.push(norm(e.path))
    put(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    const file = w.files.get(norm(e.path))
    if (file === undefined) return { deny: `ENOENT: ${e.path}` }
    return { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtime, isLink: false } }
  })
  on('process.run', (_, e) => {
    w.runs.push([...e.argv])
    const isMove = e.argv.includes('move') || e.argv[0] === 'mv'
    if (isMove) {
      const from = norm(e.argv[e.argv.length - 2] ?? '')
      const to = e.argv[e.argv.length - 1] ?? ''
      const file = w.files.get(from)
      if (file === undefined || w.isMoveBroken) return { value: { exitCode: 1, stdout: '', stderr: 'cannot move' } as never }
      w.files.delete(from)
      put(to, file.text)
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })
  on('store.get', (_, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('env.set', (_, e) => {
    w.envWrites.push(e.name)
    return { value: {} }
  })
  on('session.id', () => ({ value: SESSION }))
  on('session.version', () => ({ value: { version: options.version ?? '2.1.321' } }))
  on('session.model', () => ({ value: options.model ?? 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: { startedAt: T0, context: { window: 1_000_000, tokens: 52_000, percent: 5 }, rateLimits: w.rateLimits },
  }))
  on('settings.read', () => ({ value: w.settings }))
  on('session.messages', () => ({ value: w.messages as never }))
  on('model.complete', (_, e) => {
    w.judged.push(e.prompt)
    const text = w.judge(e.prompt)
    if (text === undefined) return { value: { isAnswered: false, reason: 'api-error' } as never }
    return {
      value: {
        isAnswered: true,
        text,
        usage: { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('agent.list', () => ({ value: w.agentList as never }))
  on('command.register', (_, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', (_, e) => {
    w.tools.push(e.name)
    return { value: { tool: `mcp__auto-router__${e.name}` } }
  })
  on('ui.open', (_, e) => {
    w.opened.push({ ...e })
    return { value: w.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'no-surface: nothing attached' } }
  })
  on('ui.status', (_, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('prompt.submit', (_, e) => {
    w.prompts.push({ text: e.text, context: [...(e.context ?? [])] })
    return { text: e.text, context: e.context }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_, e) {
    const step: Step = { model: e.model, effort: e.effort, agentId: e.agentId }
    w.steps.push(step)
    const usage = w.usageFor(step)
    yield { kind: 'text', index: 0, text: 'ok' }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: usage === null ? null : 'end_turn',
      usage,
    }
  })
  on('tool.call', (_, e) => {
    w.toolRuns.push(e.tool)
    return (w.toolAnswer(e.tool, e as unknown as Record<string, unknown>) ?? { result: 'ok' }) as never
  })
  on('tool.check', (_, e) => ({ decision: w.checkAnswer(e.tool) }))
  on('agent.spawn', (_, e) => {
    w.spawns.push({ type: e.subagentType, model: e.model, prompt: e.prompt })
    agentSeq += 1
    return { model: actualOf(e.model ?? 'opus'), agentId: `agent-${agentSeq}` }
  })
  return w
}

// ------------------------------------------------------------- driving

export async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
}

export async function submit($: Engine, text: string, turnId?: string): Promise<void> {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...(turnId === undefined ? {} : { turnId }) })
}

export async function step(
  $: Engine,
  turnId: string,
  index: number,
  model: string,
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
  agentId?: string,
): Promise<void> {
  const stream = $.turn.step({
    turnId,
    index,
    model,
    messageCount: index + 1,
    ...(effort === undefined ? {} : { effort }),
    ...(agentId === undefined ? {} : { agentId }),
  })
  let piece = await stream.next()
  while (piece.done !== true) piece = await stream.next()
}

export type TurnOptions = {
  id: string
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  steps?: number
  reason?: 'answer' | 'aborted' | 'error'
}

/** One whole main turn: the prompt, its start, its model requests and its end. */
export async function turn($: Engine, text: string, options: TurnOptions): Promise<{ text: string }> {
  await submit($, text)
  await $.turn.start({ text, turnId: options.id })
  for (let index = 0; index < (options.steps ?? 1); index += 1) {
    await step($, options.id, index, options.model ?? 'claude-opus-5-5', options.effort ?? 'medium')
  }
  const reason = options.reason ?? 'answer'
  return $.turn.complete({ turnId: options.id, answer: 'done', durationMs: 20, isAborted: reason === 'aborted', reason })
}

export async function command($: Engine, args: string): Promise<string> {
  const answer = await $.command.run({
    command: 'auto-router',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 } as never,
  })
  return answer.text ?? ''
}

export type SpawnOptions = {
  type: string
  prompt: string
  description?: string
  model?: string
  isFork?: boolean
  hasWorkflow?: boolean
}

export async function spawn($: Engine, options: SpawnOptions, id: string) {
  return $.agent.spawn({
    tool_use_id: id,
    prompt: options.prompt,
    description: options.description ?? options.prompt.slice(0, 30),
    subagentType: options.type,
    provider: { plugin: 'engine', tier: 'core' } as never,
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: options.isFork === true,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.hasWorkflow === true ? { workflow: { runId: 'wf_1', agentIndex: 1 } } : {}),
  })
}

export function pane(placement: 'dock' | 'inline' | 'widget' = 'dock', columns = 66) {
  return {
    plugin: 'auto-router',
    component: 'Pane',
    requestId: 'auto-router',
    props: {
      title: 'Auto Router',
      isFocused: false,
      bodyColumns: columns,
      placement,
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  } as const
}

type Drawn = { findAll: (query: { type: string }) => Promise<{ text: string }[]> }

/** Every word a drawing shows, one Text per line. */
export async function words(ui: Drawn): Promise<string> {
  return (await ui.findAll({ type: 'Text' })).map(one => one.text).join('\n')
}
