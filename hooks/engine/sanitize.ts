// What may be kept: short, redacted metadata about a tool call or a task.
// Never a file's content, a tool's result or a whole prompt. Pure: no `$`.

import type { ToolCategory } from '../../types'

const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key]'],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '[key]'],
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9_-]{16,}/g, '[key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[token]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[aws key]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[jwt]'],
  [/\b(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[^\s"']+/gi, '$1[redacted]'],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]'],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@'],
  [/((?:^|[\s"'{,;&?(])[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s"',;&)]+)/gi, '$1[redacted]'],
  [/(--?(?:password|passwd|pwd|token|secret|api-?key|apikey|key|pass)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]'],
  [/(\s-p)\s*(?:"[^"]*"|'[^']*'|[^\s-]\S*)(?=\s|$)/g, '$1 [redacted]'],
  [/\b[A-Fa-f0-9]{40,}\b/g, '[hex]'],
  [/[A-Za-z0-9+/_-]{48,}={0,2}/g, '[blob]'],
]

/** Masks anything shaped like a credential. Over-masks on purpose: a kept secret costs more than a hidden word. */
export function redact(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** One line, at most `max` characters, the cut marked. */
export function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= max) return line
  return `${line.slice(0, Math.max(1, max - 1))}…`
}

/** The last two segments of a path: enough to recognise a file, not a map of the disk. */
export function shortPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(part => part !== '')
  if (parts.length <= 2) return parts.join('/')
  return `…/${parts.slice(-2).join('/')}`
}

export function toolCategory(tool: string): ToolCategory {
  if (tool.startsWith('mcp__')) return 'mcp'
  switch (tool) {
    case 'Read':
    case 'Grep':
    case 'Glob':
    case 'LS':
    case 'NotebookRead':
    case 'ToolSearch':
      return 'read'
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit'
    case 'Write':
      return 'write'
    case 'Bash':
    case 'PowerShell':
    case 'BashOutput':
    case 'KillShell':
    case 'KillBash':
      return 'shell'
    case 'Agent':
    case 'Task':
      return 'agent'
    case 'WebFetch':
    case 'WebSearch':
      return 'web'
    default:
      return 'other'
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function hostOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#@\s]+@)?([^/?#:\s]+)/i.exec(url)
  return match?.[2] ?? 'url'
}

/**
 * A short label for a tool call, from its arguments: the file's name, the
 * start of a command, an MCP tool's name. Arguments that are content (a
 * file's new text, an edit's strings, an MCP tool's input) are never read.
 */
export function toolLabel(tool: string, input: Readonly<Record<string, unknown>>, shouldRedact: boolean): string {
  const clean = (value: string, max: number): string => clip(shouldRedact ? redact(value) : value, max)
  if (tool.startsWith('mcp__')) {
    const [, server = 'mcp', ...rest] = tool.split('__')
    return clip(`mcp ${server.replace(/^plugin_/, '')} / ${rest.join('__') || 'tool'}`, 90)
  }
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return `${tool} ${clean(shortPath(text(input.file_path)), 70)}`
    case 'NotebookEdit':
    case 'NotebookRead':
      return `${tool} ${clean(shortPath(text(input.notebook_path)), 70)}`
    case 'Grep':
    case 'Glob':
      return `${tool} ${clean(text(input.pattern), 48)}`
    case 'Bash':
    case 'PowerShell':
      return `$ ${clean(text(input.command), 84)}`
    case 'WebFetch':
      return `WebFetch ${clean(hostOf(text(input.url)), 60)}`
    case 'WebSearch':
      return `WebSearch ${clean(text(input.query), 56)}`
    case 'Agent':
    case 'Task':
      return `Agent ${clean(text(input.subagent_type) || 'general-purpose', 36)}: ${clean(text(input.description), 44)}`
    default:
      return clip(tool, 60)
  }
}

/** A short, redacted title for a task: the prompt's first line, or `(hidden)` when previews are off. */
export function safeTitle(prompt: string, isPreviewOn: boolean, shouldRedact: boolean): string {
  if (!isPreviewOn) return '(hidden)'
  const first = prompt.split('\n').find(line => line.trim() !== '') ?? ''
  const title = clip(shouldRedact ? redact(first) : first, 72)
  return title === '' ? '(no text)' : title
}
