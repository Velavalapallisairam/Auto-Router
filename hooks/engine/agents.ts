// The five agent definitions as data: the single source the dashboard, the
// router and the tests read. `agents/*.md` must say the same thing, and
// tests/verify-static.mjs checks that they do.

import type { AgentKey, Alias, Effort } from '../../types'

export type AgentDef = {
  key: AgentKey
  /** The file's `name`: the agent type is `auto-router:<name>`. */
  name: string
  title: string
  model: Alias
  effort: Effort
  tools: readonly string[]
  maxTurns: number
  responsibility: string
}

/** Tools that cannot change a file, run a command or start another agent. */
export const READ_ONLY_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob']

/** Tools an agent must not hold to count as read-only. */
export const MUTATING_TOOLS: readonly string[] = [
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'PowerShell',
  'Agent',
  'Task',
]

export const AGENT_DEFS: Readonly<Record<AgentKey, AgentDef>> = {
  headChef: {
    key: 'headChef',
    name: 'head-chef',
    title: 'Head Chef',
    model: 'fable',
    effort: 'xhigh',
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch'],
    maxTurns: 100,
    responsibility: 'Complex architecture, security and exceptional reasoning',
  },
  sousChef: {
    key: 'sousChef',
    name: 'sous-chef',
    title: 'Sous Chef',
    model: 'opus',
    effort: 'high',
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch'],
    maxTurns: 80,
    responsibility: 'Advanced development, debugging and difficult research',
  },
  lineCook: {
    key: 'lineCook',
    name: 'line-cook',
    title: 'Line Cook',
    model: 'sonnet',
    effort: 'medium',
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
    maxTurns: 50,
    responsibility: 'Standard development, testing and routine work',
  },
  prepCook: {
    key: 'prepCook',
    name: 'prep-cook',
    title: 'Prep Cook',
    model: 'haiku',
    effort: 'low',
    tools: ['Read', 'Grep', 'Glob', 'Edit'],
    maxTurns: 20,
    responsibility: 'Simple searches, summaries and repetitive operations',
  },
  reviewer: {
    key: 'reviewer',
    name: 'independent-reviewer',
    title: 'Independent Reviewer',
    model: 'opus',
    effort: 'high',
    tools: ['Read', 'Grep', 'Glob'],
    maxTurns: 30,
    responsibility: 'Fresh-context, read-only review of substantial or high-risk work',
  },
}

/** `auto-router:line-cook` or `line-cook` to its key; undefined for any other agent type. */
export function agentKeyOf(subagentType: string): AgentKey | undefined {
  const bare = subagentType.startsWith('auto-router:')
    ? subagentType.slice('auto-router:'.length)
    : subagentType
  for (const def of Object.values(AGENT_DEFS)) {
    if (def.name === bare) return def.key
  }
  return undefined
}

export function agentTypeOf(key: AgentKey): string {
  return `auto-router:${AGENT_DEFS[key].name}`
}
