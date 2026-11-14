// Usage accounting: what each model and each agent actually used, as the API
// reported it, and the rolling history kept between sessions. Pure: no `$`.
//
// Nothing here is estimated. A figure the engine did not report is absent,
// and the dashboard then says Unavailable.

import type { DayUsage, RateLimitReading, Totals, UsageHistory, UsageState } from '../../types'

export type ReportedUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

export function zero(): Totals {
  return { req: 0, in: 0, out: 0, cr: 0, cw: 0 }
}

export function emptyUsage(): UsageState {
  return { byModel: {}, byAgent: {}, days: {} }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function addInto(target: Totals, usage: ReportedUsage): void {
  target.req += 1
  target.in += num(usage.input_tokens)
  target.out += num(usage.output_tokens)
  target.cr += num(usage.cache_read_input_tokens)
  target.cw += num(usage.cache_creation_input_tokens)
}

function addTotals(target: Totals, more: Totals): void {
  target.req += num(more.req)
  target.in += num(more.in)
  target.out += num(more.out)
  target.cr += num(more.cr)
  target.cw += num(more.cw)
}

/** The local calendar day of `ms`, `YYYY-MM-DD`. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

/** The baseline key for a request whose engine model is not known. */
export const UNKNOWN_BASE = 'unknown'

/**
 * Adds one response's reported usage under its model, its agent and its day.
 * `baseline` is the model the engine would have used with no router: `null`
 * for a request only the router makes (no baseline cost), absent when it is
 * not known. Mutates `state`.
 */
export function recordUsage(state: UsageState, agent: string, usage: ReportedUsage, now: number, baseline?: string | null): void {
  const model = usage.model === '' ? 'unknown' : usage.model
  if (state.base === undefined) {
    if (Object.keys(state.days).length > 0) state.basePartial = true
    state.base = {}
  }
  if (baseline !== null) {
    const baseDay = (state.base[dayKey(now)] ??= {})
    addInto((baseDay[baseline === undefined || baseline === '' ? UNKNOWN_BASE : baseline] ??= zero()), usage)
  }
  addInto((state.byModel[model] ??= zero()), usage)
  const lane = (state.byAgent[agent] ??= { ...zero() })
  addInto(lane, usage)
  lane.model = model
  const split = ((state.byAgentModel ??= {})[agent] ??= {})
  addInto((split[model] ??= zero()), usage)
  const day = (state.days[dayKey(now)] ??= {})
  addInto((day[model] ??= zero()), usage)
  state.startedAt ??= now
}

export function sumTotals(map: Readonly<Record<string, Totals>>): Totals {
  const total = zero()
  for (const one of Object.values(map)) addTotals(total, one)
  return total
}

/** The share of input the prompt cache served, 0 to 1; undefined with no input to speak of. */
export function cacheHitRate(totals: Totals): number | undefined {
  const input = totals.in + totals.cr + totals.cw
  return input > 0 ? totals.cr / input : undefined
}

/** What a response was answered over: uncached, cache-written and cache-read input together. */
export function contextOf(usage: ReportedUsage): number {
  return num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens)
}

function isTotals(value: unknown): value is Totals {
  if (typeof value !== 'object' || value === null) return false
  const t = value as Record<string, unknown>
  return ['req', 'in', 'out', 'cr', 'cw'].every(key => typeof t[key] === 'number')
}

/** Reads a history file's text; undefined when it is not one (missing, torn, another format). */
export function parseHistory(text: string): UsageHistory | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<UsageHistory>
    if (parsed.version !== 1 || typeof parsed.sessions !== 'object' || parsed.sessions === null) return undefined
    const sessions: UsageHistory['sessions'] = {}
    for (const [id, session] of Object.entries(parsed.sessions)) {
      if (typeof session !== 'object' || session === null) continue
      const days: Record<string, Record<string, Totals>> = {}
      for (const [day, models] of Object.entries(session.days ?? {})) {
        const kept: Record<string, Totals> = {}
        for (const [model, totals] of Object.entries(models ?? {})) {
          if (isTotals(totals)) kept[model] = totals
        }
        days[day] = kept
      }
      const entry: UsageHistory['sessions'][string] = { startedAt: num(session.startedAt), updatedAt: num(session.updatedAt), days }
      if (typeof session.base === 'object' && session.base !== null) {
        const base: Record<string, Record<string, Totals>> = {}
        for (const [day, models] of Object.entries(session.base)) {
          const kept: Record<string, Totals> = {}
          for (const [model, totals] of Object.entries(models ?? {})) {
            if (isTotals(totals)) kept[model] = totals
          }
          base[day] = kept
        }
        entry.base = base
        if (session.partial === true) entry.partial = true
      }
      sessions[id] = entry
    }
    return { version: 1, sessions, lastLimits: parsed.lastLimits }
  } catch {
    return undefined
  }
}

/**
 * Puts this session's own totals into the history and drops sessions older
 * than `keepDays`. A session always writes its whole running total under its
 * own id, never a difference, so writing twice changes nothing and a write
 * another session overtook is put right by the next one.
 */
export function mergeHistory(
  history: UsageHistory | undefined,
  sessionId: string,
  state: UsageState,
  now: number,
  keepDays: number,
  limits?: readonly RateLimitReading[],
): UsageHistory {
  const sessions: UsageHistory['sessions'] = {}
  const oldest = now - keepDays * 86_400_000
  for (const [id, session] of Object.entries(history?.sessions ?? {})) {
    if (id !== sessionId && session.updatedAt >= oldest) sessions[id] = session
  }
  if (Object.keys(state.days).length > 0) {
    sessions[sessionId] = {
      startedAt: state.startedAt ?? now,
      updatedAt: now,
      days: JSON.parse(JSON.stringify(state.days)) as Record<string, Record<string, Totals>>,
      ...(state.base === undefined ? {} : { base: JSON.parse(JSON.stringify(state.base)) as Record<string, Record<string, Totals>> }),
      ...(state.basePartial === true ? { partial: true } : {}),
    }
  }
  const lastLimits =
    limits !== undefined && limits.length > 0 ? { at: now, rateLimits: [...limits] } : history?.lastLimits
  return lastLimits === undefined ? { version: 1, sessions } : { version: 1, sessions, lastLimits }
}

/** Totals by model over the last `days` local days, across every session in the history. */
export function aggregate(
  history: UsageHistory,
  now: number,
  days: number,
): { byModel: Record<string, Totals>; sessions: number } {
  const wanted = new Set<string>()
  for (let back = 0; back < days; back += 1) wanted.add(dayKey(now - back * 86_400_000))
  const byModel: Record<string, Totals> = {}
  let sessions = 0
  for (const session of Object.values(history.sessions)) {
    let isCounted = false
    for (const [day, models] of Object.entries(session.days)) {
      if (!wanted.has(day)) continue
      for (const [model, totals] of Object.entries(models)) {
        addTotals((byModel[model] ??= zero()), totals)
        isCounted = true
      }
    }
    if (isCounted) sessions += 1
  }
  return { byModel, sessions }
}

/**
 * The last `days` local days, oldest first, one entry each (an empty one for a
 * day with no usage). A session that kept no baseline is counted in `skipped`
 * and in neither total, so the two sides always cover the same requests.
 */
export function aggregateDays(history: UsageHistory, now: number, days: number): Record<string, DayUsage> {
  const out: Record<string, DayUsage> = {}
  for (let back = days - 1; back >= 0; back -= 1) out[dayKey(now - back * 86_400_000)] = { actual: {}, base: {}, skipped: 0 }
  for (const session of Object.values(history.sessions)) {
    const isCovered = session.base !== undefined && session.partial !== true
    for (const [day, models] of Object.entries(session.days)) {
      const slot = out[day]
      if (slot === undefined || Object.keys(models).length === 0) continue
      if (!isCovered) {
        slot.skipped += 1
        continue
      }
      for (const [model, totals] of Object.entries(models)) addTotals((slot.actual[model] ??= zero()), totals)
      for (const [model, totals] of Object.entries(session.base?.[day] ?? {})) addTotals((slot.base[model] ??= zero()), totals)
    }
  }
  return out
}

/** This session's own days in the same form, live: no history file needed. */
export function sessionDays(state: UsageState): DayUsage[] {
  if (state.base === undefined || state.basePartial === true) return []
  return Object.entries(state.days).map(([day, actual]) => ({ actual, base: state.base?.[day] ?? {}, skipped: 0 }))
}
