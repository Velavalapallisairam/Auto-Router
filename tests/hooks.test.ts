// The mod end to end, on mocked events: what reaches the engine after the
// router has had its say. No model, no disk, no network.

import { describe, expect, test } from 'claude-code/testing'

import { defaultConfig, serializeConfig } from '../hooks/engine/config.ts'
import { CONFIG, DIR, SESSION, command, spawn, start, step, submit, turn, world } from './helpers.ts'

const SIMPLE = 'fix the typo in the README heading'
const STANDARD = 'add a unit test for the parseDate function'
const COMPLEX = 'debug the intermittent deadlock in the job scheduler'
const SECURITY = 'refactor the authentication module across all services and harden the session handling'
const HISTORY = `${DIR}/usage-history.json`

describe('session start', () => {
  test('registers the command and the tool, opens the pane without taking the keyboard, and leaves settings alone', async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.commands).toEqual(['auto-router'])
    expect(w.tools).toEqual(['configure'])
    expect(w.opened).toEqual([{ id: 'auto-router', title: 'Auto Router' }])
    expect(w.opened[0]).not.toHaveProperty('focus')
    expect(w.read(CONFIG)).toBe(serializeConfig(defaultConfig()))
    expect(w.read(`${DIR}/config.schema.json`)).toContain('"title": "Auto Router configuration"')
    // Existing settings preservation: every write is under the router's own folder.
    expect(w.writes.length).toBeGreaterThan(0)
    for (const path of w.writes) expect(path.startsWith(DIR)).toBe(true)
    expect(w.writes.join('\n')).not.toContain('settings.json')
    expect(w.envWrites).toEqual([])
  })

  test('a pane the person closed stays closed at the next start', async ($, on) => {
    const w = world(on, { store: { panel: { hiddenByUser: true } } })
    await start($)
    expect(w.opened).toEqual([])
    expect(w.commands).toEqual(['auto-router'])
  })

  test('with the dashboard turned off nothing is opened, and routing still works', async ($, on) => {
    const w = world(on, {
      config: c => {
        c.sidePanel.enabled = false
      },
    })
    await start($)
    await turn($, SIMPLE, { id: 't1' })
    expect(w.opened).toEqual([])
    expect(w.steps[0]?.model).toBe('haiku')
  })

  test('where no surface can seat the pane, a status line stands in', async ($, on) => {
    const w = world(on, { isPlaced: false })
    await start($)
    expect(w.statuses.at(-1)).toContain('Auto Router')
    await turn($, SIMPLE, { id: 't1' })
    expect(w.steps[0]?.model).toBe('haiku')
  })

  test('a mod loaded into a running session sets itself up at the first event', async ($, on) => {
    const w = world(on)
    await turn($, SIMPLE, { id: 't1' })
    expect(w.commands).toEqual(['auto-router'])
    expect(w.opened.length).toBe(1)
  })
})

describe('main-session routing', () => {
  test('a simple first prompt goes to Haiku at low effort, and the API-reported model is what usage shows', async ($, on) => {
    const w = world(on)
    await start($)
    await turn($, SIMPLE, { id: 't1', model: 'claude-opus-5-5', effort: 'medium' })
    expect(w.steps).toEqual([{ model: 'haiku', effort: 'low', agentId: undefined }])
    const usage = await command($, 'usage')
    expect(usage).toContain('haiku-5-5: in 1.2k')
    expect(usage).not.toContain('opus-5-5:')
    const status = await command($, 'status')
    expect(status).toContain('haiku assigned · haiku-5-5 answered (API)')
    expect(status).toContain('Prep Cook')
  })

  test('a security-critical task goes to the top tier at xhigh and is told to get a review', async ($, on) => {
    const w = world(on)
    await start($)
    await turn($, SECURITY, { id: 't1', model: 'claude-sonnet-5-5', effort: 'medium' })
    expect(w.steps[0]).toEqual({ model: 'fable', effort: 'xhigh', agentId: undefined })
    expect(w.prompts[0]?.context.join(' ')).toContain('auto-router:independent-reviewer')
    expect(w.prompts[0]?.context.join(' ')).toContain('inspect, plan, implement, test, review')
  })

  test('small work gets no added context at all', async ($, on) => {
    const w = world(on)
    await start($)
    await turn($, SIMPLE, { id: 't1' })
    await turn($, STANDARD, { id: 't2' })
    expect(w.prompts.map(prompt => prompt.context)).toEqual([[], []])
  })

  test('the route is the same for every request of a turn', async ($, on) => {
    const w = world(on)
    await start($)
    await turn($, COMPLEX, { id: 't1', model: 'claude-sonnet-5-5', effort: 'medium', steps: 4 })
    expect(w.steps.map(one => one.model)).toEqual(['opus', 'opus', 'opus', 'opus'])
    expect(w.steps.map(one => one.effort)).toEqual(['high', 'high', 'high', 'high'])
  })

  test('a warm cache holds the model and effort for a later simple task; a cold one lets them drop', async ($, on) => {
    const w = world(on)
    w.usageFor = one => ({
      input_tokens: 2000,
      output_tokens: 500,
      cache_read_input_tokens: 150_000,
      cache_creation_input_tokens: 0,
      model: one.model.startsWith('claude-') ? one.model : `claude-${one.model}-5-5`,
    })
    await start($)
    await turn($, COMPLEX, { id: 't1', model: 'claude-opus-5-5', effort: 'medium' })
    // Opus is the session's own model, so nothing is rewritten but the effort.
    expect(w.steps[0]).toEqual({ model: 'claude-opus-5-5', effort: 'high', agentId: undefined })

    await turn($, SIMPLE, { id: 't2', model: 'claude-opus-5-5', effort: 'medium' })
    expect(w.steps[1]).toEqual({ model: 'claude-opus-5-5', effort: 'high', agentId: undefined })
    expect(await command($, 'status')).toContain('warm cache')

    await w.clock.advance(6 * 60_000)
    await turn($, SIMPLE, { id: 't3', model: 'claude-opus-5-5', effort: 'medium' })
    expect(w.steps[2]).toEqual({ model: 'haiku', effort: 'low', agentId: undefined })
  })

  test('a harder task moves up at once, whatever the cache', async ($, on) => {
    const w = world(on, { model: 'claude-sonnet-5-5' })
    await start($)
    await turn($, STANDARD, { id: 't1', model: 'claude-sonnet-5-5' })
    await turn($, COMPLEX, { id: 't2', model: 'claude-sonnet-5-5' })
    expect(w.steps[0]?.model).toBe('claude-sonnet-5-5')
    expect(w.steps[1]).toEqual({ model: 'opus', effort: 'high', agentId: undefined })
  })

  test('a model named in the prompt is used', async ($, on) => {
    const w = world(on)
    await start($)
    await turn($, 'use sonnet for this: refactor the auth module', { id: 't1' })
    expect(w.steps[0]?.model).toBe('sonnet')
  })

  test('a model picked mid-session is pinned until routing is turned on again', async ($, on) => {
    const w = world(on)
    await start($)
    await turn($, COMPLEX, { id: 't1', model: 'claude-opus-5-5' })
    // The person switches the session to Sonnet: the engine now names it.
    await turn($, COMPLEX, { id: 't2', model: 'claude-sonnet-5-5' })
    expect(w.steps[1]?.model).toBe('claude-sonnet-5-5')
    expect(await command($, 'status')).toContain('Pinned model (picked mid-session): claude-sonnet-5-5')
    await turn($, COMPLEX, { id: 't3', model: 'claude-sonnet-5-5' })
    expect(w.steps[2]?.model).toBe('claude-sonnet-5-5')

    expect(await command($, 'on')).toContain('Routing is on')
    await turn($, COMPLEX, { id: 't4', model: 'claude-sonnet-5-5' })
    expect(w.steps[3]?.model).toBe('opus')
  })

  test('an engine older than 2.1.309 keeps its own model; effort is still routed', async ($, on) => {
    const w = world(on, { version: '2.1.308' })
    await start($)
    await turn($, SIMPLE, { id: 't1', model: 'claude-opus-5-5', effort: 'medium' })
    expect(w.steps[0]).toEqual({ model: 'claude-opus-5-5', effort: 'low', agentId: undefined })
  })

  test('a request that got no answer puts its model on cooldown; the fallback serves the next one', async ($, on) => {
    const w = world(on)
    const usual = w.usageFor
    w.usageFor = one => (one.model === 'haiku' ? null : usual(one))
    await start($)
    await turn($, SIMPLE, { id: 't1', reason: 'error' })
    expect(w.steps[0]?.model).toBe('haiku')
    await turn($, SIMPLE, { id: 't2' })
    expect(w.steps[1]?.model).toBe('sonnet')
    expect(await command($, 'status')).toContain('fallback for haiku')
  })
})

describe('when the router must not act', () => {
  test('a protected session is observed only: no rewrite, no hint, no cap, no advice', async ($, on) => {
    const w = world(on, {
      config: c => {
        c.sessions.protected = [SESSION]
      },
    })
    w.agentList = [
      { id: 'a', description: 'x', type: 'general-purpose', status: 'running' },
      { id: 'b', description: 'y', type: 'general-purpose', status: 'running' },
    ]
    w.toolAnswer = () => ({ result: 'x', isError: true, text: 'bash: pnpm: command not found' })
    await start($)
    await submit($, SECURITY)
    await $.turn.start({ text: SECURITY, turnId: 't1' })
    await step($, 't1', 0, 'claude-fable-5-2', 'max')
    const failed = await $.tool.call({ tool: 'Bash', command: 'pnpm test' })
    const spawned = await spawn($, { type: 'general-purpose', prompt: 'find where the retry logic is defined' }, 'tu1')
    expect(w.steps[0]).toEqual({ model: 'claude-fable-5-2', effort: 'max', agentId: undefined })
    expect(w.prompts[0]?.context).toEqual([])
    expect(failed.context).toBeUndefined()
    expect(spawned.deny).toBeUndefined()
    expect(w.spawns[0]?.model).toBeUndefined()
    expect(await command($, 'status')).toContain('observing only (protected session)')
  })

  test('turned off, every request goes out as Claude Code set it', async ($, on) => {
    const w = world(on, {
      config: c => {
        c.enabled = false
      },
    })
    await start($)
    await turn($, SIMPLE, { id: 't1', model: 'claude-opus-5-5', effort: 'high' })
    await spawn($, { type: 'auto-router:prep-cook', prompt: 'find x' }, 'tu1')
    expect(w.steps[0]).toEqual({ model: 'claude-opus-5-5', effort: 'high', agentId: undefined })
    expect(w.spawns[0]?.model).toBeUndefined()
    expect(await command($, 'status')).toContain('Auto Router: OFF')
  })

  test('advisory mode shows the choice and applies nothing', async ($, on) => {
    const w = world(on, {
      config: c => {
        c.autonomous = false
      },
    })
    await start($)
    await turn($, SIMPLE, { id: 't1', model: 'claude-opus-5-5', effort: 'high' })
    expect(w.steps[0]).toEqual({ model: 'claude-opus-5-5', effort: 'high', agentId: undefined })
    const status = await command($, 'status')
    expect(status).toContain('ADVISORY')
    expect(status).toContain('Prep Cook (haiku, low)')
  })
})

describe('Ultracode compatibility', () => {
  test('a session running at xhigh keeps its effort, even for a simple task', async ($, on) => {
    const w = world(on)
    await start($)
    await turn($, SIMPLE, { id: 't1', model: 'claude-opus-5-5', effort: 'xhigh' })
    expect(w.steps[0]?.effort).toBe('xhigh')
    await turn($, STANDARD, { id: 't2', model: 'claude-opus-5-5', effort: 'xhigh' })
    expect(w.steps[1]?.effort).toBe('xhigh')
  })

  test('with ultracode in settings the session effort is the floor, and may still be raised', async ($, on) => {
    const w = world(on, { settings: { ultracode: true } })
    await start($)
    await turn($, SIMPLE, { id: 't1', model: 'claude-opus-5-5', effort: 'high' })
    expect(w.steps[0]?.effort).toBe('high')
    await turn($, SECURITY, { id: 't2', model: 'claude-opus-5-5', effort: 'high' })
    expect(w.steps[1]?.effort).toBe('xhigh')
  })

  test('workflow agents and forks are never rewritten, refused or counted', async ($, on) => {
    const w = world(on)
    w.agentList = [
      { id: 'a', description: 'x', type: 'general-purpose', status: 'running' },
      { id: 'b', description: 'y', type: 'general-purpose', status: 'running' },
    ]
    await start($)
    const workflow = await spawn($, { type: 'general-purpose', prompt: 'find where the retry logic is defined', hasWorkflow: true }, 'tu1')
    const fork = await spawn($, { type: 'fork', prompt: 'find where the retry logic is defined', isFork: true }, 'tu2')
    expect(workflow.deny).toBeUndefined()
    expect(fork.deny).toBeUndefined()
    expect(w.spawns.map(one => one.model)).toEqual([undefined, undefined])
  })

  test('the router writes no setting and no environment variable', async ($, on) => {
    const w = world(on, { settings: { ultracode: true, effortLevel: 'xhigh' } })
    await start($)
    await turn($, SECURITY, { id: 't1' })
    await command($, 'config switch to economical mode')
    expect(w.envWrites).toEqual([])
    for (const path of w.writes) expect(path.startsWith(DIR)).toBe(true)
    expect(w.settings).toEqual({ ultracode: true, effortLevel: 'xhigh' })
  })
})

describe('subagents', () => {
  test('a specialist runs on its tier model; a general-purpose agent is routed by its task', async ($, on) => {
    const w = world(on)
    await start($)
    await spawn($, { type: 'auto-router:line-cook', prompt: STANDARD }, 'tu1')
    await spawn($, { type: 'general-purpose', prompt: 'find where the retry logic is defined' }, 'tu2')
    await spawn($, { type: 'auto-router:head-chef', prompt: SECURITY }, 'tu3')
    await spawn($, { type: 'Explore', prompt: 'find where the retry logic is defined' }, 'tu4')
    expect(w.spawns.map(one => one.model)).toEqual(['sonnet', 'haiku', 'fable', undefined])
  })

  test('a configured tier model is what the agent gets', async ($, on) => {
    const w = world(on, {
      config: c => {
        c.tiers.lineCook = { model: 'opus', fallback: 'sonnet' }
      },
    })
    await start($)
    await spawn($, { type: 'auto-router:line-cook', prompt: STANDARD }, 'tu1')
    expect(w.spawns[0]?.model).toBe('opus')
  })

  test('a subagent\'s effort is set at its own requests, and its usage is counted under its type', async ($, on) => {
    const w = world(on)
    await start($)
    const spawned = await spawn($, { type: 'auto-router:sous-chef', prompt: COMPLEX }, 'tu1')
    const agentId = spawned.agentId ?? ''
    await $.turn.start({ text: COMPLEX, turnId: 'a1', agentId })
    await step($, 'a1', 0, 'claude-opus-5-5', 'medium', agentId)
    expect(w.steps[0]).toEqual({ model: 'claude-opus-5-5', effort: 'high', agentId })
    await $.turn.complete({ turnId: 'a1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer', agentId })
    expect(await command($, 'usage')).toContain('auto-router:sous-chef (opus-5-5)')
    expect(await command($, 'agents')).toContain('Active: none.')
  })

  test('a third parallel agent is refused, and says so', async ($, on) => {
    const w = world(on)
    w.agentList = [
      { id: 'a', description: 'x', type: 'general-purpose', status: 'running' },
      { id: 'b', description: 'y', type: 'auto-router:line-cook', status: 'waiting' },
    ]
    await start($)
    const refused = await spawn($, { type: 'auto-router:line-cook', prompt: STANDARD }, 'tu1')
    expect(refused.deny).toContain('limit is 2')
    expect(w.spawns).toEqual([])
  })

  test('with the limit set to one, a second agent is refused', async ($, on) => {
    const w = world(on, {
      config: c => {
        c.guardrails.maxParallelAgents = 1
        c.guardrails.defaultParallelAgents = 1
      },
    })
    w.agentList = [{ id: 'a', description: 'x', type: 'general-purpose', status: 'running' }]
    await start($)
    expect((await spawn($, { type: 'auto-router:line-cook', prompt: STANDARD }, 'tu1')).deny).toContain('limit is 1')
    w.agentList = []
    expect((await spawn($, { type: 'auto-router:line-cook', prompt: STANDARD }, 'tu2')).deny).toBeUndefined()
  })
})

describe('pause gate', () => {
  test('pause refuses a tool call before it runs; resume lets it through', async ($, on) => {
    const w = world(on)
    await start($)
    expect(await command($, 'pause')).toContain('Paused')
    const blocked = await $.tool.call({ tool: 'Bash', command: 'npm test' })
    const alsoBlocked = await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' })
    expect(blocked.deny).toContain('paused')
    expect(alsoBlocked.deny).toContain('paused')
    expect(w.toolRuns).toEqual([])
    expect(await command($, 'status')).toContain('2 blocked so far')
    expect(await command($, 'pause')).toBe('Already paused.')

    expect(await command($, 'resume')).toContain('Resumed')
    const ran = await $.tool.call({ tool: 'Bash', command: 'npm test' })
    expect(ran.deny).toBeUndefined()
    expect(w.toolRuns).toEqual(['Bash'])
  })

  test('pause also holds a subagent\'s tool calls', async ($, on) => {
    const w = world(on)
    await start($)
    await command($, 'pause')
    const blocked = await $.tool.call({ tool: 'Read', file_path: 'a.ts', agentId: 'agent-9' })
    expect(blocked.deny).toContain('paused')
    expect(w.toolRuns).toEqual([])
  })
})

describe('failures', () => {
  test('two substantive failures move the task up one tier, and say so beside the error', async ($, on) => {
    const w = world(on, { model: 'claude-haiku-5-5' })
    w.toolAnswer = () => ({ result: 'x', isError: true, text: 'FAIL src/a.test.ts\nTests: 1 failed, 4 passed' })
    await start($)
    await submit($, SIMPLE)
    await $.turn.start({ text: SIMPLE, turnId: 't1' })
    await step($, 't1', 0, 'claude-haiku-5-5', 'medium')
    const first = await $.tool.call({ tool: 'Bash', command: 'npm test' })
    const second = await $.tool.call({ tool: 'Bash', command: 'npm test -- a' })
    await step($, 't1', 1, 'claude-haiku-5-5', 'medium')
    expect(first.context).toBeUndefined()
    expect(second.context?.join(' ')).toContain('one tier up (haiku -> sonnet, effort low -> medium)')
    expect(w.steps[0]).toEqual({ model: 'claude-haiku-5-5', effort: 'low', agentId: undefined })
    expect(w.steps[1]).toEqual({ model: 'sonnet', effort: 'medium', agentId: undefined })
    expect(await command($, 'status')).toContain('Escalation: escalated main: haiku -> sonnet')
  })

  test('an environment failure never escalates: it is named once and left to be fixed', async ($, on) => {
    const w = world(on, { model: 'claude-haiku-5-5' })
    w.toolAnswer = () => ({ result: 'x', isError: true, text: 'bash: pnpm: command not found' })
    await start($)
    await submit($, SIMPLE)
    await $.turn.start({ text: SIMPLE, turnId: 't1' })
    await step($, 't1', 0, 'claude-haiku-5-5', 'medium')
    const first = await $.tool.call({ tool: 'Bash', command: 'pnpm test' })
    const second = await $.tool.call({ tool: 'Bash', command: 'pnpm install' })
    await step($, 't1', 1, 'claude-haiku-5-5', 'medium')
    expect(first.context?.join(' ')).toContain('environment problem')
    expect(second.context).toBeUndefined()
    expect(w.steps[1]?.model).toBe('claude-haiku-5-5')
    expect(await command($, 'status')).toContain('Escalation: none')
  })

  test('the same failing call is called out at the limit instead of being retried forever', async ($, on) => {
    const w = world(on)
    w.toolAnswer = () => ({ result: 'x', isError: true, text: 'something odd happened 42' })
    await start($)
    await submit($, STANDARD)
    await $.turn.start({ text: STANDARD, turnId: 't1' })
    const answers = []
    for (let i = 0; i < 4; i += 1) answers.push(await $.tool.call({ tool: 'Bash', command: 'make' }))
    expect(answers[0]?.context).toBeUndefined()
    expect(answers[1]?.context?.join(' ')).toContain('failed 2 times with the same error')
    expect(answers[2]?.context).toBeUndefined()
    expect(answers[3]?.context).toBeUndefined()
  })

  test('escalation stops at the per-task limit', async ($, on) => {
    const w = world(on, { model: 'claude-haiku-5-5' })
    w.toolAnswer = () => ({ result: 'x', isError: true, text: 'error TS2322: nope' })
    await start($)
    await submit($, SIMPLE)
    await $.turn.start({ text: SIMPLE, turnId: 't1' })
    await step($, 't1', 0, 'claude-haiku-5-5', 'medium')
    for (let i = 0; i < 8; i += 1) await $.tool.call({ tool: 'Bash', command: `tsc ${i}` })
    await step($, 't1', 1, 'claude-haiku-5-5', 'medium')
    // Two escalations at most: haiku -> sonnet -> opus, never further in one task.
    expect(w.steps[1]?.model).toBe('opus')
    expect(await command($, 'status')).toContain('no stronger tier left')
  })
})

describe('independent review', () => {
  test('high-risk work that changed files and ended unreviewed is flagged under the answer', async ($, on) => {
    world(on)
    await start($)
    await submit($, SECURITY)
    await $.turn.start({ text: SECURITY, turnId: 't1' })
    await step($, 't1', 0, 'claude-opus-5-5', 'medium')
    await $.tool.call({ tool: 'Edit', file_path: 'auth.ts', old_string: 'a', new_string: 'b' })
    const ended = await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 9, isAborted: false, reason: 'answer' })
    expect(ended.text).toContain('independent review did not run')
    expect(await command($, 'status')).toContain('Review: required · did not run')
  })

  test('once the reviewer has run, the review is done and its verdict is kept', async ($, on) => {
    const w = world(on)
    await start($)
    await submit($, SECURITY)
    await $.turn.start({ text: SECURITY, turnId: 't1' })
    await step($, 't1', 0, 'claude-opus-5-5', 'medium')
    await $.tool.call({ tool: 'Edit', file_path: 'auth.ts', old_string: 'a', new_string: 'b' })
    const reviewer = await spawn($, { type: 'auto-router:independent-reviewer', prompt: 'review the auth change against the requirements' }, 'tu1')
    const agentId = reviewer.agentId ?? ''
    expect(w.spawns[0]?.model).toBe('opus')
    await $.turn.start({ text: 'review', turnId: 'r1', agentId })
    await $.turn.complete({ turnId: 'r1', answer: 'VERDICT: CONCERNS\nauth.ts:4: high: missing check.', durationMs: 5, isAborted: false, reason: 'answer', agentId })
    const ended = await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 9, isAborted: false, reason: 'answer' })
    expect(ended.text).toBe('')
    expect(await command($, 'status')).toContain('Review: done · CONCERNS')
  })

  test('a high-risk question that changed nothing is not flagged', async ($, on) => {
    world(on)
    await start($)
    const ended = await turn($, 'explain how the authentication flow validates the session cookie', { id: 't1' })
    expect(ended.text).toBe('')
  })
})

describe('permissions are Claude Code\'s', () => {
  test('the router never loosens a decision, and by default never changes one', async ($, on) => {
    const w = world(on)
    await start($)
    for (const decided of ['allow', 'ask', 'deny'] as const) {
      w.checkAnswer = () => decided
      const got = await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, approver: 'person' })
      expect(got.decision).toBe(decided)
    }
  })

  test('with the extra confirm on, an allowed destructive command is asked about; nothing else changes', async ($, on) => {
    const w = world(on, {
      config: c => {
        c.guardrails.confirmDestructive = true
      },
    })
    await start($)
    const destructive = await $.tool.check({ tool: 'Bash', input: { command: 'git push --force origin main' }, approver: 'person' })
    const safe = await $.tool.check({ tool: 'Bash', input: { command: 'git status' }, approver: 'person' })
    const unattended = await $.tool.check({ tool: 'Bash', input: { command: 'git push --force origin main' } })
    expect(destructive.decision).toBe('ask')
    expect(destructive.reason).toContain('git history')
    expect(safe.decision).toBe('allow')
    expect(unattended.decision).toBe('allow')
    w.checkAnswer = () => 'deny'
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf /' }, approver: 'person' })).decision).toBe('deny')
  })

  test('a model changing a guardrail through the configure tool is put to the person', async ($, on) => {
    world(on)
    await start($)
    const sensitive = await $.tool.check({
      tool: 'mcp__auto-router__configure',
      input: { action: 'set', changes: [{ path: 'guardrails.independentReview', value: false }] },
      approver: 'person',
    })
    const plain = await $.tool.check({
      tool: 'mcp__auto-router__configure',
      input: { action: 'set', changes: [{ path: 'budgetMode', value: 'economical' }] },
      approver: 'person',
    })
    expect(sensitive.decision).toBe('ask')
    expect(plain.decision).toBe('allow')
  })
})

describe('configuration', () => {
  test('a change is validated, backed up, written in one step and taken into use', async ($, on) => {
    const w = world(on)
    await start($)
    const before = w.read(CONFIG)
    expect(await command($, 'config switch to economical mode')).toContain('budgetMode: "balanced" -> "economical"')
    expect(w.config().budgetMode).toBe('economical')
    expect(w.read(`${DIR}/backups/config.0.json`)).toBe(before)
    expect(w.read(`${DIR}/backups/index.json`)).toContain('"next": 1')
    expect(w.read(`${DIR}/config.last-good.json`)).toBe(w.read(CONFIG))
    expect(w.runs.some(argv => argv.includes('move') || argv[0] === 'mv')).toBe(true)
    expect(w.files.has(`${CONFIG}.tmp`)).toBe(false)
    expect(await command($, 'config')).toContain('profile economical')
  })

  test('an invalid or unreadable request changes nothing and says why', async ($, on) => {
    const w = world(on)
    await start($)
    const before = w.read(CONFIG)
    expect(await command($, 'config limit parallel agents to four')).toContain('Not changed')
    expect(await command($, 'config make it purple')).toContain('Not changed: not understood')
    expect(w.read(CONFIG)).toBe(before)
    expect(w.files.has(`${DIR}/backups/config.0.json`)).toBe(false)
  })

  test('where the rename cannot run, the file is still written and verified', async ($, on) => {
    const w = world(on)
    w.isMoveBroken = true
    await start($)
    expect(await command($, 'config switch to quality mode')).toContain('Changed')
    expect(w.config().budgetMode).toBe('quality')
  })

  test('the configure tool reads, changes and refuses', async ($, on) => {
    const w = world(on)
    await start($)
    const got = await $.tool.call({ tool: 'mcp__auto-router__configure', action: 'get' })
    expect(String(got.result)).toContain('"budgetMode": "balanced"')
    const set = await $.tool.call({ tool: 'mcp__auto-router__configure', action: 'set', changes: [{ path: 'guardrails.maxParallelAgents', value: 1 }, { path: 'guardrails.defaultParallelAgents', value: 1 }] })
    expect(String(set.result)).toContain('Changed')
    expect(w.config().guardrails.maxParallelAgents).toBe(1)
    const bad = await $.tool.call({ tool: 'mcp__auto-router__configure', action: 'set', changes: [{ path: 'guardrails.yolo', value: true }] })
    expect(String(bad.result)).toContain('ERROR: not changed')
    const words = await $.tool.call({ tool: 'mcp__auto-router__configure', action: 'request', request: 'Use Opus for complex frontend work.' })
    expect(String(words.result)).toContain('Changed')
    expect(w.config().routing.overrides[0]?.model).toBe('opus')
  })

  test('a change made in another session is not lost: the file is read fresh before it is patched', async ($, on) => {
    const w = world(on)
    await start($)
    const other = defaultConfig()
    other.guardrails.maxParallelAgents = 1
    other.guardrails.defaultParallelAgents = 1
    w.files.set(CONFIG, { text: serializeConfig(other), mtime: w.clock.now() + 5000 })
    await command($, 'config switch to economical mode')
    expect(w.config().budgetMode).toBe('economical')
    expect(w.config().guardrails.maxParallelAgents).toBe(1)
  })

  test('an invalid config.json is reported and the last valid one stays in force', async ($, on) => {
    const good = defaultConfig()
    good.budgetMode = 'economical'
    world(on, { files: { [CONFIG]: '{ "budgetMode": "cheap" }', [`${DIR}/config.last-good.json`]: serializeConfig(good) } })
    await start($)
    const status = await command($, 'status')
    expect(status).toContain('Configuration problem: budgetMode')
    expect(status).toContain('profile economical')
    expect(await command($, 'reload')).toContain('Configuration rejected')
  })

  test('a hand edit of config.json is picked up at the next prompt', async ($, on) => {
    const w = world(on)
    await start($)
    const edited = defaultConfig()
    edited.enabled = false
    w.files.set(CONFIG, { text: serializeConfig(edited), mtime: w.clock.now() + 9000 })
    await turn($, SIMPLE, { id: 't1', model: 'claude-opus-5-5', effort: 'high' })
    expect(w.steps[0]).toEqual({ model: 'claude-opus-5-5', effort: 'high', agentId: undefined })
  })

  test('the backup ring keeps ten files and wraps', async ($, on) => {
    const w = world(on)
    await start($)
    for (let i = 0; i < 12; i += 1) await command($, `config switch to ${i % 2 === 0 ? 'economical' : 'quality'} mode`)
    const backups = [...w.files.keys()].filter(path => /backups\/config\.\d+\.json$/.test(path))
    expect(backups.length).toBe(10)
    expect(w.read(`${DIR}/backups/index.json`)).toContain('"next": 2')
  })
})

describe('usage', () => {
  test('readings the engine does not give read Unavailable; the ones it gives are shown as given', async ($, on) => {
    const w = world(on)
    await start($)
    const before = await command($, 'usage')
    expect(before).toContain('Weekly plan usage: Unavailable')
    expect(before).toContain('Fable usage credits: Unavailable')
    expect(before).toContain('No model response recorded yet')

    w.rateLimits = [
      { kind: 'seven_day', percentUsed: 41.5, resetsAt: '2026-11-16T09:00:00Z' },
      { kind: 'five_hour', percentUsed: 12 },
    ]
    await $.session.measure({
      context: { window: 1_000_000, tokens: 250_000, percent: 25 },
      rateLimits: w.rateLimits,
      changed: ['context', 'rateLimits'],
    })
    const after = await command($, 'usage')
    expect(after).toContain('Weekly plan usage: 41.5% used · resets')
    expect(after).toContain('5-hour window: 12% used · reset time unavailable')
    expect(after).toContain('Fable usage credits: Unavailable')
  })

  test('cache reads and writes are counted, and the history file carries the session\'s totals', async ($, on) => {
    const w = world(on)
    w.usageFor = one => ({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 9000, cache_creation_input_tokens: 900, model: `claude-${one.model}-5-5` })
    await start($)
    await turn($, SIMPLE, { id: 't1', steps: 2 })
    const usage = await command($, 'usage')
    expect(usage).toContain('haiku-5-5: in 200 · out 100 · cache read 18k · cache write 1.8k · 2 req')
    expect(usage).toContain('hit rate 90%')
    const history = JSON.parse(w.read(HISTORY) ?? '{}')
    const days = Object.values(history.sessions[SESSION].days) as Record<string, { req: number }>[]
    expect(days[0]?.['claude-haiku-5-5']?.req).toBe(2)
  })

  test('an unreadable history file is left untouched', async ($, on) => {
    const w = world(on, { files: { [HISTORY]: '{"version":1,"sessions":{"a":{"sta' } })
    await start($)
    await turn($, SIMPLE, { id: 't1' })
    await $.session.end({ reason: 'other', sessionId: SESSION } as never)
    expect(w.read(HISTORY)).toBe('{"version":1,"sessions":{"a":{"sta')
  })

  test('the session\'s end writes the history', async ($, on) => {
    const w = world(on)
    await start($)
    await submit($, SIMPLE)
    await $.turn.start({ text: SIMPLE, turnId: 't1' })
    await step($, 't1', 0, 'claude-opus-5-5', 'medium')
    expect(w.files.has(HISTORY)).toBe(false)
    await $.session.end({ reason: 'other', sessionId: SESSION } as never)
    expect(w.read(HISTORY)).toContain(SESSION)
  })
})

describe('commands', () => {
  test('every subcommand answers locally', async ($, on) => {
    const w = world(on)
    await start($)
    expect(await command($, '')).toContain('Opened the Auto Router dashboard')
    expect(await command($, 'status')).toContain('Auto Router: ON · profile balanced')
    expect(await command($, 'usage')).toContain('Usage this session')
    expect(await command($, 'agents')).toContain('Head Chef [auto-router:head-chef]: fable (fallback opus)')
    expect(await command($, 'config')).toContain('Effective configuration')
    expect(await command($, 'clear')).toBe('Activity history cleared.')
    expect(await command($, 'help')).toContain('/auto-router pause')
    expect(w.steps).toEqual([])
  })

  test('opening the dashboard by command clears a remembered close', async ($, on) => {
    const w = world(on, { store: { panel: { hiddenByUser: true } } })
    await start($)
    expect(w.opened).toEqual([])
    await command($, '')
    expect(w.opened.length).toBe(1)
    expect(w.store.get('panel')).toEqual({ hiddenByUser: false })
  })
})
