// The remaining pure pieces: agent definitions, redaction, failure reading,
// destructive-call tagging and usage accounting.

import { describe, expect, test } from 'claude-code/testing'

import { AGENT_DEFS, MUTATING_TOOLS, READ_ONLY_TOOLS, agentKeyOf, agentTypeOf } from '../hooks/engine/agents.ts'
import { defaultConfig } from '../hooks/engine/config.ts'
import { AGENT_KEYS, ALIASES, EFFORTS } from '../hooks/engine/consts.ts'
import { classifyFailure, destructiveMatch } from '../hooks/engine/guard.ts'
import { clip, redact, safeTitle, shortPath, toolCategory, toolLabel } from '../hooks/engine/sanitize.ts'
import { UNAVAILABLE, fmtDuration, fmtPercent, fmtTokens, limitText, modelEvidence, usageText } from '../hooks/engine/text.ts'
import { aggregate, cacheHitRate, dayKey, emptyUsage, mergeHistory, parseHistory, recordUsage, sumTotals } from '../hooks/engine/usage.ts'

describe('agent definitions', () => {
  test('there are five, each with an explicit model, effort and tool list', () => {
    expect(AGENT_KEYS.length).toBe(5)
    for (const key of AGENT_KEYS) {
      const def = AGENT_DEFS[key]
      expect(ALIASES).toContain(def.model)
      expect(EFFORTS).toContain(def.effort)
      expect(def.tools.length).toBeGreaterThan(0)
      expect(def.maxTurns).toBeGreaterThan(0)
    }
  })

  test('the tiers map to the models the request named', () => {
    expect(AGENT_DEFS.headChef.model).toBe('fable')
    expect(AGENT_DEFS.sousChef.model).toBe('opus')
    expect(AGENT_DEFS.lineCook.model).toBe('sonnet')
    expect(AGENT_DEFS.prepCook.model).toBe('haiku')
    expect(AGENT_DEFS.reviewer.model).toBe('opus')
    const config = defaultConfig()
    for (const key of AGENT_KEYS) expect(config.tiers[key].model).toBe(AGENT_DEFS[key].model)
  })

  test('the reviewer is isolated: read-only tools and nothing that edits, runs or delegates', () => {
    const tools = AGENT_DEFS.reviewer.tools
    for (const tool of tools) expect(READ_ONLY_TOOLS).toContain(tool)
    for (const tool of MUTATING_TOOLS) expect(tools).not.toContain(tool)
  })

  test('no agent can start another agent, and privilege narrows down the tiers', () => {
    for (const key of AGENT_KEYS) {
      expect(AGENT_DEFS[key].tools).not.toContain('Agent')
      expect(AGENT_DEFS[key].tools).not.toContain('Task')
    }
    expect(AGENT_DEFS.prepCook.tools).not.toContain('Bash')
    expect(AGENT_DEFS.prepCook.tools).not.toContain('Write')
    expect(AGENT_DEFS.lineCook.tools).not.toContain('WebFetch')
  })

  test('agent types resolve both ways', () => {
    expect(agentTypeOf('lineCook')).toBe('auto-router:line-cook')
    expect(agentKeyOf('auto-router:independent-reviewer')).toBe('reviewer')
    expect(agentKeyOf('general-purpose')).toBeUndefined()
  })
})

describe('redaction', () => {
  const secrets: [string, string, string][] = [
    ['a bearer header', 'curl -H "Authorization: Bearer abcdefghijklmnop12345" https://x.test', 'abcdefghijklmnop12345'],
    ['an Anthropic key', 'export ANTHROPIC_API_KEY=sk-ant-api03-abc123def456ghi789', 'abc123def456ghi789'],
    ['a GitHub token', 'git clone https://ghp_0123456789abcdefghijABCDEFGHIJ0123456789@github.com/a/b', 'ghp_0123456789abcdefghijABCDEFGHIJ0123456789'],
    ['a password in a URL', 'psql postgres://admin:hunter2@db.example.com/app', 'hunter2'],
    ['a password flag', 'mysql --password=s3cr3tpw -u root', 's3cr3tpw'],
    ['an assignment', 'DB_PASSWORD="correct horse" npm start', 'correct horse'],
    ['an AWS key id', 'aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['a JWT', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0'],
    ['a private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', 'MIIEow'],
  ]
  for (const [name, text, secret] of secrets) {
    test(`${name} is masked`, () => {
      expect(redact(text)).not.toContain(secret)
    })
  }

  test('ordinary text is left readable', () => {
    expect(redact('npm run test -- --watch src/utils')).toBe('npm run test -- --watch src/utils')
  })

  test('a tool label never carries content, only what names the call', () => {
    const write = toolLabel('Write', { file_path: '/home/me/app/src/config.ts', content: 'TOP SECRET FILE BODY' }, true)
    expect(write).toBe('Write \u2026/src/config.ts')
    const edit = toolLabel('Edit', { file_path: 'a.ts', old_string: 'PRIVATE OLD', new_string: 'PRIVATE NEW' }, true)
    expect(edit).not.toContain('PRIVATE')
    const mcp = toolLabel('mcp__github__create_issue', { title: 'x', body: 'confidential body' }, true)
    expect(mcp).toBe('mcp github / create_issue')
    const shell = toolLabel('Bash', { command: 'curl -H "Authorization: Bearer abcdefghijklmnop12345" https://x.test' }, true)
    expect(shell).not.toContain('abcdefghijklmnop12345')
    expect(toolLabel('WebFetch', { url: 'https://user:pw@example.com/path?token=abc' }, true)).toBe('WebFetch example.com')
  })

  test('a task title is one short redacted line, or hidden', () => {
    expect(safeTitle('  \nfix login\nmore detail here', true, true)).toBe('fix login')
    expect(safeTitle('use key sk-ant-api03-abc123def456ghi789 to call it', true, true)).not.toContain('abc123def456')
    expect(safeTitle('anything', false, true)).toBe('(hidden)')
    expect(safeTitle('x'.repeat(500), true, true).length).toBeLessThanOrEqual(72)
  })

  test('small helpers', () => {
    expect(clip('a  b\n c', 20)).toBe('a b c')
    expect(clip('abcdefghij', 5).length).toBe(5)
    expect(shortPath('C:\\Users\\me\\proj\\src\\a.ts')).toBe('\u2026/src/a.ts')
    expect(toolCategory('Read')).toBe('read')
    expect(toolCategory('Edit')).toBe('edit')
    expect(toolCategory('Write')).toBe('write')
    expect(toolCategory('Bash')).toBe('shell')
    expect(toolCategory('mcp__x__y')).toBe('mcp')
    expect(toolCategory('Agent')).toBe('agent')
  })
})

describe('reading a failure', () => {
  test('a failing test, a type error and a crash are substantive', () => {
    expect(classifyFailure('Bash', 'FAIL src/a.test.ts\n  expected 3 to be 4\nTests: 1 failed, 2 passed').kind).toBe('substantive')
    expect(classifyFailure('Bash', "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.").kind).toBe('substantive')
    expect(classifyFailure('Bash', 'Traceback (most recent call last):\n  File "a.py", line 2\nKeyError: 1').kind).toBe('substantive')
  })

  test('a missing program, a permission and a timeout are environmental', () => {
    expect(classifyFailure('Bash', 'bash: pnpm: command not found').kind).toBe('environmental')
    expect(classifyFailure('Bash', 'EACCES: permission denied, open /etc/hosts').kind).toBe('environmental')
    expect(classifyFailure('WebFetch', 'request timed out after 30000ms').kind).toBe('environmental')
    expect(classifyFailure('Bash', 'Not logged in · Please run /login').kind).toBe('environmental')
  })

  test('a tool used wrongly is minor, and an unknown error is unknown', () => {
    expect(classifyFailure('Edit', 'String to replace not found in file.').kind).toBe('minor')
    expect(classifyFailure('Bash', 'something odd happened').kind).toBe('unknown')
  })

  test('the same failure has the same signature whatever its numbers; a different one differs', () => {
    const a = classifyFailure('Bash', 'Tests: 1 failed, 12 passed in 340ms')
    const b = classifyFailure('Bash', 'Tests: 1 failed, 13 passed in 512ms')
    const c = classifyFailure('Bash', 'error TS2322: nope')
    expect(a.signature).toBe(b.signature)
    expect(a.signature).not.toBe(c.signature)
    expect(a.summary).not.toContain('340')
  })
})

describe('destructive calls are tagged', () => {
  const commands: [string, string | undefined][] = [
    ['rm -rf build', 'recursive delete'],
    ['Remove-Item -Recurse -Force dist', 'recursive delete'],
    ['git push --force origin main', 'git history or worktree loss'],
    ['git reset --hard HEAD~3', 'git history or worktree loss'],
    ['psql -c "DROP TABLE users"', 'destructive SQL'],
    ['npx prisma migrate deploy', 'database change'],
    ['terraform apply -auto-approve', 'infrastructure change'],
    ['npx wrangler deploy', 'production deployment'],
    ['vercel --prod', 'production deployment'],
    ['ls -la', undefined],
    ['npm test', undefined],
    ['git push origin feature/x', undefined],
    ['git status', undefined],
  ]
  for (const [text, label] of commands) {
    test(`\`${text}\` -> ${label ?? 'nothing'}`, () => {
      expect(destructiveMatch('Bash', { command: text })).toBe(label)
    })
  }

  test('a connector action that deletes is tagged; one that reads is not', () => {
    expect(destructiveMatch('mcp__neon__delete_project', {})).toBe('high-impact connector action')
    expect(destructiveMatch('mcp__neon__list_projects', {})).toBeUndefined()
    expect(destructiveMatch('Read', { file_path: 'rm -rf' })).toBeUndefined()
  })
})

describe('usage accounting', () => {
  const use = (model: string, input: number, output: number, read = 0, written = 0) => ({
    model,
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: written,
  })
  const DAY = Date.UTC(2026, 10, 13, 12, 0, 0)

  test('each response is counted under its actual model, its agent and its day', () => {
    const state = emptyUsage()
    recordUsage(state, 'main', use('claude-sonnet-5-5', 100, 20, 900, 50), DAY)
    recordUsage(state, 'main', use('claude-sonnet-5-5', 10, 5, 1000, 0), DAY)
    recordUsage(state, 'auto-router:prep-cook', use('claude-haiku-5-5', 40, 8), DAY)
    expect(state.byModel['claude-sonnet-5-5']).toEqual({ req: 2, in: 110, out: 25, cr: 1900, cw: 50 })
    expect(state.byModel['claude-haiku-5-5']).toEqual({ req: 1, in: 40, out: 8, cr: 0, cw: 0 })
    expect(state.byAgent.main?.model).toBe('claude-sonnet-5-5')
    expect(state.byAgent['auto-router:prep-cook']?.req).toBe(1)
    expect(state.days[dayKey(DAY)]?.['claude-sonnet-5-5']?.req).toBe(2)
    expect(sumTotals(state.byModel).in).toBe(150)
  })

  test('the cache hit rate is cache reads over all input, and absent with none', () => {
    expect(cacheHitRate({ req: 1, in: 100, out: 0, cr: 900, cw: 0 })).toBe(0.9)
    expect(cacheHitRate({ req: 0, in: 0, out: 0, cr: 0, cw: 0 })).toBeUndefined()
  })

  test('writing a session to the history twice changes nothing, and other sessions are kept', () => {
    const state = emptyUsage()
    recordUsage(state, 'main', use('claude-opus-5-5', 500, 100), DAY)
    const other = { version: 1 as const, sessions: { other: { startedAt: DAY, updatedAt: DAY, days: { [dayKey(DAY)]: { 'claude-haiku-5-5': { req: 3, in: 30, out: 3, cr: 0, cw: 0 } } } } } }
    const once = mergeHistory(other, 'mine', state, DAY, 35)
    const twice = mergeHistory(once, 'mine', state, DAY, 35)
    expect(twice).toEqual(once)
    expect(Object.keys(once.sessions).sort()).toEqual(['mine', 'other'])
    const week = aggregate(once, DAY, 7)
    expect(week.sessions).toBe(2)
    expect(week.byModel['claude-opus-5-5']?.in).toBe(500)
    expect(week.byModel['claude-haiku-5-5']?.req).toBe(3)
  })

  test('sessions past the retention window are dropped, and old days fall out of the week', () => {
    const old = DAY - 40 * 86_400_000
    const history = { version: 1 as const, sessions: { ancient: { startedAt: old, updatedAt: old, days: { [dayKey(old)]: { m: { req: 1, in: 1, out: 1, cr: 0, cw: 0 } } } } } }
    const merged = mergeHistory(history, 'mine', emptyUsage(), DAY, 35)
    expect(merged.sessions.ancient).toBeUndefined()
    const tenDays = DAY - 10 * 86_400_000
    const recent = { version: 1 as const, sessions: { s: { startedAt: tenDays, updatedAt: tenDays, days: { [dayKey(tenDays)]: { m: { req: 1, in: 9, out: 1, cr: 0, cw: 0 } } } } } }
    expect(aggregate(recent, DAY, 7).sessions).toBe(0)
    expect(aggregate(recent, DAY, 14).byModel.m?.in).toBe(9)
  })

  test('a torn or foreign history file is not read as one', () => {
    expect(parseHistory('{"version":1,"sessions":{"a":{"startedAt":1,"upda')).toBeUndefined()
    expect(parseHistory('{"version":2,"sessions":{}}')).toBeUndefined()
    expect(parseHistory('[]')).toBeUndefined()
    expect(parseHistory('{"version":1,"sessions":{}}')).toEqual({ version: 1, sessions: {}, lastLimits: undefined })
  })
})

describe('what is shown', () => {
  test('a figure that was never reported reads Unavailable', () => {
    expect(fmtTokens(undefined)).toBe(UNAVAILABLE)
    expect(fmtPercent(undefined)).toBe(UNAVAILABLE)
    expect(limitText(undefined)).toBe(UNAVAILABLE)
    const text = usageText(emptyUsage())
    expect(text).toContain(`Weekly plan usage: ${UNAVAILABLE}`)
    expect(text).toContain(`Fable usage credits: ${UNAVAILABLE}`)
    expect(text).toContain(`Session cost: ${UNAVAILABLE}`)
    expect(text).toContain(`Context window: ${UNAVAILABLE}`)
  })

  test('a reported limit is shown as reported, with its reset when there is one', () => {
    expect(limitText({ kind: 'seven_day', percentUsed: 41.5, resetsAt: '2026-11-16T09:00:00Z' })).toContain('41.5% used · resets')
    expect(limitText({ kind: 'seven_day', percentUsed: 7 })).toBe('7% used · reset time unavailable')
  })

  test('an assigned model is never shown as the one that answered', () => {
    expect(modelEvidence('sonnet', undefined)).toBe('sonnet assigned · actual not reported yet')
    expect(modelEvidence('sonnet', 'claude-sonnet-5-5')).toBe('sonnet assigned · sonnet-5-5 answered (API)')
  })

  test('numbers are compact', () => {
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(12_300)).toBe('12.3k')
    expect(fmtTokens(1_250_000)).toBe('1.25M')
    expect(fmtDuration(42_000)).toBe('0:42')
    expect(fmtDuration(3_780_000)).toBe('1h03m')
  })
})
