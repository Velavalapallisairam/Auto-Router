// The dashboard pane: what it draws on each surface and what its buttons do.

import { describe, expect, test } from 'claude-code/testing'

import type { ModelState } from '../hooks/ui/pane.tsx'
import { characterSvg } from '../hooks/ui/pane.tsx'
import { CONFIG, command, pane, spawn, start, step, submit, turn, words, world } from './helpers.ts'

const TABS = ['ar-back', 'ar-agents', 'ar-usage', 'ar-guard', 'ar-config']
const HOME_CARDS = ['ROUTER', 'ACTIVITY']

describe('the dashboard', () => {
  test('draws the tabs, the home cards and their controls on every surface that seats a pane', async ($, on) => {
    world(on)
    await start($)
    for (const surface of ['desktop', 'terminal', 'vscode'] as const) {
      const ui = await $.ui.mount({ ...pane(), surface })
      const shown = await words(ui)
      for (const label of HOME_CARDS) expect(shown).toContain(label)
      for (const key of [...TABS, 'ar-off', 'ar-settings', 'ar-budget', 'ar-activity']) {
        expect(await ui.find({ type: 'Button', key })).toBeDefined()
      }
      // One control per state: the one that does not apply is not drawn.
      expect(await ui.find({ type: 'Button', key: 'ar-on' })).toBeUndefined()
      expect(await ui.find({ type: 'Button', key: 'ar-resume' })).toBeUndefined()
      expect(shown).toContain('No task yet')
      // The status card is gone from Home: limits are on Usage, the pause gate on Safety.
      expect(shown).not.toContain('STATUS')
      expect(await ui.find({ type: 'Button', key: 'ar-pause' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('shows the route with the assigned model apart from the one the API reported', async ($, on) => {
    world(on)
    await start($)
    await submit($, 'fix the typo in the README heading')
    await $.turn.start({ text: 'fix the typo in the README heading', turnId: 't1' })
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    expect(await words(ui)).toContain('haiku assigned · actual not reported yet')
    await step($, 't1', 0, 'claude-opus-5-5', 'medium')
    const shown = await words(ui)
    expect(shown).toContain('haiku assigned · haiku-5-5 answered (API)')
    expect(shown).toContain('Prep Cook')
    expect(shown).toContain('fix the typo in the README heading')
    expect(shown).toContain('simple task')
    // Every detail is a labelled field, in the order the task is worked.
    for (const label of ['Task', 'Task rating', 'Risk', '★ HEAD CHEF', 'Model', 'Tier', 'Evidence', 'Reasoning', 'SUPPORTING AGENTS', 'EXECUTION ORDER', 'FINAL RESULT']) {
      expect(shown).toContain(label)
    }
    expect(shown).toContain('Task rating\nSimple')
    expect(shown).toContain('None. The Head Chef does the whole task.')
    expect(shown).toMatch(/Head Chef · haiku · low\n\w+ · Reads the task and does the work itself\./)
    expect(shown).toContain('The Head Chef (haiku) writes the answer itself. No other agent takes part.')
    await ui.unmount()
  })

  test('the home rates a task Simple, Moderate, Complex or Critical', async ($, on) => {
    world(on)
    await start($)
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    const cases: [string, string][] = [
      ['add a unit test for the parseDate function', 'Moderate'],
      ['debug the intermittent deadlock in the job scheduler', 'Complex'],
    ]
    for (const [index, [prompt, rating]] of cases.entries()) {
      await turn($, prompt, { id: `t${index}` })
      expect(await words(ui)).toContain(`Task rating\n${rating}`)
    }
    await ui.unmount()
  })

  test('home lists the ten newest events, not four', async ($, on) => {
    world(on)
    await start($)
    for (let index = 0; index < 14; index += 1) await $.tool.call({ tool: 'Read', file_path: `/work/src/file${index}.ts` })
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    const shown = await words(ui)
    expect(shown.split('OK · Read').length - 1).toBe(10)
    expect(shown).toContain('file13.ts')
    expect(shown).not.toContain('file3.ts')
    expect(shown).toMatch(/10 of \d+/)
    await ui.unmount()
  })

  test('live activity lists tool and agent events with their status, and never their content', async ($, on) => {
    const w = world(on)
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/work/src/config.ts' })
    await $.tool.call({ tool: 'Write', file_path: '/work/src/secret.ts', content: 'TOP SECRET BODY' })
    await $.tool.call({ tool: 'Bash', command: 'curl -H "Authorization: Bearer abcdefghijklmnop12345" https://api.test' })
    await $.tool.call({ tool: 'mcp__github__create_issue', title: 'hello', body: 'CONFIDENTIAL' })
    w.toolAnswer = () => ({ result: 'x', isError: true, text: 'boom' })
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    w.toolAnswer = () => undefined
    await command($, 'pause')
    await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'OLDSECRET', new_string: 'NEWSECRET' })
    await command($, 'resume')

    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    await ui.press({ key: 'ar-activity' })
    const shown = await words(ui)
    expect(shown).toContain('Read …/src/config.ts')
    expect(shown).toContain('Write …/src/secret.ts')
    expect(shown).toContain('mcp github / create_issue')
    expect(shown).toMatch(/OK\s+Read/)
    expect(shown).toMatch(/ERR\s+\$ npm test/)
    expect(shown).toMatch(/BLOCKED\s+paused: Edit a\.ts/)
    for (const secret of ['TOP SECRET BODY', 'abcdefghijklmnop12345', 'CONFIDENTIAL', 'OLDSECRET', 'NEWSECRET']) {
      expect(shown).not.toContain(secret)
    }
    // Filters narrow the list.
    await ui.press({ key: 'ar-f-errors' })
    const errors = await words(ui)
    expect(errors).toContain('npm test')
    expect(errors).not.toContain('create_issue')
    await ui.press({ key: 'ar-clear' })
    expect(await words(ui)).not.toContain('npm test')
    await ui.unmount()
  })

  test('a spawned agent is PENDING until its first turn starts, then RUNNING, then OK', async ($, on) => {
    world(on)
    await start($)
    await submit($, 'add a unit test for the parseDate function')
    await $.turn.start({ text: 'add a unit test for the parseDate function', turnId: 't1' })
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    expect(await words(ui)).toContain('0 started · max 2 at once')
    const spawned = await spawn($, { type: 'auto-router:prep-cook', prompt: 'find where the retry logic is defined', description: 'Find retry logic' }, 'tu1')
    const agentId = spawned.agentId ?? ''
    expect(await words(ui)).toMatch(/haiku · low · PENDING/)
    await $.turn.start({ text: 'x', turnId: 'a1', agentId })
    const running = await words(ui)
    expect(running).toMatch(/haiku · low · RUNNING/)
    expect(running).toContain('1 started · max 2 at once')
    // The supporting agent is a step of its own, after the Head Chef, and the result says how the two are joined.
    expect(running).toMatch(/Head Chef · sonnet · medium\n\w+ · Reads the task, plans it and hands out the independent parts\./)
    expect(running).toMatch(/Prep Cook · haiku · low\nRUNNING · Find retry logic/)
    expect(running).toContain('2 steps')
    expect(running).toContain('Each agent returns a short report to the Head Chef (sonnet), which checks the reports and writes the one answer.')
    await $.turn.complete({ turnId: 'a1', answer: 'found it', durationMs: 5, isAborted: false, reason: 'answer', agentId })
    const shown = await words(ui)
    expect(shown).toMatch(/haiku · low · OK/)
    expect(shown).toMatch(/OK · auto-router:prep-cook finished/)
    await ui.press({ key: 'ar-agents' })
    const agents = await words(ui)
    expect(agents).toContain('haiku · low · idle')
    expect(agents).toContain('0 active · max 2')
    await ui.press({ key: 'ar-back' })
    await ui.press({ key: 'ar-activity' })
    expect(await words(ui)).toMatch(/OK\s+auto-router:prep-cook finished: Find retry logic/)
    await ui.unmount()
  })

  test('a task that needs a review lists the reviewer as the last step', async ($, on) => {
    world(on)
    await start($)
    await submit($, 'refactor the authentication module across all services and harden the session handling')
    await $.turn.start({ text: 'refactor the authentication module across all services and harden the session handling', turnId: 't1' })
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    const shown = await words(ui)
    expect(shown).toMatch(/Reviewer · opus · high\nrequired · Independent, read-only review of the finished work\./)
    expect(shown).toContain('An independent review comes before the work is called done.')
    await ui.unmount()
  })
})

describe('the agents tab', () => {
  const state = (alias: ModelState['alias'], mood: ModelState['mood']): ModelState => ({ alias, name: alias, mood, jobs: [], rest: '' })

  test('with nothing running every model is asleep, and says what it has done', async ($, on) => {
    world(on)
    await start($)
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    await ui.press({ key: 'ar-agents' })
    const shown = await words(ui)
    for (const name of ['Haiku', 'Sonnet', 'Opus', 'Fable']) expect(shown).toContain(name)
    expect(shown).toContain('0 awake')
    expect(shown).not.toContain('Awake')
    expect(shown).toContain('not used this session')
    // One image per model, so a mood change redraws that model alone.
    expect((await ui.findAll({ type: 'Svg' })).length).toBe(4)
    await ui.unmount()
  })

  test('the model whose turn is running is awake with its real task, and sleeps again when it ends', async ($, on) => {
    world(on)
    await start($)
    await submit($, 'fix the typo in the README heading')
    await $.turn.start({ text: 'fix the typo in the README heading', turnId: 't1' })
    await step($, 't1', 0, 'claude-opus-5-5', 'medium')
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    await ui.press({ key: 'ar-agents' })
    const running = await words(ui)
    expect(running).toContain('1 awake')
    expect(running).toMatch(/Main session · \w+ · \d+:\d\d · fix the typo in the README/)
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' })
    const rested = await words(ui)
    expect(rested).toContain('0 awake')
    expect(rested).toMatch(/last active \d+:\d\d ago/)
    expect(rested).toMatch(/in \S+ · out \S+ · 1 req/)
    await ui.unmount()
  })

  test('shows all five specialists, and an active one with its id, models, effort and task', async ($, on) => {
    world(on)
    await start($)
    const spawned = await spawn($, { type: 'auto-router:line-cook', prompt: 'add a unit test for the parseDate function', description: 'Add parseDate test' }, 'tu1')
    const agentId = spawned.agentId ?? ''
    await $.turn.start({ text: 'x', turnId: 'a1', agentId })
    await step($, 'a1', 0, 'claude-sonnet-5-5', 'medium', agentId)
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    await ui.press({ key: 'ar-agents' })
    const shown = await words(ui)
    for (const name of ['Head Chef', 'Sous Chef', 'Line Cook', 'Prep Cook', 'Reviewer']) expect(shown).toContain(name)
    expect(shown).toContain('fable · xhigh · idle')
    expect(shown).toMatch(/sonnet → sonnet-5-5 · medium · RUNNING \d+:\d\d · #agent- Add parseDate test/)
    expect(shown).toContain('1 active · max 2')
    // The subagent's model is the one awake.
    expect(shown).toContain('1 awake')
    expect(shown).toMatch(/Line Cook · medium · \d+:\d\d · Add parseDate test/)
    expect(await ui.find({ type: 'Button', key: 'ar-agents-config' })).toBeDefined()
    await ui.unmount()
  })

  test('a surface without vector drawing still lists the models', async ($, on) => {
    world(on)
    await start($)
    const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
    await ui.press({ key: 'ar-agents' })
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    expect(await words(ui)).toContain('Asleep')
    await ui.unmount()
  })

  test('each character draws sleep, stirring and wakefulness differently, from its mood alone', () => {
    const asleep = characterSvg(state('haiku', 'asleep'))
    expect(asleep).toContain('class="z z2"')
    expect(asleep).toContain('class="e e-asleep"')
    expect(asleep).toContain('class="l breathe"')
    expect(asleep).not.toContain('class="glow"')
    const waking = characterSvg(state('haiku', 'waking'))
    expect(waking).toContain('class="e e-waking"')
    expect(waking).toContain('class="l sway"')
    expect(waking).not.toContain('class="z')
    const awake = characterSvg(state('haiku', 'awake'))
    expect(awake).toContain('class="e e-awake"')
    expect(awake).toContain('class="l bob"')
    expect(awake).toContain('class="glow"')
    expect(awake).toContain('class="eye blink"')
    const down = characterSvg(state('haiku', 'unavailable'))
    expect(down).toContain('class="e e-unavailable"')
    expect(down).toContain('<g class="l">')
    // The same mood is the same image, so a redraw does not restart it.
    expect(characterSvg(state('haiku', 'awake'))).toBe(awake)
    for (const alias of ['haiku', 'sonnet', 'opus', 'fable'] as const) {
      for (const mood of ['asleep', 'waking', 'awake', 'unavailable'] as const) {
        const one = characterSvg(state(alias, mood))
        // No script, no handler, no outside reference: a drawing, its own gradients and its own style.
        expect(one).not.toMatch(/<script|onload|onclick|href|url\((?!#)|@import|<image|<foreignObject/i)
        expect(one.length).toBeLessThan(8_000)
        // Lit from one side, with a shadow on the floor.
        expect(one).toContain('<radialGradient id="b"')
        expect(one).toContain('fill="url(#f)"')
        // Motion is transform and opacity only, and stops for a reader who asked for none.
        expect(one).toContain('prefers-reduced-motion')
        expect(one).not.toMatch(/@keyframes[^@]*\b(width|height|top|left|fill|filter|r|d):/)
      }
    }
    // Each model has its own body.
    const bodies = new Set((['haiku', 'sonnet', 'opus', 'fable'] as const).map(alias => characterSvg(state(alias, 'asleep')).replace(/#[0-9a-f]{6}/g, '')))
    expect(bodies.size).toBe(4)
  })
})

describe('controls', () => {
  test('Pause and Resume gate tool calls from the pane', async ($, on) => {
    const w = world(on)
    await start($)
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    await ui.press({ key: 'ar-guard' })
    await ui.press({ key: 'ar-pause' })
    expect(await words(ui)).toContain('PAUSED')
    expect(await ui.find({ type: 'Button', key: 'ar-pause' })).toBeUndefined()
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toContain('paused')
    expect(w.toolRuns).toEqual([])
    expect(await words(ui)).toContain('Paused · 1 tool calls blocked')

    // While paused, Home says so and offers the way back.
    await ui.press({ key: 'ar-back' })
    expect(await words(ui)).toContain('Paused: tool calls are blocked')
    await ui.press({ key: 'ar-resume' })
    expect(await ui.find({ type: 'Button', key: 'ar-resume' })).toBeUndefined()
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
    expect(w.toolRuns).toEqual(['Bash'])
    await ui.unmount()
  })

  test('Turn Off and Turn On switch routing and persist', async ($, on) => {
    const w = world(on)
    await start($)
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    await ui.press({ key: 'ar-off' })
    expect(w.config().enabled).toBe(false)
    expect(await words(ui)).toContain('Routing is off')
    await turn($, 'fix the typo in the README heading', { id: 't1', model: 'claude-opus-5-5', effort: 'high' })
    expect(w.steps[0]).toEqual({ model: 'claude-opus-5-5', effort: 'high', agentId: undefined })

    await ui.press({ key: 'ar-on' })
    expect(w.config().enabled).toBe(true)
    // Opus just answered, so its cache is warm: routing is on again and holds it.
    await turn($, 'fix the typo in the README heading', { id: 't2', model: 'claude-opus-5-5', effort: 'high' })
    expect(w.steps[1]?.model).toBe('claude-opus-5-5')
    expect(await words(ui)).toContain('warm cache')
    // Once that cache has lapsed, the simple task takes the cheap model.
    await w.clock.advance(6 * 60_000)
    await turn($, 'fix the typo in the README heading', { id: 't3', model: 'claude-opus-5-5', effort: 'high' })
    expect(w.steps[2]?.model).toBe('haiku')
    await ui.unmount()
  })

  test('Change Budget Profile cycles the profile in config.json', async ($, on) => {
    const w = world(on)
    await start($)
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    await ui.press({ key: 'ar-budget' })
    expect(w.config().budgetMode).toBe('quality')
    await ui.press({ key: 'ar-budget' })
    expect(w.config().budgetMode).toBe('economical')
    expect(await words(ui)).toContain('economical')
    await ui.unmount()
  })

  test('each tab and sub-view opens, and Home returns to the cards', async ($, on) => {
    world(on)
    await start($)
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    const views: [string[], string][] = [
      [['ar-settings'], 'Router Settings'],
      [['ar-agents'], 'SPECIALISTS'],
      [['ar-agents', 'ar-agents-config'], 'MODEL · FALLBACK'],
      [['ar-activity'], 'EVENTS'],
      [['ar-usage'], 'WEEKLY SAVINGS'],
      [['ar-guard'], 'RISK FLOORS'],
      [['ar-config'], 'EFFECTIVE'],
    ]
    for (const [keys, marker] of views) {
      for (const key of keys) await ui.press({ key })
      expect(await words(ui)).toContain(marker)
      // The tabs are on every view.
      for (const key of TABS) expect(await ui.find({ type: 'Button', key })).toBeDefined()
      await ui.press({ key: 'ar-back' })
      expect(await words(ui)).toContain('ROUTER')
    }
    await ui.unmount()
  })

  test('Configure Agents cycles a tier model and its fallback, keeping the pair valid', async ($, on) => {
    const w = world(on)
    await start($)
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    await ui.press({ key: 'ar-agents' })
    await ui.press({ key: 'ar-agents-config' })
    await ui.press({ key: 'ar-tier-prepCook' })
    // haiku -> sonnet would equal its fallback, so the fallback takes the old model.
    expect(w.config().tiers.prepCook).toEqual({ model: 'sonnet', fallback: 'haiku' })
    await ui.press({ key: 'ar-fb-reviewer' })
    expect(w.config().tiers.reviewer).toEqual({ model: 'opus', fallback: 'haiku' })
    await ui.press({ key: 'ar-par' })
    expect(w.config().guardrails.maxParallelAgents).toBe(1)
    expect(await words(ui)).toContain('Parallel agents: at most 1.')
    await ui.unmount()
  })

  test('Settings toggles write the configuration', async ($, on) => {
    const w = world(on)
    await start($)
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    await ui.press({ key: 'ar-settings' })
    for (const key of ['ar-off', 'ar-auto', 'ar-budget', 'ar-mainmodel', 'ar-maineffort', 'ar-cache', 'ar-pins', 'ar-panel', 'ar-autoopen', 'ar-telemetry', 'ar-preview']) {
      expect(await ui.find({ type: 'Button', key })).toBeDefined()
    }
    await ui.press({ key: 'ar-auto' })
    expect(w.config().autonomous).toBe(false)
    await ui.press({ key: 'ar-cache' })
    expect(w.config().routing.mainSession.cacheAware).toBe(false)
    await ui.press({ key: 'ar-autoopen' })
    expect(w.config().sidePanel.autoOpen).toBe(false)
    await ui.unmount()
  })

  test('Safety shows the floors and toggles the extra confirm', async ($, on) => {
    const w = world(on)
    await start($)
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    await ui.press({ key: 'ar-guard' })
    const shown = await words(ui)
    expect(shown).toContain('Sous Chef · opus · high')
    expect(shown).toContain('never approves a call')
    expect(shown).toContain('does not stop a running command')
    expect(shown).toContain('same failing call called out at 2')
    await ui.press({ key: 'ar-destructive' })
    expect(w.config().guardrails.confirmDestructive).toBe(true)
    await ui.press({ key: 'ar-pause' })
    expect(await words(ui)).toContain('Paused · 0 tool calls blocked')
    await ui.press({ key: 'ar-resume' })
    expect(await words(ui)).toContain('Tool calls run')
    await ui.unmount()
  })

  test('Usage shows Unavailable for what the engine did not report, never a guess', async ($, on) => {
    world(on)
    await start($)
    await turn($, 'fix the typo in the README heading', { id: 't1' })
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    await ui.press({ key: 'ar-usage' })
    const shown = await words(ui)
    expect(shown).toContain('haiku-5-5')
    expect(shown).toContain('credits Unavailable')
    for (const label of ['USAGE OVERVIEW', 'PLAN LIMITS', 'COST BREAKDOWN', 'SAVINGS', 'WEEKLY SAVINGS', 'MODEL USAGE']) expect(shown).toContain(label)
    for (const label of ['Requests', 'Input', 'Output', 'Total tokens', 'Total cost', 'Daily', 'Weekly', 'Monthly', 'Saved', 'Percentage', 'Actual cost', 'Unoptimised']) expect(shown).toContain(label)
    // No reading, no bar: a plan limit the engine did not report is a word, not a meter.
    expect(shown).toContain('Weekly\nUnavailable')
    expect(shown).toContain('5-hour\nUnavailable')
    // The context window is reported, so it is drawn, and named for what it is.
    expect(shown).toContain('context window, not plan usage')
    expect(await ui.find({ type: 'Button', key: 'ar-refresh-usage' })).toBeDefined()
    await ui.unmount()
  })

  test('Reload reads the file again; Reopen opens the pane again and forgets the close', async ($, on) => {
    const w = world(on, { store: { panel: { hiddenByUser: true } } })
    await start($)
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    await ui.press({ key: 'ar-config' })
    w.files.set(CONFIG, { text: '{ "budgetMode": "cheap" }', mtime: w.clock.now() + 999 })
    await ui.press({ key: 'ar-reload' })
    expect(await words(ui)).toContain('problem')
    await ui.press({ key: 'ar-reopen' })
    expect(w.opened.length).toBe(1)
    expect(w.store.get('panel')).toEqual({ hiddenByUser: false })
    await ui.unmount()
  })

  test('Config shows the file and can hand it to an editor', async ($, on) => {
    const w = world(on)
    await start($)
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    await ui.press({ key: 'ar-config' })
    expect(await words(ui)).toContain('/home/test/.claude/auto-router/config.json')
    expect(await words(ui)).toContain('● valid')
    await ui.press({ key: 'ar-openfile' })
    expect(w.runs.some(argv => argv.includes('start') || argv[0] === 'open' || argv[0] === 'xdg-open')).toBe(true)
    await ui.unmount()
  })
})

describe('layout', () => {
  test('above the prompt the home is compact: no activity card, no long lines', async ($, on) => {
    world(on)
    await start($)
    const docked = await $.ui.mount({ ...pane('dock'), surface: 'desktop' })
    expect(await words(docked)).toContain('ACTIVITY')
    await docked.unmount()
    const inline = await $.ui.mount({ ...pane('inline', 48), surface: 'desktop' })
    const shown = await words(inline)
    expect(shown).toContain('ROUTER')
    expect(shown).not.toContain('ACTIVITY')
    expect(shown).not.toContain('EXECUTION ORDER')
    expect(await inline.find({ type: 'Button', key: 'ar-settings' })).toBeDefined()
    await inline.unmount()
  })

  test('a narrow pane still draws every tab and control', async ($, on) => {
    world(on)
    await start($)
    const ui = await $.ui.mount({ ...pane('dock', 30), surface: 'terminal' })
    const shown = await words(ui)
    for (const label of HOME_CARDS) expect(shown).toContain(label)
    for (const key of [...TABS, 'ar-settings']) expect(await ui.find({ type: 'Button', key })).toBeDefined()
    await ui.unmount()
  })

  test('the pane draws even with no session behind it', async ($, on) => {
    world(on)
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    expect(await words(ui)).toContain('ROUTER')
    await ui.unmount()
  })
})
