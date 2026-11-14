// Auto Router: the hooks module. It is the one place that touches `$`:
// the engine modules beside it are pure and decide; this file observes the
// session's events, applies what they decide, and draws the pane.
//
//   prompt.submit   classify the prompt locally (no model call), plan a route
//   turn.start      bind the plan to the turn
//   turn.step       send the routed model and effort; record what the API says answered
//   agent.spawn     pick a subagent's model, cap parallel agents
//   tool.call       the pause gate; activity; failure counting and escalation
//   tool.check      observe permission asks; never approves anything
//   session.measure context, plan windows and cost, as the engine reports them
//   ui.render       the dashboard pane        ui.press   its buttons
//
// Failure rule: a hook that fails must leave the session exactly as it would
// be with no router. Every hook passes the event on unchanged when its own
// work throws, and the gating ones carry a `.catch` that does the same.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  ActivityEvent,
  AgentRec,
  Alias,
  Classification,
  ConfigPatch,
  CoreState,
  Decision,
  Effort,
  EventKind,
  EventStatus,
  Risk,
  RouteState,
  RouterConfig,
  ToolCategory,
  UsageHistory,
  UsageState,
  ViewName,
  ViewState,
} from '../types'
import { AGENT_DEFS, agentKeyOf } from './engine/agents.ts'
import { classify } from './engine/classify.ts'
import {
  applyPatches,
  defaultConfig,
  describeChanges,
  isSensitivePath,
  parseConfig,
  parseRequest,
  schemaText,
  serializeConfig,
} from './engine/config.ts'
import {
  AGENT_HISTORY,
  ALIASES,
  FEED_SIZE,
  MIN_ENGINE_FOR_MAIN_MODEL,
  PAUSED_DENY,
  RISKS,
  TITLE,
} from './engine/consts.ts'
import { classifyFailure, destructiveMatch } from './engine/guard.ts'
import { JUDGE_SYSTEM, REPLY_CHARS, judgePrompt, mergeJudge, parseJudge, shouldJudge, shouldJudgeSubagent } from './engine/judge.ts'
import type { Judged } from './engine/judge.ts'
import { emptyLearning, kindOf, parseLearning, recordMiss, recordOutcome, shouldStartHigher } from './engine/learn.ts'
import {
  aliasOf,
  aliasRank,
  applyMiss,
  keepStronger,
  decideMain,
  decideSubagent,
  effortRank,
  escalate,
  isEffort,
  isVersionAtLeast,
} from './engine/route.ts'
import type { Availability } from './engine/route.ts'
import { clip, redact, safeTitle, toolCategory, toolLabel } from './engine/sanitize.ts'
import { agentsText, configText, helpText, statusText, usageText } from './engine/text.ts'
import { aggregate, aggregateDays, contextOf, emptyUsage, mergeHistory, parseHistory, recordUsage, zero } from './engine/usage.ts'
import type { ReportedUsage } from './engine/usage.ts'
import { renderPane } from './ui/pane.tsx'

const PANE_ID = 'auto-router'
const BACKUP_SLOTS = 10

// ------------------------------------------------------------- state

function initialCore(): CoreState {
  return {
    paused: false,
    blockedCount: 0,
    pins: {},
    session: {
      turns: 0,
      warm: {},
      contextTokens: 0,
      ultracode: false,
      perMessageEffort: false,
      engine: '',
    },
    unavailable: {},
    risk: 'low',
    escalation: 'none',
    note: '',
    conflicts: [],
    seq: 0,
  }
}

function initialView(): ViewState {
  return { view: 'home', filter: 'all', page: 0 }
}

// Bump a tag when the shape of its value changes: a value an earlier build
// stored under another tag then reads as absent instead of as garbage.
const coreAtom = atom({ plugin: 'auto-router', key: 'core' } as const, initialCore(), { shape: 'core-1' })
const viewAtom = atom({ plugin: 'auto-router', key: 'view' } as const, initialView(), { shape: 'view-1' })
const agentsAtom = atom({ plugin: 'auto-router', key: 'agents' } as const, [], { shape: 'agents-1' })
const feedAtom = atom({ plugin: 'auto-router', key: 'feed' } as const, [], { shape: 'feed-1' })
const logAtom = atom({ plugin: 'auto-router', key: 'log' } as const, [], { shape: 'log-1' })
const usageAtom = atom({ plugin: 'auto-router', key: 'usage' } as const, emptyUsage(), { shape: 'usage-1' })

type AtomKey = 'core' | 'view' | 'agents' | 'feed' | 'log' | 'usage'

type Lane = {
  substantive: number
  signatures: Record<string, number>
  escalations: number
  alias?: Alias
  effort?: Effort
  isEnvironmentNoted: boolean
  isTopNoted: boolean
}

type Pending = {
  decision: Decision
  title: string
  at: number
  isContinuation: boolean
  hasUltrathink: boolean
  /** Set when the person said the last answer missed: what the task moved up to. */
  miss?: string
}

/** How long a plan or a slash command waits for its turn before it is stale. */
const PENDING_MS = 600_000

type TurnState = {
  id: string
  startedAt: number
  steps: number
  engineModel?: string
  engineEffort?: string
  isEngineSwitched: boolean
  hasUltrathink: boolean
  failedModel?: string
  mutations: number
  /** A slash command's turn: the session's own model and effort stand. */
  isUnrouted: boolean
}

type StepPlan = { lane: 'main' | 'agent' | 'other'; model?: string; effort?: Effort; agent?: AgentRec }

// The working copy. Changes are made here, synchronously, and written to
// `$.state` by `flush`, one writer at a time, so two hooks running at once
// cannot lose each other's update. A reload loses this object and `hydrate`
// rebuilds it from `$.state`.
const rt = {
  isLoaded: false,
  loading: undefined as Promise<void> | undefined,
  sid: '',
  root: '',
  dir: '',
  claudeDir: '',
  engine: '',
  isWin: false,
  cfg: defaultConfig(),
  cfgText: '',
  cfgMtime: -1,
  lastGoodText: '',
  core: initialCore(),
  view: initialView(),
  agents: [] as AgentRec[],
  log: [] as ActivityEvent[],
  usage: emptyUsage(),
  seq: 0,
  unflushed: 0,
  pending: undefined as Pending | undefined,
  command: undefined as { name: string; at: number } | undefined,
  turn: undefined as TurnState | undefined,
  lanes: new Map<string, Lane>(),
  openTools: new Map<string, ActivityEvent>(),
  agentById: new Map<string, AgentRec>(),
  agentTurn: new Map<string, string>(),
  reserved: 0,
  isPanelHidden: false,
  isSetUp: false,
  isPanePlaced: false,
  isWorkflowSeen: false,
  learning: emptyLearning(),
  kind: undefined as { kind: string; alias: Alias } | undefined,
  kindEscalations: 0,
  isLearningDirty: false,
  allowed: undefined as string[] | undefined,
  denied: undefined as string[] | undefined,
}

const dirty = new Set<AtomKey>()
let writes: Promise<void> = Promise.resolve()

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function slashed(path: string): string {
  return path.replace(/\\/g, '/')
}

function backslashed(path: string): string {
  return path.replace(/\//g, '\\')
}

function nothing(): undefined {
  return undefined
}

function mark(...keys: AtomKey[]): void {
  for (const key of keys) dirty.add(key)
}

async function writeAtom($: EngineInterface, key: AtomKey): Promise<void> {
  switch (key) {
    case 'core': {
      const value = clone({ ...rt.core, seq: rt.seq })
      await update($, coreAtom, () => value)
      return
    }
    case 'view': {
      const value = clone(rt.view)
      await update($, viewAtom, () => value)
      return
    }
    case 'agents': {
      const value = clone(rt.agents)
      await update($, agentsAtom, () => value)
      return
    }
    case 'feed': {
      const value = clone(rt.log.slice(-FEED_SIZE))
      await update($, feedAtom, () => value)
      return
    }
    case 'log': {
      const value = clone(rt.log)
      rt.unflushed = 0
      await update($, logAtom, () => value)
      return
    }
    default: {
      const value = clone(rt.usage)
      await update($, usageAtom, () => value)
    }
  }
}

/** Writes what changed to `$.state`. One run at a time: a later call waits and writes whatever is dirty by then. */
function flush($: EngineInterface): Promise<void> {
  const run = async (): Promise<void> => {
    const keys = [...dirty]
    dirty.clear()
    for (const key of keys) {
      try {
        await writeAtom($, key)
      } catch {
        // The pane lags a beat; routing goes on.
      }
    }
  }
  writes = writes.then(run, run)
  return writes
}

// -------------------------------------------------------------- paths

function configPath(): string {
  return `${rt.dir}/config.json`
}

function schemaPath(): string {
  return `${rt.dir}/config.schema.json`
}

function lastGoodPath(): string {
  return `${rt.dir}/config.last-good.json`
}

function historyPath(): string {
  return `${rt.dir}/usage-history.json`
}

function learningPath(): string {
  return `${rt.dir}/learning.json`
}

function healthPath(): string {
  return `${rt.dir}/logs/router.log`
}

// ------------------------------------------------------------ routing

/** Why the router only observes in this session, or undefined when it may act. */
function passiveReason(): string | undefined {
  if (rt.sid !== '' && rt.root.includes(`/dev-mods/${rt.sid}/`)) {
    return 'development copy in the session that wrote it'
  }
  if (rt.sid !== '' && rt.cfg.sessions.protected.includes(rt.sid)) return 'protected session'
  return undefined
}

function isActive(): boolean {
  return rt.cfg.enabled && rt.core.session.passive === undefined
}

function canApply(): boolean {
  return isActive() && rt.cfg.autonomous
}

function canRouteMainModel(): boolean {
  return canApply() && rt.cfg.routing.mainSession.routeModel && isVersionAtLeast(rt.engine, MIN_ENGINE_FOR_MAIN_MODEL)
}

function canRouteMainEffort(): boolean {
  return canApply() && rt.cfg.routing.mainSession.routeEffort
}

function availability(now: number): Availability {
  return { now, unavailable: rt.core.unavailable, allowed: rt.allowed, denied: rt.denied }
}

function isUltracode(): boolean {
  const base = rt.core.session.baseEffort
  return rt.core.session.ultracode || rt.isWorkflowSeen || base === 'xhigh' || base === 'max'
}

function riskMax(a: Risk, b: Risk): Risk {
  return RISKS.indexOf(a) >= RISKS.indexOf(b) ? a : b
}

/** The current route as a decision, so a short follow-up can keep it. */
function decisionOf(route: RouteState): Decision {
  return {
    tier: route.tier,
    agent: route.agent,
    targetAlias: route.targetAlias,
    targetEffort: route.targetEffort,
    alias: route.alias,
    effort: route.effort,
    modelAction: 'keep',
    effortAction: 'keep',
    usedFallback: route.usedFallback,
    floors: route.floors,
    reasons: [],
    explanation: route.explanation,
    complexity: route.complexity,
    risk: route.risk,
    ambiguity: route.ambiguity,
    domains: route.domains,
    confidence: route.confidence,
    reviewRequired: route.reviewRequired,
    delegation: { suggested: false, agents: [], parallel: 1, reason: '' },
  }
}

function laneOf(key: string): Lane {
  let lane = rt.lanes.get(key)
  if (lane === undefined) {
    lane = { substantive: 0, signatures: {}, escalations: 0, isEnvironmentNoted: false, isTopNoted: false }
    rt.lanes.set(key, lane)
  }
  return lane
}

// -------------------------------------------------------------- events

function pushEvent(
  now: number,
  kind: EventKind,
  status: EventStatus,
  label: string,
  more: Partial<Pick<ActivityEvent, 'cat' | 'tool' | 'turnId' | 'agentId' | 'toolUseId' | 'ms'>> = {},
): ActivityEvent | undefined {
  if (!rt.cfg.telemetry.enabled) return undefined
  rt.seq += 1
  const safe = rt.cfg.telemetry.redactSecrets ? redact(label) : label
  const event: ActivityEvent = { id: rt.seq, t: now, kind, status, label: clip(safe, 140), sessionId: rt.sid, ...more }
  rt.log.push(event)
  const over = rt.log.length - rt.cfg.telemetry.maxEvents
  if (over > 0) rt.log.splice(0, over)
  rt.unflushed += 1
  mark('feed')
  if (rt.unflushed >= 25) mark('log')
  return event
}

function setNote(text: string): void {
  rt.core.note = clip(text, 200)
  mark('core')
}

// --------------------------------------------------------------- files

async function mtimeOf($: EngineInterface, path: string): Promise<number> {
  try {
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return -1
  }
}

/**
 * Replaces a file in one step: the new text goes to a sibling temp file and
 * is renamed over the old one, so a reader sees the old file or the new one,
 * never half of each. Where the rename cannot run, the file is written in
 * place and the caller's read-back check stands guard.
 */
async function writeAtomic($: EngineInterface, path: string, text: string): Promise<void> {
  const temp = `${path}.tmp`
  await $.fs.write(temp, text)
  let isMoved = false
  try {
    const argv = rt.isWin
      ? ['cmd.exe', '/d', '/c', 'move', '/y', backslashed(temp), backslashed(path)]
      : ['mv', '-f', temp, path]
    const done = await $.process.run(argv, { timeoutMs: 10_000 })
    isMoved = done.exitCode === 0
  } catch {
    isMoved = false
  }
  if (!isMoved) await $.fs.write(path, text)
}

/** Appends one line to the health log: lifecycle facts only, last 200 lines kept. */
async function health($: EngineInterface, text: string): Promise<void> {
  try {
    const now = await $.clock.now()
    const path = healthPath()
    let before = ''
    try {
      if (await $.fs.exists(path)) before = String(await $.fs.read(path))
    } catch {
      before = ''
    }
    const lines = before.split('\n').filter(line => line !== '').slice(-199)
    lines.push(`${new Date(now).toISOString()} [${rt.sid.slice(0, 8)}] ${clip(redact(text), 300)}`)
    await $.fs.write(path, `${lines.join('\n')}\n`)
  } catch {
    // A log line is never worth failing a hook for.
  }
}

/**
 * Reads config.json. A valid file becomes the configuration and the
 * last-known-good copy; an invalid one is reported and the last valid
 * configuration stays in force. A missing file is created from the defaults.
 */
async function loadConfig($: EngineInterface, canWrite: boolean): Promise<void> {
  const file = configPath()
  let text: string | undefined
  try {
    text = (await $.fs.exists(file)) ? String(await $.fs.read(file)) : undefined
  } catch {
    text = undefined
  }
  if (text === undefined) {
    rt.cfg = defaultConfig()
    rt.cfgText = serializeConfig(rt.cfg)
    rt.core.configError = undefined
    if (canWrite) {
      try {
        await $.fs.write(file, rt.cfgText)
        await $.fs.write(schemaPath(), schemaText())
      } catch {
        rt.core.configError = 'config.json could not be written'
      }
    }
  } else {
    const parsed = parseConfig(text)
    if (parsed.isValid) {
      rt.cfg = parsed.config
      rt.cfgText = text
      rt.core.configError = undefined
      if (canWrite && rt.lastGoodText !== text) {
        try {
          await $.fs.write(lastGoodPath(), text)
          rt.lastGoodText = text
          // A schema an earlier build wrote does not know this build's settings: replace it.
          const schema = schemaText()
          const onDisk = (await $.fs.exists(schemaPath())) ? String(await $.fs.read(schemaPath())) : undefined
          if (onDisk !== schema) await $.fs.write(schemaPath(), schema)
        } catch {
          // The copy is a convenience; the configuration itself is loaded.
        }
      }
    } else {
      rt.core.configError = clip(parsed.errors.slice(0, 3).join('; '), 240)
      try {
        const good = parseConfig(String(await $.fs.read(lastGoodPath())))
        rt.cfg = good.isValid ? good.config : defaultConfig()
      } catch {
        rt.cfg = defaultConfig()
      }
    }
  }
  rt.cfgMtime = await mtimeOf($, file)
  rt.core.session.passive = passiveReason()
  mark('core')
}

async function backupConfig($: EngineInterface, previous: string, reason: string, now: number): Promise<void> {
  const index = `${rt.dir}/backups/index.json`
  let next = 0
  let entries: Record<string, { savedAt: string; reason: string }> = {}
  try {
    const raw: unknown = JSON.parse(String(await $.fs.read(index)))
    if (isRecord(raw)) {
      if (typeof raw.next === 'number' && Number.isInteger(raw.next)) next = ((raw.next % BACKUP_SLOTS) + BACKUP_SLOTS) % BACKUP_SLOTS
      if (isRecord(raw.entries)) entries = raw.entries as Record<string, { savedAt: string; reason: string }>
    }
  } catch {
    next = 0
  }
  await $.fs.write(`${rt.dir}/backups/config.${next}.json`, previous)
  entries[String(next)] = { savedAt: new Date(now).toISOString(), reason: clip(reason, 120) }
  await $.fs.write(index, `${JSON.stringify({ next: (next + 1) % BACKUP_SLOTS, slots: BACKUP_SLOTS, entries }, null, 2)}\n`)
}

type Saved = { isSaved: true; summary: string } | { isSaved: false; errors: string[] }

/**
 * Changes the configuration: reads the file fresh (another session may have
 * changed it), applies the patches to those paths only, validates the whole
 * result, backs the previous file up, replaces it in one step, reads it back,
 * and only then takes it into use. Any failure leaves the old file in force.
 */
async function saveConfig($: EngineInterface, patches: readonly ConfigPatch[], reason: string): Promise<Saved> {
  const file = configPath()
  const now = await $.clock.now()
  let base: RouterConfig = rt.cfg
  let previous = rt.cfgText === '' ? serializeConfig(rt.cfg) : rt.cfgText
  try {
    if (await $.fs.exists(file)) {
      const onDisk = String(await $.fs.read(file))
      const parsed = parseConfig(onDisk)
      previous = onDisk
      if (parsed.isValid) base = parsed.config
    }
  } catch {
    base = rt.cfg
  }
  const result = applyPatches(base, patches)
  if (!result.isValid) return { isSaved: false, errors: result.errors }
  if (result.changes.length === 0) return { isSaved: true, summary: 'no setting changed' }
  const text = serializeConfig(result.config)
  try {
    await backupConfig($, previous, reason, now)
    await writeAtomic($, file, text)
    const back = String(await $.fs.read(file))
    if (back !== text) {
      await $.fs.write(file, previous)
      return { isSaved: false, errors: ['the file did not read back as written; the previous configuration was restored'] }
    }
  } catch {
    return { isSaved: false, errors: ['config.json could not be written; nothing was changed'] }
  }
  rt.cfg = result.config
  rt.cfgText = text
  rt.core.configError = undefined
  rt.core.session.passive = passiveReason()
  rt.cfgMtime = await mtimeOf($, file)
  try {
    await $.fs.write(lastGoodPath(), text)
    rt.lastGoodText = text
  } catch {
    // The live file is right; the spare copy can wait for the next load.
  }
  const summary = describeChanges(result.changes)
  pushEvent(now, 'config', 'OK', `config: ${summary}`)
  mark('core')
  return { isSaved: true, summary }
}

/** Picks up a hand edit of config.json: one stat per prompt, a read only when the file moved. */
async function reloadIfChanged($: EngineInterface): Promise<void> {
  const mtime = await mtimeOf($, configPath())
  if (mtime === rt.cfgMtime) return
  await loadConfig($, true)
  const now = await $.clock.now()
  pushEvent(now, 'config', rt.core.configError === undefined ? 'OK' : 'ERR', rt.core.configError === undefined ? 'config.json reloaded' : `config.json rejected: ${rt.core.configError}`)
}

async function readHistory($: EngineInterface): Promise<{ history: UsageHistory | undefined; isUnreadable: boolean }> {
  const file = historyPath()
  try {
    if (!(await $.fs.exists(file))) return { history: undefined, isUnreadable: false }
    const parsed = parseHistory(String(await $.fs.read(file)))
    return { history: parsed, isUnreadable: parsed === undefined }
  } catch {
    return { history: undefined, isUnreadable: true }
  }
}

/** Writes this session's running totals into usage-history.json, at most once a minute unless forced. */
async function flushHistory($: EngineInterface, now: number, isForced: boolean): Promise<void> {
  if (!rt.cfg.telemetry.enabled || Object.keys(rt.usage.days).length === 0) return
  if (!isForced && rt.usage.lastFlushAt !== undefined && now - rt.usage.lastFlushAt < 60_000) return
  try {
    const found = await readHistory($)
    if (found.isUnreadable) {
      rt.usage.flushError = 'usage-history.json is unreadable and was left untouched'
    } else {
      const merged = mergeHistory(found.history, rt.sid === '' ? 'unknown' : rt.sid, rt.usage, now, rt.cfg.telemetry.historyDays, rt.usage.rateLimits)
      await writeAtomic($, historyPath(), `${JSON.stringify(merged)}\n`)
      const week = aggregate(merged, now, 7)
      rt.usage.weekly = { days: 7, byModel: week.byModel, sessions: week.sessions, computedAt: now }
      rt.usage.series = { days: aggregateDays(merged, now, 30), computedAt: now }
      rt.usage.flushError = undefined
    }
    rt.usage.lastFlushAt = now
  } catch {
    rt.usage.flushError = 'usage-history.json could not be written'
  }
  mark('usage')
}

async function refreshWeekly($: EngineInterface, now: number): Promise<void> {
  const found = await readHistory($)
  if (found.isUnreadable) {
    rt.usage.flushError = 'usage-history.json is unreadable'
    return
  }
  const merged = mergeHistory(found.history, rt.sid === '' ? 'unknown' : rt.sid, rt.usage, now, rt.cfg.telemetry.historyDays)
  const week = aggregate(merged, now, 7)
  rt.usage.weekly = { days: 7, byModel: week.byModel, sessions: week.sessions, computedAt: now }
  rt.usage.series = { days: aggregateDays(merged, now, 30), computedAt: now }
  mark('usage')
}

// ------------------------------------------------------------- hydrate

async function readSettings($: EngineInterface): Promise<void> {
  try {
    const settings = await $.settings.read()
    rt.core.session.ultracode = settings.ultracode === true
    const strings = (value: unknown): string[] | undefined =>
      Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : undefined
    rt.allowed = strings(settings.availableModels)
    rt.denied = strings(settings.deniedModels)
  } catch {
    // No settings read: nothing is assumed restricted.
  }
}

/** Other mods that also set a model or an effort, by the key of their /mods switch. */
const OTHER_ROUTERS: Readonly<Record<string, string>> = {
  'model-router': 'The model-router mod also picks subagent models.',
  'model-selector': 'The model-selector mod also sets the main chat\'s model and effort.',
}

/** Another mod that also routes: said plainly, never switched off silently. */
async function findConflicts($: EngineInterface, pluginDirs: string | undefined): Promise<string[]> {
  // The mod's folder as the last part of one entry; entries are parted by ; on Windows and : elsewhere.
  const dirs = slashed(pluginDirs ?? '')
  const loaded = Object.keys(OTHER_ROUTERS).filter(name => new RegExp(`/${name}/*(?:$|[;:,])`).test(dirs))
  if (loaded.length === 0) return []
  let switches: Record<string, unknown> = {}
  try {
    const file = `${rt.claudeDir}/mods/switches.json`
    if (await $.fs.exists(file)) {
      const parsed: unknown = JSON.parse(String(await $.fs.read(file)))
      if (isRecord(parsed)) switches = parsed
    }
  } catch {
    // Unreadable switch file: assume the other mod is on.
  }
  return loaded
    .filter(name => switches[name] !== false)
    .map(name => `${OTHER_ROUTERS[name] ?? name} Two routers can undo each other: turn one off (Configuration has the switch).`)
}

async function hydrate($: EngineInterface): Promise<void> {
  rt.root = slashed($.plugin.root)
  const os = await $.env.get('OS').catch(nothing)
  const profile = await $.env.get('USERPROFILE').catch(nothing)
  const homeVar = await $.env.get('HOME').catch(nothing)
  const override = await $.env.get('CLAUDE_CONFIG_DIR').catch(nothing)
  const capabilities = await $.env.get('CLAUDE_CODE_MODEL_CAPABILITIES').catch(nothing)
  const pluginDirs = await $.env.get('CLAUDE_CODE_PLUGIN_DIRS').catch(nothing)
  rt.isWin = os === 'Windows_NT' || /^[A-Za-z]:\//.test(rt.root)
  const home = slashed((rt.isWin ? profile ?? homeVar : homeVar ?? profile) ?? '')
  rt.claudeDir = override !== undefined && override !== '' ? slashed(override) : `${home}/.claude`
  rt.dir = `${rt.claudeDir}/auto-router`
  rt.sid = await $.session.id().catch(() => '')
  rt.engine = await $.session
    .version()
    .then(version => version.version)
    .catch(() => '')

  try {
    rt.core = { ...initialCore(), ...clone(await read($, coreAtom)) }
    rt.view = clone(await read($, viewAtom))
    rt.agents = clone(await read($, agentsAtom))
    rt.log = clone(await read($, logAtom))
    const feed = clone(await read($, feedAtom))
    const known = new Set(rt.log.map(event => event.id))
    for (const event of feed) {
      if (!known.has(event.id)) rt.log.push(event)
    }
    rt.log.sort((a, b) => a.id - b.id)
    rt.usage = clone(await read($, usageAtom))
  } catch {
    // Unreadable state: start from the initial values.
  }
  rt.seq = Math.max(rt.core.seq, ...rt.log.map(event => event.id), 0)
  rt.agentById.clear()
  for (const agent of rt.agents) {
    if (agent.agentId !== undefined) rt.agentById.set(agent.agentId, agent)
  }

  await loadConfig($, true)
  try {
    rt.learning = (await $.fs.exists(learningPath())) ? parseLearning(String(await $.fs.read(learningPath()))) : emptyLearning()
  } catch {
    rt.learning = emptyLearning()
  }
  try {
    const panel = await $.store.get('panel')
    rt.isPanelHidden = isRecord(panel) && panel.hiddenByUser === true
  } catch {
    rt.isPanelHidden = false
  }
  await readSettings($)
  rt.core.session.engine = rt.engine
  rt.core.session.perMessageEffort = /per_turn_effort/.test(capabilities ?? '')
  if (rt.core.session.baseModel === undefined) {
    rt.core.session.baseModel = await $.session.model().catch(nothing)
  }
  rt.core.session.passive = passiveReason()
  rt.core.conflicts = await findConflicts($, pluginDirs)
  mark('core')
}

/** Makes the working copy ready. The first hook to run after a load or a `/clear` pays for it; the rest return at once. */
async function ready($: EngineInterface): Promise<void> {
  if (rt.isLoaded) return
  const done = (): void => {
    rt.isLoaded = true
  }
  rt.loading ??= hydrate($).then(done, done)
  await rt.loading
}

const CONFIGURE_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['get', 'request', 'set'] },
    request: { type: 'string', description: 'For "request": the change in the user\'s words, e.g. "switch to economical mode".' },
    changes: {
      type: 'array',
      description: 'For "set": the settings to change.',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, value: {} },
        required: ['path', 'value'],
      },
    },
  },
  required: ['action'],
}

/**
 * Registers the command and the tool and opens the pane, once per load. A
 * session's start does it; where a mod is loaded into a session already
 * running, or a `/clear` moved the process to a new session, the first hook
 * to run does. Each step stands alone: one that fails leaves the others.
 */
async function setup($: EngineInterface, source: string): Promise<void> {
  await ready($)
  if (rt.isSetUp) return
  rt.isSetUp = true
  const steps: string[] = []
  try {
    await $.command.register({
      name: 'auto-router',
      description: 'Auto Router dashboard, status, usage, agents, config, pause and resume',
      argumentHint: '[status|usage|agents|config|pause|resume|clear]',
      immediate: true,
    })
    steps.push('command ok')
  } catch (error) {
    steps.push(`command FAILED (${String((error as Error)?.message ?? error).slice(0, 220)})`)
  }
  try {
    await $.tool.register({
      name: 'configure',
      description:
        'Read or change the Auto Router configuration (model tiers, budget profile, parallel agent limit, reviews, dashboard). Use it when the user asks in words for a router setting to change. action "get" returns the effective configuration; "request" takes the user\'s own sentence; "set" takes exact dotted paths. Changes are validated, backed up and applied atomically; an invalid one is refused with the reason.',
      inputSchema: CONFIGURE_SCHEMA,
    })
    steps.push('tool ok')
  } catch (error) {
    steps.push(`tool FAILED (${String((error as Error)?.message ?? error).slice(0, 220)})`)
  }
  const wantsPane = rt.cfg.sidePanel.enabled && rt.cfg.sidePanel.autoOpen && !rt.isPanelHidden
  const opened = wantsPane ? await openPane($, false) : 'not opened (off, or closed by hand)'
  await health(
    $,
    `ready via ${source} · engine ${rt.engine || 'unknown'} · routing ${isActive() ? 'active' : `passive (${rt.core.session.passive ?? 'off'})`} · ${steps.join(' · ')} · pane: ${opened}`,
  )
}

// ---------------------------------------------------------------- pane

function statusLine(): string {
  const route = rt.core.route
  if (rt.core.paused) return 'Auto Router: paused'
  if (route === undefined) return `Auto Router: ${isActive() ? 'on' : 'observing'}`
  return `Auto Router: ${route.sentModel ?? route.alias ?? 'session model'} / ${route.sentEffort ?? route.effort ?? 'session effort'}`
}

/** Opens the pane without asking for the keyboard. Where no surface can seat it, a status line stands in. */
async function openPane($: EngineInterface, isAsked: boolean): Promise<string> {
  if (!rt.cfg.sidePanel.enabled && !isAsked) return 'the dashboard is turned off in the configuration'
  try {
    const opened = await $.ui.open({ id: PANE_ID, title: TITLE })
    rt.isPanePlaced = opened.isPlaced
    if (opened.isPlaced) {
      $.ui.status(undefined)
      return 'Opened the Auto Router dashboard.'
    }
    $.ui.status(statusLine())
    return `The dashboard is open but not drawn yet (${opened.reason}). A status line stands in until a surface can seat it.`
  } catch {
    rt.isPanePlaced = false
    return 'The dashboard could not be opened here. /auto-router status prints the same facts.'
  }
}

async function rememberHidden($: EngineInterface, isHidden: boolean): Promise<void> {
  rt.isPanelHidden = isHidden
  try {
    await $.store.set('panel', { hiddenByUser: isHidden })
  } catch {
    // The preference is lost with the session; nothing else depends on it.
  }
}

async function setPaused($: EngineInterface, isPaused: boolean, now: number): Promise<string> {
  if (rt.core.paused === isPaused) return isPaused ? 'Already paused.' : 'Not paused.'
  rt.core.paused = isPaused
  if (isPaused) {
    rt.core.pausedAt = now
    rt.core.blockedCount = 0
  }
  pushEvent(now, 'guard', isPaused ? 'BLOCKED' : 'OK', isPaused ? 'paused: new tool calls are blocked' : 'resumed: tool calls run again')
  mark('core', 'log')
  if (!rt.isPanePlaced) $.ui.status(statusLine())
  return isPaused
    ? 'Paused. New tool calls are refused before they run. A command already running is not stopped, and finished work is kept. /auto-router resume continues.'
    : 'Resumed. Tool calls run again.'
}

function clearActivity(now: number): string {
  rt.log = []
  rt.openTools.clear()
  rt.unflushed = 0
  rt.view.page = 0
  pushEvent(now, 'system', 'OK', 'activity cleared')
  mark('feed', 'log', 'view')
  return 'Activity history cleared.'
}

// ------------------------------------------------------------ commands

async function changeFromText($: EngineInterface, request: string, source: string): Promise<string> {
  const understood = parseRequest(request, rt.cfg)
  if (!understood.isUnderstood) return `Not changed: ${understood.reason}`
  const saved = await saveConfig($, understood.patches, `${source}: ${clip(request, 80)}`)
  return saved.isSaved ? `Changed (${understood.summary}): ${saved.summary}` : `Not changed: ${saved.errors.join('; ')}`
}

async function runCommand($: EngineInterface, raw: string): Promise<string> {
  const args = raw.trim()
  const space = args.search(/\s/)
  const word = (space < 0 ? args : args.slice(0, space)).toLowerCase()
  const rest = space < 0 ? '' : args.slice(space + 1).trim()
  const now = await $.clock.now()
  switch (word) {
    case '':
    case 'open':
    case 'dashboard': {
      rt.view = initialView()
      mark('view')
      await rememberHidden($, false)
      return openPane($, true)
    }
    case 'status':
      return statusText(rt.core, rt.cfg)
    case 'usage': {
      await measure($, now)
      await refreshWeekly($, now)
      return usageText(rt.usage)
    }
    case 'agents':
      return agentsText(rt.cfg, rt.agents, now)
    case 'config':
      if (rest === '') return configText(rt.cfg, configPath(), rt.core.configError)
      return changeFromText($, rest, 'command')
    case 'pause':
      return setPaused($, true, now)
    case 'resume':
      return setPaused($, false, now)
    case 'clear':
      return clearActivity(now)
    case 'on':
    case 'off': {
      const saved = await saveConfig($, [{ path: 'enabled', value: word === 'on' }], `command: ${word}`)
      if (word === 'on') rt.core.pins = {}
      mark('core')
      return saved.isSaved ? `Routing is ${word}.` : `Not changed: ${saved.errors.join('; ')}`
    }
    case 'reload':
      await loadConfig($, true)
      return rt.core.configError === undefined ? 'Configuration reloaded and valid.' : `Configuration rejected: ${rt.core.configError}. The last valid configuration is in use.`
    case 'help':
      return helpText()
    default:
      return changeFromText($, args, 'command')
  }
}

// ------------------------------------------------------------- presses

const BUDGETS = ['economical', 'balanced', 'quality'] as const

function nextOf<T>(order: readonly T[], current: T): T {
  const index = order.indexOf(current)
  return order[(index + 1) % order.length] ?? current
}

async function toggle($: EngineInterface, path: string, current: boolean, label: string): Promise<void> {
  const saved = await saveConfig($, [{ path, value: !current }], `pane: ${label}`)
  setNote(saved.isSaved ? `${label}: ${!current ? 'on' : 'off'}.` : `Not changed: ${saved.errors.join('; ')}`)
}

function show(view: ViewName): void {
  rt.view = { ...rt.view, view, page: 0 }
  rt.core.note = ''
  mark('view', 'core')
  if (view === 'activity' || view === 'guardrails') mark('log')
}

async function openFile($: EngineInterface, path: string): Promise<boolean> {
  try {
    const argv = rt.isWin
      ? ['cmd.exe', '/d', '/c', 'start', '', backslashed(path)]
      : [rt.root.startsWith('/Users/') || rt.claudeDir.startsWith('/Users/') ? 'open' : 'xdg-open', path]
    const done = await $.process.run(argv, { timeoutMs: 8000 })
    return done.exitCode === 0
  } catch {
    return false
  }
}

async function handlePress($: EngineInterface, element: string): Promise<void> {
  const now = await $.clock.now()
  const c = rt.cfg
  if (element.startsWith('ar-tier-') || element.startsWith('ar-fb-')) {
    const isModel = element.startsWith('ar-tier-')
    const key = agentKeyOf(AGENT_DEFS[element.slice(isModel ? 8 : 6) as keyof typeof AGENT_DEFS]?.name ?? '')
    if (key === undefined) return
    const tier = c.tiers[key]
    let model = tier.model
    let fallback = tier.fallback
    if (isModel) {
      const previous = model
      model = nextOf(ALIASES, model)
      if (fallback === model) fallback = previous
    } else {
      const choices: (Alias | undefined)[] = [undefined, ...ALIASES.filter(alias => alias !== model)]
      fallback = nextOf(choices, fallback)
    }
    const value = fallback === undefined ? { model } : { model, fallback }
    const saved = await saveConfig($, [{ path: `tiers.${key}`, value }], `pane: ${AGENT_DEFS[key].title}`)
    setNote(saved.isSaved ? `${AGENT_DEFS[key].title}: ${model}${fallback === undefined ? '' : `, fallback ${fallback}`}.` : `Not changed: ${saved.errors.join('; ')}`)
    return
  }
  if (element.startsWith('ar-f-')) {
    const filter = element.slice(5)
    if (filter === 'all' || filter === 'tools' || filter === 'agents' || filter === 'routing' || filter === 'errors') {
      rt.view = { ...rt.view, filter, page: 0 }
      mark('view')
    }
    return
  }
  switch (element) {
    case 'ar-back':
      show('home')
      return
    case 'ar-settings':
      show('settings')
      return
    case 'ar-agents':
      show('agents')
      return
    case 'ar-agents-config':
      show('agents-config')
      return
    case 'ar-activity':
      show('activity')
      return
    case 'ar-usage':
      await measure($, now)
      await refreshWeekly($, now)
      show('usage')
      return
    case 'ar-guard':
      show('guardrails')
      return
    case 'ar-config':
      show('config')
      return
    case 'ar-older':
      rt.view = { ...rt.view, page: rt.view.page + 1 }
      mark('view', 'log')
      return
    case 'ar-newer':
      rt.view = { ...rt.view, page: Math.max(0, rt.view.page - 1) }
      mark('view')
      return
    case 'ar-on':
    case 'ar-off': {
      const isOn = element === 'ar-on'
      const saved = await saveConfig($, [{ path: 'enabled', value: isOn }], `pane: turn ${isOn ? 'on' : 'off'}`)
      if (isOn) rt.core.pins = {}
      setNote(saved.isSaved ? `Routing is ${isOn ? 'on' : 'off'}.` : `Not changed: ${saved.errors.join('; ')}`)
      return
    }
    case 'ar-unpin':
      rt.core.pins = {}
      setNote('Pins cleared: the router chooses again.')
      return
    case 'ar-pause':
      setNote(await setPaused($, true, now))
      return
    case 'ar-resume':
      setNote(await setPaused($, false, now))
      return
    case 'ar-clear':
      setNote(clearActivity(now))
      return
    case 'ar-budget': {
      const mode = nextOf(BUDGETS, c.budgetMode)
      const saved = await saveConfig($, [{ path: 'budgetMode', value: mode }], 'pane: budget profile')
      setNote(saved.isSaved ? `Budget profile: ${mode}.` : `Not changed: ${saved.errors.join('; ')}`)
      return
    }
    case 'ar-auto':
      await toggle($, 'autonomous', c.autonomous, 'Apply decisions')
      return
    case 'ar-mainmodel':
      await toggle($, 'routing.mainSession.routeModel', c.routing.mainSession.routeModel, 'Main session model routing')
      return
    case 'ar-maineffort':
      await toggle($, 'routing.mainSession.routeEffort', c.routing.mainSession.routeEffort, 'Main session effort routing')
      return
    case 'ar-cache':
      await toggle($, 'routing.mainSession.cacheAware', c.routing.mainSession.cacheAware, 'Cache-aware switching')
      return
    case 'ar-pins':
      await toggle($, 'guardrails.respectUserPins', c.guardrails.respectUserPins, 'Keep mid-session picks')
      return
    case 'ar-panel':
      await toggle($, 'sidePanel.enabled', c.sidePanel.enabled, 'Dashboard')
      return
    case 'ar-autoopen':
      await toggle($, 'sidePanel.autoOpen', c.sidePanel.autoOpen, 'Open at session start')
      return
    case 'ar-telemetry':
      await toggle($, 'telemetry.enabled', c.telemetry.enabled, 'Activity and usage')
      return
    case 'ar-preview':
      await toggle($, 'telemetry.promptPreview', c.telemetry.promptPreview, 'Task titles')
      return
    case 'ar-submodel':
      await toggle($, 'routing.subagents.routeModel', c.routing.subagents.routeModel, 'Subagent model routing')
      return
    case 'ar-subeffort':
      await toggle($, 'routing.subagents.routeEffort', c.routing.subagents.routeEffort, 'Subagent effort routing')
      return
    case 'ar-destructive':
      await toggle($, 'guardrails.confirmDestructive', c.guardrails.confirmDestructive, 'Extra confirm for destructive commands')
      return
    case 'ar-review': {
      const isOn = c.guardrails.independentReview && c.guardrails.reviewMode !== 'off'
      const saved = await saveConfig(
        $,
        [
          { path: 'guardrails.independentReview', value: !isOn },
          { path: 'guardrails.reviewMode', value: isOn ? 'off' : 'remind' },
        ],
        'pane: independent review',
      )
      setNote(saved.isSaved ? `Independent review: ${isOn ? 'off' : 'on'}.` : `Not changed: ${saved.errors.join('; ')}`)
      return
    }
    case 'ar-par': {
      const max = c.guardrails.maxParallelAgents === 1 ? 2 : 1
      const patches: ConfigPatch[] = [{ path: 'guardrails.maxParallelAgents', value: max }]
      if (c.guardrails.defaultParallelAgents > max) patches.push({ path: 'guardrails.defaultParallelAgents', value: max })
      const saved = await saveConfig($, patches, 'pane: parallel agents')
      setNote(saved.isSaved ? `Parallel agents: at most ${max}.` : `Not changed: ${saved.errors.join('; ')}`)
      return
    }
    case 'ar-defpar': {
      const wanted = c.guardrails.defaultParallelAgents === 1 ? 2 : 1
      const saved = await saveConfig($, [{ path: 'guardrails.defaultParallelAgents', value: wanted }], 'pane: default parallel agents')
      setNote(saved.isSaved ? `Default parallel agents: ${wanted}.` : `Not changed: ${saved.errors.join('; ')}`)
      return
    }
    case 'ar-reload':
      await loadConfig($, true)
      setNote(rt.core.configError === undefined ? 'Configuration reloaded and valid.' : `Rejected: ${rt.core.configError}`)
      return
    case 'ar-reopen':
      await rememberHidden($, false)
      setNote(await openPane($, true))
      return
    case 'ar-openfile':
      setNote((await openFile($, configPath())) ? 'Opened config.json in your editor.' : `Could not open an editor. The file is ${configPath()}`)
      return
    case 'ar-refresh-usage':
      await measure($, now)
      await refreshWeekly($, now)
      setNote('Usage read again.')
      return
    case 'ar-fix-conflict': {
      const switches = `${rt.claudeDir}/mods/switches.json`
      try {
        let json: Record<string, unknown> = {}
        if (await $.fs.exists(switches)) {
          const parsed: unknown = JSON.parse(String(await $.fs.read(switches)))
          if (isRecord(parsed)) json = parsed
        }
        for (const name of Object.keys(OTHER_ROUTERS)) json[name] = false
        await $.fs.write(switches, `${JSON.stringify(json, null, 2)}\n`)
        rt.core.conflicts = []
        setNote('The other routing mods are off in every chat within a few seconds. Their own /mods switch turns them back on.')
      } catch {
        setNote('Could not write ~/.claude/mods/switches.json.')
      }
      return
    }
    default:
  }
}

// ---------------------------------------------------------- measurement

/** The context window, the plan's rate-limit windows and the session's cost, exactly as the engine has them. */
async function measure($: EngineInterface, now: number): Promise<void> {
  try {
    const usage = await $.session.usage()
    rt.usage.context = { window: usage.context.window, tokens: usage.context.tokens, percent: usage.context.percent }
    rt.usage.rateLimits = usage.rateLimits.map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed, resetsAt: limit.resetsAt }))
    rt.usage.costUsd = usage.cost?.usd
    rt.usage.measuredAt = now
    rt.usage.startedAt ??= usage.startedAt
    mark('usage')
  } catch {
    // No reading: the pane says Unavailable.
  }
}

// ------------------------------------------------------- turn handling

function routeFrom(decision: Decision, title: string, now: number, turnId: string | undefined): RouteState {
  return {
    turnId,
    title,
    startedAt: now,
    tier: decision.tier,
    agent: decision.agent,
    targetAlias: decision.targetAlias,
    targetEffort: decision.targetEffort,
    alias: decision.alias,
    effort: decision.effort,
    modelAction: decision.modelAction,
    effortAction: decision.effortAction,
    explanation: decision.explanation,
    floors: decision.floors,
    complexity: decision.complexity,
    risk: decision.risk,
    ambiguity: decision.ambiguity,
    domains: decision.domains,
    confidence: decision.confidence,
    reviewRequired: decision.reviewRequired,
    review: decision.reviewRequired ? 'required' : 'none',
    delegation: decision.delegation.suggested ? `${decision.delegation.agents.map(key => AGENT_DEFS[key].name).join(', ')} x${decision.delegation.parallel}` : undefined,
    status: 'pending',
    usedFallback: decision.usedFallback,
    escalations: 0,
    steps: 0,
  }
}

/**
 * Asks the judge model what the task means. One short request; any failure,
 * refusal or timeout answers undefined and the local rules stand.
 */
async function askJudge($: EngineInterface, text: string, now: number, previousReply?: string): Promise<Judged | undefined> {
  try {
    const reply = await $.model.complete({
      model: rt.cfg.judge.model,
      system: JUDGE_SYSTEM,
      prompt: judgePrompt(text, previousReply),
      maxTokens: 200,
      effort: 'low',
      timeoutMs: rt.cfg.judge.timeoutMs,
    })
    if (!reply.isAnswered) return undefined
    if (rt.cfg.telemetry.enabled) {
      recordUsage(rt.usage, 'router judge', { ...reply.usage, model: `judge (${rt.cfg.judge.model})` }, now, null)
      mark('usage')
    }
    return parseJudge(reply.text)
  } catch {
    return undefined
  }
}

/**
 * The start of the assistant's last answer, for the judge: with it "that is
 * wrong" and "now the other one" can be read for what they mean. Credentials
 * are masked; with no answer yet, or none readable, the judge reads the
 * prompt alone.
 */
async function lastReply($: EngineInterface): Promise<string | undefined> {
  try {
    const messages = await $.session.messages()
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message !== undefined && message.role === 'assistant' && message.text.trim() !== '') {
        return redact(message.text.trim().slice(0, REPLY_CHARS))
      }
    }
  } catch {
    // No transcript to read here.
  }
  return undefined
}

async function saveLearning($: EngineInterface): Promise<void> {
  try {
    await writeAtomic($, learningPath(), `${JSON.stringify(rt.learning)}\n`)
  } catch {
    // What was learned stays in memory for this session.
  }
}

function planMain(read: Classification, text: string, now: number, isMidTurn: boolean): Pending {
  const s = rt.core.session
  const before = rt.core.route
  // A complaint about the last answer is the same task going on, one step up: never a new, cheaper one.
  const isMiss = read.miss && before !== undefined && canApply()
  const cls = isMiss ? { ...read, continuation: true } : read
  const kind = kindOf(cls.complexity, cls.domains)
  const previous = before === undefined ? undefined : decisionOf(before)
  let decision = decideMain(cls, rt.cfg, {
    now,
    isFirstTurn: s.lastRequestAt === undefined,
    isMidTurn,
    currentAlias: s.lastAlias ?? aliasOf(s.baseModel),
    currentEffort: s.lastEffort ?? (isEffort(s.baseEffort) ? s.baseEffort : undefined),
    engineEffort: isEffort(s.baseEffort) ? s.baseEffort : undefined,
    contextTokens: s.contextTokens,
    warm: s.warm,
    hasPerMessageEffort: s.perMessageEffort,
    isUltracode: isUltracode(),
    pins: rt.core.pins,
    availability: availability(now),
    canRouteModel: canRouteMainModel(),
    canRouteEffort: canRouteMainEffort(),
    previous,
    shouldStartHigher: alias => shouldStartHigher(rt.learning, kind, alias, ALIASES, rt.cfg),
  })
  const isContinuation = cls.continuation && before !== undefined
  let miss: string | undefined
  if (isMiss && before !== undefined) {
    const stepped = applyMiss(decision, rt.cfg, {
      misses: (before.misses ?? 0) + 1,
      held: { alias: before.alias, effort: before.effort },
      availability: availability(now),
    })
    decision = stepped.decision
    miss = stepped.note
    // What was counted as a fine run when its turn ended was not one.
    if (rt.kind !== undefined) {
      recordMiss(rt.learning, rt.kind.kind, now, rt.kind.alias, rt.cfg)
      rt.isLearningDirty = true
    }
  }
  if (!isContinuation) {
    rt.kind = { kind, alias: decision.alias ?? decision.targetAlias }
    rt.kindEscalations = 0
  }
  const title = isContinuation && before !== undefined
    ? before.title
    : safeTitle(text, rt.cfg.telemetry.promptPreview, rt.cfg.telemetry.redactSecrets)
  return { decision, title, at: now, isContinuation, hasUltrathink: cls.explicit.ultrathink === true, miss }
}

/** What the model is told beside the prompt: nothing for small work, one short block where delegation or review is due. */
function hintsFor(decision: Decision): string[] {
  if (!canApply()) return []
  const parts: string[] = []
  const isSubstantial = decision.complexity !== 'simple' && decision.complexity !== 'standard'
  if (isSubstantial && rt.cfg.budgetMode !== 'economical') {
    parts.push('Work in order: inspect, plan, implement, test, review. Read only the files the task needs and run the tests it touches.')
  }
  if (decision.delegation.suggested) {
    const agents = decision.delegation.agents.map(key => `auto-router:${AGENT_DEFS[key].name}`).join(' or ')
    parts.push(`Independent parts may go to ${agents}, at most ${decision.delegation.parallel} at a time, each asked for a short report. Keep small steps here: no agent per stage.`)
  }
  if (decision.reviewRequired) {
    parts.push('This is high-risk work: check the result against the request, run the relevant tests, then have auto-router:independent-reviewer review the change before you finish.')
  }
  return parts.length === 0 ? [] : [`[Auto Router] ${parts.join(' ')}`]
}

function beginMainTurn(turnId: string, now: number): void {
  const pending = rt.pending
  rt.pending = undefined
  const command = rt.command
  rt.command = undefined
  rt.turn = { id: turnId, startedAt: now, steps: 0, isEngineSwitched: false, hasUltrathink: pending?.hasUltrathink === true, mutations: 0, isUnrouted: false }
  rt.core.session.turns += 1
  rt.core.note = ''
  if (pending !== undefined && now - pending.at < PENDING_MS) {
    const before = rt.core.route
    const route = routeFrom(pending.decision, pending.title, now, turnId)
    if (pending.isContinuation && before !== undefined) {
      // The same task goes on: what it has earned so far stays with it.
      route.review = before.review === 'missed' ? 'required' : before.review
      route.reviewVerdict = before.reviewVerdict
      route.escalations = before.escalations
      route.lastEscalation = before.lastEscalation
      route.misses = before.misses
      if (before.escalations > 0) {
        if (before.alias !== undefined && route.alias !== undefined && aliasRank(before.alias) > aliasRank(route.alias)) route.alias = before.alias
        if (before.effort !== undefined && route.effort !== undefined && effortRank(before.effort) > effortRank(route.effort)) route.effort = before.effort
      }
      if (pending.miss !== undefined) {
        route.misses = (before.misses ?? 0) + 1
        route.escalations = before.escalations + 1
        route.lastEscalation = pending.miss
        rt.core.escalation = `you said the answer missed: ${pending.miss}`
        pushEvent(now, 'guard', 'OK', `the answer was called wrong: ${pending.miss}`, { turnId })
      }
    } else {
      rt.lanes.delete('main')
      rt.core.escalation = 'none'
      rt.core.risk = 'low'
    }
    route.status = 'running'
    rt.core.route = route
    rt.core.risk = riskMax(rt.core.risk, route.risk)
  } else if (command !== undefined && now - command.at < PENDING_MS) {
    // A slash command's turn: its skill is not ours to read, and the last task's
    // route may be far too small for it. The session's own model and effort stand.
    rt.turn.isUnrouted = true
    pushEvent(now, 'route', 'OK', `/${command.name}: a slash command, so the session's own model and effort stand`, { turnId })
  } else if (rt.core.route !== undefined) {
    rt.core.route.turnId = turnId
    rt.core.route.status = 'running'
    rt.core.route.endedAt = undefined
  }
  mark('core')
}

/** A model or effort the person changed between turns is theirs: the router keeps off it until routing is turned on again. */
function observePins(model: string, effort: string | undefined, now: number): void {
  const s = rt.core.session
  const isUltrathink = rt.turn?.hasUltrathink === true
  if (rt.cfg.guardrails.respectUserPins) {
    if (s.baseModel !== undefined && s.turns > 1 && model !== s.baseModel) {
      rt.core.pins.model = model
      pushEvent(now, 'route', 'OK', `you switched to ${model} mid-session: kept as pinned`)
    }
    if (s.baseEffort !== undefined && s.turns > 1 && effort !== undefined && effort !== s.baseEffort && !isUltrathink && isEffort(effort)) {
      rt.core.pins.effort = effort
      pushEvent(now, 'route', 'OK', `you set effort ${effort} mid-session: kept as pinned`)
    }
  }
  s.baseModel = model
  if (effort !== undefined && !isUltrathink) s.baseEffort = effort
  mark('core')
}

/**
 * The session's own effort is first seen at a turn's first request. Where the
 * session runs with Ultracode (or at xhigh or max, which is how Ultracode
 * runs), the route is never left below it.
 */
function keepEffortFloor(engineEffort: string | undefined): void {
  const route = rt.core.route
  if (route === undefined || route.effort === undefined || !isEffort(engineEffort)) return
  if (route.effortAction === 'explicit' || !rt.cfg.ultracode.keepEffortFloor || !isUltracode()) return
  if (effortRank(engineEffort) > effortRank(route.effort)) {
    route.effort = engineEffort
    route.effortAction = 'keep'
    route.explanation = `${route.explanation} · session effort ${engineEffort} kept as the floor`
    mark('core')
  }
}

function planStep(model: string, effort: string | undefined, agentId: string | undefined, now: number): StepPlan {
  if (agentId !== undefined) {
    const agent = rt.agentById.get(agentId)
    if (agent === undefined) return { lane: 'other' }
    const plan: StepPlan = { lane: 'agent', agent }
    if (!canApply()) return plan
    const lane = rt.lanes.get(agentId)
    const wanted = lane?.effort ?? (isEffort(agent.effort) ? agent.effort : undefined)
    if (wanted !== undefined && rt.cfg.routing.subagents.routeEffort && wanted !== effort) plan.effort = wanted
    if (lane?.alias !== undefined && aliasOf(model) !== lane.alias && isVersionAtLeast(rt.engine, MIN_ENGINE_FOR_MAIN_MODEL)) plan.model = lane.alias
    return plan
  }
  const plan: StepPlan = { lane: 'main' }
  const turn = rt.turn
  if (turn !== undefined) {
    if (turn.steps === 0) {
      turn.engineModel = model
      turn.engineEffort = effort
      observePins(model, effort, now)
      keepEffortFloor(effort)
    } else if (turn.engineModel !== undefined && model !== turn.engineModel) {
      // The engine itself moved this turn to another model (a fallback): its choice stands.
      turn.isEngineSwitched = true
    }
    turn.steps += 1
  }
  const route = rt.core.route
  if (route === undefined || turn?.isEngineSwitched === true || turn?.isUnrouted === true) return plan
  const isModelFree = rt.core.pins.model === undefined || route.modelAction === 'explicit'
  const isEffortFree = rt.core.pins.effort === undefined || route.effortAction === 'explicit'
  if (route.alias !== undefined && isModelFree && canRouteMainModel() && aliasOf(model) !== route.alias) plan.model = route.alias
  if (route.effort !== undefined && isEffortFree && canRouteMainEffort() && route.effort !== effort) plan.effort = route.effort
  return plan
}

function recordStep(
  plan: StepPlan,
  engineModel: string,
  engineEffort: string | undefined,
  sentModel: string,
  sentEffort: string | undefined,
  usage: ReportedUsage | null,
  hasResponse: boolean,
  now: number,
): void {
  if (plan.lane === 'main') {
    const route = rt.core.route
    const s = rt.core.session
    if (route !== undefined) {
      route.engineModel = engineModel
      route.engineEffort = engineEffort
      route.sentModel = sentModel
      route.sentEffort = sentEffort
      route.steps += 1
      if (usage !== null) {
        const isNew = route.actualModel !== usage.model
        route.actualModel = usage.model
        if (isNew) {
          const asked = plan.model ?? sentModel
          const isOther = plan.model !== undefined && aliasOf(usage.model) !== aliasOf(plan.model)
          pushEvent(now, 'model', isOther ? 'ERR' : 'OK', isOther ? `asked ${asked}, the API answered with ${usage.model}` : `main: ${usage.model} answered (asked ${asked}, effort ${sentEffort ?? 'default'})`, { turnId: rt.turn?.id })
        }
      }
    }
    if (usage !== null) {
      const family = aliasOf(usage.model)
      if (family !== undefined) {
        s.lastAlias = family
        s.warm[family] = now
      }
      if (isEffort(sentEffort)) s.lastEffort = sentEffort
      s.lastRequestAt = now
      s.contextTokens = contextOf(usage)
      if (rt.cfg.telemetry.enabled) recordUsage(rt.usage, 'main', usage, now, engineModel)
    } else if (!hasResponse && plan.model !== undefined && rt.turn !== undefined) {
      rt.turn.failedModel = plan.model
    }
    mark('core', 'usage')
    return
  }
  if (usage === null) return
  if (plan.lane === 'agent' && plan.agent !== undefined) {
    const agent = plan.agent
    agent.actual = usage.model
    agent.tokens.req += 1
    agent.tokens.in += usage.input_tokens
    agent.tokens.out += usage.output_tokens
    agent.tokens.cr += usage.cache_read_input_tokens
    agent.tokens.cw += usage.cache_creation_input_tokens
    if (sentEffort !== undefined) agent.effort = sentEffort
    if (rt.cfg.telemetry.enabled) recordUsage(rt.usage, agent.type, usage, now, agent.routed ? agent.base : engineModel)
    mark('agents', 'usage')
    return
  }
  if (rt.cfg.telemetry.enabled) recordUsage(rt.usage, 'other (forks, workflows)', usage, now, engineModel)
  mark('usage')
}

function endMainTurn(turnId: string, reason: string, now: number): boolean {
  const route = rt.core.route
  const turn = rt.turn
  let isReviewMissed = false
  if (route !== undefined && route.turnId === turnId) {
    route.status = reason === 'answer' ? 'done' : reason === 'aborted' ? 'aborted' : 'error'
    route.endedAt = now
    // Remember how this kind of task went on the model it started on. An interrupt teaches nothing.
    if (rt.kind !== undefined && reason !== 'aborted' && canApply()) {
      const isEscalated = route.escalations > (rt.kindEscalations ?? 0)
      recordOutcome(rt.learning, rt.kind.kind, { at: now, alias: rt.kind.alias, isEscalated, isFailed: reason === 'error' }, rt.cfg)
      rt.kindEscalations = route.escalations
      rt.isLearningDirty = true
    }
    if (route.review === 'required' && reason === 'answer' && turn !== undefined && turn.mutations > 0) {
      route.review = 'missed'
      isReviewMissed = true
      pushEvent(now, 'guard', 'ERR', 'high-risk task ended without the independent review', { turnId })
    }
  }
  if (reason === 'error' && turn?.failedModel !== undefined) {
    const family = aliasOf(turn.failedModel)
    if (family !== undefined) {
      // Unavailable-model fallback: the next requests use the tier's fallback until the cooldown passes.
      rt.core.unavailable[family] = { until: now + rt.cfg.fallback.cooldownMinutes * 60_000, reason: 'a request to it failed' }
      pushEvent(now, 'model', 'ERR', `${family} failed a request: its fallback is used for ${rt.cfg.fallback.cooldownMinutes} minutes`, { turnId })
    }
  }
  rt.turn = undefined
  mark('core', 'log')
  return isReviewMissed
}

// ----------------------------------------------------------- tool calls

function categoryOf(tool: string): ToolCategory {
  return toolCategory(tool)
}

/** Reads a failed call, counts it against its loop, and says what the model should hear beside the error. */
function onFailure(tool: string, text: string, agentId: string | undefined, now: number): string | undefined {
  const failure = classifyFailure(tool, text)
  const key = agentId ?? 'main'
  const lane = laneOf(key)
  const guard = rt.cfg.guardrails
  const notes: string[] = []
  const seen = (lane.signatures[failure.signature] ?? 0) + 1
  lane.signatures[failure.signature] = seen
  // An environment failure gets its own note below; "same call" would be wrong for it.
  if (seen === guard.identicalFailureLimit && failure.kind !== 'environmental') {
    notes.push(`This exact call has now failed ${seen} times with the same error. Do not run it again unchanged: change the approach, or stop and report the blocker.`)
    pushEvent(now, 'guard', 'BLOCKED', `the same failing ${tool} call repeated ${seen} times: retry called out`, { agentId, turnId: rt.turn?.id })
  }
  if (failure.kind === 'environmental' && !lane.isEnvironmentNoted) {
    lane.isEnvironmentNoted = true
    notes.push(`This looks like an environment problem (${failure.summary}), not a reasoning one. Fix the environment or ask the user; a stronger model will not help.`)
    pushEvent(now, 'guard', 'OK', `environment failure (${failure.summary}): not counted toward escalation`, { agentId })
  }
  if (failure.kind === 'substantive') {
    lane.substantive += 1
    // A slash command's turn is not routed, so there is no route of its own to move up.
    const isRouted = !(key === 'main' && rt.turn?.isUnrouted === true)
    if (lane.substantive >= guard.autoEscalateAfterFailures && canApply() && isRouted) {
      const route = key === 'main' ? rt.core.route : undefined
      const agent = agentId === undefined ? undefined : rt.agentById.get(agentId)
      const currentAlias = lane.alias ?? (key === 'main' ? route?.alias ?? aliasOf(rt.turn?.engineModel) : aliasOf(agent?.actual ?? agent?.resolved ?? agent?.assigned))
      const currentEffort = lane.effort ?? (key === 'main' ? route?.effort ?? (isEffort(rt.turn?.engineEffort) ? rt.turn?.engineEffort : undefined) : isEffort(agent?.effort) ? agent?.effort : undefined)
      const up = lane.escalations < guard.maxEscalationsPerTask ? escalate(rt.cfg, currentAlias, currentEffort, availability(now)) : undefined
      if (up !== undefined) {
        lane.escalations += 1
        lane.substantive = 0
        lane.alias = up.alias ?? lane.alias
        lane.effort = up.effort
        if (route !== undefined) {
          if (up.alias !== undefined && rt.core.pins.model === undefined) route.alias = up.alias
          if (rt.core.pins.effort === undefined) route.effort = up.effort
          route.escalations += 1
          route.lastEscalation = up.note
        }
        if (agent !== undefined) agent.escalations += 1
        rt.core.escalation = `escalated ${key === 'main' ? 'main' : 'agent'}: ${up.note}`
        pushEvent(now, 'guard', 'OK', `escalated after ${guard.autoEscalateAfterFailures} substantive failures (${failure.summary}): ${up.note}`, { agentId, turnId: rt.turn?.id })
        notes.push(`${guard.autoEscalateAfterFailures} substantive failures on this task (${failure.summary}). The rest of the task runs one tier up (${up.note}). Before the next attempt, state the root cause from the error output above and change the approach.`)
      } else if (!lane.isTopNoted) {
        lane.isTopNoted = true
        rt.core.escalation = 'no stronger tier left for this task'
        notes.push('Repeated substantive failures and no stronger tier is left. Stop, summarize what failed with the error output, and ask the user how to proceed.')
        pushEvent(now, 'guard', 'ERR', 'repeated failures at the top tier: asked to stop and report', { agentId })
      }
      mark('core', 'agents')
    }
  }
  return notes.length === 0 ? undefined : `[Auto Router] ${notes.join(' ')}`
}

async function countRunning($: EngineInterface): Promise<number> {
  try {
    const list = await $.agent.list()
    return list.filter(agent => agent.status === 'running' || agent.status === 'pending' || agent.status === 'waiting').length
  } catch {
    return rt.agents.filter(agent => agent.status === 'RUNNING' || agent.status === 'PENDING').length
  }
}

function rememberAgent(agent: AgentRec): void {
  rt.agents.unshift(agent)
  const live = rt.agents.filter(one => one.status === 'RUNNING' || one.status === 'PENDING')
  const done = rt.agents.filter(one => one.status !== 'RUNNING' && one.status !== 'PENDING')
  rt.agents = [...live, ...done].slice(0, AGENT_HISTORY)
  // A record that fell off the list is forgotten everywhere.
  const kept = new Set(rt.agents)
  for (const [id, one] of rt.agentById) {
    if (!kept.has(one)) rt.agentById.delete(id)
  }
  mark('agents')
}

/** The configure tool: the model's way to change settings a person asked for in words. */
async function configure($: EngineInterface, input: Readonly<Record<string, unknown>>): Promise<string> {
  const action = typeof input.action === 'string' ? input.action : 'get'
  if (action === 'get') {
    return `${configText(rt.cfg, configPath(), rt.core.configError)}\n\nSettings are changed by dotted path, for example {"path":"budgetMode","value":"economical"} or {"path":"guardrails.maxParallelAgents","value":1}.\n${serializeConfig(rt.cfg)}`
  }
  if (action === 'request') {
    const request = typeof input.request === 'string' ? input.request : ''
    return changeFromText($, request, 'tool')
  }
  if (action === 'set') {
    const changes = Array.isArray(input.changes) ? input.changes : []
    const patches: ConfigPatch[] = []
    for (const change of changes) {
      if (isRecord(change) && typeof change.path === 'string') patches.push({ path: change.path, value: change.value })
    }
    if (patches.length === 0) return 'ERROR: no change given. Pass changes: [{ "path": "...", "value": ... }].'
    const saved = await saveConfig($, patches, 'tool: set')
    return saved.isSaved ? `Changed: ${saved.summary}. The new configuration is in force.` : `ERROR: not changed. ${saved.errors.join('; ')}`
  }
  return `ERROR: unknown action "${action}". Use get, set or request.`
}

// ------------------------------------------------------------ register

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      // A new session in this process: set up again, whatever an earlier one did.
      rt.isSetUp = false
      await setup($, 'session.start')
      rt.core.session.surface = e.surface ?? undefined
      mark('core')
      await flush($)
    } catch {
      // A router that cannot start leaves the session as it was.
    }
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    try {
      await setup($, 'session.attach')
      rt.core.session.surface = e.surface
      if (rt.cfg.sidePanel.enabled && rt.cfg.sidePanel.autoOpen && !rt.isPanelHidden) {
        const opened = await openPane($, false)
        await health($, `surface ${e.surface} attached; pane: ${opened}`)
      }
      mark('core')
      await flush($)
    } catch {
      // Drawing is optional; routing does not wait for a surface.
    }
    return attached
  })

  on('session.end', async ($, e, next) => {
    try {
      if (rt.isLoaded) {
        const now = await $.clock.now()
        await flushHistory($, now, true)
      }
    } catch {
      // The exit is not held for a history write.
    }
    // After a /clear the process goes on under a new session id with fresh state.
    rt.isLoaded = false
    rt.isSetUp = false
    rt.loading = undefined
    rt.turn = undefined
    rt.pending = undefined
    rt.command = undefined
    rt.lanes.clear()
    rt.openTools.clear()
    rt.agentTurn.clear()
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    try {
      if (rt.isLoaded && e.agentId === undefined && compacted.skip === undefined) {
        // The conversation was rewritten: every model's cached prefix is gone.
        rt.core.session.warm = {}
        rt.core.session.contextTokens = 0
        mark('core')
        await flush($)
      }
    } catch {
      // Cache bookkeeping only.
    }
    return compacted
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    try {
      await ready($)
      const now = await $.clock.now()
      rt.usage.context = { window: e.context.window, tokens: e.context.tokens, percent: e.context.percent }
      rt.usage.rateLimits = e.rateLimits.map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed, resetsAt: limit.resetsAt }))
      if (e.cost !== undefined) rt.usage.costUsd = e.cost.usd
      rt.usage.measuredAt = now
      mark('usage')
      await flush($)
    } catch {
      // A missed reading shows as the previous one.
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    let hints: string[] = []
    try {
      await setup($, 'prompt.submit')
      const kind = e.origin.kind
      const isTask = e.command === undefined && e.isMeta !== true && kind !== 'task-notification' && kind !== 'observer' && kind !== 'peer-send-message'
      if (e.command !== undefined && e.isMeta !== true && e.command.name !== 'auto-router') {
        // A slash command that starts a turn: remembered so that turn is left to the session's own model.
        rt.command = { name: e.command.name, at: await $.clock.now() }
        rt.pending = undefined
      }
      if (isTask) {
        await reloadIfChanged($)
        const now = await $.clock.now()
        const isMidTurn = e.turnId !== undefined
        rt.command = undefined
        let cls = classify(e.text)
        if (canApply() && shouldJudge(cls, rt.cfg)) {
          // With a task already under way the judge is shown how the last answer began.
          const reply = rt.core.route === undefined ? undefined : await lastReply($)
          cls = mergeJudge(cls, await askJudge($, e.text, now, reply), rt.cfg)
        }
        let pending = planMain(cls, e.text, now, isMidTurn)
        const waiting = rt.pending
        if (isMidTurn && waiting !== undefined && now - waiting.at < PENDING_MS) {
          // An earlier prompt still waits for its turn: the turn may read either, so the plan is never the weaker one.
          pending = { ...pending, decision: keepStronger(pending.decision, waiting.decision), miss: pending.miss ?? waiting.miss }
        }
        rt.pending = pending
        const route = rt.core.route
        if (isMidTurn && route !== undefined) {
          // Typed over a running turn: the turn may move up at once, never down.
          const d = pending.decision
          if (d.alias !== undefined && (route.alias === undefined || aliasRank(d.alias) > aliasRank(route.alias)) && d.modelAction === 'upgrade') route.alias = d.alias
          if (d.effort !== undefined && (route.effort === undefined || effortRank(d.effort) > effortRank(route.effort))) route.effort = d.effort
        }
        pushEvent(now, 'route', 'OK', `${isActive() ? '' : 'would be: '}${pending.decision.explanation}`, { turnId: e.turnId })
        hints = hintsFor(pending.decision)
        if (!rt.isPanePlaced && rt.cfg.sidePanel.enabled) $.ui.status(statusLine())
        mark('core')
        await flush($)
      }
    } catch {
      hints = []
    }
    return hints.length > 0 ? next({ ...e, context: [...(e.context ?? []), ...hints] }) : next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    try {
      await setup($, 'turn.start')
      const now = await $.clock.now()
      if (e.agentId === undefined) {
        beginMainTurn(e.turnId, now)
      } else {
        rt.agentTurn.set(e.agentId, e.turnId)
        const agent = rt.agentById.get(e.agentId)
        if (agent !== undefined && agent.status === 'PENDING') {
          agent.status = 'RUNNING'
          pushEvent(now, 'agent', 'RUNNING', `${agent.type} started: ${agent.task}`, { agentId: e.agentId, turnId: e.turnId })
          mark('agents')
        }
      }
      await flush($)
    } catch {
      // The turn starts either way.
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    let sent = e
    let plan: StepPlan = { lane: e.agentId === undefined ? 'main' : 'other' }
    const engineEffort = typeof e.effort === 'string' ? e.effort : undefined
    try {
      await ready($)
      const now = await $.clock.now()
      plan = planStep(e.model, engineEffort, e.agentId, now)
      if (plan.model !== undefined) sent = { ...sent, model: plan.model }
      if (plan.effort !== undefined) sent = { ...sent, effort: plan.effort }
    } catch {
      sent = e
    }
    const result = yield* next(sent)
    try {
      const now = await $.clock.now()
      const sentEffort = typeof sent.effort === 'string' ? sent.effort : undefined
      recordStep(plan, e.model, engineEffort, sent.model, sentEffort, result.usage, result.stopReason !== null, now)
      await flush($)
    } catch {
      // The response stands whatever the bookkeeping does.
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    let isReviewMissed = false
    try {
      await ready($)
      const now = await $.clock.now()
      if (e.agentId === undefined) {
        isReviewMissed = endMainTurn(e.turnId, e.reason, now)
        if (rt.isLearningDirty) {
          rt.isLearningDirty = false
          await saveLearning($)
        }
        await flushHistory($, now, false)
      } else {
        const agent = rt.agentById.get(e.agentId)
        if (agent !== undefined) {
          agent.status = e.reason === 'answer' ? 'OK' : e.reason === 'aborted' ? 'BLOCKED' : 'ERR'
          agent.endedAt = now
          pushEvent(now, 'agent', agent.status, `${agent.type} ${e.reason === 'answer' ? 'finished' : e.reason}: ${agent.task}`, { agentId: e.agentId, turnId: e.turnId, ms: Math.round(e.durationMs) })
          if (agent.agent === 'reviewer' && rt.core.route !== undefined) {
            rt.core.route.review = 'done'
            const verdict = /VERDICT:\s*(PASS|FAIL|CONCERNS)/i.exec(e.answer)
            rt.core.route.reviewVerdict = verdict?.[1]?.toUpperCase()
            mark('core')
          }
          rememberAgent(rt.agents.splice(rt.agents.indexOf(agent), 1)[0] ?? agent)
        }
        rt.lanes.delete(e.agentId)
        rt.agentTurn.delete(e.agentId)
      }
      await flush($)
    } catch {
      // The answer is the turn's, not the router's.
    }
    const ended = await next(e)
    if (isReviewMissed && isActive()) {
      return { ...ended, text: 'Auto Router: this was high-risk work and the independent review did not run. Ask for a review before relying on it.' }
    }
    return ended
  })

  on('agent.spawn', async ($, e, next) => {
    await ready($)
    const now = await $.clock.now()
    const isLeftAlone = e.fork || e.workflow !== undefined || e.resume !== undefined || e.isTeammate === true
    if (e.workflow !== undefined) rt.isWorkflowSeen = true
    const key = agentKeyOf(e.subagentType)
    const title = clip(rt.cfg.telemetry.redactSecrets ? redact(e.description) : e.description, 60)
    let sent = e
    const agent: AgentRec = {
      key: e.tool_use_id === '' ? `spawn-${now}-${rt.seq}` : e.tool_use_id,
      type: e.subagentType,
      agent: key,
      task: rt.cfg.telemetry.promptPreview ? title : '(hidden)',
      assigned: e.model,
      status: 'PENDING',
      startedAt: now,
      routed: false,
      tokens: zero(),
      escalations: 0,
    }
    let isReserved = false
    if (!isLeftAlone && isActive()) {
      rt.reserved += 1
      isReserved = true
      const running = await countRunning($)
      if (running + rt.reserved - 1 >= rt.cfg.guardrails.maxParallelAgents) {
        rt.reserved -= 1
        agent.status = 'BLOCKED'
        agent.endedAt = now
        agent.note = `parallel limit ${rt.cfg.guardrails.maxParallelAgents}`
        rememberAgent(agent)
        pushEvent(now, 'agent', 'BLOCKED', `${e.subagentType} refused: ${running} agent(s) already running, the limit is ${rt.cfg.guardrails.maxParallelAgents}`, { toolUseId: e.tool_use_id })
        await flush($)
        return {
          deny: `Auto Router: ${running} subagent(s) are already running and the limit is ${rt.cfg.guardrails.maxParallelAgents}. Wait for one to finish, or do this step in the main session. Do not retry at once.`,
        }
      }
      if (rt.cfg.autonomous) {
        const task = `${e.description}\n${e.prompt}`
        let cls = classify(task)
        // Where the task alone picks the model, it is read for its meaning too, as a prompt is.
        const sub = rt.cfg.routing.subagents
        const isOpenPick = key === undefined && sub.routeModel && sub.routeTypes.includes(e.subagentType) && aliasOf(e.model) === undefined
        let judgedAs: string | undefined
        if (isOpenPick && shouldJudgeSubagent(cls, rt.cfg)) {
          cls = mergeJudge(cls, await askJudge($, task, now), rt.cfg)
          judgedAs = cls.signals.find(signal => signal.startsWith('judge: '))?.replace(/ \(.*\)$/, '')
        }
        const decision = decideSubagent(cls, rt.cfg, {
          subagentType: e.subagentType,
          callModel: e.model,
          availability: availability(now),
        })
        if (decision.isManaged) {
          if (decision.alias !== undefined && aliasOf(e.model) !== decision.alias) {
            sent = { ...e, model: decision.alias }
            agent.routed = true
            // With no router the call's own model stands, or the agent inherits the session's.
            agent.base = aliasOf(e.model) === undefined ? rt.core.session.baseModel : e.model
          }
          agent.assigned = decision.alias ?? e.model
          agent.effort = decision.effort
          agent.note = [decision.usedFallback ? 'fallback model' : '', ...decision.reasons, judgedAs ?? ''].filter(text => text !== '').join(' · ') || undefined
          rt.core.risk = riskMax(rt.core.risk, decision.risk)
        }
      }
    }
    if (key === 'reviewer' && rt.core.route !== undefined) {
      rt.core.route.review = 'running'
      mark('core')
    }
    rememberAgent(agent)
    const event = pushEvent(now, 'agent', 'PENDING', `${e.subagentType}${agent.assigned === undefined ? '' : ` on ${agent.assigned}`}: ${agent.task}`, { toolUseId: e.tool_use_id })
    await flush($)
    let started
    try {
      started = await next(sent)
    } finally {
      if (isReserved) rt.reserved -= 1
    }
    const end = await $.clock.now()
    if (started.deny !== undefined) {
      agent.status = 'BLOCKED'
      agent.endedAt = end
      agent.note = 'refused'
      if (event !== undefined) event.status = 'BLOCKED'
    } else {
      agent.agentId = started.agentId
      agent.resolved = started.model
      if (started.agentId !== undefined) {
        rt.agentById.set(started.agentId, agent)
        if (event !== undefined) event.agentId = started.agentId
      }
      if (isLeftAlone) agent.note = e.workflow !== undefined ? 'workflow agent: left alone' : e.fork ? 'fork: left alone' : 'left alone'
    }
    mark('agents', 'feed')
    await flush($)
    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    await setup($, 'tool.call')
    if (rt.core.paused) {
      // The pause gate: refused here, before the permission check and before the tool.
      const now = await $.clock.now()
      rt.core.blockedCount += 1
      pushEvent(now, 'tool', 'BLOCKED', `paused: ${toolLabel(e.tool, e as unknown as Record<string, unknown>, rt.cfg.telemetry.redactSecrets)}`, {
        cat: categoryOf(e.tool),
        tool: e.tool,
        toolUseId: e.tool_use_id,
        agentId: e.agentId,
        turnId: e.agentId === undefined ? rt.turn?.id : rt.agentTurn.get(e.agentId),
      })
      mark('core')
      await flush($)
      return { deny: PAUSED_DENY }
    }
    const started = await $.clock.now()
    const args = e as unknown as Record<string, unknown>
    const danger = destructiveMatch(e.tool, args)
    if (danger !== undefined) {
      rt.core.risk = riskMax(rt.core.risk, 'high')
      pushEvent(started, 'guard', 'OK', `${danger}: permission is Claude Code's to decide`, { toolUseId: e.tool_use_id, agentId: e.agentId })
      mark('core')
    }
    const event = pushEvent(started, 'tool', 'RUNNING', toolLabel(e.tool, args, rt.cfg.telemetry.redactSecrets), {
      cat: categoryOf(e.tool),
      tool: e.tool,
      toolUseId: e.tool_use_id,
      agentId: e.agentId,
      turnId: e.agentId === undefined ? rt.turn?.id : rt.agentTurn.get(e.agentId),
    })
    if (event !== undefined) rt.openTools.set(e.tool_use_id, event)
    await flush($)

    const ran = await next(e)

    let context: string | undefined
    try {
      const ended = await $.clock.now()
      rt.openTools.delete(e.tool_use_id)
      const isDenied = ran.deny !== undefined
      const isError = !isDenied && ran.isError === true
      if (event !== undefined) {
        event.status = isDenied ? 'BLOCKED' : isError ? 'ERR' : 'OK'
        event.ms = Math.max(0, Math.round(ended - started))
        mark('feed')
      }
      if (isError) {
        // Counted and shown either way; said to the model only where the router may act.
        const advice = onFailure(e.tool, typeof ran.text === 'string' ? ran.text : '', e.agentId, ended)
        context = isActive() ? advice : undefined
      } else if (!isDenied && ran.isReadOnly !== true && e.agentId === undefined && rt.turn !== undefined) {
        const cat = categoryOf(e.tool)
        if (cat === 'edit' || cat === 'write' || cat === 'shell') rt.turn.mutations += 1
      }
      await flush($)
    } catch {
      context = undefined
    }
    if (context !== undefined && ran.deny === undefined) {
      return { ...ran, context: [...(ran.context ?? []), context] } as typeof ran
    }
    return ran
  }).catch(($, e, next) => (!next.called && rt.core.paused ? { deny: PAUSED_DENY } : next(e)))

  on('tool.call', { tool: 'mcp__auto-router__configure' }, async ($, e) => {
    await ready($)
    const text = await configure($, e as unknown as Record<string, unknown>)
    await flush($)
    return { result: text }
  }).catch(() => ({ result: 'ERROR: the Auto Router configure tool failed; nothing was changed.' }))

  on('tool.check', async ($, e, next) => {
    const decided = await next(e)
    try {
      await ready($)
      const event = e.tool_use_id === undefined ? undefined : rt.openTools.get(e.tool_use_id)
      if (event !== undefined && decided.decision === 'ask') {
        // Waiting on the person or the mode's decider.
        event.status = 'PENDING'
        mark('feed')
        await flush($)
      }
      if (decided.decision === 'deny') return decided
      if (e.tool === 'mcp__auto-router__configure' && isRecord(e.input) && e.input.action === 'set' && Array.isArray(e.input.changes)) {
        const isSensitive = e.input.changes.some(change => isRecord(change) && typeof change.path === 'string' && isSensitivePath(change.path))
        if (isSensitive) return { decision: 'ask', reason: 'Auto Router: this changes a guardrail, a risk floor or the session protection. Confirm it.' }
      }
      if (decided.decision === 'allow' && rt.cfg.guardrails.confirmDestructive && rt.core.session.passive === undefined && e.approver !== undefined) {
        const danger = destructiveMatch(e.tool, e.input)
        if (danger !== undefined) {
          const now = await $.clock.now()
          pushEvent(now, 'guard', 'PENDING', `${danger}: confirmation asked`, { toolUseId: e.tool_use_id, agentId: e.agentId })
          await flush($)
          return { decision: 'ask', reason: `Auto Router guardrail: ${danger}. Confirm before it runs.` }
        }
      }
    } catch {
      // Claude Code's own decision stands.
    }
    return decided
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'auto-router' }, async ($, e) => {
    await setup($, 'command.run')
    let text: string
    try {
      text = await runCommand($, e.args)
    } catch {
      text = 'Auto Router could not run that command. /auto-router help lists what it takes.'
    }
    await flush($)
    return { text }
  }).catch(() => ({ text: 'Auto Router could not run that command.' }))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE_ID) {
      rt.isPanePlaced = false
      if (e.origin.kind === 'person') await rememberHidden($, true)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Presses come here, not to onPress: a closure lives for one drawing only.
  on('ui.press', { plugin: 'auto-router' }, async ($, e) => {
    try {
      await setup($, 'ui.press')
      await handlePress($, e.element)
      await flush($)
    } catch {
      // A press that fails changes nothing.
    }
    return { element: e.element }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const ui = $.ui.resolve(e)
    await ready($)
    rt.isPanePlaced = true
    const core = await read($, coreAtom)
    const view = await read($, viewAtom)
    const agents = await read($, agentsAtom)
    const feed = await read($, feedAtom)
    const usage = await read($, usageAtom)
    const log = view.view === 'activity' || view.view === 'guardrails' ? await read($, logAtom) : []
    const now = await $.clock.now()
    return renderPane(ui, {
      cols: Math.max(30, e.props.bodyColumns),
      placement: e.props.placement,
      now,
      core,
      view,
      agents,
      feed,
      log,
      usage,
      config: rt.cfg,
      configPath: configPath(),
      isPanelHidden: rt.isPanelHidden,
    })
  })
}
