// Reading a failed tool call (is a stronger model the answer, or is the
// environment broken?) and tagging a call that is destructive or reaches
// production. Pure: no `$`, no I/O.

export type FailureKind = 'environmental' | 'substantive' | 'minor' | 'unknown'

export type Failure = {
  kind: FailureKind
  /** The same for the same tool failing the same way: what "identical failure" is counted by. */
  signature: string
  /** What kind of failure it was, in a few words. Never the error text itself. */
  summary: string
}

const ENVIRONMENTAL: readonly (readonly [RegExp, string])[] = [
  [/\b(?:enoent|no such file or directory|cannot find the (?:file|path)|path not found)\b/i, 'missing file or path'],
  [/\b(?:command not found|is not recognized as (?:an? )?(?:internal|the name)|not installed|executable file not found)\b/i, 'missing program'],
  [/\b(?:eacces|eperm|permission denied|access is denied|operation not permitted|unauthorized|authentication failed|not logged in|\b401\b|\b403\b)\b/i, 'permission or sign-in'],
  [/\b(?:etimedout|timed? ?out|timeout|deadline exceeded)\b/i, 'timeout'],
  [/\b(?:econnrefused|econnreset|enotfound|network (?:error|unreachable)|could not resolve host|connection refused|dns|socket hang up|offline)\b/i, 'network'],
  [/\b(?:rate limit|too many requests|\b429\b|overloaded|service unavailable|\b50[234]\b|bad gateway)\b/i, 'service limit'],
  [/\b(?:enospc|disk (?:is )?full|no space left|out of memory|oom|killed|ebusy|resource busy|file is locked|being used by another process)\b/i, 'machine resource'],
]

const SUBSTANTIVE: readonly (readonly [RegExp, string])[] = [
  [/\b(?:tests? failed|failing tests?|failed tests?|\d+ (?:failed|failing)|assertion ?error|assertionerror|expected\b.{0,80}\b(?:to|but|received))\b/i, 'failing test'],
  [/\b(?:error ts\d+|is not assignable to|type error|typeerror|cannot find (?:name|module)|has no exported member|property .{1,40} does not exist)\b/i, 'type or reference error'],
  [/\b(?:syntaxerror|syntax error|unexpected token|parse error|invalid syntax|indentationerror)\b/i, 'syntax error'],
  [/\b(?:referenceerror|nameerror|attributeerror|valueerror|keyerror|indexerror|null ?pointer|undefined is not|is not a function|is not defined)\b/i, 'runtime error'],
  [/\b(?:traceback \(most recent call last\)|panic:|segmentation fault|unhandled (?:exception|rejection)|stack trace)\b/i, 'crash'],
  [/\b(?:compilation failed|build failed|failed to compile|lint errors?|\d+ errors?)\b/i, 'build or lint failure'],
]

const MINOR = /\b(?:string to replace not found|old_string|not unique|has not been read|read it first|has been modified since|file already exists|no changes to make)\b/i

function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** Reads a failed tool call's error text. The text is matched, hashed and dropped: none of it is returned. */
export function classifyFailure(tool: string, errorText: string): Failure {
  const text = errorText.slice(0, 4000)
  const normal = text
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 240)
  const signature = hash(`${tool}|${normal}`)
  if ((tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'Read') && MINOR.test(text)) {
    return { kind: 'minor', signature, summary: 'tool misuse' }
  }
  for (const [pattern, summary] of SUBSTANTIVE) {
    if (pattern.test(text)) return { kind: 'substantive', signature, summary }
  }
  for (const [pattern, summary] of ENVIRONMENTAL) {
    if (pattern.test(text)) return { kind: 'environmental', signature, summary }
  }
  return { kind: 'unknown', signature, summary: 'unclassified error' }
}

const DESTRUCTIVE: readonly (readonly [RegExp, string])[] = [
  [/\brm\s+(?:-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r)\b|\bremove-item\b[^|;&]*-recurse\b|\brmdir\s+\/s\b|\bdel\s+\/s\b|\brd\s+\/s\b/i, 'recursive delete'],
  [/\bgit\s+push\b[^|;&]*(?:--force\b|--force-with-lease\b|\s-f\b)|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f|\bgit\s+branch\s+-D\b/i, 'git history or worktree loss'],
  [/\bdrop\s+(?:table|database|schema|index)\b|\btruncate\s+table\b|\bdelete\s+from\s+\w+\s*(?:;|$)/i, 'destructive SQL'],
  [/\b(?:prisma\s+migrate\s+(?:deploy|reset)|alembic\s+(?:upgrade|downgrade)|supabase\s+db\s+(?:reset|push)|knex\s+migrate:(?:latest|rollback)|rake\s+db:(?:migrate|drop|reset)|flyway\s+(?:migrate|clean))\b/i, 'database change'],
  [/\b(?:terraform|tofu|pulumi)\s+(?:apply|destroy|up)\b|\bkubectl\s+(?:delete|apply|replace|rollout)\b|\bhelm\s+(?:upgrade|install|uninstall|delete|rollback)\b/i, 'infrastructure change'],
  [/\b(?:wrangler\s+(?:deploy|publish)|vercel\b[^|;&]*--prod\b|netlify\s+deploy\b[^|;&]*--prod\b|firebase\s+deploy|fly\s+deploy|railway\s+up|gcloud\s+(?:app|run)\s+deploy|aws\s+(?:s3\s+rm\b[^|;&]*--recursive|cloudformation\s+(?:deploy|delete-stack))|npm\s+publish|cargo\s+publish|docker\s+push|gh\s+release\s+create)\b/i, 'production deployment'],
  [/\b(?:mkfs|dd\s+if=|shutdown|reboot|format\s+[a-z]:|diskpart|docker\s+system\s+prune|chmod\s+-R\s+777)\b/i, 'machine-level command'],
]

const HIGH_IMPACT_MCP = /(?:^|_)(?:delete|drop|destroy|remove|reset|purge|merge|deploy|publish|send|pause|restore|rotate|revoke|trash)(?:_|$)/i

/**
 * Names what makes a tool call destructive or production-reaching, or
 * undefined. A tag for the dashboard's risk line, and, only when
 * `guardrails.confirmDestructive` is on, the reason an allowed call is put to
 * the person instead. It never approves anything.
 */
export function destructiveMatch(tool: string, input: unknown): string | undefined {
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command =
      typeof input === 'object' && input !== null && typeof (input as { command?: unknown }).command === 'string'
        ? ((input as { command: string }).command)
        : ''
    for (const [pattern, label] of DESTRUCTIVE) {
      if (pattern.test(command)) return label
    }
    return undefined
  }
  if (tool.startsWith('mcp__')) {
    const name = tool.split('__').slice(2).join('__')
    if (HIGH_IMPACT_MCP.test(name)) return 'high-impact connector action'
  }
  return undefined
}
