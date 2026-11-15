// The configure tool's confirm gate and the destructive-command check.

import { describe, expect, test } from 'claude-code/testing'

import { isSensitivePath } from '../hooks/engine/config.ts'
import { destructiveMatch } from '../hooks/engine/guard.ts'
import { CONFIG, start, world } from './helpers.ts'

const TOOL = 'mcp__auto-router__configure'

describe('the configure gate', () => {
  test('the models behind a floor and the judge are sensitive', () => {
    expect(isSensitivePath('tiers.sousChef.model')).toBe(true)
    expect(isSensitivePath('judge.uncertainBelow')).toBe(true)
    expect(isSensitivePath('judge.mode')).toBe(true)
    expect(isSensitivePath('routing.overrides')).toBe(false)
  })

  test('every action that writes a sensitive setting is put to the person', async ($, on) => {
    world(on)
    await start($)
    const check = async (input: Record<string, unknown>) => (await $.tool.check({ tool: TOOL, input, tool_use_id: 'c1' } as never)).decision
    expect(await check({ action: 'set', changes: [{ path: 'tiers.sousChef.model', value: 'haiku' }] })).toBe('ask')
    expect(await check({ action: 'set', changes: [{ path: 'judge.uncertainBelow', value: 0 }] })).toBe('ask')
    // A request in words is read by the patches it turns into.
    expect(await check({ action: 'request', request: 'limit parallel agents to one' })).toBe('ask')
    expect(await check({ action: 'request', request: 'use fable only for architecture and security' })).toBe('ask')
    // Harmless changes and reads are not.
    expect(await check({ action: 'request', request: 'switch to economical mode' })).toBe('allow')
    expect(await check({ action: 'set', changes: [{ path: 'budgetMode', value: 'quality' }] })).toBe('allow')
    expect(await check({ action: 'get' })).toBe('allow')
    // Anything not plainly read-only is treated as sensitive.
    expect(await check({ action: 'set', changes: 'everything' })).toBe('ask')
    expect(await check({ action: 'set', changes: [{ value: 1 }] })).toBe('ask')
    expect(await check({ action: 'wipe' })).toBe('ask')
    expect(CONFIG).toContain('config.json')
  })
})

describe('destructive commands', () => {
  const cases: [string, string | undefined][] = [
    ['rm -r build', 'recursive delete'],
    ['rm -f -r build', 'recursive delete'],
    ['rm --recursive --force build', 'recursive delete'],
    ['Remove-Item -Recurse -Force .\\build', 'recursive delete'],
    ['Remove-Item .\\build -r', 'recursive delete'],
    ['ri build -rec', 'recursive delete'],
    ['rmdir /q /s build', 'recursive delete'],
    ['del /f /s /q *.tmp', 'recursive delete'],
    ['git push origin +main', 'git history or worktree loss'],
    ['git push -uf origin main', 'git history or worktree loss'],
    ['git push --force-if-includes origin main', 'git history or worktree loss'],
    ['git clean --force -d', 'git history or worktree loss'],
    ['git branch --delete --force old', 'git history or worktree loss'],
    // Ordinary commands are left alone.
    ['rm notes.txt', undefined],
    ['git push -u origin main', undefined],
    ['git push --follow-tags', undefined],
    ['Remove-Item notes.txt', undefined],
    ['npm run format', undefined],
  ]
  test('reads the common spellings of a recursive delete and a forced push', () => {
    for (const [command, label] of cases) expect([command, destructiveMatch('Bash', { command })]).toEqual([command, label])
  })
})
