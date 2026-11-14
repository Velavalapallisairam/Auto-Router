// Model and effort selection, risk floors, cache-aware switching, fallback
// and escalation: the engine's decisions, with no session beneath.

import { describe, expect, test } from 'claude-code/testing'

import type { Alias, Effort, RouterConfig } from '../types'
import { classify } from '../hooks/engine/classify.ts'
import { defaultConfig } from '../hooks/engine/config.ts'
import {
  aliasOf,
  decideMain,
  decideSubagent,
  escalate,
  isSwitchWorthIt,
  isVersionAtLeast,
  pickIdeal,
  resolveAlias,
} from '../hooks/engine/route.ts'
import type { Availability, MainContext } from '../hooks/engine/route.ts'

const NOW = 1_800_000_000_000
const free: Availability = { now: NOW, unavailable: {} }

function context(over: Partial<MainContext> = {}): MainContext {
  return {
    now: NOW,
    isFirstTurn: true,
    isMidTurn: false,
    contextTokens: 0,
    warm: {},
    hasPerMessageEffort: false,
    isUltracode: false,
    pins: {},
    availability: free,
    canRouteModel: true,
    canRouteEffort: true,
    ...over,
  }
}

function withConfig(change: (config: RouterConfig) => void): RouterConfig {
  const config = defaultConfig()
  change(config)
  return config
}

const SIMPLE = 'fix the typo in the README heading'
const STANDARD = 'add a unit test for the parseDate function'
const COMPLEX = 'debug the intermittent deadlock in the job scheduler'
const ARCHITECTURE = 'design the architecture for a multi-tenant notification system'
const SECURITY = 'refactor the authentication module across all services and harden the session handling'
const EXCEPTIONAL = 'design a novel lock-free consensus protocol and prove its correctness'

describe('the four tiers', () => {
  const cases: [string, string, Alias, Effort][] = [
    ['simple', SIMPLE, 'haiku', 'low'],
    ['standard', STANDARD, 'sonnet', 'medium'],
    ['complex', COMPLEX, 'opus', 'high'],
    ['complex architecture', ARCHITECTURE, 'fable', 'high'],
    ['critical security', SECURITY, 'fable', 'xhigh'],
    ['exceptional', EXCEPTIONAL, 'fable', 'max'],
  ]
  for (const [name, prompt, alias, effort] of cases) {
    test(`a ${name} task runs on ${alias} at ${effort}`, () => {
      const ideal = pickIdeal(classify(prompt), defaultConfig())
      expect(ideal.alias).toBe(alias)
      expect(ideal.effort).toBe(effort)
    })
  }

  test('explaining an architecture is not designing one: the top tier is kept for the work', () => {
    const told = pickIdeal(classify('explain the architecture of this service in depth'), defaultConfig())
    expect(told.alias).toBe('opus')
    expect(pickIdeal(classify(ARCHITECTURE), defaultConfig()).alias).toBe('fable')
  })

  test('a security audit goes to the top tier at xhigh', () => {
    const ideal = pickIdeal(classify('audit the authentication module for vulnerabilities'), defaultConfig())
    expect(ideal.alias).toBe('fable')
    expect(ideal.effort).toBe('xhigh')
  })

  test('a diagnosis question is not handed to the cheapest tier', () => {
    expect(pickIdeal(classify('what is wrong with this code?'), defaultConfig()).alias).not.toBe('haiku')
  })

  test('effort follows complexity, not the model: a complex task off the top tier is still high', () => {
    const ideal = pickIdeal(classify(COMPLEX), defaultConfig())
    expect(ideal.tier).toBe('sousChef')
    expect(ideal.effort).toBe('high')
  })
})

describe('quality protection', () => {
  test('an unfamiliar task goes straight to Opus, never a cheap tier', () => {
    const ideal = pickIdeal(classify('xyzzy plugh'), defaultConfig())
    expect(ideal.alias).toBe('opus')
    expect(ideal.floors).toContain('uncertain')
  })

  test('a short high-risk task gets the high-impact floor', () => {
    const ideal = pickIdeal(classify('rotate the prod api keys'), defaultConfig())
    expect(ideal.alias).toBe('opus')
    expect(['high', 'xhigh', 'max']).toContain(ideal.effort)
    expect(ideal.floors).toContain('highImpact')
  })

  test('an ambiguous high-risk task never reaches Haiku', () => {
    const ideal = pickIdeal(classify('prod is down, something is wrong, figure it out'), defaultConfig())
    expect(ideal.alias).not.toBe('haiku')
    expect(ideal.alias).not.toBe('sonnet')
    expect(ideal.floors).toContain('ambiguousHighRisk')
  })

  test('the economical profile does not lower a floor', () => {
    const economical = withConfig(config => {
      config.budgetMode = 'economical'
    })
    expect(pickIdeal(classify('rotate the prod api keys'), economical).alias).toBe('opus')
    expect(pickIdeal(classify(SECURITY), economical).alias).toBe('fable')
  })

  test('the quality profile raises effort for complex work', () => {
    const quality = withConfig(config => {
      config.budgetMode = 'quality'
    })
    expect(pickIdeal(classify(COMPLEX), quality).effort).toBe('xhigh')
  })

  test('an override applies, and a floor still outranks it', () => {
    const config = withConfig(c => {
      c.routing.overrides = [{ domain: 'frontend', complexity: 'complex', model: 'sonnet' }]
    })
    const plain = pickIdeal(classify('overhaul the tailwind layout of the dashboard page end-to-end'), config)
    expect(plain.alias).toBe('sonnet')
    const risky = pickIdeal(classify('overhaul the react login flow end-to-end with new oauth handling'), config)
    expect(risky.alias).not.toBe('sonnet')
  })

  test('"Fable only for architecture and security" keeps other exceptional work off it', () => {
    const config = withConfig(c => {
      c.routing.headChef = { domains: ['architecture', 'security'], exceptional: false }
    })
    const cls = classify('prove from first principles that this novel sorting algorithm terminates, in depth, comparing trade-offs')
    expect(cls.complexity).toBe('exceptional')
    expect(pickIdeal(cls, config).alias).toBe('opus')
    expect(pickIdeal(classify(SECURITY), config).alias).toBe('fable')
  })

  test('effort limits clamp what is asked', () => {
    const config = withConfig(c => {
      c.effortLimits = { min: 'medium', max: 'high' }
    })
    expect(pickIdeal(classify(SIMPLE), config).effort).toBe('medium')
    expect(pickIdeal(classify(EXCEPTIONAL), config).effort).toBe('high')
  })
})

describe('the main session', () => {
  test('the first turn takes the cheapest capable model outright', () => {
    const decision = decideMain(classify(SIMPLE), defaultConfig(), context({ currentAlias: 'opus' }))
    expect(decision.modelAction).toBe('initial')
    expect(decision.alias).toBe('haiku')
    expect(decision.effort).toBe('low')
  })

  test('a stronger task moves up at once', () => {
    const decision = decideMain(
      classify(COMPLEX),
      defaultConfig(),
      context({ isFirstTurn: false, currentAlias: 'sonnet', currentEffort: 'medium', contextTokens: 200_000, warm: { sonnet: NOW - 1000 } }),
    )
    expect(decision.modelAction).toBe('upgrade')
    expect(decision.alias).toBe('opus')
    expect(decision.effortAction).toBe('raise')
  })

  test('a warm cache over a large context holds the model for a simple follow-on task', () => {
    const decision = decideMain(
      classify(SIMPLE),
      defaultConfig(),
      context({ isFirstTurn: false, currentAlias: 'opus', currentEffort: 'high', contextTokens: 200_000, warm: { opus: NOW - 30_000 } }),
    )
    expect(decision.modelAction).toBe('hold-cache')
    expect(decision.alias).toBe('opus')
    expect(decision.targetAlias).toBe('haiku')
    expect(decision.effortAction).toBe('hold-cache')
    expect(decision.effort).toBe('high')
  })

  test('a cold cache frees the move down', () => {
    const decision = decideMain(
      classify(SIMPLE),
      defaultConfig(),
      context({ isFirstTurn: false, currentAlias: 'opus', currentEffort: 'high', contextTokens: 200_000, warm: { opus: NOW - 3_600_000 } }),
    )
    expect(decision.modelAction).toBe('downgrade')
    expect(decision.alias).toBe('haiku')
    expect(decision.effort).toBe('low')
  })

  test('with per-message effort, lowering it is free', () => {
    const decision = decideMain(
      classify(SIMPLE),
      defaultConfig(),
      context({ isFirstTurn: false, currentAlias: 'opus', currentEffort: 'high', contextTokens: 200_000, warm: { opus: NOW - 30_000 }, hasPerMessageEffort: true }),
    )
    expect(decision.effortAction).toBe('lower')
    expect(decision.effort).toBe('low')
  })

  test('a prompt typed over a running turn never moves the model down', () => {
    const decision = decideMain(
      classify(SIMPLE),
      defaultConfig(),
      context({ isFirstTurn: false, isMidTurn: true, currentAlias: 'opus', currentEffort: 'high', warm: {} }),
    )
    expect(decision.alias).toBe('opus')
  })

  test('a model named in the prompt wins over floors and pins', () => {
    const decision = decideMain(classify('use haiku for this: refactor the auth module'), defaultConfig(), context({ pins: { model: 'claude-opus-5-5' } }))
    expect(decision.modelAction).toBe('explicit')
    expect(decision.alias).toBe('haiku')
  })

  test('a model picked mid-session is left alone', () => {
    const decision = decideMain(classify(COMPLEX), defaultConfig(), context({ isFirstTurn: false, currentAlias: 'sonnet', pins: { model: 'claude-sonnet-5-5', effort: 'low' } }))
    expect(decision.modelAction).toBe('pinned')
    expect(decision.alias).toBeUndefined()
    expect(decision.effortAction).toBe('pinned')
    expect(decision.effort).toBeUndefined()
    expect(decision.targetAlias).toBe('opus')
  })

  test('advisory mode decides and applies nothing', () => {
    const decision = decideMain(classify(SIMPLE), defaultConfig(), context({ canRouteModel: false, canRouteEffort: false }))
    expect(decision.modelAction).toBe('off')
    expect(decision.alias).toBeUndefined()
    expect(decision.effort).toBeUndefined()
    expect(decision.targetAlias).toBe('haiku')
  })

  test('a short follow-up keeps the task\'s route', () => {
    const first = decideMain(classify(SECURITY), defaultConfig(), context())
    const next = decideMain(
      classify('ok go ahead'),
      defaultConfig(),
      context({ isFirstTurn: false, currentAlias: 'fable', currentEffort: 'xhigh', warm: { fable: NOW - 1000 }, contextTokens: 50_000, previous: first }),
    )
    expect(next.targetAlias).toBe('fable')
    expect(next.targetEffort).toBe('xhigh')
    expect(next.modelAction).toBe('keep')
  })

  test('Ultracode keeps the session effort as the floor', () => {
    const decision = decideMain(classify(SIMPLE), defaultConfig(), context({ isUltracode: true, engineEffort: 'xhigh', currentAlias: 'opus' }))
    expect(decision.effort).toBe('xhigh')
  })

  test('high-risk work asks for the independent review; a lookup does not', () => {
    expect(decideMain(classify(SECURITY), defaultConfig(), context()).reviewRequired).toBe(true)
    expect(decideMain(classify(SIMPLE), defaultConfig(), context()).reviewRequired).toBe(false)
    const off = withConfig(c => {
      c.guardrails.independentReview = false
    })
    expect(decideMain(classify(SECURITY), off, context()).reviewRequired).toBe(false)
  })

  test('the explanation says what was chosen and why', () => {
    const decision = decideMain(classify(SECURITY), defaultConfig(), context())
    expect(decision.explanation).toContain('Head Chef')
    expect(decision.explanation).toContain('fable')
    expect(decision.explanation).toContain('floor')
  })
})

describe('the prompt cache is weighed, not ignored', () => {
  test('leaving a warm Opus for Sonnet over a large context does not pay for a simple task', () => {
    expect(isSwitchWorthIt(defaultConfig(), 'opus', 'sonnet', 'simple', 150_000, true, false)).toBe(false)
  })

  test('with nothing cached, the cheaper model pays', () => {
    expect(isSwitchWorthIt(defaultConfig(), 'opus', 'haiku', 'simple', 150_000, false, false)).toBe(true)
  })

  test('with almost no context, the cheaper model pays even from a warm cache', () => {
    expect(isSwitchWorthIt(defaultConfig(), 'opus', 'haiku', 'standard', 2000, true, false)).toBe(true)
  })
})

describe('fallback for an unavailable model', () => {
  test('a tier whose model is down uses its fallback', () => {
    const down: Availability = { now: NOW, unavailable: { opus: { until: NOW + 60_000, reason: 'failed' } } }
    expect(resolveAlias(defaultConfig(), 'opus', 'sousChef', down)).toEqual({ alias: 'sonnet', usedFallback: true })
    const decision = decideMain(classify(COMPLEX), defaultConfig(), context({ availability: down }))
    expect(decision.alias).toBe('sonnet')
    expect(decision.usedFallback).toBe(true)
    expect(decision.targetAlias).toBe('opus')
  })

  test('once the cooldown passes the model is used again', () => {
    const past: Availability = { now: NOW, unavailable: { opus: { until: NOW - 1, reason: 'failed' } } }
    expect(resolveAlias(defaultConfig(), 'opus', 'sousChef', past)).toEqual({ alias: 'opus', usedFallback: false })
  })

  test('an organization allowlist is respected', () => {
    const limited: Availability = { now: NOW, unavailable: {}, allowed: ['sonnet', 'claude-haiku-5-5'] }
    expect(resolveAlias(defaultConfig(), 'fable', 'headChef', limited).alias).toBeUndefined()
    expect(resolveAlias(defaultConfig(), 'opus', 'sousChef', limited)).toEqual({ alias: 'sonnet', usedFallback: true })
    expect(resolveAlias(defaultConfig(), 'haiku', 'prepCook', limited)).toEqual({ alias: 'haiku', usedFallback: false })
  })

  test('with no usable model the session model stands', () => {
    const none: Availability = { now: NOW, unavailable: {}, allowed: ['haiku'] }
    const decision = decideMain(classify(SECURITY), defaultConfig(), context({ availability: none, currentAlias: 'haiku' }))
    expect(decision.modelAction).toBe('unavailable')
  })
})

describe('escalation after failures is a separate mechanism', () => {
  test('one tier up, and one effort level', () => {
    expect(escalate(defaultConfig(), 'haiku', 'low', free)).toEqual({ alias: 'sonnet', effort: 'medium', note: 'haiku -> sonnet, effort low -> medium' })
    expect(escalate(defaultConfig(), 'sonnet', 'medium', free)?.alias).toBe('opus')
    expect(escalate(defaultConfig(), 'opus', 'high', free)?.alias).toBe('fable')
  })

  test('at the top tier only the effort moves, and then nothing does', () => {
    const top = escalate(defaultConfig(), 'fable', 'high', free)
    expect(top?.alias).toBeUndefined()
    expect(top?.effort).toBe('xhigh')
    expect(escalate(defaultConfig(), 'fable', 'max', free)).toBeUndefined()
  })

  test('escalation skips a model that is unavailable', () => {
    const down: Availability = { now: NOW, unavailable: { sonnet: { until: NOW + 1000, reason: 'failed' } } }
    expect(escalate(defaultConfig(), 'haiku', 'low', down)?.alias).toBe('opus')
  })
})

describe('subagents', () => {
  const sub = (type: string, prompt: string, callModel?: string) =>
    decideSubagent(classify(prompt), defaultConfig(), { subagentType: type, callModel, availability: free })

  test('each specialist runs on its tier model', () => {
    expect(sub('auto-router:prep-cook', 'find where the retry logic is defined').alias).toBe('haiku')
    expect(sub('auto-router:line-cook', STANDARD).alias).toBe('sonnet')
    expect(sub('auto-router:sous-chef', COMPLEX).alias).toBe('opus')
    expect(sub('auto-router:head-chef', ARCHITECTURE).alias).toBe('fable')
  })

  test('a risk floor lifts a cheap specialist handed risky work', () => {
    const decision = sub('auto-router:prep-cook', 'rotate the prod api keys')
    expect(decision.alias).toBe('opus')
    expect(decision.reasons.join(' ')).toContain('risk floor')
  })

  test('the reviewer runs on its own model at high effort or more, whatever the task', () => {
    const decision = sub('auto-router:independent-reviewer', 'review the typo fix')
    expect(decision.alias).toBe('opus')
    expect(['high', 'xhigh', 'max']).toContain(decision.effort)
  })

  test('a general-purpose agent with no model named is routed by its task', () => {
    expect(sub('general-purpose', 'find where the retry logic is defined').alias).toBe('haiku')
    expect(sub('general-purpose', COMPLEX).alias).toBe('opus')
  })

  test('a model the call named is kept unless a floor asks for more', () => {
    expect(sub('general-purpose', 'find where the retry logic is defined', 'opus').alias).toBeUndefined()
    expect(sub('general-purpose', 'rotate the prod api keys', 'haiku').alias).toBe('opus')
  })

  test('an agent type the router is not set to route is left alone', () => {
    const decision = sub('Explore', 'find where the retry logic is defined')
    expect(decision.isManaged).toBe(false)
    expect(decision.alias).toBeUndefined()
  })
})

describe('helpers', () => {
  test('a model id maps to its family', () => {
    expect(aliasOf('claude-opus-5-5[1m]')).toBe('opus')
    expect(aliasOf('claude-haiku-5-5')).toBe('haiku')
    expect(aliasOf('claude-fable-5-2')).toBe('fable')
    expect(aliasOf('sonnet')).toBe('sonnet')
    expect(aliasOf('gpt-x')).toBeUndefined()
    expect(aliasOf(undefined)).toBeUndefined()
  })

  test('engine versions compare numerically', () => {
    expect(isVersionAtLeast('2.1.321', '2.1.309')).toBe(true)
    expect(isVersionAtLeast('2.1.308', '2.1.309')).toBe(false)
    expect(isVersionAtLeast('2.1.309-dev.20260920', '2.1.309')).toBe(true)
    expect(isVersionAtLeast('2.10.0', '2.9.9')).toBe(true)
    expect(isVersionAtLeast('', '2.1.309')).toBe(false)
  })
})
