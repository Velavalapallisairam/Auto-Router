// Configuration: the defaults are valid, bad values are refused by name,
// a change touches only what it names, and plain-English requests parse.

import { describe, expect, test } from 'claude-code/testing'

import {
  CONFIG_SCHEMA,
  applyPatches,
  defaultConfig,
  isSensitivePath,
  parseConfig,
  parseRequest,
  schemaText,
  serializeConfig,
  validateConfig,
} from '../hooks/engine/config.ts'

describe('validation', () => {
  test('the defaults are valid and round-trip through their own text', () => {
    const checked = parseConfig(serializeConfig(defaultConfig()))
    expect(checked.isValid).toBe(true)
    expect(checked.config).toEqual(defaultConfig())
  })

  test('the schema file is the schema the validator walks', () => {
    expect(JSON.parse(schemaText())).toEqual(JSON.parse(JSON.stringify(CONFIG_SCHEMA)))
    expect(CONFIG_SCHEMA.additionalProperties).toBe(false)
  })

  test('the configuration the request spelled out is accepted, the rest filled from defaults', () => {
    const given = {
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
      effortBounds: { simple: 'low', standard: 'medium', complex: 'high', critical: 'xhigh', exceptional: 'max' },
      guardrails: { maxParallelAgents: 2, autoEscalateAfterFailures: 2, independentReview: true },
      sidePanel: { enabled: true, autoOpen: true, position: 'right' },
      telemetry: { enabled: true, maxEvents: 500, redactSecrets: true },
    }
    const checked = validateConfig(given)
    expect(checked.isValid).toBe(true)
    expect(checked.config?.tiers.reviewer).toEqual({ model: 'opus' })
    expect(checked.config?.guardrails.defaultParallelAgents).toBe(1)
    expect(checked.config?.routing.headChef.domains).toEqual(['architecture', 'security'])
  })

  const bad: [string, (config: Record<string, unknown>) => void, string][] = [
    ['an unknown budget mode', c => (c.budgetMode = 'cheap'), 'budgetMode'],
    ['three parallel agents', c => ((c.guardrails as Record<string, unknown>).maxParallelAgents = 3), 'guardrails.maxParallelAgents'],
    ['an unknown model', c => (((c.tiers as Record<string, Record<string, unknown>>).lineCook as Record<string, unknown>).model = 'gpt'), 'tiers.lineCook.model'],
    ['an unknown effort', c => ((c.effortBounds as Record<string, unknown>).simple = 'tiny'), 'effortBounds.simple'],
    ['a setting that does not exist', c => (c.turbo = true), 'turbo'],
    ['a wrong type', c => (c.enabled = 'yes'), 'enabled'],
    ['a fallback equal to its model', c => ((c.tiers as Record<string, unknown>).sousChef = { model: 'opus', fallback: 'opus' }), 'tiers.sousChef.fallback'],
    ['a default above the maximum', c => (c.guardrails = { ...(c.guardrails as object), maxParallelAgents: 1, defaultParallelAgents: 2 }), 'defaultParallelAgents'],
    ['effort limits upside down', c => (c.effortLimits = { min: 'max', max: 'low' }), 'effortLimits'],
    ['too few events kept', c => ((c.telemetry as Record<string, unknown>).maxEvents = 5), 'telemetry.maxEvents'],
  ]
  for (const [name, change, path] of bad) {
    test(`${name} is refused, naming ${path}`, () => {
      const config = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, unknown>
      change(config)
      const checked = validateConfig(config)
      expect(checked.isValid).toBe(false)
      expect(checked.errors.join('\n')).toContain(path)
    })
  }

  test('text that is not JSON is refused, not guessed at', () => {
    const checked = parseConfig('{ "enabled": tru')
    expect(checked.isValid).toBe(false)
    expect(checked.errors[0]).toContain('not valid JSON')
  })
})

describe('changes by path', () => {
  test('a change touches the named setting and nothing else', () => {
    const before = defaultConfig()
    const result = applyPatches(before, [{ path: 'budgetMode', value: 'economical' }])
    expect(result.isValid).toBe(true)
    if (!result.isValid) return
    expect(result.changes).toEqual([{ path: 'budgetMode', from: 'balanced', to: 'economical' }])
    expect({ ...result.config, budgetMode: 'balanced' }).toEqual(before)
    expect(before.budgetMode).toBe('balanced')
  })

  test('an unknown path is refused', () => {
    const result = applyPatches(defaultConfig(), [{ path: 'guardrails.yolo', value: true }])
    expect(result.isValid).toBe(false)
    expect(result.errors[0]).toContain('guardrails.yolo')
  })

  test('an invalid value is refused and nothing is applied', () => {
    const result = applyPatches(defaultConfig(), [
      { path: 'budgetMode', value: 'economical' },
      { path: 'guardrails.maxParallelAgents', value: 9 },
    ])
    expect(result.isValid).toBe(false)
  })

  test('the format version cannot be changed', () => {
    expect(applyPatches(defaultConfig(), [{ path: 'version', value: 2 }]).isValid).toBe(false)
  })

  test('setting a value to what it already is changes nothing', () => {
    const result = applyPatches(defaultConfig(), [{ path: 'enabled', value: true }])
    expect(result.isValid && result.changes.length).toBe(0)
  })

  test('guardrails, floors and the session protection are sensitive', () => {
    expect(isSensitivePath('guardrails.maxParallelAgents')).toBe(true)
    expect(isSensitivePath('riskFloors.highImpact')).toBe(true)
    expect(isSensitivePath('sessions.protected')).toBe(true)
    expect(isSensitivePath('enabled')).toBe(true)
    expect(isSensitivePath('budgetMode')).toBe(false)
    expect(isSensitivePath('sidePanel.autoOpen')).toBe(false)
  })
})

describe('plain-English requests', () => {
  const ask = (text: string) => {
    const parsed = parseRequest(text, defaultConfig())
    if (!parsed.isUnderstood) return parsed
    const applied = applyPatches(defaultConfig(), parsed.patches)
    return { ...parsed, config: applied.isValid ? applied.config : undefined }
  }

  test('"Switch to economical mode."', () => {
    const got = ask('Switch to economical mode.')
    expect(got.isUnderstood && got.config?.budgetMode).toBe('economical')
  })

  test('"Use Opus for complex frontend work."', () => {
    const got = ask('Use Opus for complex frontend work.')
    expect(got.isUnderstood && got.config?.routing.overrides).toEqual([
      { domain: 'frontend', complexity: 'complex', model: 'opus', note: 'Use Opus for complex frontend work.' },
    ])
  })

  test('"Limit parallel agents to one."', () => {
    const got = ask('Limit parallel agents to one.')
    expect(got.isUnderstood && got.config?.guardrails.maxParallelAgents).toBe(1)
    expect(got.isUnderstood && got.config?.guardrails.defaultParallelAgents).toBe(1)
  })

  test('"Disable the dashboard."', () => {
    const got = ask('Disable the dashboard.')
    expect(got.isUnderstood && got.config?.sidePanel).toEqual({ enabled: false, autoOpen: false, position: 'right' })
  })

  test('"Use Fable only for architecture and security."', () => {
    const got = ask('Use Fable only for architecture and security.')
    expect(got.isUnderstood && got.config?.routing.headChef).toEqual({ domains: ['architecture', 'security'], exceptional: false })
  })

  test('"Require independent reviews for high-risk changes."', () => {
    const off = defaultConfig()
    off.guardrails.independentReview = false
    off.guardrails.reviewMode = 'off'
    const parsed = parseRequest('Require independent reviews for high-risk changes.', off)
    expect(parsed.isUnderstood).toBe(true)
    if (!parsed.isUnderstood) return
    const applied = applyPatches(off, parsed.patches)
    expect(applied.isValid && applied.config.guardrails.independentReview).toBe(true)
    expect(applied.isValid && applied.config.guardrails.reviewMode).toBe('remind')
  })

  test('a request it cannot read is refused with a reason, not guessed', () => {
    const got = parseRequest('make it purple', defaultConfig())
    expect(got.isUnderstood).toBe(false)
    expect(!got.isUnderstood && got.reason).toContain('not understood')
  })

  test('a request outside the limits says so', () => {
    const got = parseRequest('limit parallel agents to four', defaultConfig())
    expect(got.isUnderstood).toBe(false)
  })

  test('an unknown area is named', () => {
    const got = parseRequest('use opus for complex blockchain work', defaultConfig())
    expect(got.isUnderstood).toBe(false)
    expect(!got.isUnderstood && got.reason).toContain('blockchain')
  })
})
