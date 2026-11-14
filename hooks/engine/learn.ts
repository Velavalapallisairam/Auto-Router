// Learning from outcomes: which kinds of task had to be escalated or ended in
// an error on the model they started on. A kind that keeps needing more
// starts one tier up next time. Pure: no `$`, no I/O. Only counts are kept,
// keyed by complexity and area: never a prompt, never an error text.

import type { Alias, Complexity, RouterConfig } from '../../types'

export type Outcome = { at: number; alias: Alias; isEscalated: boolean; isFailed: boolean }
export type Learning = { version: 1; kinds: Record<string, Outcome[]> }

const MAX_KINDS = 200

export function emptyLearning(): Learning {
  return { version: 1, kinds: {} }
}

/** The kind a task belongs to: its complexity and its two leading areas. */
export function kindOf(complexity: Complexity, domains: readonly string[]): string {
  return `${complexity}|${[...domains].sort().slice(0, 2).join('+') || 'general'}`
}

export function parseLearning(text: string): Learning {
  try {
    const raw = JSON.parse(text) as Partial<Learning>
    if (raw.version !== 1 || typeof raw.kinds !== 'object' || raw.kinds === null) return emptyLearning()
    const kinds: Record<string, Outcome[]> = {}
    for (const [kind, list] of Object.entries(raw.kinds)) {
      if (!Array.isArray(list)) continue
      kinds[kind] = list.filter(
        one => typeof one === 'object' && one !== null && typeof one.at === 'number' && typeof one.alias === 'string',
      )
    }
    return { version: 1, kinds }
  } catch {
    return emptyLearning()
  }
}

/** Adds one finished task. Keeps the newest `window` outcomes per kind. Mutates `learning`. */
export function recordOutcome(learning: Learning, kind: string, outcome: Outcome, config: RouterConfig): void {
  const list = learning.kinds[kind] ?? []
  list.push(outcome)
  learning.kinds[kind] = list.slice(-config.learning.window)
  const names = Object.keys(learning.kinds)
  if (names.length > MAX_KINDS) {
    // Forget the kinds not seen for longest.
    names
      .sort((a, b) => (learning.kinds[a]?.at(-1)?.at ?? 0) - (learning.kinds[b]?.at(-1)?.at ?? 0))
      .slice(0, names.length - MAX_KINDS)
      .forEach(name => delete learning.kinds[name])
  }
}

/**
 * The person said the answer missed. The run just recorded for this kind was
 * counted as fine when its turn ended; it is marked failed. With none to mark,
 * a failed run is added. Mutates `learning`.
 */
export function recordMiss(learning: Learning, kind: string, at: number, alias: Alias, config: RouterConfig): void {
  const last = learning.kinds[kind]?.at(-1)
  if (last !== undefined && !last.isFailed) {
    last.isFailed = true
    last.at = at
    return
  }
  recordOutcome(learning, kind, { at, alias, isEscalated: false, isFailed: true }, config)
}

/**
 * Whether tasks of this kind should start one tier above `alias`: at least
 * `bumpAfter` of the remembered runs that started on `alias` (or stronger)
 * were escalated or failed. A failure on a weaker model says nothing here.
 */
export function shouldStartHigher(
  learning: Learning,
  kind: string,
  alias: Alias,
  order: readonly Alias[],
  config: RouterConfig,
): boolean {
  if (!config.learning.enabled) return false
  const at = order.indexOf(alias)
  const bad = (learning.kinds[kind] ?? []).filter(
    one => (one.isEscalated || one.isFailed) && order.indexOf(one.alias) >= at,
  )
  return bad.length >= config.learning.bumpAfter
}
