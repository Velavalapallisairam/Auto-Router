// Runtime constants shared by the engine modules. Pure data: no `$`, no I/O.

import type {
  AgentKey,
  Alias,
  Complexity,
  Effort,
  EventStatus,
  Risk,
  TierName,
} from '../../types'

export const NAME = 'auto-router'
export const PANE = 'auto-router'
export const TITLE = 'Auto Router'
export const CONFIG_TOOL = 'mcp__auto-router__configure'

/** Cheapest first: the order model capability is compared in. */
export const ALIASES: readonly Alias[] = ['haiku', 'sonnet', 'opus', 'fable']
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const TIERS: readonly TierName[] = ['prepCook', 'lineCook', 'sousChef', 'headChef']
export const AGENT_KEYS: readonly AgentKey[] = [
  'headChef',
  'sousChef',
  'lineCook',
  'prepCook',
  'reviewer',
]
export const COMPLEXITIES: readonly Complexity[] = [
  'simple',
  'standard',
  'complex',
  'critical',
  'exceptional',
]
export const RISKS: readonly Risk[] = ['low', 'medium', 'high', 'critical']
export const STATUSES: readonly EventStatus[] = ['PENDING', 'RUNNING', 'OK', 'ERR', 'BLOCKED']

export const DOMAINS: readonly string[] = [
  'architecture',
  'security',
  'frontend',
  'backend',
  'database',
  'infra',
  'debugging',
  'testing',
  'docs',
  'research',
  'data',
  'mechanical',
  'search',
  'summary',
]

/**
 * The first engine release where a `turn.step` hook may name a model by its
 * alias (`haiku`); before it an alias went out as written and the request failed.
 */
export const MIN_ENGINE_FOR_MAIN_MODEL = '2.1.309'

/** How many events the dashboard card's feed keeps; the full ring is `telemetry.maxEvents`. */
export const FEED_SIZE = 40
export const AGENT_HISTORY = 24

export const PAUSED_DENY =
  'Auto Router is paused by the user, so this tool call was not run. Do not retry it or call other tools. ' +
  'Tell the user the session is paused and that the Resume button in the Auto Router pane or /auto-router resume continues it.'
