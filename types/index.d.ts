// Auto Router: the type contract. Every value the mod keeps in `$.state` is
// declared here (PluginState, at the bottom), with the plain-data types the
// engine modules, the hooks module and the pane share. No imports: this file
// is read by `claude plugin validate` as the mod's contract.

export type Alias = 'fable' | 'opus' | 'sonnet' | 'haiku'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type TierName = 'prepCook' | 'lineCook' | 'sousChef' | 'headChef'
export type AgentKey = TierName | 'reviewer'
export type Complexity = 'simple' | 'standard' | 'complex' | 'critical' | 'exceptional'
export type Risk = 'low' | 'medium' | 'high' | 'critical'
export type Ambiguity = 'low' | 'medium' | 'high'
export type Scope = 'local' | 'multi' | 'broad'
export type BudgetMode = 'economical' | 'balanced' | 'quality'
export type EventStatus = 'PENDING' | 'RUNNING' | 'OK' | 'ERR' | 'BLOCKED'
export type EventKind = 'route' | 'model' | 'tool' | 'agent' | 'guard' | 'config' | 'usage' | 'system'
export type ToolCategory = 'read' | 'edit' | 'write' | 'shell' | 'mcp' | 'agent' | 'web' | 'other'
export type ReviewMode = 'remind' | 'off'

// ---------------------------------------------------------------- config

export type TierConfig = { model: Alias; fallback?: Alias }
export type FloorConfig = { minTier: TierName; minEffort: Effort }
export type ModelCost = { in: number; out: number; cacheRead: number }

/** One routing override: every field given must match; then tier/model/effort apply (floors still hold). */
export type OverrideRule = {
  domain?: string
  complexity?: Complexity
  risk?: Risk
  tier?: TierName
  model?: Alias
  effort?: Effort
  note?: string
}

export type RouterConfig = {
  $schema?: string
  version: 1
  enabled: boolean
  autonomous: boolean
  budgetMode: BudgetMode
  tiers: {
    headChef: TierConfig
    sousChef: TierConfig
    lineCook: TierConfig
    prepCook: TierConfig
    reviewer: TierConfig
  }
  effortBounds: {
    simple: Effort
    standard: Effort
    complex: Effort
    critical: Effort
    exceptional: Effort
  }
  effortLimits: { min: Effort; max: Effort }
  routing: {
    mainSession: { routeModel: boolean; routeEffort: boolean; cacheAware: boolean }
    subagents: { routeModel: boolean; routeEffort: boolean; routeTypes: string[] }
    headChef: { domains: string[]; exceptional: boolean }
    overrides: OverrideRule[]
    minConfidenceForPrepCook: number
  }
  riskFloors: {
    securitySensitive: FloorConfig
    highImpact: FloorConfig
    criticalImpact: FloorConfig
    ambiguousHighRisk: FloorConfig
    uncertain: FloorConfig
  }
  guardrails: {
    maxParallelAgents: number
    defaultParallelAgents: number
    autoEscalateAfterFailures: number
    maxEscalationsPerTask: number
    identicalFailureLimit: number
    independentReview: boolean
    reviewMode: ReviewMode
    confirmDestructive: boolean
    respectUserPins: boolean
  }
  fallback: { cooldownMinutes: number }
  judge: {
    mode: 'always' | 'uncertain' | 'off'
    model: Alias
    timeoutMs: number
    uncertainBelow: number
    minConfidenceToLower: number
    /** Also judge a routed subagent's task when the call named no model. */
    subagents: boolean
  }
  learning: { enabled: boolean; window: number; bumpAfter: number }
  cache: { ttlMinutes: number; switchMargin: number; returnRisk: number; writeMultiplier: number }
  costModel: { fable: ModelCost; opus: ModelCost; sonnet: ModelCost; haiku: ModelCost }
  ultracode: { keepEffortFloor: boolean }
  sessions: { protected: string[] }
  sidePanel: { enabled: boolean; autoOpen: boolean; position: 'right' }
  telemetry: {
    enabled: boolean
    maxEvents: number
    redactSecrets: boolean
    promptPreview: boolean
    historyDays: number
  }
}

export type ConfigPatch = { path: string; value: unknown }
export type ConfigChange = { path: string; from: unknown; to: unknown }

// -------------------------------------------------------- classification

export type Classification = {
  complexity: Complexity
  risk: Risk
  ambiguity: Ambiguity
  scope: Scope
  domains: string[]
  confidence: number
  signals: string[]
  explicit: {
    model?: Alias
    effort?: Effort
    ultrathink?: boolean
    noSubagents?: boolean
    wantAgents?: boolean
  }
  continuation: boolean
  /** The prompt says the last answer was wrong or asks for it to be done again. */
  miss: boolean
  /** The prompt asks to be told or shown something; nothing is to be built or changed. */
  readOnly: boolean
  needsVerification: boolean
  delegation: { suggested: boolean; agents: AgentKey[]; parallel: number; reason: string }
  wordCount: number
}

/** What the router decided for one task: where it should run and why. */
export type Decision = {
  tier: TierName
  agent: AgentKey
  /** The model the task ideally runs on. */
  targetAlias: Alias
  targetEffort: Effort
  /** The model the router sends; absent: the engine's own model stands. */
  alias?: Alias
  /** The effort the router sends; absent: the engine's own effort stands. */
  effort?: Effort
  modelAction:
    | 'initial'
    | 'keep'
    | 'upgrade'
    | 'downgrade'
    | 'hold-cache'
    | 'pinned'
    | 'explicit'
    | 'unavailable'
    | 'off'
  effortAction: 'set' | 'keep' | 'raise' | 'lower' | 'hold-cache' | 'pinned' | 'explicit' | 'off'
  usedFallback: boolean
  floors: string[]
  reasons: string[]
  explanation: string
  complexity: Complexity
  risk: Risk
  ambiguity: Ambiguity
  domains: string[]
  confidence: number
  reviewRequired: boolean
  delegation: { suggested: boolean; agents: AgentKey[]; parallel: number; reason: string }
}

// ------------------------------------------------------------ live state

export type Totals = { req: number; in: number; out: number; cr: number; cw: number }

export type RouteState = {
  turnId?: string
  title: string
  startedAt: number
  endedAt?: number
  tier: TierName
  agent: AgentKey
  targetAlias: Alias
  targetEffort: Effort
  alias?: Alias
  effort?: Effort
  modelAction: string
  effortAction: string
  explanation: string
  floors: string[]
  complexity: Complexity
  risk: Risk
  ambiguity: Ambiguity
  domains: string[]
  confidence: number
  reviewRequired: boolean
  review: 'none' | 'required' | 'running' | 'done' | 'missed'
  reviewVerdict?: string
  delegation?: string
  /** What the engine would have sent with no router. */
  engineModel?: string
  engineEffort?: string
  /** What the API reported for the last response: the evidence. */
  actualModel?: string
  sentModel?: string
  sentEffort?: string
  status: 'pending' | 'running' | 'done' | 'error' | 'aborted'
  usedFallback: boolean
  escalations: number
  lastEscalation?: string
  /** How many times the person said this task's answer missed. */
  misses?: number
  steps: number
}

export type CoreState = {
  paused: boolean
  pausedAt?: number
  blockedCount: number
  route?: RouteState
  pins: { model?: string; effort?: Effort }
  session: {
    baseModel?: string
    baseEffort?: string
    turns: number
    lastAlias?: Alias
    lastEffort?: Effort
    lastRequestAt?: number
    /** Last request time per model family: a cache entry is presumed warm for cache.ttlMinutes after it. */
    warm: { fable?: number; opus?: number; sonnet?: number; haiku?: number }
    contextTokens: number
    ultracode: boolean
    perMessageEffort: boolean
    engine: string
    surface?: string
    /** Why the router only observes in this session; absent: routing may act. */
    passive?: string
  }
  unavailable: Record<string, { until: number; reason: string }>
  /** Highest risk seen in the current task: the classification's, or a tool call's tag. */
  risk: Risk
  escalation: string
  note: string
  conflicts: string[]
  configError?: string
  configLoadedAt?: number
  seq: number
}

export type AgentRec = {
  key: string
  agentId?: string
  type: string
  agent?: AgentKey
  task: string
  /** The model the router (or the call) asked for. */
  assigned?: string
  /** The id the engine resolved at spawn. */
  resolved?: string
  /** The id the API reported: the evidence. */
  actual?: string
  effort?: string
  status: EventStatus
  startedAt: number
  endedAt?: number
  routed: boolean
  /** The model this agent would have run on with no router; set when the router changed it. */
  base?: string
  note?: string
  tokens: Totals
  escalations: number
}

export type ActivityEvent = {
  id: number
  t: number
  kind: EventKind
  status: EventStatus
  label: string
  cat?: ToolCategory
  tool?: string
  sessionId?: string
  turnId?: string
  agentId?: string
  toolUseId?: string
  ms?: number
}

/** One local day across the history: what ran, and the same tokens filed under the model that would have run with no router. */
export type DayUsage = {
  actual: Record<string, Totals>
  base: Record<string, Totals>
  /** Sessions with usage that day and no baseline record: left out of both. */
  skipped: number
}

export type RateLimitReading = { kind: string; percentUsed: number; resetsAt?: string }

export type UsageState = {
  startedAt?: number
  byModel: Record<string, Totals>
  byAgent: Record<string, Totals & { model?: string }>
  /** Each agent's totals split by the model that answered, so its cost can be priced. */
  byAgentModel?: Record<string, Record<string, Totals>>
  /** This session's totals per local day and model, as the weekly history stores them. */
  days: Record<string, Record<string, Totals>>
  /**
   * The same tokens per local day, filed under the model the engine would have
   * used with no router. A router-only request (the judge) is filed nowhere;
   * one whose engine model is not known is filed under `unknown`.
   */
  base?: Record<string, Record<string, Totals>>
  /** Usage was recorded in this session before `base` was kept: its savings cannot be worked out. */
  basePartial?: boolean
  context?: { tokens?: number; window: number; percent?: number }
  rateLimits?: RateLimitReading[]
  costUsd?: number
  measuredAt?: number
  weekly?: { days: number; byModel: Record<string, Totals>; sessions: number; computedAt: number }
  /** The last 30 local days, one entry per day, from the history file. */
  series?: { days: Record<string, DayUsage>; computedAt: number }
  lastFlushAt?: number
  flushError?: string
}

export type ViewName =
  | 'home'
  | 'settings'
  | 'agents'
  | 'agents-config'
  | 'activity'
  | 'usage'
  | 'guardrails'
  | 'config'

export type ViewState = {
  view: ViewName
  filter: 'all' | 'tools' | 'agents' | 'routing' | 'errors'
  page: number
}

export type UsageHistory = {
  version: 1
  sessions: Record<
    string,
    {
      startedAt: number
      updatedAt: number
      days: Record<string, Record<string, Totals>>
      base?: Record<string, Record<string, Totals>>
      partial?: boolean
    }
  >
  lastLimits?: { at: number; rateLimits: RateLimitReading[] }
}

declare module 'claude-code' {
  interface PluginState {
    'auto-router': {
      /** Pause flag, the current route, pins and what the session is known to be. */
      core: Shaped<CoreState>
      /** Which view the pane shows. */
      view: Shaped<ViewState>
      /** Subagents seen this session, active ones first. */
      agents: Shaped<AgentRec[]>
      /** The newest activity events: what the dashboard card draws. */
      feed: Shaped<ActivityEvent[]>
      /** The whole activity ring, up to telemetry.maxEvents; written less often. */
      log: Shaped<ActivityEvent[]>
      /** Token usage by actual model and by agent, and the last measurement. */
      usage: Shaped<UsageState>
    }
  }
}
