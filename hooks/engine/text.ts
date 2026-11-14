// Words and numbers as the pane and the /auto-router command show them.
// Pure: no `$`. A figure that was never reported reads "Unavailable": nothing
// here estimates a limit, a cost, a saving or a reset time.

import type {
  AgentRec,
  CoreState,
  RateLimitReading,
  RouterConfig,
  Totals,
  UsageState,
} from '../../types'
import { AGENT_DEFS, agentTypeOf } from './agents.ts'
import { AGENT_KEYS } from './consts.ts'
import { cacheHitRate, sumTotals } from './usage.ts'

export const UNAVAILABLE = 'Unavailable'

export function fmtTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return UNAVAILABLE
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1).replace(/\.?0+$/, '')}k`
  return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
}

/** Dollars: four places under a cent so a small sum is not shown as zero. */
export function fmtUsd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return UNAVAILABLE
  const abs = Math.abs(n)
  const text = abs > 0 && abs < 0.01 ? abs.toFixed(4) : abs.toFixed(2)
  return `${n < 0 ? '-' : ''}$${text}`
}

export function fmtPercent(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return UNAVAILABLE
  return `${Math.round(n * 10) / 10}%`
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const two = (n: number): string => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}h${two(minutes)}m` : `${minutes}:${two(seconds)}`
}

export function fmtClock(ms: number): string {
  const d = new Date(ms)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** An ISO timestamp as a local day and time; "Unavailable" when none was reported. */
export function fmtWhen(iso: string | undefined): string {
  if (iso === undefined || iso === '') return UNAVAILABLE
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${WEEKDAYS[d.getDay()] ?? ''} ${d.getDate()} ${MONTHS[d.getMonth()] ?? ''} ${two(d.getHours())}:${two(d.getMinutes())}`
}

export function limitLabel(kind: string): string {
  if (kind === 'five_hour') return '5-hour window'
  if (kind === 'seven_day') return 'Weekly plan'
  if (kind === 'spend_limit') return 'Spend limit'
  return kind.replace(/_/g, ' ')
}

export function findLimit(
  limits: readonly RateLimitReading[] | undefined,
  kind: string,
): RateLimitReading | undefined {
  return limits?.find(limit => limit.kind === kind)
}

/** The rate-limit window that speaks for Fable usage credits, if the engine exposes one. */
export function fableCredits(limits: readonly RateLimitReading[] | undefined): RateLimitReading | undefined {
  return limits?.find(limit => /fable|credit/i.test(limit.kind))
}

export function limitText(limit: RateLimitReading | undefined): string {
  if (limit === undefined) return UNAVAILABLE
  const reset = limit.resetsAt === undefined ? 'reset time unavailable' : `resets ${fmtWhen(limit.resetsAt)}`
  return `${fmtPercent(limit.percentUsed)} used · ${reset}`
}

/** `claude-sonnet-5-5` reads `sonnet-5-5`; an alias stays as it is. */
export function modelShort(id: string | undefined): string {
  if (id === undefined || id === '') return UNAVAILABLE
  return id.replace(/^claude-/, '')
}

export function totalsText(totals: Totals): string {
  return `in ${fmtTokens(totals.in)} · out ${fmtTokens(totals.out)} · cache read ${fmtTokens(totals.cr)} · cache write ${fmtTokens(totals.cw)} · ${totals.req} req`
}

export function hitText(totals: Totals): string {
  const rate = cacheHitRate(totals)
  return rate === undefined ? UNAVAILABLE : `${Math.round(rate * 100)}%`
}

export function routerState(core: CoreState, config: RouterConfig): 'paused' | 'observing' | 'off' | 'advisory' | 'on' {
  if (core.paused) return 'paused'
  if (core.session.passive !== undefined) return 'observing'
  if (!config.enabled) return 'off'
  if (!config.autonomous) return 'advisory'
  return 'on'
}

export function stateWord(state: ReturnType<typeof routerState>): string {
  switch (state) {
    case 'paused':
      return 'PAUSED'
    case 'observing':
      return 'OBSERVING'
    case 'off':
      return 'OFF'
    case 'advisory':
      return 'ADVISORY'
    default:
      return 'ON'
  }
}

/** The model line: what was assigned, and what the API said answered. Never the one for the other. */
export function modelEvidence(assigned: string | undefined, actual: string | undefined): string {
  const asked = assigned ?? 'session model'
  if (actual === undefined) return `${asked} assigned · actual not reported yet`
  return `${asked} assigned · ${modelShort(actual)} answered (API)`
}

export function reviewWord(core: CoreState): string {
  const route = core.route
  if (route === undefined) return 'no task yet'
  switch (route.review) {
    case 'required':
      return 'required · not started'
    case 'running':
      return 'running'
    case 'done':
      return `done${route.reviewVerdict === undefined ? '' : ` · ${route.reviewVerdict}`}`
    case 'missed':
      return 'required · did not run'
    default:
      return 'not required'
  }
}

export function statusText(core: CoreState, config: RouterConfig): string {
  const lines: string[] = []
  const state = routerState(core, config)
  lines.push(`Auto Router: ${stateWord(state)} · profile ${config.budgetMode}${config.autonomous ? '' : ' · advisory (not applied)'}`)
  if (core.session.passive !== undefined) lines.push(`This session: observing only (${core.session.passive}).`)
  if (core.paused) lines.push(`Paused: new tool calls are blocked (${core.blockedCount} blocked so far). Running commands are not stopped; finished work is kept.`)
  const route = core.route
  if (route === undefined) {
    lines.push('Task: none yet.')
  } else {
    lines.push(`Task: ${route.title}`)
    lines.push(`Agent: ${AGENT_DEFS[route.agent].title} · effort ${route.sentEffort ?? route.effort ?? route.engineEffort ?? 'session default'}`)
    lines.push(`Model: ${modelEvidence(route.sentModel ?? route.alias, route.actualModel)}`)
    lines.push(`Why: ${route.explanation}`)
    lines.push(`Risk: ${core.risk} · Review: ${reviewWord(core)} · Escalation: ${core.escalation}`)
  }
  if (core.pins.model !== undefined) lines.push(`Pinned model (picked mid-session): ${core.pins.model}`)
  if (core.pins.effort !== undefined) lines.push(`Pinned effort (picked mid-session): ${core.pins.effort}`)
  if (core.configError !== undefined) lines.push(`Configuration problem: ${core.configError}`)
  for (const conflict of core.conflicts) lines.push(`Note: ${conflict}`)
  return lines.join('\n')
}

export function usageText(usage: UsageState): string {
  const lines: string[] = ['Usage this session (as the API reported it):']
  const models = Object.entries(usage.byModel)
  if (models.length === 0) lines.push('  No model response recorded yet.')
  for (const [model, totals] of models) lines.push(`  ${modelShort(model)}: ${totalsText(totals)}`)
  const agents = Object.entries(usage.byAgent)
  if (agents.length > 0) {
    lines.push('By agent:')
    for (const [agent, totals] of agents) {
      lines.push(`  ${agent} (${modelShort(totals.model)}): in ${fmtTokens(totals.in)} · out ${fmtTokens(totals.out)} · ${totals.req} req`)
    }
  }
  const all = sumTotals(usage.byModel)
  lines.push(`Cache: read ${fmtTokens(all.cr)} · written ${fmtTokens(all.cw)} · hit rate ${hitText(all)}`)
  const context = usage.context
  lines.push(
    context === undefined
      ? `Context window: ${UNAVAILABLE}`
      : `Context window: ${fmtPercent(context.percent)} of ${fmtTokens(context.window)} (${fmtTokens(context.tokens)} tokens)`,
  )
  lines.push(`Weekly plan usage: ${limitText(findLimit(usage.rateLimits, 'seven_day'))}`)
  lines.push(`5-hour window: ${limitText(findLimit(usage.rateLimits, 'five_hour'))}`)
  for (const limit of usage.rateLimits ?? []) {
    if (limit.kind !== 'seven_day' && limit.kind !== 'five_hour') lines.push(`${limitLabel(limit.kind)}: ${limitText(limit)}`)
  }
  lines.push(`Fable usage credits: ${limitText(fableCredits(usage.rateLimits))}`)
  lines.push(`Session cost: ${usage.costUsd === undefined ? UNAVAILABLE : `$${usage.costUsd.toFixed(4)} (engine ledger)`}`)
  const weekly = usage.weekly
  if (weekly !== undefined) {
    const total = sumTotals(weekly.byModel)
    lines.push(`Last ${weekly.days} days on this machine (${weekly.sessions} sessions): ${totalsText(total)}`)
  }
  if (usage.flushError !== undefined) lines.push(`History file: ${usage.flushError}`)
  return lines.join('\n')
}

export function agentsText(config: RouterConfig, agents: readonly AgentRec[], now: number): string {
  const lines: string[] = ['Specialist agents (assigned by config; "actual" is what the API reported):']
  for (const key of AGENT_KEYS) {
    const def = AGENT_DEFS[key]
    const tier = config.tiers[key]
    const fallback = tier.fallback === undefined ? '' : ` (fallback ${tier.fallback})`
    lines.push(`  ${def.title} [${agentTypeOf(key)}]: ${tier.model}${fallback} · base effort ${def.effort} · ${def.responsibility}`)
  }
  lines.push(`Parallel agents: default ${config.guardrails.defaultParallelAgents}, max ${config.guardrails.maxParallelAgents}.`)
  const live = agents.filter(agent => agent.status === 'RUNNING' || agent.status === 'PENDING')
  lines.push(live.length === 0 ? 'Active: none.' : 'Active:')
  for (const agent of live) {
    lines.push(
      `  ${agent.status} ${agent.type} #${(agent.agentId ?? agent.key).slice(0, 8)} · ${modelEvidence(agent.assigned, agent.actual)} · effort ${agent.effort ?? 'default'} · ${fmtDuration(now - agent.startedAt)} · ${agent.task}`,
    )
  }
  return lines.join('\n')
}

export function configLines(config: RouterConfig): string[] {
  const t = config.tiers
  const e = config.effortBounds
  return [
    `Routing: ${config.enabled ? 'on' : 'off'} · ${config.autonomous ? 'autonomous' : 'advisory'} · profile ${config.budgetMode}`,
    `Models: Head Chef ${t.headChef.model} · Sous Chef ${t.sousChef.model} · Line Cook ${t.lineCook.model} · Prep Cook ${t.prepCook.model} · Reviewer ${t.reviewer.model}`,
    `Fallbacks: ${t.headChef.fallback ?? '-'} · ${t.sousChef.fallback ?? '-'} · ${t.lineCook.fallback ?? '-'} · ${t.prepCook.fallback ?? '-'} · ${t.reviewer.fallback ?? '-'}`,
    `Effort: simple ${e.simple} · standard ${e.standard} · complex ${e.complex} · critical ${e.critical} · exceptional ${e.exceptional} (limits ${config.effortLimits.min} to ${config.effortLimits.max})`,
    `Top tier used for: ${config.routing.headChef.domains.join(', ') || 'no area'}${config.routing.headChef.exceptional ? ', and exceptional reasoning' : ''}`,
    `Understanding: ${config.judge.mode === 'off' ? 'local rules only' : `local rules + ${config.judge.model} judge (${config.judge.mode})`} · unsure below ${config.judge.uncertainBelow} goes to ${config.tiers[config.riskFloors.uncertain.minTier].model} · learning ${config.learning.enabled ? 'on' : 'off'}`,
    `Main session: model ${config.routing.mainSession.routeModel ? 'routed' : 'left alone'} · effort ${config.routing.mainSession.routeEffort ? 'routed' : 'left alone'} · cache-aware ${config.routing.mainSession.cacheAware ? 'on' : 'off'}`,
    `Agents: default ${config.guardrails.defaultParallelAgents} · max ${config.guardrails.maxParallelAgents} · escalate after ${config.guardrails.autoEscalateAfterFailures} substantive failures`,
    `Review: ${config.guardrails.independentReview && config.guardrails.reviewMode !== 'off' ? 'independent review for high-risk work' : 'off'} · extra confirm for destructive commands ${config.guardrails.confirmDestructive ? 'on' : 'off'}`,
    `Overrides: ${config.routing.overrides.length === 0 ? 'none' : config.routing.overrides.map(rule => `${[rule.complexity, rule.domain, rule.risk].filter(Boolean).join(' ')} -> ${rule.model ?? rule.tier ?? rule.effort ?? ''}`).join('; ')}`,
    `Panel: ${config.sidePanel.enabled ? 'on' : 'off'} · auto-open ${config.sidePanel.autoOpen ? 'on' : 'off'} · docked right where it fits`,
    `Telemetry: ${config.telemetry.enabled ? 'on' : 'off'} · ${config.telemetry.maxEvents} events · secrets ${config.telemetry.redactSecrets ? 'redacted' : 'NOT redacted'} · task titles ${config.telemetry.promptPreview ? 'kept (redacted)' : 'hidden'}`,
    `Protected sessions: ${config.sessions.protected.length}`,
  ]
}

export function configText(config: RouterConfig, path: string, error: string | undefined): string {
  const lines = [`Effective configuration (${path}):`, ...configLines(config).map(line => `  ${line}`)]
  if (error !== undefined) lines.push(`Problem: ${error} (the last valid configuration is in use)`)
  lines.push('Change it with /auto-router config <request>, for example: /auto-router config switch to economical mode')
  return lines.join('\n')
}

export function helpText(): string {
  return [
    '/auto-router            open the dashboard',
    '/auto-router status     routing status',
    '/auto-router usage      usage by model and agent',
    '/auto-router agents     agent assignments',
    '/auto-router config     effective configuration; add a request to change it',
    '/auto-router pause      block new tool calls',
    '/auto-router resume     allow tool calls again',
    '/auto-router clear      clear the activity history',
    '/auto-router on | off   turn routing on or off',
    '/auto-router reload     read config.json again',
  ].join('\n')
}
