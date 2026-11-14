// The routing engine: from a classification to a model, an effort and a
// reason. Pure and deterministic: no `$`, no I/O, no model call.
//
// Order of precedence, highest first: an explicit request in the prompt, a
// model or effort the person picked mid-session, the risk floors, routing
// overrides, the tier for the task's complexity, the budget profile. A cheaper
// model is taken only when it is capable AND cheaper once the prompt cache is
// counted; a stronger one is taken at once.

import type {
  AgentKey,
  Alias,
  Classification,
  Complexity,
  Decision,
  Effort,
  Risk,
  RouterConfig,
  TierName,
} from '../../types'
import { AGENT_DEFS, agentKeyOf } from './agents.ts'
import { ALIASES, COMPLEXITIES, EFFORTS, RISKS, TIERS } from './consts.ts'

// ----------------------------------------------------------- orderings

export function aliasRank(alias: Alias): number {
  return ALIASES.indexOf(alias)
}

export function effortRank(effort: Effort): number {
  return EFFORTS.indexOf(effort)
}

export function tierRank(tier: TierName): number {
  return TIERS.indexOf(tier)
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)
}

export function isAlias(value: unknown): value is Alias {
  return typeof value === 'string' && (ALIASES as readonly string[]).includes(value)
}

/** The model family an id or alias belongs to (`claude-opus-5-5[1m]` is `opus`); undefined when it names none. */
export function aliasOf(model: string | undefined | null): Alias | undefined {
  const m = (model ?? '').toLowerCase()
  if (m.includes('fable') || m.includes('mythos')) return 'fable'
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  return undefined
}

export function maxEffort(a: Effort, b: Effort): Effort {
  return effortRank(a) >= effortRank(b) ? a : b
}

export function clampEffort(effort: Effort, limits: { min: Effort; max: Effort }): Effort {
  if (effortRank(effort) < effortRank(limits.min)) return limits.min
  if (effortRank(effort) > effortRank(limits.max)) return limits.max
  return effort
}

export function bumpEffort(effort: Effort, by: number, limits: { min: Effort; max: Effort }): Effort {
  const index = Math.max(0, Math.min(EFFORTS.length - 1, effortRank(effort) + by))
  return clampEffort(EFFORTS[index] ?? effort, limits)
}

/** True when version `have` (`2.1.321`, `2.1.321-dev...`) is `want` or later; false when it cannot be read. */
export function isVersionAtLeast(have: string, want: string): boolean {
  const parse = (v: string): number[] =>
    (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(part => Number(part))
  const a = parse(have)
  const b = parse(want)
  if (a.length !== 3 || b.length !== 3) return false
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }
  return true
}

export function tierOfAlias(config: RouterConfig, alias: Alias): TierName {
  for (const tier of [...TIERS].reverse()) {
    if (config.tiers[tier].model === alias) return tier
  }
  // No tier names this model: the tier whose model is nearest in capability.
  let best: TierName = 'lineCook'
  let gap = Number.POSITIVE_INFINITY
  for (const tier of TIERS) {
    const distance = Math.abs(aliasRank(config.tiers[tier].model) - aliasRank(alias))
    if (distance < gap) {
      gap = distance
      best = tier
    }
  }
  return best
}

// --------------------------------------------------------- availability

export type Availability = {
  now: number
  /** Models that failed lately, each with when it may be tried again. */
  unavailable: Readonly<Record<string, { until: number; reason: string }>>
  /** The organization's `availableModels` allowlist, when it sets one. */
  allowed?: readonly string[]
  /** The organization's `deniedModels`. */
  denied?: readonly string[]
}

export function isUsable(alias: Alias, availability: Availability): boolean {
  const down = availability.unavailable[alias]
  if (down !== undefined && down.until > availability.now) return false
  const denied = availability.denied ?? []
  if (denied.some(entry => entry.toLowerCase() === alias)) return false
  const allowed = availability.allowed
  if (allowed !== undefined && allowed.length > 0) {
    return allowed.some(entry => aliasOf(entry) === alias)
  }
  return true
}

/**
 * The model to send for `alias`: itself when usable, else the tier's
 * fallback. This is the unavailable-model path only; a failed task moving up
 * a tier is `escalate`, a separate mechanism.
 */
export function resolveAlias(
  config: RouterConfig,
  alias: Alias,
  tier: AgentKey | undefined,
  availability: Availability,
): { alias?: Alias; usedFallback: boolean } {
  if (isUsable(alias, availability)) return { alias, usedFallback: false }
  const owner = tier ?? tierOfAlias(config, alias)
  const fallback = config.tiers[owner].fallback
  if (fallback !== undefined && fallback !== alias && isUsable(fallback, availability)) {
    return { alias: fallback, usedFallback: true }
  }
  return { usedFallback: false }
}

// --------------------------------------------------------- ideal choice

export type Ideal = {
  tier: TierName
  alias: Alias
  effort: Effort
  floors: string[]
  reasons: string[]
  /** The weakest model the floors allow, and the lowest effort. */
  floorAlias?: Alias
  floorEffort?: Effort
}

const TIER_TITLE: Record<TierName, string> = {
  headChef: AGENT_DEFS.headChef.title,
  sousChef: AGENT_DEFS.sousChef.title,
  lineCook: AGENT_DEFS.lineCook.title,
  prepCook: AGENT_DEFS.prepCook.title,
}

function complexityRank(level: Complexity): number {
  return COMPLEXITIES.indexOf(level)
}

function riskRank(risk: Risk): number {
  return RISKS.indexOf(risk)
}

/** The model and effort a task deserves before the session's state is weighed. */
export function pickIdeal(cls: Classification, config: RouterConfig): Ideal {
  const reasons: string[] = []
  const floors: string[] = []
  const head = config.routing.headChef
  const isHeadDomain = head.domains.some(domain => cls.domains.includes(domain))
  const risk = riskRank(cls.risk)
  const isQuality = config.budgetMode === 'quality'

  let tier: TierName
  switch (cls.complexity) {
    case 'exceptional':
      tier = head.exceptional || isHeadDomain ? 'headChef' : 'sousChef'
      break
    case 'critical':
      tier = isHeadDomain ? 'headChef' : 'sousChef'
      break
    case 'complex':
      // Explaining an architecture is not designing one: the top tier is for the work, not the telling.
      tier = isHeadDomain && !cls.readOnly ? 'headChef' : 'sousChef'
      break
    case 'standard':
      tier = isQuality && risk >= 1 ? 'sousChef' : 'lineCook'
      break
    default: {
      const bar = isQuality ? Math.max(0.8, config.routing.minConfidenceForPrepCook) : config.routing.minConfidenceForPrepCook
      const isEligible = cls.risk === 'low' && cls.ambiguity === 'low' && cls.confidence >= bar
      tier = isEligible ? 'prepCook' : 'lineCook'
      if (!isEligible) reasons.push('simple but not clear-cut: kept off the cheapest tier')
    }
  }
  let alias: Alias = config.tiers[tier].model
  let effort: Effort = config.effortBounds[cls.complexity]

  for (const rule of config.routing.overrides) {
    const isMatch =
      (rule.domain === undefined || cls.domains.includes(rule.domain)) &&
      (rule.complexity === undefined || rule.complexity === cls.complexity) &&
      (rule.risk === undefined || rule.risk === cls.risk)
    if (!isMatch) continue
    if (rule.tier !== undefined) {
      tier = rule.tier
      alias = config.tiers[tier].model
    }
    if (rule.model !== undefined) {
      alias = rule.model
      tier = tierOfAlias(config, alias)
    }
    if (rule.effort !== undefined) effort = rule.effort
    reasons.push(`override: ${[rule.complexity, rule.domain, rule.risk].filter(Boolean).join(' ')}`)
    break
  }

  if (isQuality && complexityRank(cls.complexity) >= 2) {
    effort = bumpEffort(effort, 1, config.effortLimits)
    reasons.push('quality profile: effort raised')
  }

  // Risk floors: never lowered by a budget profile or an override.
  let floorAlias: Alias | undefined
  let floorEffort: Effort | undefined
  const apply = (name: keyof RouterConfig['riskFloors']): void => {
    const floor = config.riskFloors[name]
    const model = config.tiers[floor.minTier].model
    floors.push(name)
    if (floorAlias === undefined || aliasRank(model) > aliasRank(floorAlias)) floorAlias = model
    floorEffort = floorEffort === undefined ? floor.minEffort : maxEffort(floorEffort, floor.minEffort)
  }
  if (cls.domains.includes('security') && risk >= 2) apply('securitySensitive')
  if (cls.risk === 'high') apply('highImpact')
  if (cls.risk === 'critical') apply('criticalImpact')
  if (cls.ambiguity === 'high' && risk >= 2) apply('ambiguousHighRisk')
  if (cls.confidence < config.judge.uncertainBelow || cls.ambiguity === 'high') apply('uncertain')

  if (floorAlias !== undefined && aliasRank(alias) < aliasRank(floorAlias)) {
    alias = floorAlias
    tier = tierOfAlias(config, alias)
  }
  if (floorEffort !== undefined) effort = maxEffort(effort, floorEffort)
  if (cls.explicit.ultrathink === true) effort = maxEffort(effort, 'xhigh')
  effort = clampEffort(effort, config.effortLimits)

  return { tier, alias, effort, floors, reasons, floorAlias, floorEffort }
}

// ---------------------------------------------------------- cache cost

type Work = { steps: number; input: number; output: number }

/** A rough size for a task of each complexity: requests, new input tokens, output tokens. Heuristic. */
const WORK: Record<Complexity, Work> = {
  simple: { steps: 2, input: 1500, output: 400 },
  standard: { steps: 8, input: 12_000, output: 3000 },
  complex: { steps: 25, input: 60_000, output: 12_000 },
  critical: { steps: 35, input: 90_000, output: 18_000 },
  exceptional: { steps: 50, input: 150_000, output: 30_000 },
}

/** The relative cost of running one task of `complexity` on `alias` over a context of `contextTokens`. */
export function estimateCost(
  config: RouterConfig,
  alias: Alias,
  complexity: Complexity,
  contextTokens: number,
  isWarm: boolean,
): number {
  const price = config.costModel[alias]
  const work = WORK[complexity]
  const first = (isWarm ? price.cacheRead : price.in * config.cache.writeMultiplier) * contextTokens
  const later = (work.steps - 1) * price.cacheRead * contextTokens
  const long = LONG_PROMPT[alias]
  const scale = long !== undefined && contextTokens > long.over ? long.factor : 1
  return scale * (first + later + price.in * work.input + price.out * work.output)
}

/**
 * Haiku 5.5 is listed at five times its price for a prompt over 100K tokens
 * ($0.50 / $2.50 against $0.10 / $0.50; list prices cached 2026-11-03). On a
 * long conversation it is not the bargain its weight says.
 */
const LONG_PROMPT: Partial<Record<Alias, { over: number; factor: number }>> = {
  haiku: { over: 100_000, factor: 5 },
}

/**
 * Whether leaving `from` for the cheaper `to` pays once the prompt cache is
 * counted: `to` reads the whole context uncached, and `from`'s warm entry may
 * lapse before the session returns to it.
 */
export function isSwitchWorthIt(
  config: RouterConfig,
  from: Alias,
  to: Alias,
  complexity: Complexity,
  contextTokens: number,
  isFromWarm: boolean,
  isToWarm: boolean,
): boolean {
  let margin = config.cache.switchMargin
  let returnRisk = config.cache.returnRisk
  if (config.budgetMode === 'economical') {
    margin *= 0.5
    returnRisk *= 0.7
  } else if (config.budgetMode === 'quality') {
    margin = Math.min(0.9, margin + 0.25)
  }
  const stay = estimateCost(config, from, complexity, contextTokens, isFromWarm)
  const leave = estimateCost(config, to, complexity, contextTokens, isToWarm)
  const abandoned = isFromWarm ? returnRisk * config.costModel[from].in * config.cache.writeMultiplier * contextTokens : 0
  return leave + abandoned < stay * (1 - margin)
}

// -------------------------------------------------------- main session

export type MainContext = {
  now: number
  isFirstTurn: boolean
  /** The prompt arrived while a turn was running: only an upgrade applies. */
  isMidTurn: boolean
  /** The family of the model the last request used, or the session's own. */
  currentAlias?: Alias
  currentEffort?: Effort
  /** What the engine would send for effort with no router. */
  engineEffort?: Effort
  contextTokens: number
  /** When each model family last answered: its cache entry is presumed warm for cache.ttlMinutes after. */
  warm: Readonly<Partial<Record<Alias, number>>>
  hasPerMessageEffort: boolean
  isUltracode: boolean
  pins: { model?: string; effort?: Effort }
  availability: Availability
  canRouteModel: boolean
  canRouteEffort: boolean
  previous?: Decision
  /** What past outcomes say: true when tasks of this kind kept failing on this model or a stronger one. */
  shouldStartHigher?: (alias: Alias) => boolean
}

function describe(decision: Omit<Decision, 'explanation'>): string {
  const parts: string[] = [`${decision.complexity} task`, `risk ${decision.risk}`]
  if (decision.domains.length > 0) parts.push(decision.domains.slice(0, 3).join(', '))
  const head = parts.join(' · ')
  const want = `${TIER_TITLE[decision.tier]} (${decision.targetAlias}, ${decision.targetEffort})`
  const notes: string[] = []
  switch (decision.modelAction) {
    case 'hold-cache':
      notes.push(`staying on ${decision.alias ?? 'the current model'}: its warm cache is cheaper than moving down`)
      break
    case 'pinned':
      notes.push('model picked by you mid-session is kept')
      break
    case 'explicit':
      notes.push('model named in the prompt')
      break
    case 'unavailable':
      notes.push(`${decision.targetAlias} is unavailable and has no usable fallback`)
      break
    case 'off':
      notes.push('model routing is not applied here')
      break
    case 'upgrade':
      notes.push('moved up')
      break
    case 'downgrade':
      notes.push('moved down: cheaper even with the cache counted')
      break
    default:
      break
  }
  if (decision.usedFallback) notes.push(`fallback for ${decision.targetAlias}`)
  if (decision.effortAction === 'hold-cache') notes.push('effort kept: lowering it would rewrite the message cache')
  if (decision.effortAction === 'pinned') notes.push('effort picked by you mid-session is kept')
  if (decision.floors.length > 0) notes.push(`floor: ${decision.floors.join(', ')}`)
  for (const reason of decision.reasons) notes.push(reason)
  return `${head} -> ${want}${notes.length > 0 ? ` · ${notes.join(' · ')}` : ''}`
}

/** Decides the main conversation's model and effort for one prompt. */
export function decideMain(cls: Classification, config: RouterConfig, ctx: MainContext): Decision {
  const ttlMs = config.cache.ttlMinutes * 60_000
  const isWarm = (alias: Alias | undefined): boolean => {
    if (alias === undefined) return false
    const at = ctx.warm[alias]
    return at !== undefined && ctx.now - at < ttlMs
  }

  // A bare "ok, go on" keeps the task's route: a short follow-up is not a new, simpler task.
  const previous = ctx.previous
  const isKept = cls.continuation && previous !== undefined
  const ideal = pickIdeal(cls, config)
  let tier = isKept ? previous.tier : ideal.tier
  let targetAlias = isKept ? previous.targetAlias : ideal.alias
  let targetEffort = isKept ? previous.targetEffort : ideal.effort
  const reasons = isKept ? ['follow-up: the task keeps its route'] : [...ideal.reasons]
  const floors = isKept ? [...previous.floors] : ideal.floors
  // The judge's verdict is shown; its free-text reason is not, since it may echo the prompt.
  const judged = cls.signals.find(signal => signal.startsWith('judge: '))
  if (!isKept && judged !== undefined) reasons.push(judged.replace(/ \(.*\)$/, ''))

  if (!isKept && ctx.shouldStartHigher?.(targetAlias) === true && cls.explicit.model === undefined) {
    // This kind of task needed more than this model before: start where it ended up.
    const ladder = [...new Set(TIERS.map(one => config.tiers[one].model))].sort((a, b) => aliasRank(a) - aliasRank(b))
    const higher = ladder.find(candidate => aliasRank(candidate) > aliasRank(targetAlias))
    if (higher !== undefined) {
      targetAlias = higher
      tier = tierOfAlias(config, higher)
      targetEffort = bumpEffort(targetEffort, 1, config.effortLimits)
      reasons.push('learned: this kind of task needed a stronger model before')
    }
  }

  if (ctx.isUltracode && config.ultracode.keepEffortFloor && ctx.engineEffort !== undefined) {
    if (effortRank(ctx.engineEffort) > effortRank(targetEffort)) {
      targetEffort = clampEffort(ctx.engineEffort, config.effortLimits)
      reasons.push('Ultracode: session effort kept as the floor')
    }
  }

  // ---- model
  let alias: Alias | undefined
  let modelAction: Decision['modelAction']
  let usedFallback = false
  const current = ctx.currentAlias
  if (cls.explicit.model !== undefined) {
    alias = cls.explicit.model
    modelAction = 'explicit'
  } else if (ctx.pins.model !== undefined && config.guardrails.respectUserPins) {
    modelAction = 'pinned'
  } else if (!ctx.canRouteModel) {
    modelAction = 'off'
  } else {
    const resolved = resolveAlias(config, targetAlias, tier, ctx.availability)
    usedFallback = resolved.usedFallback
    if (resolved.alias === undefined) {
      modelAction = 'unavailable'
      alias = current
    } else if (current === undefined || ctx.isFirstTurn) {
      alias = resolved.alias
      modelAction = 'initial'
    } else if (resolved.alias === current) {
      alias = current
      modelAction = 'keep'
    } else if (aliasRank(resolved.alias) > aliasRank(current)) {
      alias = resolved.alias
      modelAction = 'upgrade'
    } else if (ctx.isMidTurn) {
      alias = current
      modelAction = 'keep'
    } else if (
      !config.routing.mainSession.cacheAware ||
      isSwitchWorthIt(config, current, resolved.alias, cls.complexity, ctx.contextTokens, isWarm(current), isWarm(resolved.alias))
    ) {
      alias = resolved.alias
      modelAction = 'downgrade'
    } else {
      alias = current
      modelAction = 'hold-cache'
    }
  }

  // ---- effort
  let effort: Effort | undefined
  let effortAction: Decision['effortAction']
  const isModelMoving = modelAction === 'initial' || modelAction === 'upgrade' || modelAction === 'downgrade' || modelAction === 'explicit'
  if (cls.explicit.effort !== undefined) {
    effort = clampEffort(cls.explicit.effort, config.effortLimits)
    targetEffort = effort
    effortAction = 'explicit'
  } else if (ctx.pins.effort !== undefined && config.guardrails.respectUserPins) {
    effortAction = 'pinned'
  } else if (!ctx.canRouteEffort) {
    effortAction = 'off'
  } else {
    const held = ctx.currentEffort
    if (held === undefined || ctx.isFirstTurn) {
      effort = targetEffort
      effortAction = 'set'
    } else if (targetEffort === held) {
      effort = held
      effortAction = 'keep'
    } else if (effortRank(targetEffort) > effortRank(held)) {
      effort = targetEffort
      effortAction = 'raise'
    } else if (
      ctx.hasPerMessageEffort ||
      !config.routing.mainSession.cacheAware ||
      isModelMoving ||
      !isWarm(alias ?? current)
    ) {
      // Lowering is free when effort rides its own message, when the cache is cold, or when it is rewritten anyway.
      effort = targetEffort
      effortAction = 'lower'
    } else {
      effort = held
      effortAction = 'hold-cache'
    }
  }

  const review = config.guardrails.independentReview && config.guardrails.reviewMode !== 'off'
  const risk = isKept ? previous.risk : cls.risk
  const complexity = isKept ? previous.complexity : cls.complexity
  const reviewBar = config.budgetMode === 'quality' ? riskRank(risk) >= 1 && complexityRank(complexity) >= 2 : false
  const reviewRequired = review && (riskRank(risk) >= 2 || complexityRank(complexity) >= 3 || reviewBar)

  const delegation =
    config.budgetMode === 'economical' && cls.explicit.wantAgents !== true
      ? { suggested: false, agents: [], parallel: 1, reason: 'economical profile: no unasked subagents' }
      : {
          ...cls.delegation,
          // Parts that can truly run apart may use the maximum; anything else gets the default.
          parallel: Math.min(
            config.guardrails.maxParallelAgents,
            cls.delegation.parallel > 1 ? config.guardrails.maxParallelAgents : config.guardrails.defaultParallelAgents,
          ),
        }

  const partial: Omit<Decision, 'explanation'> = {
    tier,
    agent: tier,
    targetAlias,
    targetEffort,
    alias,
    effort,
    modelAction,
    effortAction,
    usedFallback,
    floors,
    reasons,
    complexity,
    risk,
    ambiguity: isKept ? previous.ambiguity : cls.ambiguity,
    domains: isKept ? previous.domains : cls.domains,
    confidence: isKept ? previous.confidence : cls.confidence,
    reviewRequired,
    delegation,
  }
  return { ...partial, explanation: describe(partial) }
}

// ------------------------------------------------------------ subagents

export type SubContext = {
  subagentType: string
  /** The model the Agent call named, if any. */
  callModel?: string
  availability: Availability
}

export type SubDecision = {
  /** One of the five specialists, or a type the router is set to route. */
  isManaged: boolean
  agent?: AgentKey
  /** The model to set at spawn; absent: the call's own stands. */
  alias?: Alias
  effort?: Effort
  usedFallback: boolean
  floors: string[]
  reasons: string[]
  complexity: Complexity
  risk: Risk
}

/** Decides a subagent's model and effort from its task. Forks, workflow agents, resumes and teammates never reach this. */
export function decideSubagent(cls: Classification, config: RouterConfig, ctx: SubContext): SubDecision {
  const ideal = pickIdeal(cls, config)
  const key = agentKeyOf(ctx.subagentType)
  const base: SubDecision = {
    isManaged: false,
    usedFallback: false,
    floors: ideal.floors,
    reasons: [],
    complexity: cls.complexity,
    risk: cls.risk,
  }
  const routeModel = config.routing.subagents.routeModel
  const routeEffort = config.routing.subagents.routeEffort

  if (key !== undefined) {
    // A specialist: its tier's model, lifted only if a risk floor asks for more.
    let want: Alias = config.tiers[key].model
    const reasons: string[] = []
    if (key !== 'reviewer' && ideal.floorAlias !== undefined && aliasRank(ideal.floorAlias) > aliasRank(want)) {
      want = ideal.floorAlias
      reasons.push(`risk floor lifts ${AGENT_DEFS[key].title} to ${want}`)
    }
    const resolved = resolveAlias(config, want, key, ctx.availability)
    let effort: Effort = maxEffort(ideal.effort, key === 'reviewer' ? 'high' : config.effortLimits.min)
    effort = clampEffort(effort, config.effortLimits)
    return {
      ...base,
      isManaged: true,
      agent: key,
      alias: routeModel ? resolved.alias : undefined,
      effort: routeEffort ? effort : undefined,
      usedFallback: resolved.usedFallback,
      reasons,
    }
  }

  if (!config.routing.subagents.routeTypes.includes(ctx.subagentType)) return base

  const called = aliasOf(ctx.callModel)
  let want: Alias | undefined
  const reasons: string[] = []
  if (called !== undefined) {
    // The call named a model: kept, unless a risk floor asks for more.
    if (ideal.floorAlias !== undefined && aliasRank(ideal.floorAlias) > aliasRank(called)) {
      want = ideal.floorAlias
      reasons.push(`risk floor lifts ${called} to ${want}`)
    }
  } else {
    want = ideal.alias
  }
  if (want === undefined) {
    return { ...base, isManaged: true, effort: routeEffort ? ideal.effort : undefined, reasons }
  }
  const resolved = resolveAlias(config, want, undefined, ctx.availability)
  return {
    ...base,
    isManaged: true,
    alias: routeModel ? resolved.alias : undefined,
    effort: routeEffort ? ideal.effort : undefined,
    usedFallback: resolved.usedFallback,
    reasons,
  }
}

// ----------------------------------------------------------- escalation

/**
 * One tier up for a task that failed on substance: the next stronger usable
 * model among the tiers, and one more effort level. At the top tier only the
 * effort moves; with nothing left to raise the answer is undefined.
 */
export function escalate(
  config: RouterConfig,
  alias: Alias | undefined,
  effort: Effort | undefined,
  availability: Availability,
): { alias?: Alias; effort: Effort; note: string } | undefined {
  const ladder = [...new Set(TIERS.map(tier => config.tiers[tier].model))].sort((a, b) => aliasRank(a) - aliasRank(b))
  const at = alias === undefined ? -1 : aliasRank(alias)
  const next = ladder.find(candidate => aliasRank(candidate) > at && isUsable(candidate, availability))
  const from = effort ?? 'medium'
  const raised = bumpEffort(from, 1, config.effortLimits)
  if (next === undefined && raised === from) return undefined
  if (next === undefined) return { effort: raised, note: `effort ${from} -> ${raised} (already on the strongest model)` }
  return { alias: next, effort: raised, note: `${alias ?? 'session model'} -> ${next}, effort ${from} -> ${raised}` }
}

// ---------------------------------------------------------------- misses

function ladderOf(config: RouterConfig): Alias[] {
  return [...new Set(TIERS.map(tier => config.tiers[tier].model))].sort((a, b) => aliasRank(a) - aliasRank(b))
}

/**
 * The person said the answer missed. The task keeps its route and moves up a
 * step: the first miss raises the effort alone, which keeps the prompt cache;
 * from the second the model moves one tier up as well. Where the effort has
 * no level left the model moves at once. A model or an effort the router is
 * not sending here (pinned by the person, or routing off) is left alone.
 * `held` is what the task runs on now, where an earlier escalation put it
 * above the plan.
 */
export function applyMiss(
  decision: Decision,
  config: RouterConfig,
  ctx: { misses: number; held: { alias?: Alias; effort?: Effort }; availability: Availability },
): { decision: Decision; note: string } {
  let alias = decision.alias
  if (alias !== undefined && ctx.held.alias !== undefined && aliasRank(ctx.held.alias) > aliasRank(alias)) alias = ctx.held.alias
  let effort = decision.effort
  if (effort !== undefined && ctx.held.effort !== undefined) effort = maxEffort(effort, ctx.held.effort)

  const moves: string[] = []
  const raiseEffort = (): boolean => {
    if (effort === undefined) return false
    const raised = bumpEffort(effort, 1, config.effortLimits)
    if (raised === effort) return false
    moves.push(`effort ${effort} -> ${raised}`)
    effort = raised
    return true
  }
  const raiseModel = (): boolean => {
    if (alias === undefined) return false
    const at = aliasRank(alias)
    const next = ladderOf(config).find(candidate => aliasRank(candidate) > at && isUsable(candidate, ctx.availability))
    if (next === undefined) return false
    moves.push(`${alias} -> ${next}`)
    alias = next
    return true
  }
  if (ctx.misses <= 1) {
    if (!raiseEffort()) raiseModel()
  } else {
    raiseModel()
    raiseEffort()
  }

  const note =
    moves.length === 0
      ? `miss ${ctx.misses}: nothing stronger is left to route to; a fresh chat with a handoff is the next step`
      : `miss ${ctx.misses}: ${moves.join(', ')}`
  const targetAlias = alias !== undefined && aliasRank(alias) > aliasRank(decision.targetAlias) ? alias : decision.targetAlias
  const targetEffort = effort === undefined ? decision.targetEffort : maxEffort(decision.targetEffort, effort)
  const tier = targetAlias === decision.targetAlias ? decision.tier : tierOfAlias(config, targetAlias)
  return {
    note,
    decision: {
      ...decision,
      tier,
      agent: tier,
      targetAlias,
      targetEffort,
      alias,
      effort,
      modelAction: alias !== decision.alias ? 'upgrade' : decision.modelAction,
      effortAction: effort !== decision.effort ? 'raise' : decision.effortAction,
      reasons: [...decision.reasons, note],
      explanation: `${decision.explanation} · ${note}`,
    },
  }
}

// -------------------------------------------------------- queued prompts

/**
 * Two prompts waiting for one turn: nothing says which of them the turn will
 * read, so the later plan is kept and is never weaker than the earlier one.
 */
export function keepStronger(later: Decision, earlier: Decision): Decision {
  const alias =
    later.alias !== undefined && earlier.alias !== undefined && aliasRank(earlier.alias) > aliasRank(later.alias) ? earlier.alias : later.alias
  const effort =
    later.effort !== undefined && earlier.effort !== undefined && effortRank(earlier.effort) > effortRank(later.effort) ? earlier.effort : later.effort
  const isEarlierHarder = aliasRank(earlier.targetAlias) > aliasRank(later.targetAlias)
  const targetEffort = maxEffort(later.targetEffort, earlier.targetEffort)
  const reviewRequired = later.reviewRequired || earlier.reviewRequired
  const risk = riskRank(earlier.risk) > riskRank(later.risk) ? earlier.risk : later.risk
  const isSame =
    alias === later.alias && effort === later.effort && !isEarlierHarder && targetEffort === later.targetEffort && reviewRequired === later.reviewRequired && risk === later.risk
  if (isSame) return later
  const note = 'queued prompts: the stronger route is kept'
  return {
    ...later,
    tier: isEarlierHarder ? earlier.tier : later.tier,
    agent: isEarlierHarder ? earlier.agent : later.agent,
    targetAlias: isEarlierHarder ? earlier.targetAlias : later.targetAlias,
    targetEffort,
    alias,
    effort,
    risk,
    reviewRequired,
    floors: [...new Set([...later.floors, ...earlier.floors])],
    reasons: [...later.reasons, note],
    explanation: `${later.explanation} · ${note}`,
  }
}
