// What usage costs at the list prices in `costModel`, and what the same tokens
// would have cost on the model the engine would have used with no router.
// Pure: no `$`.
//
// A cost here is an estimate from reported tokens and configured prices, and
// is labelled so wherever it is shown. It is never a bill. Where a model
// cannot be priced, or no baseline was recorded, the answer is undefined and
// the dashboard says Unavailable.

import type { DayUsage, RouterConfig, Totals } from '../../types'
import { aliasOf } from './route.ts'

type Pricing = Pick<RouterConfig, 'costModel' | 'cache'>

function tokens(totals: Totals): number {
  return totals.in + totals.out + totals.cr + totals.cw
}

/** US dollars for `totals` on `model`; undefined when the model has no price and used tokens. */
export function costOf(model: string, totals: Totals, config: Pricing): number | undefined {
  const alias = aliasOf(model)
  if (alias === undefined) return tokens(totals) === 0 ? 0 : undefined
  const price = config.costModel[alias]
  return (totals.in * price.in + totals.out * price.out + totals.cr * price.cacheRead + totals.cw * price.in * config.cache.writeMultiplier) / 1_000_000
}

/** The sum over a map keyed by model; undefined when any entry cannot be priced. */
export function costOfMap(map: Readonly<Record<string, Totals>>, config: Pricing): number | undefined {
  let sum = 0
  for (const [model, totals] of Object.entries(map)) {
    const one = costOf(model, totals, config)
    if (one === undefined) return undefined
    sum += one
  }
  return sum
}

export type Saving = {
  /** Estimated cost of what ran. */
  actual: number
  /** The same tokens on the model the engine would have used. */
  baseline: number
  /** baseline - actual; negative when the router spent more. */
  saved: number
  /** saved / baseline, 0 to 100; undefined with no baseline cost. */
  percent: number | undefined
  requests: number
  /** Sessions left out because they kept no baseline. */
  skipped: number
}

/**
 * The saving over a set of days. Undefined when nothing was recorded with a
 * baseline, or when either side cannot be priced.
 */
export function savingOf(days: readonly DayUsage[], config: Pricing): Saving | undefined {
  let actual = 0
  let baseline = 0
  let requests = 0
  let skipped = 0
  for (const day of days) {
    skipped += day.skipped
    const a = costOfMap(day.actual, config)
    const b = costOfMap(day.base, config)
    if (a === undefined || b === undefined) return undefined
    actual += a
    baseline += b
    for (const totals of Object.values(day.actual)) requests += totals.req
  }
  if (requests === 0) return undefined
  const saved = baseline - actual
  return { actual, baseline, saved, percent: baseline > 0 ? (saved / baseline) * 100 : undefined, requests, skipped }
}

/** The newest `count` days of a series, oldest first, with their keys. */
export function lastDays(series: Readonly<Record<string, DayUsage>>, count: number): [string, DayUsage][] {
  return Object.entries(series)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-count)
}
