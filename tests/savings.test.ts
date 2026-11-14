// Cost and savings: priced from reported tokens, against the model the engine
// would have used with no router, and Unavailable wherever that cannot be done.

import { describe, expect, test } from 'claude-code/testing'

import type { DayUsage, Totals, UsageHistory } from '../types'
import { defaultConfig } from '../hooks/engine/config.ts'
import { costOf, costOfMap, lastDays, savingOf } from '../hooks/engine/cost.ts'
import { fmtUsd } from '../hooks/engine/text.ts'
import { aggregateDays, dayKey, emptyUsage, mergeHistory, parseHistory, recordUsage, sessionDays } from '../hooks/engine/usage.ts'
import { DIR, SESSION, T0, pane, start, turn, words, world } from './helpers.ts'

const HISTORY = `${DIR}/usage-history.json`
const SIMPLE = 'fix the typo in the README heading'
const config = defaultConfig()
const totals = (input: number, output: number, read = 0, write = 0, req = 1): Totals => ({ req, in: input, out: output, cr: read, cw: write })
/** Equal to within rounding: sums of prices are floating point. */
const near = (value: number | undefined, want: number): void => expect(Math.abs((value ?? Number.NaN) - want) < 1e-9).toBe(true)
const reported = (model: string) => ({ input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model })

describe('pricing', () => {
  test('a model is priced per million tokens: input, output, cache read, and cache write at the write multiplier', () => {
    near(costOf('claude-haiku-5-5', totals(1_000_000, 1_000_000), config), 0.6)
    near(costOf('claude-opus-5-5', totals(1_000_000, 0, 1_000_000, 1_000_000), config), 4 + 0.2 + 4 * 1.25)
    near(costOf('judge (haiku)', totals(1_000_000, 0), config), 0.1)
  })

  test('a model with no price is not guessed at', () => {
    expect(costOf('some-other-model', totals(10, 10), config)).toBeUndefined()
    expect(costOf('some-other-model', totals(0, 0, 0, 0, 0), config)).toBe(0)
    expect(costOfMap({ 'claude-haiku-5-5': totals(10, 10), unknown: totals(10, 10) }, config)).toBeUndefined()
  })

  test('small sums keep their digits; a missing one reads Unavailable', () => {
    expect(fmtUsd(0.00077)).toBe('$0.0008')
    expect(fmtUsd(12.345)).toBe('$12.35')
    expect(fmtUsd(-0.5)).toBe('-$0.50')
    expect(fmtUsd(0)).toBe('$0.00')
    expect(fmtUsd(undefined)).toBe('Unavailable')
  })
})

describe('the baseline', () => {
  test('each request is also filed under the model the engine would have used', () => {
    const state = emptyUsage()
    recordUsage(state, 'main', reported('claude-haiku-5-5'), T0, 'claude-opus-5-5')
    // A request only the router makes has no baseline cost.
    recordUsage(state, 'router judge', reported('judge (haiku)'), T0, null)
    const day = dayKey(T0)
    expect(state.base?.[day]?.['claude-opus-5-5']?.in).toBe(1_000_000)
    expect(Object.keys(state.base?.[day] ?? {})).toEqual(['claude-opus-5-5'])
    expect(state.byAgentModel?.main?.['claude-haiku-5-5']?.req).toBe(1)
    const saving = savingOf(sessionDays(state), config)
    // Haiku 0.1 + 0.05, the judge 0.1 + 0.05; Opus 4 + 2.
    near(saving?.actual, 0.3)
    near(saving?.baseline, 6)
    near(saving?.saved, 5.7)
    near(saving?.percent, 95)
    expect(saving?.requests).toBe(2)
  })

  test('a stronger model than the session\'s is a negative saving, not hidden', () => {
    const state = emptyUsage()
    recordUsage(state, 'main', reported('claude-fable-5-2'), T0, 'claude-sonnet-5-5')
    const saving = savingOf(sessionDays(state), config)
    near(saving?.saved, 3 - 12)
    expect(saving?.percent).toBeLessThan(0)
  })

  test('with routing off the two sides are equal', () => {
    const state = emptyUsage()
    recordUsage(state, 'main', reported('claude-opus-5-5'), T0, 'claude-opus-5-5')
    const saving = savingOf(sessionDays(state), config)
    expect(saving?.saved).toBe(0)
    expect(saving?.percent).toBe(0)
  })

  test('no baseline, no figure: an unknown engine model, usage from before tracking, or nothing recorded', () => {
    const unknown = emptyUsage()
    recordUsage(unknown, 'agent', reported('claude-haiku-5-5'), T0)
    expect(savingOf(sessionDays(unknown), config)).toBeUndefined()

    const before = emptyUsage()
    before.days[dayKey(T0)] = { 'claude-haiku-5-5': totals(10, 10) }
    recordUsage(before, 'main', reported('claude-haiku-5-5'), T0, 'claude-opus-5-5')
    expect(before.basePartial).toBe(true)
    expect(sessionDays(before)).toEqual([])

    expect(savingOf([], config)).toBeUndefined()
    expect(savingOf([{ actual: {}, base: {}, skipped: 0 }], config)).toBeUndefined()
  })
})

describe('the history', () => {
  test('the baseline survives the file, and a session without one is left out of both sides', () => {
    const state = emptyUsage()
    recordUsage(state, 'main', reported('claude-haiku-5-5'), T0, 'claude-opus-5-5')
    const old: UsageHistory = {
      version: 1,
      sessions: { old: { startedAt: T0, updatedAt: T0, days: { [dayKey(T0)]: { 'claude-opus-5-5': totals(5_000_000, 0) } } } },
    }
    const merged = parseHistory(JSON.stringify(mergeHistory(old, SESSION, state, T0, 35)))
    expect(merged?.sessions[SESSION]?.base?.[dayKey(T0)]?.['claude-opus-5-5']?.req).toBe(1)
    expect(merged?.sessions.old?.base).toBeUndefined()

    const days = aggregateDays(merged as UsageHistory, T0, 7)
    const keys = Object.keys(days)
    expect(keys.length).toBe(7)
    expect(keys[6]).toBe(dayKey(T0))
    expect(keys[0]).toBe(dayKey(T0 - 6 * 86_400_000))
    const today = days[dayKey(T0)] as DayUsage
    expect(today.skipped).toBe(1)
    // The old session's five million tokens are in neither total.
    expect(today.actual['claude-opus-5-5']).toBeUndefined()
    const saving = savingOf(lastDays(days, 7).map(([, day]) => day), config)
    near(saving?.actual, 0.15)
    near(saving?.baseline, 6)
    expect(saving?.skipped).toBe(1)
  })
})

describe('the usage tab', () => {
  test('a routed turn shows what it cost, what it would have cost, and the difference', async ($, on) => {
    world(on)
    await start($)
    // The engine would have sent Opus; the router sends Haiku: 1200 in, 300 out, 4000 written to cache.
    await turn($, SIMPLE, { id: 't1' })
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    await ui.press({ key: 'ar-usage' })
    const shown = await words(ui)
    expect(shown).toContain('Requests\n1')
    expect(shown).toContain('Total tokens\n5.5k')
    expect(shown).toContain('Total cost\n$0.0008 estimate at list prices')
    expect(shown).toContain('This session\n$0.03 saved · 97.5%')
    expect(shown).toContain('Daily\n$0.03 saved · 97.5%')
    expect(shown).toContain('Weekly\n$0.03 saved · 97.5%')
    expect(shown).toContain('Monthly\n$0.03 saved · 97.5%')
    expect(shown).toContain('Saved\n$0.03')
    expect(shown).toContain('Percentage\n97.5%')
    expect(shown).toContain('Actual cost\n$0.0008 estimated API cost · 1 requests')
    expect(shown).toContain('Unoptimised\n$0.03 without Auto Router')
    // The chart has a row for each of the seven days; six had no usage.
    expect(shown.split('no usage').length - 1).toBe(6)
    expect(shown).toContain('An estimate, not a bill')
    await ui.unmount()
  })

  test('with routing off nothing is claimed', async ($, on) => {
    world(on, { config: c => void (c.enabled = false) })
    await start($)
    await turn($, SIMPLE, { id: 't1' })
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    await ui.press({ key: 'ar-usage' })
    const shown = await words(ui)
    expect(shown).toContain('Weekly\n$0.00 saved · 0%')
    expect(shown).toContain('opus-5-5')
    await ui.unmount()
  })

  test('before any usage every savings figure reads Unavailable', async ($, on) => {
    world(on)
    await start($)
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    await ui.press({ key: 'ar-usage' })
    const shown = await words(ui)
    for (const label of ['This session', 'Daily', 'Weekly', 'Monthly', 'Saved', 'Percentage', 'Actual cost', 'Unoptimised', 'Total cost']) {
      expect(shown).toContain(`${label}\nUnavailable`)
    }
    expect(shown).not.toMatch(/\$\d/)
    await ui.unmount()
  })

  test('history from before savings were tracked is named and left out', async ($, on) => {
    const old: UsageHistory = {
      version: 1,
      sessions: { old: { startedAt: T0, updatedAt: T0, days: { [dayKey(T0)]: { 'claude-opus-5-5': totals(5_000_000, 0) } } } },
    }
    world(on, { files: { [HISTORY]: JSON.stringify(old) } })
    await start($)
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    await ui.press({ key: 'ar-usage' })
    await ui.press({ key: 'ar-refresh-usage' })
    const shown = await words(ui)
    expect(shown).toContain('Weekly\nUnavailable')
    expect(shown).not.toContain('saved ·')
    await ui.unmount()
  })

  test('monthly needs thirty days of history to be kept', async ($, on) => {
    world(on, { config: c => void (c.telemetry.historyDays = 14) })
    await start($)
    await turn($, SIMPLE, { id: 't1' })
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    await ui.press({ key: 'ar-usage' })
    const shown = await words(ui)
    expect(shown).toContain('Monthly\nUnavailable')
    expect(shown).toContain('telemetry.historyDays keeps 14')
    await ui.unmount()
  })
})
