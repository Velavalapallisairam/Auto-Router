// The router's configuration: defaults, the JSON schema, a validator for it,
// path patches, and a small parser for the plain-English changes a person
// types after `/auto-router config`. Pure: no `$`, no I/O. The hooks module
// reads and writes the file; this module only says what a valid one is.

import type { Alias, ConfigChange, ConfigPatch, RouterConfig } from '../../types'
import { ALIASES, COMPLEXITIES, DOMAINS, EFFORTS, RISKS, TIERS } from './consts.ts'

export const CONFIG_VERSION = 1

/**
 * The defaults. `costModel` holds relative routing weights taken from the
 * published per-million-token list prices (cached 2026-11-03); they steer the
 * cache-aware switching rule only and are never shown as a cost or a saving.
 * Haiku's cache-read weight is an assumption (a tenth of its input price);
 * its higher price for a prompt over 100K tokens is counted in the routing
 * engine, not here.
 */
export function defaultConfig(): RouterConfig {
  return {
    $schema: './config.schema.json',
    version: 1,
    enabled: true,
    autonomous: true,
    budgetMode: 'balanced',
    tiers: {
      headChef: { model: 'fable', fallback: 'opus' },
      sousChef: { model: 'opus', fallback: 'sonnet' },
      lineCook: { model: 'sonnet', fallback: 'haiku' },
      prepCook: { model: 'haiku', fallback: 'sonnet' },
      reviewer: { model: 'opus' },
    },
    effortBounds: {
      simple: 'low',
      standard: 'medium',
      complex: 'high',
      critical: 'xhigh',
      exceptional: 'max',
    },
    effortLimits: { min: 'low', max: 'max' },
    routing: {
      mainSession: { routeModel: true, routeEffort: true, cacheAware: true },
      subagents: { routeModel: true, routeEffort: true, routeTypes: ['general-purpose', 'claude'] },
      headChef: { domains: ['architecture', 'security'], exceptional: true },
      overrides: [],
      minConfidenceForPrepCook: 0.6,
    },
    riskFloors: {
      securitySensitive: { minTier: 'sousChef', minEffort: 'high' },
      highImpact: { minTier: 'sousChef', minEffort: 'high' },
      criticalImpact: { minTier: 'sousChef', minEffort: 'xhigh' },
      ambiguousHighRisk: { minTier: 'sousChef', minEffort: 'high' },
      // Unsure means the stronger model at once: a wrong cheap start costs more than it saves.
      uncertain: { minTier: 'sousChef', minEffort: 'high' },
    },
    guardrails: {
      maxParallelAgents: 2,
      defaultParallelAgents: 1,
      autoEscalateAfterFailures: 2,
      maxEscalationsPerTask: 2,
      identicalFailureLimit: 2,
      independentReview: true,
      reviewMode: 'remind',
      confirmDestructive: false,
      respectUserPins: true,
    },
    fallback: { cooldownMinutes: 10 },
    judge: { mode: 'always', model: 'haiku', timeoutMs: 6000, uncertainBelow: 0.75, minConfidenceToLower: 0.8, subagents: true },
    learning: { enabled: true, window: 6, bumpAfter: 2 },
    cache: { ttlMinutes: 5, switchMargin: 0.15, returnRisk: 0.5, writeMultiplier: 1.25 },
    costModel: {
      fable: { in: 8, out: 40, cacheRead: 0.2 },
      opus: { in: 4, out: 20, cacheRead: 0.2 },
      sonnet: { in: 2, out: 10, cacheRead: 0.1 },
      haiku: { in: 0.1, out: 0.5, cacheRead: 0.01 },
    },
    ultracode: { keepEffortFloor: true },
    sessions: { protected: [] },
    sidePanel: { enabled: true, autoOpen: true, position: 'right' },
    telemetry: {
      enabled: true,
      maxEvents: 500,
      redactSecrets: true,
      promptPreview: true,
      historyDays: 35,
    },
  }
}

// ---------------------------------------------------------------- schema

type Schema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean'
  description?: string
  enum?: readonly (string | number | boolean)[]
  const?: string | number | boolean
  properties?: Record<string, Schema>
  required?: readonly string[]
  additionalProperties?: boolean
  items?: Schema
  minimum?: number
  maximum?: number
  maxItems?: number
  maxLength?: number
  pattern?: string
  [annotation: string]: unknown
}

const alias: Schema = { type: 'string', enum: ALIASES }
const effort: Schema = { type: 'string', enum: EFFORTS }
const tierName: Schema = { type: 'string', enum: TIERS }
const flag = (description: string): Schema => ({ type: 'boolean', description })

const tier = (description: string): Schema => ({
  type: 'object',
  description,
  properties: {
    model: { ...alias, description: 'The model alias this agent runs on.' },
    fallback: { ...alias, description: 'Used only while the model is unavailable or not allowed.' },
  },
  required: ['model'],
  additionalProperties: false,
})

const floor = (description: string): Schema => ({
  type: 'object',
  description,
  properties: { minTier: tierName, minEffort: effort },
  required: ['minTier', 'minEffort'],
  additionalProperties: false,
})

const cost: Schema = {
  type: 'object',
  properties: {
    in: { type: 'number', minimum: 0 },
    out: { type: 'number', minimum: 0 },
    cacheRead: { type: 'number', minimum: 0 },
  },
  required: ['in', 'out', 'cacheRead'],
  additionalProperties: false,
}

/** The schema `config.schema.json` is written from, and the one the validator walks. */
export const CONFIG_SCHEMA: Schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'auto-router/config.schema.json',
  title: 'Auto Router configuration',
  type: 'object',
  properties: {
    $schema: { type: 'string' },
    version: { type: 'integer', const: 1, description: 'The configuration format.' },
    enabled: flag('The global switch. Off: every request goes out as Claude Code set it.'),
    autonomous: flag('On: the router applies its choice. Off: it only shows what it would choose.'),
    budgetMode: {
      type: 'string',
      enum: ['economical', 'balanced', 'quality'],
      description: 'How hard the router leans toward cheaper models. No mode lowers a risk floor.',
    },
    tiers: {
      type: 'object',
      properties: {
        headChef: tier('Complex architecture, security and exceptional reasoning.'),
        sousChef: tier('Advanced development, debugging and difficult research.'),
        lineCook: tier('Standard development, testing and routine work.'),
        prepCook: tier('Simple searches, summaries and repetitive operations.'),
        reviewer: tier('The independent reviewer: fresh context, read-only tools.'),
      },
      required: ['headChef', 'sousChef', 'lineCook', 'prepCook', 'reviewer'],
      additionalProperties: false,
    },
    effortBounds: {
      type: 'object',
      description: 'The effort each task complexity starts from, before floors and limits.',
      properties: {
        simple: effort,
        standard: effort,
        complex: effort,
        critical: effort,
        exceptional: effort,
      },
      required: ['simple', 'standard', 'complex', 'critical', 'exceptional'],
      additionalProperties: false,
    },
    effortLimits: {
      type: 'object',
      description: 'The lowest and highest effort the router may ask for.',
      properties: { min: effort, max: effort },
      required: ['min', 'max'],
      additionalProperties: false,
    },
    routing: {
      type: 'object',
      properties: {
        mainSession: {
          type: 'object',
          properties: {
            routeModel: flag('Route the main conversation model.'),
            routeEffort: flag('Route the main conversation effort.'),
            cacheAware: flag('Weigh the prompt cache before moving to a cheaper model or a lower effort.'),
          },
          required: ['routeModel', 'routeEffort', 'cacheAware'],
          additionalProperties: false,
        },
        subagents: {
          type: 'object',
          properties: {
            routeModel: flag('Pick the model of each routed subagent.'),
            routeEffort: flag('Pick the effort of each routed subagent.'),
            routeTypes: {
              type: 'array',
              description: 'Agent types, beside the five specialists, whose model the router picks.',
              items: { type: 'string', maxLength: 128 },
              maxItems: 32,
            },
          },
          required: ['routeModel', 'routeEffort', 'routeTypes'],
          additionalProperties: false,
        },
        headChef: {
          type: 'object',
          description: 'When the top tier is used.',
          properties: {
            domains: { type: 'array', items: { type: 'string', enum: DOMAINS }, maxItems: 14 },
            exceptional: flag('Also use the top tier for exceptional reasoning in any domain.'),
          },
          required: ['domains', 'exceptional'],
          additionalProperties: false,
        },
        overrides: {
          type: 'array',
          description: 'Rules read in order: when every field given matches, the tier, model or effort applies. Risk floors still hold.',
          maxItems: 32,
          items: {
            type: 'object',
            properties: {
              domain: { type: 'string', enum: DOMAINS },
              complexity: { type: 'string', enum: COMPLEXITIES },
              risk: { type: 'string', enum: RISKS },
              tier: tierName,
              model: alias,
              effort,
              note: { type: 'string', maxLength: 200 },
            },
            additionalProperties: false,
          },
        },
        minConfidenceForPrepCook: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['mainSession', 'subagents', 'headChef', 'overrides', 'minConfidenceForPrepCook'],
      additionalProperties: false,
    },
    riskFloors: {
      type: 'object',
      description: 'Minimum model tier and effort by risk. Budget modes never lower these.',
      properties: {
        securitySensitive: floor('Security-sensitive work.'),
        highImpact: floor('High-risk work: production, money, regulated data.'),
        criticalImpact: floor('Critical risk: destructive or irreversible changes.'),
        ambiguousHighRisk: floor('A vague request that touches something high-risk.'),
        uncertain: floor('A task the classifier is unsure of.'),
      },
      required: ['securitySensitive', 'highImpact', 'criticalImpact', 'ambiguousHighRisk', 'uncertain'],
      additionalProperties: false,
    },
    guardrails: {
      type: 'object',
      properties: {
        maxParallelAgents: { type: 'integer', minimum: 1, maximum: 2, description: 'A spawn past this many running subagents is refused.' },
        defaultParallelAgents: { type: 'integer', minimum: 1, maximum: 2 },
        autoEscalateAfterFailures: { type: 'integer', minimum: 1, maximum: 10, description: 'Substantive failures before a task moves up one tier.' },
        maxEscalationsPerTask: { type: 'integer', minimum: 0, maximum: 3 },
        identicalFailureLimit: { type: 'integer', minimum: 2, maximum: 10, description: 'Repeats of one failing call before the model is told to stop retrying it.' },
        independentReview: flag('Ask for an independent review when the risk calls for one.'),
        reviewMode: { type: 'string', enum: ['remind', 'off'] },
        confirmDestructive: flag('Also ask before a destructive or production command that a rule would allow. Only ever tightens.'),
        respectUserPins: flag('A model or effort picked mid-session is kept until routing is turned on again.'),
      },
      required: [
        'maxParallelAgents',
        'defaultParallelAgents',
        'autoEscalateAfterFailures',
        'maxEscalationsPerTask',
        'identicalFailureLimit',
        'independentReview',
        'reviewMode',
        'confirmDestructive',
        'respectUserPins',
      ],
      additionalProperties: false,
    },
    fallback: {
      type: 'object',
      properties: { cooldownMinutes: { type: 'number', minimum: 1, maximum: 1440 } },
      required: ['cooldownMinutes'],
      additionalProperties: false,
    },
    judge: {
      type: 'object',
      description: 'The semantic judge: a small model reads each new task for what it means. It may raise difficulty or risk freely and lower difficulty only when confident.',
      properties: {
        mode: { type: 'string', enum: ['always', 'uncertain', 'off'], description: 'always: every new task. uncertain: only when the local rules are unsure. off: rules alone.' },
        model: { ...alias, description: 'The model that judges. One short request per judged task.' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000 },
        uncertainBelow: { type: 'number', minimum: 0, maximum: 1 },
        minConfidenceToLower: { type: 'number', minimum: 0.5, maximum: 1 },
        subagents: flag('Also judge the task of a routed subagent whose call named no model. One short request per such subagent.'),
      },
      required: ['mode', 'model', 'timeoutMs', 'uncertainBelow', 'minConfidenceToLower', 'subagents'],
      additionalProperties: false,
    },
    learning: {
      type: 'object',
      description: 'Kinds of task that kept needing escalation start one tier up. Counts only; no prompt is kept.',
      properties: {
        enabled: flag('Learn from escalations and failed turns.'),
        window: { type: 'integer', minimum: 2, maximum: 20 },
        bumpAfter: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['enabled', 'window', 'bumpAfter'],
      additionalProperties: false,
    },
    cache: {
      type: 'object',
      properties: {
        ttlMinutes: { type: 'number', minimum: 1, maximum: 120 },
        switchMargin: { type: 'number', minimum: 0, maximum: 0.9 },
        returnRisk: { type: 'number', minimum: 0, maximum: 1 },
        writeMultiplier: { type: 'number', minimum: 1, maximum: 3 },
      },
      required: ['ttlMinutes', 'switchMargin', 'returnRisk', 'writeMultiplier'],
      additionalProperties: false,
    },
    costModel: {
      type: 'object',
      description: 'Relative routing weights per model. Not billing data.',
      properties: { fable: cost, opus: cost, sonnet: cost, haiku: cost },
      required: ['fable', 'opus', 'sonnet', 'haiku'],
      additionalProperties: false,
    },
    ultracode: {
      type: 'object',
      properties: { keepEffortFloor: flag('With Ultracode on, never send less effort than the session runs at.') },
      required: ['keepEffortFloor'],
      additionalProperties: false,
    },
    sessions: {
      type: 'object',
      properties: {
        protected: {
          type: 'array',
          description: 'Session ids the router only observes: no model, effort or subagent change.',
          items: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
          maxItems: 200,
        },
      },
      required: ['protected'],
      additionalProperties: false,
    },
    sidePanel: {
      type: 'object',
      properties: {
        enabled: flag('Draw the Auto Router pane.'),
        autoOpen: flag('Open the pane when a session starts, unless it was closed by hand.'),
        position: { type: 'string', enum: ['right'], description: 'Docked beside the conversation where the surface has room; above the prompt otherwise.' },
      },
      required: ['enabled', 'autoOpen', 'position'],
      additionalProperties: false,
    },
    telemetry: {
      type: 'object',
      properties: {
        enabled: flag('Record activity and usage.'),
        maxEvents: { type: 'integer', minimum: 50, maximum: 2000 },
        redactSecrets: flag('Mask anything that looks like a credential before it is kept.'),
        promptPreview: flag('Keep a short, redacted title of the current task.'),
        historyDays: { type: 'integer', minimum: 7, maximum: 120 },
      },
      required: ['enabled', 'maxEvents', 'redactSecrets', 'promptPreview', 'historyDays'],
      additionalProperties: false,
    },
  },
  required: [
    'version',
    'enabled',
    'autonomous',
    'budgetMode',
    'tiers',
    'effortBounds',
    'effortLimits',
    'routing',
    'riskFloors',
    'guardrails',
    'fallback',
    'judge',
    'learning',
    'cache',
    'costModel',
    'ultracode',
    'sessions',
    'sidePanel',
    'telemetry',
  ],
  additionalProperties: false,
}

// ------------------------------------------------------------- validator

function kindOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function check(schema: Schema, value: unknown, path: string, errors: string[]): void {
  const at = path === '' ? 'config' : path
  if (schema.type !== undefined) {
    const kind = kindOf(value)
    const isRight =
      schema.type === 'integer'
        ? typeof value === 'number' && Number.isInteger(value)
        : schema.type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : kind === schema.type
    if (!isRight) {
      errors.push(`${at}: expected ${schema.type}, got ${kind}`)
      return
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${at}: must be ${JSON.stringify(schema.const)}`)
  }
  if (schema.enum !== undefined && !schema.enum.includes(value as string)) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`)
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: ${value} is below ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: ${value} is above ${schema.maximum}`)
  }
  if (typeof value === 'string') {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength} characters`)
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match ${schema.pattern}`)
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`)
    if (schema.items !== undefined) {
      value.forEach((item, index) => check(schema.items as Schema, item, `${path}[${index}]`, errors))
    }
  }
  if (isPlainObject(value) && schema.properties !== undefined) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path === '' ? key : `${path}.${key}`}: is required`)
    }
    for (const [key, child] of Object.entries(value)) {
      const sub = schema.properties[key]
      const childPath = path === '' ? key : `${path}.${key}`
      if (sub === undefined) {
        if (schema.additionalProperties === false) errors.push(`${childPath}: is not a known setting`)
      } else {
        check(sub, child, childPath, errors)
      }
    }
  }
}

function rankOf<T>(order: readonly T[], value: T): number {
  return order.indexOf(value)
}

/** Rules the schema cannot say: relations between settings. */
function checkRelations(config: RouterConfig, errors: string[]): void {
  if (rankOf(EFFORTS, config.effortLimits.min) > rankOf(EFFORTS, config.effortLimits.max)) {
    errors.push('effortLimits: min is above max')
  }
  if (config.guardrails.defaultParallelAgents > config.guardrails.maxParallelAgents) {
    errors.push('guardrails.defaultParallelAgents: is above guardrails.maxParallelAgents')
  }
  for (const [name, tierConfig] of Object.entries(config.tiers)) {
    if (tierConfig.fallback !== undefined && tierConfig.fallback === tierConfig.model) {
      errors.push(`tiers.${name}.fallback: is the same model as tiers.${name}.model`)
    }
  }
  config.routing.overrides.forEach((rule, index) => {
    if (rule.tier === undefined && rule.model === undefined && rule.effort === undefined) {
      errors.push(`routing.overrides[${index}]: sets no tier, model or effort`)
    }
    if (rule.domain === undefined && rule.complexity === undefined && rule.risk === undefined) {
      errors.push(`routing.overrides[${index}]: matches every task; give a domain, complexity or risk`)
    }
  })
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Fills what `given` leaves out from the defaults, key by key; arrays and
 * scalars are taken whole. A tier is taken whole too: one written without a
 * fallback has none, it does not inherit the default's.
 */
function fill(base: unknown, given: unknown, path = ''): unknown {
  if (!isPlainObject(base) || !isPlainObject(given)) return given === undefined ? base : given
  if (/^tiers\.[A-Za-z]+$/.test(path)) return given
  const out: Record<string, unknown> = { ...given }
  for (const [key, value] of Object.entries(base)) {
    out[key] = key in given ? fill(value, given[key], path === '' ? key : `${path}.${key}`) : value
  }
  return out
}

export type Validation =
  | { isValid: true; config: RouterConfig; errors: [] }
  | { isValid: false; config?: undefined; errors: string[] }

/**
 * Validates a parsed configuration. Settings a file leaves out take their
 * defaults; a setting the schema does not know, or a value it refuses, is an
 * error naming its path, so a bad edit is never silently dropped.
 */
export function validateConfig(value: unknown): Validation {
  if (!isPlainObject(value)) {
    return { isValid: false, errors: [`config: expected object, got ${kindOf(value)}`] }
  }
  const filled = fill(defaultConfig(), value) as RouterConfig
  const errors: string[] = []
  check(CONFIG_SCHEMA, filled, '', errors)
  if (errors.length === 0) checkRelations(filled, errors)
  if (errors.length > 0) return { isValid: false, errors }
  return { isValid: true, config: filled, errors: [] }
}

/** Parses and validates a configuration file's text. */
export function parseConfig(text: string): Validation {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { isValid: false, errors: [`config: not valid JSON (${String((error as Error).message).slice(0, 120)})`] }
  }
  return validateConfig(parsed)
}

export function serializeConfig(config: RouterConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

export function schemaText(): string {
  return `${JSON.stringify(CONFIG_SCHEMA, null, 2)}\n`
}

// --------------------------------------------------------------- patches

function schemaAt(path: string): Schema | undefined {
  let node: Schema | undefined = CONFIG_SCHEMA
  for (const part of path.split('.')) {
    if (node?.properties === undefined) return undefined
    node = node.properties[part]
  }
  return node
}

function getAt(root: unknown, path: string): unknown {
  let node: unknown = root
  for (const part of path.split('.')) {
    if (!isPlainObject(node)) return undefined
    node = node[part]
  }
  return node
}

function setAt(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let node: Record<string, unknown> = root
  for (const part of parts.slice(0, -1)) {
    const next = node[part]
    if (!isPlainObject(next)) return
    node = next
  }
  const last = parts[parts.length - 1]
  if (last !== undefined) node[last] = value
}

export type PatchResult =
  | { isValid: true; config: RouterConfig; changes: ConfigChange[]; errors: [] }
  | { isValid: false; errors: string[] }

/**
 * Applies changes by dotted path (`guardrails.maxParallelAgents`) to a copy
 * of `config` and validates the result. Only the named paths change; a path
 * the schema does not know is refused, as is any value it does not accept.
 */
export function applyPatches(config: RouterConfig, patches: readonly ConfigPatch[]): PatchResult {
  const next = clone(config) as unknown as Record<string, unknown>
  const errors: string[] = []
  const changes: ConfigChange[] = []
  if (patches.length === 0) return { isValid: false, errors: ['no change was given'] }
  for (const patch of patches) {
    if (typeof patch.path !== 'string' || !/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/.test(patch.path)) {
      errors.push(`${String(patch.path)}: not a setting path`)
      continue
    }
    if (patch.path === 'version' || patch.path === '$schema') {
      errors.push(`${patch.path}: cannot be changed`)
      continue
    }
    if (schemaAt(patch.path) === undefined) {
      errors.push(`${patch.path}: is not a known setting`)
      continue
    }
    if (patch.value === undefined) {
      errors.push(`${patch.path}: no value given`)
      continue
    }
    const from = getAt(next, patch.path)
    setAt(next, patch.path, clone(patch.value))
    if (JSON.stringify(from) !== JSON.stringify(patch.value)) {
      changes.push({ path: patch.path, from, to: patch.value })
    }
  }
  if (errors.length > 0) return { isValid: false, errors }
  const checked = validateConfig(next)
  if (!checked.isValid) return { isValid: false, errors: checked.errors }
  return { isValid: true, config: checked.config, changes, errors: [] }
}

/** Settings that weaken a guardrail or the session protection: a model's change to one is always put to the person. */
export const SENSITIVE_PATHS: readonly string[] = [
  'enabled',
  'riskFloors',
  'guardrails',
  'sessions',
  'telemetry.redactSecrets',
  'routing.headChef',
]

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATHS.some(root => path === root || path.startsWith(`${root}.`))
}

// --------------------------------------------- plain-English requests

const MODEL_WORD = '(fable|opus|sonnet|haiku)'
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, '1': 1, '2': 2, three: 3, '3': 3, four: 4, '4': 4 }

export type RequestResult =
  | { isUnderstood: true; patches: ConfigPatch[]; summary: string }
  | { isUnderstood: false; reason: string }

/**
 * Turns a common plain-English request into patches, with no model call:
 * "switch to economical mode", "limit parallel agents to one", "disable the
 * dashboard", "use opus for complex frontend work", "use fable only for
 * architecture and security", "require independent reviews for high-risk
 * changes". Anything else is not understood, and says so.
 */
export function parseRequest(text: string, config: RouterConfig): RequestResult {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')
  if (t === '') return { isUnderstood: false, reason: 'no request given' }

  const mode = /\b(economical|economy|balanced|quality)\b(?: (?:mode|profile|budget))?/.exec(t)
  if (mode !== null && /\b(?:switch|change|set|use|go|move|budget|profile|mode)\b/.test(t) && !new RegExp(MODEL_WORD).test(t)) {
    const value = mode[1] === 'economy' ? 'economical' : (mode[1] as string)
    return { isUnderstood: true, patches: [{ path: 'budgetMode', value }], summary: `budget profile: ${value}` }
  }

  const parallel = /\b(?:limit|cap|restrict|set|allow|max(?:imum)?)\b.*\bparallel\b.*?\b(one|two|three|four|[1-4])\b|\b(one|two|[12])\b (?:parallel )?(?:sub-?)?agents?\b(?: at (?:a|one) time| max(?:imum)?| at most)/.exec(t)
  if (parallel !== null && /agent/.test(t)) {
    const count = NUMBER_WORDS[(parallel[1] ?? parallel[2]) as string]
    if (count === undefined || count > 2) {
      return { isUnderstood: false, reason: 'parallel agents can be 1 or 2' }
    }
    const patches: ConfigPatch[] = [{ path: 'guardrails.maxParallelAgents', value: count }]
    if (config.guardrails.defaultParallelAgents > count) {
      patches.push({ path: 'guardrails.defaultParallelAgents', value: count })
    }
    return { isUnderstood: true, patches, summary: `parallel agents: at most ${count}` }
  }

  const panel = /\b(disable|hide|turn off|close|enable|show|turn on|open)\b.*\b(dashboard|side ?panel|pane|panel)\b/.exec(t)
  if (panel !== null) {
    const isOn = /enable|show|turn on|open/.test(panel[1] as string)
    return {
      isUnderstood: true,
      patches: [
        { path: 'sidePanel.enabled', value: isOn },
        { path: 'sidePanel.autoOpen', value: isOn },
      ],
      summary: `dashboard: ${isOn ? 'on' : 'off'}`,
    }
  }

  const only = new RegExp(`\\buse ${MODEL_WORD} only for ([a-z ,&/-]+)$`).exec(t)
  if (only !== null) {
    const model = only[1] as Alias
    const wanted = (only[2] as string)
      .split(/,| and | & |\//)
      .map(word => word.trim().replace(/ (?:work|tasks?|changes?)$/, ''))
      .filter(word => word !== '')
    const unknown = wanted.filter(word => !DOMAINS.includes(word))
    if (unknown.length > 0) {
      return { isUnderstood: false, reason: `unknown area: ${unknown.join(', ')}. Known: ${DOMAINS.join(', ')}` }
    }
    if (model !== config.tiers.headChef.model) {
      return { isUnderstood: false, reason: `"only for" applies to the top tier's model (${config.tiers.headChef.model}); change tiers.headChef.model first` }
    }
    return {
      isUnderstood: true,
      patches: [{ path: 'routing.headChef', value: { domains: wanted, exceptional: false } }],
      summary: `${model} only for ${wanted.join(' and ')}`,
    }
  }

  const forWork = new RegExp(`\\buse ${MODEL_WORD} for (?:all )?(?:(simple|standard|complex|critical|exceptional) )?([a-z-]+)?(?: (?:work|tasks?|changes?|development))?$`).exec(t)
  if (forWork !== null && (forWork[2] !== undefined || forWork[3] !== undefined)) {
    const model = forWork[1] as Alias
    const complexity = forWork[2]
    const area = forWork[3]
    if (area !== undefined && area !== 'work' && area !== 'tasks' && !DOMAINS.includes(area)) {
      return { isUnderstood: false, reason: `unknown area: ${area}. Known: ${DOMAINS.join(', ')}` }
    }
    const rule: Record<string, string> = { model, note: text.trim().slice(0, 200) }
    if (complexity !== undefined) rule.complexity = complexity
    if (area !== undefined && DOMAINS.includes(area)) rule.domain = area
    if (rule.complexity === undefined && rule.domain === undefined) {
      return { isUnderstood: false, reason: 'say which work: a complexity, an area, or both' }
    }
    const kept = config.routing.overrides.filter(
      existing => !(existing.domain === rule.domain && existing.complexity === rule.complexity && existing.risk === undefined),
    )
    return {
      isUnderstood: true,
      patches: [{ path: 'routing.overrides', value: [...kept, rule] }],
      summary: `${model} for ${[complexity, area].filter(Boolean).join(' ')} work`,
    }
  }

  const review = /\b(require|enable|turn on|always|disable|skip|turn off|no)\b.*\b(?:independent )?reviews?\b/.exec(t)
  if (review !== null) {
    const isOn = /require|enable|turn on|always/.test(review[1] as string)
    return {
      isUnderstood: true,
      patches: [
        { path: 'guardrails.independentReview', value: isOn },
        { path: 'guardrails.reviewMode', value: isOn ? 'remind' : 'off' },
      ],
      summary: `independent review for high-risk changes: ${isOn ? 'required' : 'off'}`,
    }
  }

  const power = /^(?:turn |switch )?(on|off|enable|disable)(?: (?:the )?(?:router|routing|auto router))?$/.exec(t)
  if (power !== null) {
    const isOn = power[1] === 'on' || power[1] === 'enable'
    return { isUnderstood: true, patches: [{ path: 'enabled', value: isOn }], summary: `router: ${isOn ? 'on' : 'off'}` }
  }

  return {
    isUnderstood: false,
    reason: 'not understood. Try: "switch to economical mode", "limit parallel agents to one", "disable the dashboard", "use opus for complex frontend work", "use fable only for architecture and security", "require independent reviews"',
  }
}

export function describeChanges(changes: readonly ConfigChange[]): string {
  if (changes.length === 0) return 'no setting changed'
  return changes
    .map(change => `${change.path}: ${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}`)
    .join('; ')
}
