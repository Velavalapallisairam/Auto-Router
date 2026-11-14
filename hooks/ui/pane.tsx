// The Auto Router pane as a drawing: one header with five tabs (Home, Agents,
// Usage, Safety, Config) and a few quiet cards per tab. Pure: it is handed the
// surface's elements and the data, and returns a tree. Every press is answered
// in the hooks module (`ui.press`), so a Button here carries a key and no
// behaviour of its own.
//
// One set of parts draws every tab: a card, a section heading inside it, a
// labelled field, a two-sided table row, a meter, a setting and a button row.
// Spacing lives in those parts and nowhere else.
//
// Colors are theme keys, so the pane follows the person's light or dark theme.
// The drawings with their own colors are the model characters (SVG images),
// whose palette is chosen to read on both.

import type { Elements, RenderElement } from 'claude-code'

import type { ActivityEvent, AgentKey, AgentRec, Alias, Complexity, DayUsage, EventStatus, Risk, RouterConfig, Totals, UsageState, ViewState, CoreState } from '../../types'
import { AGENT_DEFS } from '../engine/agents.ts'
import { AGENT_KEYS } from '../engine/consts.ts'
import type { Saving } from '../engine/cost.ts'
import { costOf, costOfMap, lastDays, savingOf } from '../engine/cost.ts'
import { aliasOf } from '../engine/route.ts'
import {
  UNAVAILABLE,
  configLines,
  fableCredits,
  findLimit,
  fmtClock,
  fmtDuration,
  fmtPercent,
  fmtTokens,
  fmtUsd,
  fmtWhen,
  hitText,
  limitLabel,
  modelEvidence,
  modelShort,
  reviewWord,
  routerState,
  stateWord,
} from '../engine/text.ts'
import { dayKey, sessionDays, sumTotals } from '../engine/usage.ts'

export type PaneUi = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button'> & { Svg?: Elements['desktop']['Svg'] }

export type PaneModel = {
  cols: number
  /** Where the surface seated the pane; `widget` is the desktop app's minimized form. */
  placement: 'dock' | 'inline' | 'widget'
  now: number
  core: CoreState
  view: ViewState
  agents: readonly AgentRec[]
  feed: readonly ActivityEvent[]
  log: readonly ActivityEvent[]
  usage: UsageState
  config: RouterConfig
  configPath: string
  isPanelHidden: boolean
}

const GOOD = 'success'
const WARN = 'warning'
const BAD = 'error'
const ACCENT = 'claude'
const LABEL = 12
/** Activity rows on Home. */
const HOME_EVENTS = 10

const noop = (): void => undefined

type Kids = readonly (RenderElement | null)[]
type Badge = { text: string; color?: string }
type ButtonSpec = { key: string; label: string; text: string; isPrimary?: boolean }

function cut(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, Math.max(1, max - 1))}…`
}

function statusColor(status: EventStatus): string | undefined {
  switch (status) {
    case 'OK':
      return GOOD
    case 'ERR':
      return BAD
    case 'BLOCKED':
      return WARN
    case 'RUNNING':
      return ACCENT
    default:
      return undefined
  }
}

function riskColor(risk: Risk): string | undefined {
  if (risk === 'critical') return BAD
  if (risk === 'high') return WARN
  return undefined
}

function isDock(m: PaneModel): boolean {
  return m.placement !== 'inline'
}

// ------------------------------------------------------------ building blocks

function card(ui: PaneUi, m: PaneModel, id: string, label: string, badge: Badge | undefined, body: Kids): RenderElement {
  const { Box, Text } = ui
  return (
    <Box key={`card-${id}`} flexDirection="column" borderStyle="round" borderDimColor marginTop={1} paddingX={1} width={m.cols}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor size="caption" weight="semibold">
          {label}
        </Text>
        {badge === undefined ? null : (
          <Text size="caption" weight="semibold" color={badge.color} dimColor={badge.color === undefined}>
            {badge.text}
          </Text>
        )}
      </Box>
      {body}
    </Box>
  )
}

/** One label and its value on a row. */
function kv(ui: PaneUi, m: PaneModel, key: string, label: string, value: string, color?: string, isWrapped = false): RenderElement {
  const { Box, Text } = ui
  const room = Math.max(12, m.cols - LABEL - 6)
  return (
    <Box key={key} flexDirection="row" gap={1}>
      <Box width={LABEL}>
        <Text dimColor size="footnote">
          {label}
        </Text>
      </Box>
      <Text size="footnote" color={color} wrap={isWrapped ? 'wrap' : 'truncate-end'}>
        {isWrapped ? value : cut(value, room)}
      </Text>
    </Box>
  )
}

/** A percentage as a thin bar. With no reading it says Unavailable: a bar is never guessed. */
function meter(ui: PaneUi, m: PaneModel, key: string, label: string, percent: number | undefined, detail?: string): RenderElement {
  const { Box, Text } = ui
  if (percent === undefined || !Number.isFinite(percent)) return kv(ui, m, key, label, UNAVAILABLE)
  const width = Math.max(6, Math.min(22, m.cols - LABEL - 14))
  const p = Math.max(0, Math.min(100, percent))
  const filled = Math.round((p / 100) * width)
  const color = p >= 90 ? BAD : p >= 70 ? WARN : GOOD
  return (
    <Box key={key} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Box width={LABEL}>
          <Text dimColor size="footnote">
            {label}
          </Text>
        </Box>
        <Box flexDirection="row">
          {filled > 0 ? (
            <Text size="footnote" color={color}>
              {'━'.repeat(filled)}
            </Text>
          ) : null}
          {filled < width ? (
            <Text size="footnote" dimColor>
              {'─'.repeat(width - filled)}
            </Text>
          ) : null}
        </Box>
        <Text size="footnote" tabular color={p >= 70 ? color : undefined}>
          {fmtPercent(percent)}
        </Text>
      </Box>
      {detail === undefined || !isDock(m) ? null : (
        <Box paddingLeft={LABEL + 1}>
          <Text dimColor size="caption" wrap="truncate-end">
            {detail}
          </Text>
        </Box>
      )}
    </Box>
  )
}

function limitMeter(ui: PaneUi, m: PaneModel, key: string, label: string, kind: string): RenderElement {
  const limit = findLimit(m.usage.rateLimits, kind)
  if (limit === undefined) return kv(ui, m, key, label, UNAVAILABLE)
  return meter(ui, m, key, label, limit.percentUsed, limit.resetsAt === undefined ? 'reset time unavailable' : `resets ${fmtWhen(limit.resetsAt)}`)
}

/** A setting: its name, a short hint, and the button that changes it. */
function toggle(ui: PaneUi, m: PaneModel, key: string, label: string, value: string, isOn: boolean, hint = ''): RenderElement {
  const { Box, Text, Button } = ui
  const right = Math.max(5, value.length) + 4
  const left = Math.max(12, m.cols - 4 - right - 1)
  return (
    <Box key={`row-${key}`} flexDirection="row" justifyContent="space-between" gap={1}>
      <Box flexDirection="column" width={left}>
        <Text size="footnote" wrap="truncate-end">
          {label}
        </Text>
        {hint === '' || !isDock(m) ? null : (
          <Text dimColor size="caption" wrap="truncate-end">
            {cut(hint, left)}
          </Text>
        )}
      </Box>
      <Button key={key} label={`${label}: ${value}`} variant={isOn ? 'primary' : 'secondary'} onPress={noop}>
        {value}
      </Button>
    </Box>
  )
}

function buttons(ui: PaneUi, key: string, specs: readonly ButtonSpec[]): RenderElement {
  const { Box, Button } = ui
  return (
    <Box key={key} flexDirection="row" columnGap={2} rowGap={1} flexWrap="wrap" marginTop={1}>
      {specs.map(spec => (
        <Button key={spec.key} label={spec.label} variant={spec.isPrimary === true ? 'primary' : 'secondary'} onPress={noop}>
          {spec.text}
        </Button>
      ))}
    </Box>
  )
}

function note(ui: PaneUi, key: string, text: string, color?: string): RenderElement {
  const { Text } = ui
  return (
    <Text key={key} size="caption" dimColor={color === undefined} color={color} wrap="wrap">
      {text}
    </Text>
  )
}

/** A heading inside a card: what the fields under it are about. */
function section(ui: PaneUi, key: string, label: string, detail?: string, color?: string): RenderElement {
  const { Box, Text } = ui
  return (
    <Box key={key} flexDirection="row" justifyContent="space-between" gap={1} marginTop={1}>
      <Text size="caption" weight="semibold" color={color} dimColor={color === undefined}>
        {label}
      </Text>
      {detail === undefined ? null : (
        <Text size="caption" dimColor wrap="truncate-end">
          {detail}
        </Text>
      )}
    </Box>
  )
}

/** A table row: a name on the left, its figure on the right, an optional quiet line under both. */
function pair(ui: PaneUi, m: PaneModel, key: string, left: string, right: string, detail?: string, color?: string): RenderElement {
  const { Box, Text } = ui
  const room = Math.max(8, m.cols - 6 - right.length)
  return (
    <Box key={key} flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Text size="footnote" wrap="truncate-end">
          {cut(left, room)}
        </Text>
        <Text size="footnote" tabular color={color}>
          {right}
        </Text>
      </Box>
      {detail === undefined ? null : (
        <Text dimColor size="caption" wrap="truncate-end">
          {cut(detail, Math.max(16, m.cols - 4))}
        </Text>
      )}
    </Box>
  )
}

function onOff(isOn: boolean): string {
  return isOn ? 'On' : 'Off'
}

// --------------------------------------------------------------------- shell

const TABS: readonly (readonly [string, string, string])[] = [
  ['ar-back', 'Home', 'home'],
  ['ar-agents', 'Agents', 'agents'],
  ['ar-usage', 'Usage', 'usage'],
  ['ar-guard', 'Safety', 'guardrails'],
  ['ar-config', 'Config', 'config'],
]

/** The tab a view belongs under: Settings and Activity open from Home, Configure from Agents. */
function tabOf(view: ViewState['view']): string {
  if (view === 'settings' || view === 'activity') return 'home'
  if (view === 'agents-config') return 'agents'
  return view
}

function headline(m: PaneModel): { text: string; color?: string } {
  const state = routerState(m.core, m.config)
  const route = m.core.route
  const on = route === undefined ? '' : ` · ${route.sentModel ?? route.alias ?? 'session model'} / ${route.sentEffort ?? route.effort ?? 'session effort'}`
  switch (state) {
    case 'paused':
      return { text: 'Paused: tool calls are blocked', color: WARN }
    case 'observing':
      return { text: `Observing only${on}`, color: WARN }
    case 'off':
      return { text: 'Routing is off' }
    case 'advisory':
      return { text: `Advising, not applying${on}` }
    default:
      return { text: `Routing on · ${m.config.budgetMode}${on}`, color: GOOD }
  }
}

function shell(ui: PaneUi, m: PaneModel, crumb: string | undefined, body: Kids): RenderElement {
  const { Box, Text, Button } = ui
  const head = headline(m)
  const active = tabOf(m.view.view)
  return (
    <Box flexDirection="column" width={m.cols}>
      <Box flexDirection="row" gap={1} paddingX={1}>
        <Text color={head.color} dimColor={head.color === undefined}>
          ●
        </Text>
        <Text weight="semibold" wrap="truncate-end">
          {cut(head.text, Math.max(16, m.cols - 5))}
        </Text>
      </Box>
      <Box flexDirection="row" columnGap={2} rowGap={1} paddingX={1} marginTop={1} flexWrap="wrap">
        {TABS.map(([key, label, tab]) => (
          <Button key={key} label={`${label} tab`} variant={tab === active ? 'primary' : 'secondary'} onPress={noop}>
            {label}
          </Button>
        ))}
      </Box>
      {crumb === undefined ? null : (
        <Box paddingX={1} marginTop={1}>
          <Text weight="semibold">{crumb}</Text>
        </Box>
      )}
      {m.core.note === '' ? null : (
        <Box paddingX={1} marginTop={1}>
          <Text size="footnote" color={GOOD} wrap="wrap">
            {m.core.note}
          </Text>
        </Box>
      )}
      {m.core.configError === undefined ? null : (
        <Box paddingX={1}>
          <Text size="footnote" color={BAD} wrap="wrap">
            {`Config problem: ${m.core.configError}`}
          </Text>
        </Box>
      )}
      {m.core.conflicts.map((text, index) => (
        <Box key={`conflict-${index}`} paddingX={1}>
          <Text color={WARN} size="footnote" wrap="wrap">
            {text}
          </Text>
        </Box>
      ))}
      {body}
    </Box>
  )
}

// ---------------------------------------------------------------------- data

function isLive(agent: AgentRec): boolean {
  return agent.status === 'RUNNING' || agent.status === 'PENDING'
}

function merged(m: PaneModel): ActivityEvent[] {
  const byId = new Map<number, ActivityEvent>()
  for (const event of m.log) byId.set(event.id, event)
  for (const event of m.feed) byId.set(event.id, event)
  return [...byId.values()].sort((a, b) => b.id - a.id)
}

function eventText(event: ActivityEvent): string {
  return `${fmtClock(event.t)} ${event.status.padEnd(7)} ${event.label}`
}

function shortTitle(key: AgentKey): string {
  return AGENT_DEFS[key].title.replace('Independent ', '')
}

function agentValue(m: PaneModel, key: AgentKey): { value: string; isLive: boolean } {
  const def = AGENT_DEFS[key]
  const configured = m.config.tiers[key].model
  const live = m.agents.find(agent => agent.agent === key && isLive(agent))
  if (live === undefined) return { value: `${configured} · ${def.effort} · idle`, isLive: false }
  const actual = live.actual === undefined ? '' : ` → ${modelShort(live.actual)}`
  return {
    value: `${live.assigned ?? configured}${actual} · ${live.effort ?? def.effort} · ${live.status} ${fmtDuration(m.now - live.startedAt)} · #${(live.agentId ?? live.key).slice(0, 6)} ${live.task}`,
    isLive: true,
  }
}

/** One subagent the router saw, as a line: models, effort, state, time and task. */
function agentLine(m: PaneModel, agent: AgentRec): string {
  const actual = agent.actual === undefined ? '' : ` → ${modelShort(agent.actual)}`
  const time = fmtDuration((agent.endedAt ?? m.now) - agent.startedAt)
  return `${agent.assigned ?? 'session model'}${actual} · ${agent.effort ?? 'default effort'} · ${agent.status} ${time} · ${agent.task}`
}

function agentName(agent: AgentRec): string {
  return agent.agent === undefined ? agent.type.replace('auto-router:', '') : shortTitle(agent.agent)
}

export type ModelMood = 'awake' | 'waking' | 'asleep' | 'unavailable'
export type ModelState = {
  alias: Alias
  name: string
  mood: ModelMood
  /** What it is doing now, one entry per running or pending job. */
  jobs: string[]
  /** For a model at rest: when it last answered and what it has used. */
  rest: string
}

/** Smallest first: the order the stage draws them in. */
export const STAGE_ORDER: readonly Alias[] = ['haiku', 'sonnet', 'opus', 'fable']
const MODEL_NAME: Readonly<Record<Alias, string>> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' }

type StageInput = Pick<PaneModel, 'core' | 'agents' | 'usage' | 'now'>

/**
 * What each model family is doing, from the router's own records and nothing
 * else: the main turn that is running, the subagents that are running or
 * pending, the cooldown list, and the tokens the API reported.
 */
export function modelStates(m: StageInput): ModelState[] {
  const route = m.core.route
  const mainAlias = route === undefined ? undefined : aliasOf(route.actualModel ?? route.sentModel ?? route.alias ?? m.core.session.baseModel)
  return STAGE_ORDER.map(alias => {
    const running: string[] = []
    const pending: string[] = []
    if (route !== undefined && route.status === 'running' && mainAlias === alias) {
      running.push(`Main session · ${route.sentEffort ?? route.effort ?? route.engineEffort ?? 'session effort'} · ${fmtDuration(m.now - route.startedAt)} · ${route.title}`)
    }
    for (const agent of m.agents) {
      if (!isLive(agent) || aliasOf(agent.actual ?? agent.resolved ?? agent.assigned) !== alias) continue
      const who = agent.agent === undefined ? agent.type : shortTitle(agent.agent)
      const text = `${who} · ${agent.effort ?? 'default effort'} · ${agent.status === 'PENDING' ? 'starting' : fmtDuration(m.now - agent.startedAt)} · ${agent.task}`
      if (agent.status === 'RUNNING') running.push(text)
      else pending.push(text)
    }
    const blocked = Object.entries(m.core.unavailable).find(([name, entry]) => aliasOf(name) === alias && entry.until > m.now)
    const totals: Totals = { req: 0, in: 0, out: 0, cr: 0, cw: 0 }
    for (const [id, one] of Object.entries(m.usage.byModel)) {
      if (aliasOf(id) !== alias) continue
      totals.req += one.req
      totals.in += one.in
      totals.out += one.out
    }
    const last = m.core.session.warm[alias]
    const parts: string[] = []
    if (blocked !== undefined) parts.push(`unavailable: ${blocked[1].reason}`)
    if (last !== undefined) parts.push(`last active ${fmtDuration(m.now - last)} ago`)
    if (totals.req > 0) parts.push(`in ${fmtTokens(totals.in)} · out ${fmtTokens(totals.out)} · ${totals.req} req`)
    if (parts.length === 0) parts.push('not used this session')
    const mood: ModelMood = running.length > 0 ? 'awake' : pending.length > 0 ? 'waking' : blocked !== undefined ? 'unavailable' : 'asleep'
    return { alias, name: MODEL_NAME[alias], mood, jobs: [...running, ...pending], rest: parts.join(' · ') }
  })
}

// --------------------------------------------------------- model characters

type Shade = { light: string; mid: string; dark: string }
const HUE: Readonly<Record<Alias, Shade>> = {
  haiku: { light: '#a8f5b8', mid: '#34c759', dark: '#14803a' },
  sonnet: { light: '#8fd0ff', mid: '#0a84ff', dark: '#0450a8' },
  opus: { light: '#e2b4fa', mid: '#af52de', dark: '#6d219c' },
  fable: { light: '#ffdc8f', mid: '#ff9f0a', dark: '#b85f00' },
}
const GREY: Shade = { light: '#cfcfd4', mid: '#8e8e93', dark: '#55555b' }
const GOLD: Shade = { light: '#fff0b8', mid: '#f5b301', dark: '#a86c00' }
const EYE_GAP: Readonly<Record<Alias, number>> = { haiku: 6, sonnet: 7.5, opus: 9, fable: 10 }
const EYE_Y: Readonly<Record<Alias, number>> = { haiku: 3, sonnet: 1, opus: 0, fable: 0 }
const MOUTH_DY: Readonly<Record<Alias, number>> = { haiku: 8, sonnet: 9, opus: 12.5, fable: 9 }
const SHADOW_RX: Readonly<Record<Alias, number>> = { haiku: 17, sonnet: 21, opus: 25, fable: 27 }

/** The stage is this wide for one character; four of them wrap to fit the pane. */
export const CHARACTER_SIZE = { width: 120, height: 124 } as const

const EASE = 'cubic-bezier(.22,1,.36,1)'
// Only transform and opacity move, so the compositor does all of it. Each
// character has an entry (played once, when its own mood changes and its image
// is replaced) and a loop that starts as the entry ends.
const STAGE_STYLE = [
  '.e,.l,.eye,.sh,.glow,.spark{transform-box:fill-box}',
  '.e,.l{transform-origin:50% 100%}.eye,.sh,.glow,.spark{transform-origin:center}',
  `.e-asleep{opacity:.5;animation:settle .9s ${EASE} both}`,
  `.e-waking{opacity:.82;animation:stir .8s ${EASE} both}`,
  `.e-awake{animation:rise .7s ${EASE} both}`,
  '.e-unavailable{opacity:.55}',
  '.breathe{animation:breathe 4.8s ease-in-out .9s infinite}',
  '.sway{animation:sway 3.4s ease-in-out .8s infinite}',
  '.bob{animation:bob 2.8s ease-in-out .7s infinite}',
  '.sh-awake{animation:shade 2.8s ease-in-out .7s infinite}',
  '.open{animation:open .5s ease-out .15s both}',
  '.blink{animation:blink 4.6s 1.2s infinite}',
  '.fade{animation:fade .8s ease-out both}',
  '.glow{animation:glow 3.2s ease-in-out infinite}',
  '.z{opacity:0;animation:z 4.2s ease-in-out .9s infinite}.z2{animation-delay:2.3s}.z3{animation-delay:3.7s}',
  '.spark{opacity:0;animation:spark 2s ease-in-out .7s infinite}.s2{animation-delay:1.7s}',
  '@keyframes settle{from{opacity:.95;transform:translateY(-2px) scale(1.02)}}',
  '@keyframes stir{from{opacity:.5;transform:scale(1.015,.97)}}',
  '@keyframes rise{from{opacity:.82;transform:translateY(2px) scale(.98,.96)}}',
  '@keyframes breathe{0%,100%{transform:scale(1,1)}50%{transform:scale(1.025,.965)}}',
  '@keyframes sway{0%,100%{transform:rotate(-1.4deg)}50%{transform:rotate(1.4deg)}}',
  '@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}',
  '@keyframes shade{0%,100%{transform:scaleX(1);opacity:1}50%{transform:scaleX(.88);opacity:.75}}',
  '@keyframes open{from{transform:scaleY(.15)}}',
  '@keyframes blink{0%,93%,100%{transform:scaleY(1)}96.5%{transform:scaleY(.1)}}',
  '@keyframes fade{from{opacity:0}}',
  '@keyframes glow{0%,100%{opacity:.55;transform:scale(.94)}50%{opacity:.95;transform:scale(1.04)}}',
  '@keyframes z{0%{opacity:0;transform:translate(0,0)}35%{opacity:.9}100%{opacity:0;transform:translate(5px,-12px)}}',
  '@keyframes spark{0%,100%{opacity:.1;transform:scale(.6)}50%{opacity:1;transform:scale(1)}}',
  '@media (prefers-reduced-motion:reduce){*{animation:none!important}.z{opacity:.7}}',
].join('')

/** Lighting shared by every character: one key light from the upper left, a soft floor shadow, a glow. */
function lighting(hue: Shade, gold: Shade): string {
  const stops = (shade: Shade): string => `<stop offset="0" stop-color="${shade.light}"/><stop offset=".52" stop-color="${shade.mid}"/><stop offset="1" stop-color="${shade.dark}"/>`
  return (
    '<defs>' +
    `<radialGradient id="b" cx=".33" cy=".25" r=".9">${stops(hue)}</radialGradient>` +
    `<radialGradient id="k" cx=".35" cy=".2" r=".95">${stops(gold)}</radialGradient>` +
    '<radialGradient id="h"><stop offset="0" stop-color="#fff" stop-opacity=".8"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>' +
    '<radialGradient id="f"><stop offset="0" stop-color="#000" stop-opacity=".4"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>' +
    `<radialGradient id="a"><stop offset=".35" stop-color="${hue.mid}" stop-opacity=".42"/><stop offset="1" stop-color="${hue.mid}" stop-opacity="0"/></radialGradient>` +
    `<linearGradient id="p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hue.light}"/><stop offset=".3" stop-color="${hue.mid}"/><stop offset="1" stop-color="${hue.dark}"/></linearGradient>` +
    '</defs>'
  )
}

const BODY = 'url(#b)'
const SHINE = 'url(#h)'
const CHEEK = '#ff8fa3'

/**
 * Each model's own body, larger as the model is: a sprout, a robot, a bear, a
 * crowned sage. Built back to front: what is behind, the lit body, its lighter
 * belly or panel, surface detail, then the highlight.
 */
function body(alias: Alias, hue: Shade): string {
  switch (alias) {
    case 'haiku':
      return (
        `<path d="M0,-10 C-1,-17 2,-22 7,-25" stroke="${hue.dark}" stroke-width="2.4" fill="none" stroke-linecap="round"/>` +
        `<path d="M6,-25 C10,-33 20,-33 23,-30 C21,-22 13,-19 6,-25Z" fill="${BODY}"/>` +
        `<path d="M8,-25 Q15,-28 21,-30" stroke="${hue.light}" stroke-width=".8" fill="none" opacity=".75"/>` +
        `<path d="M1,-17 C-5,-22 -12,-20 -13,-17 C-10,-13 -4,-13 1,-17Z" fill="${BODY}"/>` +
        `<ellipse cx="-8" cy="21" rx="6" ry="3.2" fill="${hue.dark}"/><ellipse cx="8" cy="21" rx="6" ry="3.2" fill="${hue.dark}"/>` +
        `<circle cy="5" r="17" fill="${BODY}"/>` +
        `<ellipse cy="11" rx="10" ry="8" fill="${hue.light}" opacity=".3"/>` +
        `<circle cx="-11" cy="9" r="2.6" fill="${CHEEK}" opacity=".5"/><circle cx="11" cy="9" r="2.6" fill="${CHEEK}" opacity=".5"/>` +
        `<ellipse cx="-7" cy="-5" rx="6.5" ry="3.6" fill="${SHINE}" transform="rotate(-28 -7 -5)"/>`
      )
    case 'sonnet':
      return (
        `<path d="M0,-16 V-25" stroke="${hue.dark}" stroke-width="3" stroke-linecap="round"/><circle cy="-27" r="3.8" fill="${BODY}"/><circle cx="-1.2" cy="-28.2" r="1.1" fill="#fff" opacity=".7"/>` +
        `<rect x="-25" y="-3" width="6" height="13" rx="3" fill="${hue.dark}"/><rect x="19" y="-3" width="6" height="13" rx="3" fill="${hue.dark}"/>` +
        `<rect x="-13" y="23" width="10" height="6" rx="3" fill="${hue.dark}"/><rect x="3" y="23" width="10" height="6" rx="3" fill="${hue.dark}"/>` +
        `<rect x="-18" y="-14" width="40" height="40" rx="12" fill="${hue.dark}"/>` +
        `<rect x="-20" y="-16" width="40" height="40" rx="12" fill="${BODY}"/>` +
        `<rect x="-15" y="-10" width="30" height="23" rx="8" fill="#08192b" opacity=".6"/>` +
        '<path d="M-12,-7 h13 l-7,9 h-6z" fill="#fff" opacity=".09"/>' +
        `<path d="M-20,17 h40" stroke="${hue.dark}" stroke-width="1" opacity=".4"/>` +
        `<circle cx="-14" cy="20.5" r="1.3" fill="${hue.light}" opacity=".85"/><circle cx="14" cy="20.5" r="1.3" fill="${hue.light}" opacity=".85"/>` +
        `<ellipse cx="-9" cy="-13" rx="8" ry="2.2" fill="${SHINE}"/>`
      )
    case 'opus':
      return (
        `<circle cx="-17" cy="-15" r="8.5" fill="${BODY}"/><circle cx="17" cy="-15" r="8.5" fill="${BODY}"/>` +
        `<circle cx="-17" cy="-15" r="4.4" fill="${hue.light}" opacity=".6"/><circle cx="17" cy="-15" r="4.4" fill="${hue.light}" opacity=".6"/>` +
        `<ellipse cx="-10" cy="27" rx="7.5" ry="3.6" fill="${hue.dark}"/><ellipse cx="10" cy="27" rx="7.5" ry="3.6" fill="${hue.dark}"/>` +
        `<ellipse cx="-24" cy="12" rx="5" ry="7.5" fill="${BODY}"/><ellipse cx="24" cy="12" rx="5" ry="7.5" fill="${BODY}"/>` +
        `<circle cy="4" r="24" fill="${BODY}"/>` +
        `<ellipse cy="11" rx="11.5" ry="8.5" fill="${hue.light}" opacity=".48"/>` +
        '<ellipse cy="7" rx="3.2" ry="2.1" fill="#2b1140"/><ellipse cx="-.8" cy="6.4" rx="1" ry=".6" fill="#fff" opacity=".55"/>' +
        `<path d="M-5,-19 q2,-6 4,-1 q2,-6 4,1 q2,-5 3,1" stroke="${hue.light}" stroke-width="1.6" fill="none" stroke-linecap="round" opacity=".85"/>` +
        `<circle cx="-16" cy="10" r="3" fill="${CHEEK}" opacity=".42"/><circle cx="16" cy="10" r="3" fill="${CHEEK}" opacity=".42"/>` +
        `<ellipse cx="-10" cy="-9" rx="8.5" ry="4.6" fill="${SHINE}" transform="rotate(-28 -10 -9)"/>`
      )
    default:
      return (
        `<path d="M-24,-8 C-34,4 -36,24 -27,30 H27 C36,24 34,4 24,-8Z" fill="${hue.dark}"/>` +
        `<ellipse cx="-11" cy="28" rx="7.5" ry="3.3" fill="${hue.dark}"/><ellipse cx="11" cy="28" rx="7.5" ry="3.3" fill="${hue.dark}"/>` +
        `<rect x="-26" y="-22" width="52" height="50" rx="22" fill="${BODY}"/>` +
        `<ellipse cy="15" rx="15" ry="10" fill="${hue.light}" opacity=".22"/>` +
        '<path d="M0,13 l1.8,3.6 4,.6 -2.9,2.8 .7,4 -3.6,-1.9 -3.6,1.9 .7,-4 -2.9,-2.8 4,-.6z" fill="url(#k)"/>' +
        '<path d="M-15,-20 L-17,-34 L-8,-27 L0,-37 L8,-27 L17,-34 L15,-20Z" fill="url(#k)" stroke-linejoin="round"/>' +
        '<rect x="-15.5" y="-23.5" width="31" height="5" rx="2.5" fill="url(#k)"/>' +
        '<circle cy="-28.5" r="2.1" fill="#ff375f"/><circle cx="-.7" cy="-29.2" r=".7" fill="#fff" opacity=".8"/>' +
        '<circle cx="-9" cy="-21" r="1.3" fill="#64d2ff"/><circle cx="9" cy="-21" r="1.3" fill="#64d2ff"/>' +
        `<circle cx="-17" cy="9" r="3" fill="${CHEEK}" opacity=".4"/><circle cx="17" cy="9" r="3" fill="${CHEEK}" opacity=".4"/>` +
        `<ellipse cx="-12" cy="-11" rx="9" ry="4.4" fill="${SHINE}" transform="rotate(-25 -12 -11)"/>`
      )
  }
}

function face(alias: Alias, mood: ModelMood): string {
  const e = EYE_GAP[alias]
  const y = EYE_Y[alias]
  const my = y + MOUTH_DY[alias]
  const eye = (x: number, r: number): string =>
    `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff"/><circle cx="${x + 0.7}" cy="${y + 0.4}" r="${r / 2}" fill="#1c1c1e"/><circle cx="${x - 0.6}" cy="${y - 0.9}" r="${r / 4.5}" fill="#fff"/>`
  if (mood === 'awake') {
    return (
      `<g class="eye open"><g class="eye blink">${eye(-e, 3.6)}${eye(e, 3.6)}</g></g>` +
      `<path d="M-5,${my} q5,4.5 10,0" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/>`
    )
  }
  if (mood === 'waking') {
    // Half-open: the lids are still coming up.
    return (
      `<ellipse cx="${-e}" cy="${y}" rx="3.2" ry="1.7" fill="#fff"/><ellipse cx="${e}" cy="${y}" rx="3.2" ry="1.7" fill="#fff"/>` +
      `<circle cx="${-e + 0.5}" cy="${y + 0.3}" r="1.2" fill="#1c1c1e"/><circle cx="${e + 0.5}" cy="${y + 0.3}" r="1.2" fill="#1c1c1e"/>` +
      `<path d="M-3,${my + 1} h6" stroke="#fff" stroke-width="2" stroke-linecap="round"/>`
    )
  }
  if (mood === 'unavailable') {
    const cross = (x: number): string => `M${x - 2.5},${y - 2.5} l5,5 M${x + 2.5},${y - 2.5} l-5,5`
    return `<path d="${cross(-e)} ${cross(e)} M-4,${my + 1} h8" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/>`
  }
  return (
    `<path d="M${-e - 3},${y} q3,3 6,0 M${e - 3},${y} q3,3 6,0" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/>` +
    `<ellipse cy="${my + 0.5}" rx="1.7" ry="1.4" fill="#fff" opacity=".9"/>`
  )
}

/**
 * One model as its own SVG image. The markup depends on the model and its mood
 * alone, so a redraw with the same mood is the same image and nothing restarts;
 * when the mood changes the image is replaced and its entry plays once, from
 * the pose the last mood left: a sleeper stirs, a stirring one rises, a busy
 * one settles back to sleep.
 */
export function characterSvg(state: ModelState): string {
  const { alias, mood } = state
  const isUp = mood === 'awake'
  const isOff = mood === 'unavailable'
  const hue = isOff ? GREY : HUE[alias]
  const loop = isUp ? 'bob' : mood === 'asleep' ? 'breathe' : mood === 'waking' ? 'sway' : ''
  const pill = isUp || mood === 'waking' ? 'url(#p)' : GREY.mid
  const { width, height } = CHARACTER_SIZE
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui,-apple-system,'Segoe UI',sans-serif">`,
    lighting(hue, isOff ? GREY : GOLD),
    `<style>${STAGE_STYLE}</style>`,
    '<g transform="translate(60,54)">',
    isUp ? '<g class="fade"><circle class="glow" cy="2" r="44" fill="url(#a)"/></g>' : '',
    `<ellipse class="sh${isUp ? ' sh-awake' : ''}" cy="31" rx="${SHADOW_RX[alias]}" ry="4.6" fill="url(#f)"/>`,
    `<g class="e e-${mood}"><g class="l${loop === '' ? '' : ` ${loop}`}">${body(alias, hue)}${face(alias, mood)}</g></g>`,
    mood === 'asleep'
      ? `<g fill="${GREY.mid}" font-weight="700"><text class="z" x="22" y="-17" font-size="9">z</text><text class="z z2" x="28" y="-25" font-size="11">z</text><text class="z z3" x="35" y="-33" font-size="13">Z</text></g>`
      : '',
    isUp ? `<circle class="spark" cx="-36" cy="-20" r="2.2" fill="${hue.light}"/><circle class="spark s2" cx="37" cy="-16" r="1.8" fill="${hue.light}"/>` : '',
    `<rect x="-28" y="42" width="56" height="19" rx="9.5" fill="${pill}" opacity="${isUp ? 1 : mood === 'waking' ? 0.9 : 0.65}"/>`,
    isUp || mood === 'waking' ? '<rect x="-24" y="43.5" width="48" height="6" rx="3" fill="#fff" opacity=".18"/>' : '',
    `<text y="55.5" text-anchor="middle" font-size="10.5" font-weight="600" fill="#fff">${state.name}</text>`,
    '</g></svg>',
  ]
  return parts.join('')
}

function moodWord(mood: ModelMood): string {
  switch (mood) {
    case 'awake':
      return 'Awake'
    case 'waking':
      return 'Waking'
    case 'unavailable':
      return 'Unavailable'
    default:
      return 'Asleep'
  }
}

function moodColor(mood: ModelMood): string | undefined {
  if (mood === 'awake') return GOOD
  if (mood === 'waking') return ACCENT
  if (mood === 'unavailable') return WARN
  return undefined
}

function modelRow(ui: PaneUi, m: PaneModel, state: ModelState): RenderElement {
  const { Box, Text } = ui
  const color = moodColor(state.mood)
  const first = state.jobs[0]
  const more = state.jobs.length > 1 ? ` · +${state.jobs.length - 1} more` : ''
  return (
    <Box key={`model-${state.alias}`} flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
          <Text size="footnote" color={color} dimColor={color === undefined}>
            {state.mood === 'awake' || state.mood === 'waking' ? '●' : '○'}
          </Text>
          <Text size="footnote" weight="semibold">
            {state.name}
          </Text>
        </Box>
        <Text size="footnote" color={color} dimColor={color === undefined}>
          {moodWord(state.mood)}
        </Text>
      </Box>
      <Box flexDirection="row" gap={1} paddingLeft={2}>
        <Box width={5}>
          <Text dimColor size="caption">
            {first === undefined ? 'Last' : 'Now'}
          </Text>
        </Box>
        <Text dimColor size="caption" wrap="truncate-end">
          {cut(first === undefined ? state.rest : `${first}${more}`, Math.max(16, m.cols - 9))}
        </Text>
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------------- home

const RATING: Readonly<Record<Complexity, string>> = {
  simple: 'Simple',
  standard: 'Moderate',
  complex: 'Complex',
  critical: 'Critical',
  exceptional: 'Critical (exceptional)',
}

type PlanStep = { who: string; model: string; what: string; state: string; color?: string }
type TaskPlan = { lead: string; support: AgentRec[]; steps: PlanStep[]; result: string }

/**
 * Who does what for the task under way, from the route and the subagents the
 * router recorded since it began. Nothing is predicted: an agent is listed
 * once it was started, a suggestion is called a suggestion.
 */
function taskPlan(m: PaneModel): TaskPlan | undefined {
  const route = m.core.route
  if (route === undefined) return undefined
  const model = route.sentModel ?? route.alias ?? 'session model'
  const effort = route.sentEffort ?? route.effort ?? route.engineEffort ?? 'session default'
  const support = m.agents.filter(agent => agent.startedAt >= route.startedAt).sort((a, b) => a.startedAt - b.startedAt)
  const workers = support.filter(agent => agent.agent !== 'reviewer' && agent.status !== 'BLOCKED')
  const reviewers = support.filter(agent => agent.agent === 'reviewer')
  const isShared = workers.length > 0
  const steps: PlanStep[] = [
    {
      who: 'Head Chef',
      model: `${model} · ${effort}`,
      what: isShared ? 'Reads the task, plans it and hands out the independent parts.' : 'Reads the task and does the work itself.',
      state: route.status,
      color: ACCENT,
    },
  ]
  for (const agent of workers) {
    steps.push({ who: agentName(agent), model: `${agent.assigned ?? 'session model'} · ${agent.effort ?? 'default effort'}`, what: agent.task, state: agent.status, color: statusColor(agent.status) })
  }
  if (!isShared && route.delegation !== undefined) {
    steps.push({ who: 'Suggested', model: route.delegation, what: 'Independent parts may go to these agents. None has started.', state: 'not started' })
  }
  for (const agent of reviewers) {
    steps.push({ who: 'Reviewer', model: `${agent.assigned ?? m.config.tiers.reviewer.model} · ${agent.effort ?? AGENT_DEFS.reviewer.effort}`, what: 'Independent, read-only review of the finished work.', state: agent.status, color: statusColor(agent.status) })
  }
  const hasReview = reviewers.length > 0 || route.reviewRequired
  if (reviewers.length === 0 && route.reviewRequired) {
    steps.push({ who: 'Reviewer', model: `${m.config.tiers.reviewer.model} · ${AGENT_DEFS.reviewer.effort}`, what: 'Independent, read-only review of the finished work.', state: route.review, color: route.review === 'missed' ? WARN : undefined })
  }
  const combine = isShared
    ? `Each agent returns a short report to the Head Chef (${model}), which checks the reports and writes the one answer.`
    : `The Head Chef (${model}) writes the answer itself. No other agent takes part.`
  return { lead: `${model} · ${effort}`, support, steps, result: hasReview ? `${combine} An independent review comes before the work is called done.` : combine }
}

/** One numbered step of the execution order: who and on what, then what it does and its state. */
function stepRow(ui: PaneUi, m: PaneModel, index: number, step: PlanStep): RenderElement {
  const { Box, Text } = ui
  const room = Math.max(16, m.cols - 8)
  return (
    <Box key={`step-${index}`} flexDirection="row" gap={1}>
      <Box width={2}>
        <Text size="footnote" dimColor tabular>
          {String(index + 1)}
        </Text>
      </Box>
      <Box flexDirection="column">
        <Text size="footnote" weight={index === 0 ? 'semibold' : 'regular'} color={index === 0 ? ACCENT : undefined} wrap="truncate-end">
          {cut(`${step.who} · ${step.model}`, room)}
        </Text>
        <Text size="caption" color={step.color === ACCENT ? undefined : step.color} dimColor={step.color === undefined || step.color === ACCENT} wrap="wrap">
          {`${step.state} · ${step.what}`}
        </Text>
      </Box>
    </Box>
  )
}

function routerCard(ui: PaneUi, m: PaneModel): RenderElement {
  const { Text } = ui
  const state = routerState(m.core, m.config)
  const route = m.core.route
  const plan = taskPlan(m)
  const isOn = m.config.enabled
  const isFull = isDock(m)
  const hasPins = m.core.pins.model !== undefined || m.core.pins.effort !== undefined
  const badgeColor = state === 'on' ? GOOD : state === 'off' ? undefined : WARN
  const body: (RenderElement | null)[] = []
  if (route === undefined || plan === undefined) {
    body.push(
      <Text key="none" weight="semibold">
        No task yet
      </Text>,
      note(ui, 'none-hint', 'The next prompt is read, rated and routed.'),
    )
  } else {
    const workers = plan.support.filter(agent => agent.agent !== 'reviewer')
    body.push(
      kv(ui, m, 'task', 'Task', route.title, undefined, isFull),
      kv(ui, m, 'rating', 'Task rating', RATING[route.complexity]),
      kv(ui, m, 'risk', 'Risk', route.risk, riskColor(route.risk)),
      section(ui, 'sec-lead', '★ HEAD CHEF', 'leads the task', ACCENT),
      kv(ui, m, 'lead', 'Model', plan.lead, ACCENT),
      kv(ui, m, 'tier', 'Tier', AGENT_DEFS[route.agent].title),
      kv(ui, m, 'evidence', 'Evidence', modelEvidence(route.sentModel ?? route.alias, route.actualModel)),
      isFull ? kv(ui, m, 'why', 'Reasoning', route.explanation, undefined, true) : null,
      section(ui, 'sec-support', 'SUPPORTING AGENTS', `${workers.length} started · max ${m.config.guardrails.maxParallelAgents} at once`),
    )
    if (plan.support.length === 0) {
      body.push(note(ui, 'support-none', route.delegation === undefined ? 'None. The Head Chef does the whole task.' : `None started. Suggested: ${route.delegation}.`))
    }
    for (const agent of plan.support.slice(0, isFull ? 5 : 2)) {
      body.push(kv(ui, m, `support-${agent.key}`, agentName(agent), agentLine(m, agent), isLive(agent) ? ACCENT : statusColor(agent.status), isFull))
    }
    if (isFull) {
      body.push(section(ui, 'sec-order', 'EXECUTION ORDER', `${plan.steps.length} ${plan.steps.length === 1 ? 'step' : 'steps'}`), ...plan.steps.map((step, index) => stepRow(ui, m, index, step)))
      body.push(section(ui, 'sec-result', 'FINAL RESULT'), note(ui, 'result', plan.result))
    }
  }
  if (m.core.session.passive !== undefined) body.push(note(ui, 'passive', `Observing only: ${m.core.session.passive}`, WARN))
  if (hasPins) body.push(note(ui, 'pins', `Pinned by you: ${[m.core.pins.model, m.core.pins.effort].filter(Boolean).join(' · ')}`, WARN))
  const specs: ButtonSpec[] = []
  if (m.core.paused) specs.push({ key: 'ar-resume', label: 'Resume', text: 'Resume tool calls', isPrimary: true })
  if (isOn) specs.push({ key: 'ar-off', label: 'Turn Off', text: 'Turn Off' })
  if (!isOn || hasPins) specs.push({ key: 'ar-on', label: 'Turn On', text: isOn ? 'Resume routing' : 'Turn On', isPrimary: !m.core.paused })
  specs.push({ key: 'ar-settings', label: 'Settings', text: 'Settings' })
  specs.push({ key: 'ar-budget', label: 'Change Budget Profile', text: `Profile: ${m.config.budgetMode}` })
  body.push(buttons(ui, 'router-actions', specs))
  return card(ui, m, 'router', 'ROUTER', { text: `● ${stateWord(state)}`, color: badgeColor }, body)
}

function activityCard(ui: PaneUi, m: PaneModel): RenderElement {
  const events = merged(m)
  const rows: (RenderElement | null)[] = events.slice(0, HOME_EVENTS).map(event => kv(ui, m, `event-${event.id}`, fmtClock(event.t), `${event.status} · ${event.label}`, statusColor(event.status)))
  if (rows.length === 0) rows.push(note(ui, 'none', m.config.telemetry.enabled ? 'No events yet.' : 'Telemetry is off.'))
  rows.push(buttons(ui, 'activity-actions', [{ key: 'ar-activity', label: 'View Activity', text: 'View all' }]))
  return card(ui, m, 'activity', 'ACTIVITY', { text: `${Math.min(events.length, HOME_EVENTS)} of ${events.length}` }, rows)
}

function home(ui: PaneUi, m: PaneModel): RenderElement {
  return shell(ui, m, undefined, [routerCard(ui, m), isDock(m) ? activityCard(ui, m) : null])
}

// ------------------------------------------------------------------ settings

function settingsView(ui: PaneUi, m: PaneModel): RenderElement {
  const c = m.config
  const main = c.routing.mainSession
  const pins = [m.core.pins.model, m.core.pins.effort].filter(Boolean).join(' · ')
  return shell(ui, m, 'Router Settings', [
    card(ui, m, 'routing', 'ROUTING', undefined, [
      toggle(ui, m, c.enabled ? 'ar-off' : 'ar-on', 'Automatic routing', onOff(c.enabled), c.enabled, 'Off: requests go out as Claude Code set them.'),
      toggle(ui, m, 'ar-auto', 'Apply decisions', c.autonomous ? 'Auto' : 'Advise', c.autonomous, 'Advise: shown, not applied.'),
      toggle(ui, m, 'ar-budget', 'Budget profile', c.budgetMode, c.budgetMode !== 'economical', 'No profile lowers a risk floor.'),
      toggle(ui, m, 'ar-mainmodel', 'Main session model', onOff(main.routeModel), main.routeModel),
      toggle(ui, m, 'ar-maineffort', 'Main session effort', onOff(main.routeEffort), main.routeEffort),
      toggle(ui, m, 'ar-cache', 'Cache-aware switching', onOff(main.cacheAware), main.cacheAware, 'Stay while a warm cache is cheaper.'),
      toggle(ui, m, 'ar-pins', 'Keep my mid-session picks', onOff(c.guardrails.respectUserPins), c.guardrails.respectUserPins, 'Until routing is turned on again.'),
      pins === '' ? null : toggle(ui, m, 'ar-unpin', `Pinned: ${pins}`, 'Unpin', false, 'Hand the choice back to the router.'),
      note(ui, 'effort-note', m.core.session.perMessageEffort ? 'Effort changes cost no cache here.' : 'Effort is lowered only when the message cache is cold.'),
    ]),
    card(ui, m, 'panel', 'PANEL AND TELEMETRY', undefined, [
      toggle(ui, m, 'ar-panel', 'Dashboard', onOff(c.sidePanel.enabled), c.sidePanel.enabled),
      toggle(ui, m, 'ar-autoopen', 'Open at session start', onOff(c.sidePanel.autoOpen), c.sidePanel.autoOpen, m.isPanelHidden ? 'You closed it: stays closed until reopened.' : 'Never takes the keyboard.'),
      toggle(ui, m, 'ar-telemetry', 'Activity and usage', onOff(c.telemetry.enabled), c.telemetry.enabled, 'Sanitized metadata only.'),
      toggle(ui, m, 'ar-preview', 'Task titles', onOff(c.telemetry.promptPreview), c.telemetry.promptPreview, 'A short, redacted title of the task.'),
    ]),
  ])
}

// -------------------------------------------------------------------- agents

function agentsView(ui: PaneUi, m: PaneModel): RenderElement {
  const { Box, Text } = ui
  const states = modelStates(m)
  const up = states.filter(state => state.mood === 'awake').length
  const live = m.agents.filter(isLive)
  const Svg = ui.Svg
  // One image per model: a mood change replaces that model's image alone, so
  // only the one that woke or fell asleep plays its transition.
  const stage =
    Svg === undefined ? null : (
      <Box key="stage" flexDirection="row" justifyContent="center" flexWrap="wrap" columnGap={1} rowGap={1} marginBottom={1}>
        {states.map(state => (
          <Svg key={`char-${state.alias}`} source={characterSvg(state)} alt={`${state.name} ${moodWord(state.mood).toLowerCase()}`} width={CHARACTER_SIZE.width} height={CHARACTER_SIZE.height} />
        ))}
      </Box>
    )
  const tiers = AGENT_KEYS.map(key => {
    const one = agentValue(m, key)
    return kv(ui, m, `tier-${key}`, shortTitle(key), one.value, one.isLive ? ACCENT : undefined, one.isLive)
  })
  const seen = m.agents.slice(0, isDock(m) ? 5 : 2).map(agent => (
    <Box key={`seen-${agent.key}`} flexDirection="column">
      <Text size="footnote" color={statusColor(agent.status)} wrap="truncate-end">
        {cut(`${agent.status} · ${agent.type.replace('auto-router:', '')} · #${(agent.agentId ?? agent.key).slice(0, 8)} · ${fmtDuration((agent.endedAt ?? m.now) - agent.startedAt)}`, Math.max(16, m.cols - 4))}
      </Text>
      <Text dimColor size="caption" wrap="truncate-end">
        {cut(`${modelEvidence(agent.assigned, agent.actual)} · in ${fmtTokens(agent.tokens.in)} · out ${fmtTokens(agent.tokens.out)} · ${agent.task}${agent.note === undefined ? '' : ` · ${agent.note}`}`, Math.max(16, m.cols - 4))}
      </Text>
    </Box>
  ))
  return shell(ui, m, undefined, [
    card(ui, m, 'models', 'MODELS', { text: `${up} awake`, color: up > 0 ? GOOD : undefined }, [stage, ...states.map(state => modelRow(ui, m, state))]),
    card(ui, m, 'tiers', 'SPECIALISTS', { text: `${live.length} active · max ${m.config.guardrails.maxParallelAgents}`, color: live.length > 0 ? ACCENT : undefined }, [
      ...tiers,
      buttons(ui, 'tier-actions', [{ key: 'ar-agents-config', label: 'Configure Agents', text: 'Configure' }]),
    ]),
    card(ui, m, 'seen', 'THIS SESSION', { text: `${m.agents.length} subagents` }, seen.length > 0 ? seen : [note(ui, 'none', 'No subagent has started in this session.')]),
  ])
}

function agentsConfigView(ui: PaneUi, m: PaneModel): RenderElement {
  const { Box, Text, Button } = ui
  const g = m.config.guardrails
  const sub = m.config.routing.subagents
  const tiers = AGENT_KEYS.map(key => {
    const tier = m.config.tiers[key]
    const title = AGENT_DEFS[key].title
    return (
      <Box key={`tier-${key}`} flexDirection="row" justifyContent="space-between" gap={1}>
        <Text size="footnote" wrap="truncate-end">
          {shortTitle(key)}
        </Text>
        <Box flexDirection="row" gap={2}>
          <Button key={`ar-tier-${key}`} label={`${title} model: ${tier.model}`} variant="primary" onPress={noop}>
            {tier.model}
          </Button>
          <Button key={`ar-fb-${key}`} label={`${title} fallback: ${tier.fallback ?? 'none'}`} variant="secondary" onPress={noop}>
            {tier.fallback ?? 'none'}
          </Button>
        </Box>
      </Box>
    )
  })
  return shell(ui, m, 'Configure Agents', [
    card(ui, m, 'tiers', 'MODEL · FALLBACK', { text: 'press to cycle' }, [
      ...tiers,
      note(ui, 'tiers-note', 'A fallback is used only while its model is unavailable. Moving up a tier after failures is escalation, a separate rule.'),
    ]),
    card(ui, m, 'limits', 'DELEGATION', undefined, [
      toggle(ui, m, 'ar-par', 'Maximum parallel agents', String(g.maxParallelAgents), g.maxParallelAgents > 1, 'A spawn past this is refused.'),
      toggle(ui, m, 'ar-defpar', 'Default parallel agents', String(g.defaultParallelAgents), g.defaultParallelAgents > 1),
      toggle(ui, m, 'ar-submodel', 'Route subagent models', onOff(sub.routeModel), sub.routeModel, `Specialists and: ${sub.routeTypes.join(', ') || 'none'}.`),
      toggle(ui, m, 'ar-subeffort', 'Route subagent effort', onOff(sub.routeEffort), sub.routeEffort),
      toggle(ui, m, 'ar-review', 'Independent review', onOff(g.independentReview && g.reviewMode !== 'off'), g.independentReview && g.reviewMode !== 'off', 'Fresh-context, read-only, for high-risk work.'),
    ]),
  ])
}

// ------------------------------------------------------------------ activity

const FILTERS: readonly (readonly [ViewState['filter'], string])[] = [
  ['all', 'All'],
  ['tools', 'Tools'],
  ['agents', 'Agents'],
  ['routing', 'Routing'],
  ['errors', 'Errors'],
]

function matches(event: ActivityEvent, filter: ViewState['filter']): boolean {
  switch (filter) {
    case 'tools':
      return event.kind === 'tool'
    case 'agents':
      return event.kind === 'agent'
    case 'routing':
      return event.kind === 'route' || event.kind === 'model' || event.kind === 'guard' || event.kind === 'config'
    case 'errors':
      return event.status === 'ERR' || event.status === 'BLOCKED'
    default:
      return true
  }
}

function activityView(ui: PaneUi, m: PaneModel): RenderElement {
  const { Box, Text, Button } = ui
  const size = isDock(m) ? 12 : 6
  const events = merged(m).filter(event => matches(event, m.view.filter))
  const pages = Math.max(1, Math.ceil(events.length / size))
  const page = Math.min(m.view.page, pages - 1)
  const shown = events.slice(page * size, page * size + size)
  const room = Math.max(20, m.cols - 4)
  const rows = shown.map(event => (
    <Box key={`event-${event.id}`} flexDirection="column">
      <Text size="footnote" color={statusColor(event.status)} wrap="truncate-end">
        {cut(eventText(event), room)}
      </Text>
      {isDock(m) ? (
        <Text dimColor size="caption" wrap="truncate-end">
          {cut(
            [
              event.kind,
              event.cat,
              event.ms === undefined ? undefined : `${event.ms} ms`,
              event.turnId === undefined ? undefined : `turn ${event.turnId.slice(0, 8)}`,
              event.agentId === undefined ? undefined : `agent ${event.agentId.slice(0, 8)}`,
              event.toolUseId === undefined ? undefined : `call ${event.toolUseId.slice(-8)}`,
            ]
              .filter(Boolean)
              .join(' · '),
            room,
          )}
        </Text>
      ) : null}
    </Box>
  ))
  const pager: ButtonSpec[] = []
  if (page > 0) pager.push({ key: 'ar-newer', label: 'Newer events', text: 'Newer' })
  if (page < pages - 1) pager.push({ key: 'ar-older', label: 'Older events', text: 'Older' })
  pager.push({ key: 'ar-clear', label: 'Clear Activity', text: 'Clear' })
  return shell(ui, m, 'Live Activity', [
    <Box key="filters" flexDirection="row" columnGap={2} rowGap={1} paddingX={1} marginTop={1} flexWrap="wrap">
      {FILTERS.map(([id, label]) => (
        <Button key={`ar-f-${id}`} label={`Show ${label}`} variant={m.view.filter === id ? 'primary' : 'secondary'} onPress={noop}>
          {label}
        </Button>
      ))}
    </Box>,
    card(ui, m, 'events', 'EVENTS', { text: `${events.length} · page ${page + 1} of ${pages}` }, [
      ...(rows.length > 0 ? rows : [note(ui, 'none', 'Nothing to show.')]),
      buttons(ui, 'pager', pager),
    ]),
    <Box key="privacy" paddingX={1} marginTop={1}>
      {note(ui, 'privacy-text', `Sanitized metadata only${m.config.telemetry.redactSecrets ? ', secrets masked' : ''}. Up to ${m.config.telemetry.maxEvents} events, this session.`)}
    </Box>,
  ])
}

// --------------------------------------------------------------------- usage

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** `2026-11-13` as `Fri 13`. */
function dayLabel(key: string): string {
  const [y, mo, d] = key.split('-').map(Number)
  if (y === undefined || mo === undefined || d === undefined) return key
  return `${DAY_NAMES[new Date(y, mo - 1, d).getDay()] ?? ''} ${String(d).padStart(2, '0')}`
}

function savedColor(saving: Saving | undefined): string | undefined {
  if (saving === undefined || saving.saved === 0) return undefined
  return saving.saved > 0 ? GOOD : WARN
}

/** A saving in words. A negative one is said as what it is: more was spent, on stronger models. */
function savedText(saving: Saving | undefined): string {
  if (saving === undefined) return UNAVAILABLE
  if (saving.saved < 0) return `${fmtUsd(-saving.saved)} more spent · stronger models used`
  return saving.percent === undefined ? `${fmtUsd(saving.saved)} saved` : `${fmtUsd(saving.saved)} saved · ${fmtPercent(saving.percent)}`
}

function tokenLine(totals: Totals): string {
  return `in ${fmtTokens(totals.in)} · out ${fmtTokens(totals.out)} · cache read ${fmtTokens(totals.cr)} · write ${fmtTokens(totals.cw)}`
}

/** The week as one bar per day, scaled to the largest day; a day with nothing to show says so. */
function savingsChart(ui: PaneUi, m: PaneModel, week: readonly [string, DayUsage][]): RenderElement[] {
  const { Box, Text } = ui
  const each = week.map(([key, day]) => ({ key, day, saving: savingOf([day], m.config) }))
  const peak = Math.max(0, ...each.map(one => Math.abs(one.saving?.saved ?? 0)))
  const width = Math.max(6, Math.min(24, m.cols - LABEL - 16))
  return each.map(({ key, day, saving }) => {
    const hasUsage = Object.keys(day.actual).length > 0
    const value = saving === undefined ? (hasUsage || day.skipped > 0 ? UNAVAILABLE : 'no usage') : fmtUsd(saving.saved)
    const filled = saving === undefined || peak === 0 ? 0 : Math.max(saving.saved === 0 ? 0 : 1, Math.round((Math.abs(saving.saved) / peak) * width))
    return (
      <Box key={`bar-${key}`} flexDirection="row" gap={1}>
        <Box width={LABEL}>
          <Text dimColor size="footnote">
            {dayLabel(key)}
          </Text>
        </Box>
        <Box flexDirection="row">
          {filled > 0 ? (
            <Text size="footnote" color={savedColor(saving)}>
              {'━'.repeat(filled)}
            </Text>
          ) : null}
          {filled < width ? (
            <Text size="footnote" dimColor>
              {'─'.repeat(width - filled)}
            </Text>
          ) : null}
        </Box>
        <Text size="footnote" tabular dimColor={saving === undefined} color={savedColor(saving)}>
          {value}
        </Text>
      </Box>
    )
  })
}

function usageView(ui: PaneUi, m: PaneModel): RenderElement {
  const { Box } = ui
  const usage = m.usage
  const models = Object.entries(usage.byModel).sort((a, b) => b[1].in + b[1].out + b[1].cr - (a[1].in + a[1].out + a[1].cr))
  const agents = Object.entries(usage.byAgent)
  const all = sumTotals(usage.byModel)
  const weekly = usage.weekly
  const credits = fableCredits(usage.rateLimits)
  const others = (usage.rateLimits ?? []).filter(limit => limit.kind !== 'seven_day' && limit.kind !== 'five_hour' && limit !== credits)
  const context = usage.context

  const sessionCost = costOfMap(usage.byModel, m.config)
  const series = usage.series?.days
  const today = series?.[dayKey(m.now)]
  const week = series === undefined ? [] : lastDays(series, 7)
  const month = series === undefined ? [] : lastDays(series, 30)
  const keepsMonth = m.config.telemetry.historyDays >= 30
  const savedSession = savingOf(sessionDays(usage), m.config)
  const savedToday = today === undefined ? undefined : savingOf([today], m.config)
  const savedWeek = savingOf(week.map(([, day]) => day), m.config)
  const savedMonth = keepsMonth ? savingOf(month.map(([, day]) => day), m.config) : undefined
  const readAt = usage.series === undefined ? 'history not read yet' : `history read ${fmtClock(usage.series.computedAt)}`

  return shell(ui, m, undefined, [
    card(ui, m, 'overview', 'USAGE OVERVIEW', { text: 'this session · API-reported' }, [
      kv(ui, m, 'req', 'Requests', String(all.req)),
      kv(ui, m, 'in', 'Input', `${fmtTokens(all.in)} uncached`),
      kv(ui, m, 'cr', 'Cache read', fmtTokens(all.cr)),
      kv(ui, m, 'cw', 'Cache write', fmtTokens(all.cw)),
      kv(ui, m, 'out', 'Output', fmtTokens(all.out)),
      kv(ui, m, 'total', 'Total tokens', fmtTokens(all.in + all.out + all.cr + all.cw)),
      kv(ui, m, 'hit', 'Cache hit', hitText(all)),
    ]),
    card(ui, m, 'plan', 'PLAN LIMITS', { text: 'engine-reported' }, [
      limitMeter(ui, m, 'weekly', 'Weekly', 'seven_day'),
      limitMeter(ui, m, 'five', '5-hour', 'five_hour'),
      context?.percent === undefined
        ? kv(ui, m, 'context', 'Context', UNAVAILABLE)
        : meter(ui, m, 'context', 'Context', context.percent, `${fmtTokens(context.tokens)} of ${fmtTokens(context.window)} · context window, not plan usage`),
      ...others.map(limit => meter(ui, m, `limit-${limit.kind}`, cut(limitLabel(limit.kind), LABEL), limit.percentUsed, limit.resetsAt === undefined ? undefined : `resets ${fmtWhen(limit.resetsAt)}`)),
      credits === undefined ? kv(ui, m, 'fable', 'Fable', `credits ${UNAVAILABLE}`) : meter(ui, m, 'fable', 'Fable', credits.percentUsed, 'usage credits'),
    ]),
    card(ui, m, 'cost', 'COST BREAKDOWN', { text: 'this session' }, [
      kv(ui, m, 'cost-total', 'Total cost', all.req === 0 ? UNAVAILABLE : `${fmtUsd(sessionCost)} estimate at list prices`),
      kv(ui, m, 'cost-ledger', 'Engine ledger', usage.costUsd === undefined ? UNAVAILABLE : `$${usage.costUsd.toFixed(4)} reported`),
      section(ui, 'sec-cost-model', 'BY MODEL'),
      ...(models.length > 0 ? models.map(([model, totals]) => pair(ui, m, `cost-model-${model}`, modelShort(model), fmtUsd(costOf(model, totals, m.config)))) : [note(ui, 'cost-none', 'No model response recorded yet.')]),
      section(ui, 'sec-cost-agent', 'BY AGENT'),
      ...(agents.length > 0
        ? agents.map(([agent, totals]) => {
            const split = usage.byAgentModel?.[agent]
            return pair(ui, m, `cost-agent-${agent}`, agent.replace('auto-router:', ''), fmtUsd(split === undefined ? undefined : costOfMap(split, m.config)), `${modelShort(totals.model)} · in ${fmtTokens(totals.in)} · out ${fmtTokens(totals.out)} · ${totals.req} req`)
          })
        : [note(ui, 'cost-agent-none', 'No agent has answered yet.')]),
    ]),
    card(ui, m, 'savings', 'SAVINGS', { text: 'estimate' }, [
      kv(ui, m, 'save-session', 'This session', savedText(savedSession), savedColor(savedSession)),
      kv(ui, m, 'save-day', 'Daily', savedText(savedToday), savedColor(savedToday)),
      kv(ui, m, 'save-week', 'Weekly', savedText(savedWeek), savedColor(savedWeek)),
      kv(ui, m, 'save-month', 'Monthly', savedText(savedMonth), savedColor(savedMonth)),
      keepsMonth ? null : note(ui, 'save-month-note', `Monthly needs 30 days of history; telemetry.historyDays keeps ${m.config.telemetry.historyDays}.`),
      note(ui, 'save-read', `Daily, weekly and monthly come from this machine's history file (${readAt}).`),
    ]),
    card(ui, m, 'week', 'WEEKLY SAVINGS', { text: 'last 7 days' }, [
      kv(ui, m, 'week-saved', 'Saved', savedWeek === undefined ? UNAVAILABLE : fmtUsd(savedWeek.saved), savedColor(savedWeek)),
      kv(ui, m, 'week-pct', 'Percentage', savedWeek?.percent === undefined ? UNAVAILABLE : fmtPercent(savedWeek.percent), savedColor(savedWeek)),
      kv(ui, m, 'week-actual', 'Actual cost', savedWeek === undefined ? UNAVAILABLE : `${fmtUsd(savedWeek.actual)} estimated API cost · ${savedWeek.requests} requests`),
      kv(ui, m, 'week-base', 'Unoptimised', savedWeek === undefined ? UNAVAILABLE : `${fmtUsd(savedWeek.baseline)} without Auto Router`),
      section(ui, 'sec-chart', 'SAVED PER DAY'),
      ...(week.length > 0 ? savingsChart(ui, m, week) : [note(ui, 'chart-none', UNAVAILABLE)]),
      savedWeek !== undefined && savedWeek.skipped > 0 ? note(ui, 'week-skipped', `Left out: ${savedWeek.skipped} session-days recorded before savings were tracked.`, WARN) : null,
      note(ui, 'week-how', 'Baseline: the same reported tokens priced on the model Claude Code would have used with no router. Both sides use the list prices in costModel. An estimate, not a bill; a figure that cannot be worked out reads Unavailable.'),
    ]),
    card(ui, m, 'models', 'MODEL USAGE', { text: `${models.length} this session` }, [
      ...(models.length > 0 ? models.map(([model, totals]) => pair(ui, m, `model-${model}`, modelShort(model), `${totals.req} req`, tokenLine(totals))) : [note(ui, 'none', 'No model response recorded yet.')]),
      section(ui, 'sec-history', 'LAST 7 DAYS · THIS MACHINE', weekly === undefined ? undefined : `${weekly.sessions} sessions`),
      ...(weekly === undefined
        ? [note(ui, 'no-history', 'No history read yet.')]
        : Object.entries(weekly.byModel).map(([model, totals]) => pair(ui, m, `history-${model}`, modelShort(model), `${totals.req} req`, tokenLine(totals)))),
      usage.flushError === undefined ? null : note(ui, 'flush', usage.flushError, WARN),
      buttons(ui, 'usage-actions', [
        { key: 'ar-refresh-usage', label: 'Refresh usage history', text: 'Refresh' },
        { key: 'ar-budget', label: 'Change Budget Profile', text: `Profile: ${m.config.budgetMode}` },
      ]),
    ]),
    <Box key="honest" paddingX={1} marginTop={1}>
      {note(ui, 'honest-text', 'Tokens and plan limits are as the engine reported them. Costs and savings are estimates from those tokens.')}
    </Box>,
  ])
}

// -------------------------------------------------------------------- safety

function guardrailsView(ui: PaneUi, m: PaneModel): RenderElement {
  const g = m.config.guardrails
  const core = m.core
  const floors = m.config.riskFloors
  const floor = (key: string, label: string, one: { minTier: AgentKey; minEffort: string }): RenderElement =>
    kv(ui, m, key, label, `${AGENT_DEFS[one.minTier].title} · ${m.config.tiers[one.minTier].model} · ${one.minEffort}`)
  const guards = merged(m).filter(event => event.kind === 'guard').slice(0, 4)
  const isReviewOn = g.independentReview && g.reviewMode !== 'off'
  return shell(ui, m, undefined, [
    card(ui, m, 'pause', 'PAUSE GATE', core.paused ? { text: '● PAUSED', color: WARN } : { text: '● RUNNING', color: GOOD }, [
      toggle(ui, m, core.paused ? 'ar-resume' : 'ar-pause', core.paused ? `Paused · ${core.blockedCount} tool calls blocked` : 'Tool calls run', core.paused ? 'Resume' : 'Pause', core.paused),
      note(ui, 'pause-hint', 'Pause refuses each new tool call. It does not stop a running command or undo finished work.'),
    ]),
    card(ui, m, 'now', 'THIS TASK', undefined, [
      kv(ui, m, 'risk', 'Risk', core.risk, riskColor(core.risk)),
      kv(ui, m, 'review-now', 'Review', reviewWord(core), core.route?.review === 'missed' ? WARN : undefined),
      kv(ui, m, 'esc-now', 'Escalation', core.escalation, core.escalation === 'none' ? undefined : WARN, true),
    ]),
    card(ui, m, 'controls', 'CONTROLS', undefined, [
      toggle(ui, m, 'ar-destructive', 'Confirm destructive commands', onOff(g.confirmDestructive), g.confirmDestructive, 'Asks first. Only ever tightens.'),
      toggle(ui, m, 'ar-review', 'Independent review', onOff(isReviewOn), isReviewOn, 'Fresh-context, read-only, for high-risk work.'),
      note(ui, 'perm', 'Claude Code decides permissions. The router never approves a call and never bypasses a rule.'),
    ]),
    card(ui, m, 'floors', 'RISK FLOORS', { text: 'never lowered' }, [
      floor('f1', 'Security', floors.securitySensitive),
      floor('f2', 'High risk', floors.highImpact),
      floor('f3', 'Critical', floors.criticalImpact),
      floor('f4', 'Vague+risk', floors.ambiguousHighRisk),
      floor('f5', 'Unsure', floors.uncertain),
    ]),
    card(ui, m, 'rules', 'RULES', undefined, [
      kv(ui, m, 'esc-rule', 'Escalate', `after ${g.autoEscalateAfterFailures} failures, one tier up · max ${g.maxEscalationsPerTask} per task`, undefined, true),
      kv(ui, m, 'repeat', 'Retries', `same failing call called out at ${g.identicalFailureLimit}`),
      kv(ui, m, 'env', 'Env errors', 'never escalate'),
    ]),
    card(ui, m, 'recent', 'GUARD EVENTS', { text: String(guards.length) }, guards.length > 0
      ? guards.map(event => kv(ui, m, `guard-${event.id}`, fmtClock(event.t), `${event.status} · ${event.label}`, statusColor(event.status)))
      : [note(ui, 'none', 'None.')]),
  ])
}

// -------------------------------------------------------------------- config

function configView(ui: PaneUi, m: PaneModel): RenderElement {
  const { Box, Text } = ui
  const isValid = m.core.configError === undefined
  return shell(ui, m, undefined, [
    card(ui, m, 'file', 'FILE', isValid ? { text: '● valid', color: GOOD } : { text: '● problem', color: BAD }, [
      <Text key="path" size="footnote" wrap="truncate-middle">
        {m.configPath}
      </Text>,
      isValid ? null : note(ui, 'bad', `${m.core.configError ?? ''}. The last valid configuration is in use.`, BAD),
      buttons(ui, 'file-actions', [
        { key: 'ar-openfile', label: 'Open config.json', text: 'Open' },
        { key: 'ar-reload', label: 'Reload Configuration', text: 'Reload' },
        { key: 'ar-reopen', label: 'Reopen Panel', text: m.isPanelHidden ? 'Reopen panel' : 'Reopen' },
      ]),
    ]),
    card(ui, m, 'effective', 'EFFECTIVE', undefined, configLines(m.config).map((text, index) => (
      <Text key={`cfg-${index}`} size="caption" dimColor wrap="wrap">
        {text}
      </Text>
    ))),
    m.core.conflicts.length === 0
      ? null
      : card(ui, m, 'conflicts', 'OTHER ROUTERS', { text: 'conflict', color: WARN }, [
          toggle(ui, m, 'ar-fix-conflict', 'Other routing mods', 'Turn off', false, 'Writes their own switches in ~/.claude/mods/switches.json.'),
        ]),
    <Box key="how" paddingX={1} marginTop={1}>
      {note(ui, 'how-text', 'Each change is validated, backed up and written in one step. Or ask in words: /auto-router config switch to economical mode')}
    </Box>,
  ])
}

/**
 * The minimized pane: what reads at a glance, with nothing to press, since a
 * click may not reach a widget.
 */
function glance(ui: PaneUi, m: PaneModel): RenderElement {
  const { Box, Text } = ui
  const route = m.core.route
  const isObserving = m.core.session.passive !== undefined || !m.config.autonomous
  const state = m.core.paused ? 'paused' : !m.config.enabled ? 'off' : isObserving ? 'observing' : 'on'
  const color = m.core.paused ? WARN : state === 'on' ? GOOD : undefined
  const running =
    route === undefined
      ? 'No task yet'
      : `${route.sentModel ?? route.alias ?? 'session model'} · ${route.sentEffort ?? route.effort ?? 'session effort'}`
  const room = Math.max(16, m.cols - 2)
  return (
    <Box key="glance" flexDirection="column" paddingX={1}>
      <Box flexDirection="row" gap={1}>
        <Text size="caption" weight="semibold">
          Auto Router
        </Text>
        <Text size="caption" weight="semibold" color={color} dimColor={color === undefined}>
          {state}
        </Text>
      </Box>
      <Text size="footnote" wrap="truncate-end">
        {cut(running, room)}
      </Text>
      {route === undefined ? null : (
        <Text key="glance-task" dimColor size="footnote" wrap="truncate-end">
          {cut(`${route.status} · risk ${m.core.risk} · ${route.title}`, room)}
        </Text>
      )}
      {m.core.escalation === 'none' ? null : (
        <Text key="glance-up" size="footnote" color={WARN} wrap="truncate-end">
          {cut(m.core.escalation, room)}
        </Text>
      )}
    </Box>
  )
}

/** The pane's whole drawing for one view. */
export function renderPane(ui: PaneUi, m: PaneModel): RenderElement {
  if (m.placement === 'widget') return glance(ui, m)
  switch (m.view.view) {
    case 'settings':
      return settingsView(ui, m)
    case 'agents':
      return agentsView(ui, m)
    case 'agents-config':
      return agentsConfigView(ui, m)
    case 'activity':
      return activityView(ui, m)
    case 'usage':
      return usageView(ui, m)
    case 'guardrails':
      return guardrailsView(ui, m)
    case 'config':
      return configView(ui, m)
    default:
      return home(ui, m)
  }
}
