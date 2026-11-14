// Static checks the mod's own tests cannot make, because a test runs with no
// file system: that the five agent files say what the code says they do, and
// that the manifests agree. Run with Node 22.18 or later:
//
//   node tests/verify-static.mjs
//
// Exits 1, naming each mismatch, when anything is out of step.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AGENT_DEFS, MUTATING_TOOLS, READ_ONLY_TOOLS } from '../hooks/engine/agents.ts'
import { CONFIG_SCHEMA, defaultConfig, validateConfig } from '../hooks/engine/config.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const fail = message => problems.push(message)

function frontmatter(path) {
  const text = readFileSync(path, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
  if (match === null) return undefined
  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z]+):\s*(.*)$/.exec(line)
    if (pair !== null) fields[pair[1]] = pair[2].trim()
  }
  return { fields, body: match[2] }
}

const list = value => (value ?? '').split(',').map(one => one.trim()).filter(Boolean)

for (const def of Object.values(AGENT_DEFS)) {
  const path = join(root, 'agents', `${def.name}.md`)
  if (!existsSync(path)) {
    fail(`agents/${def.name}.md is missing`)
    continue
  }
  const parsed = frontmatter(path)
  if (parsed === undefined) {
    fail(`agents/${def.name}.md has no frontmatter`)
    continue
  }
  const { fields, body } = parsed
  const expect = (field, want) => {
    if (fields[field] !== String(want)) fail(`agents/${def.name}.md ${field}: "${fields[field]}", the code says "${want}"`)
  }
  expect('name', def.name)
  expect('model', def.model)
  expect('effort', def.effort)
  expect('maxTurns', def.maxTurns)
  const tools = list(fields.tools)
  if (tools.join(',') !== def.tools.join(',')) fail(`agents/${def.name}.md tools: ${tools.join(', ')}; the code says ${def.tools.join(', ')}`)
  if (tools.includes('Agent') || tools.includes('Task')) fail(`agents/${def.name}.md may start another agent`)
  if ((fields.description ?? '').length < 40) fail(`agents/${def.name}.md description is too short to route by`)
  if (body.trim().length < 200) fail(`agents/${def.name}.md has no real system prompt`)
  for (const banned of ['permissionMode', 'hooks', 'mcpServers']) {
    if (banned in fields) fail(`agents/${def.name}.md sets ${banned}, which a plugin agent may not`)
  }
}

// The reviewer: read-only tools, and the mutating ones withheld by name as well.
{
  const parsed = frontmatter(join(root, 'agents', 'independent-reviewer.md'))
  const tools = list(parsed?.fields.tools)
  const withheld = list(parsed?.fields.disallowedTools)
  for (const tool of tools) if (!READ_ONLY_TOOLS.includes(tool)) fail(`the reviewer holds ${tool}, which is not read-only`)
  for (const tool of MUTATING_TOOLS) if (tools.includes(tool)) fail(`the reviewer holds ${tool}`)
  for (const tool of ['Edit', 'Write', 'Bash', 'Agent']) if (!withheld.includes(tool)) fail(`the reviewer does not withhold ${tool}`)
  if (!/VERDICT: (PASS|CONCERNS|FAIL)/.test(parsed?.body ?? '')) fail('the reviewer prompt does not fix the verdict line the router reads')
}

const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
if (manifest.name !== 'auto-router') fail(`plugin.json name is ${manifest.name}`)
if (manifest.types !== './types/index.d.ts') fail('plugin.json does not name the type contract')
if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? '')) fail('plugin.json version is not semantic')

const hooks = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'))
if (JSON.stringify(hooks.modules) !== '["./register.tsx"]') fail('hooks.json does not name ./register.tsx')

const marketplace = join(root, '.claude-plugin', 'marketplace.json')
if (existsSync(marketplace)) {
  const listed = JSON.parse(readFileSync(marketplace, 'utf8')).plugins?.find(one => one.name === 'auto-router')
  if (listed === undefined) fail('marketplace.json does not list auto-router')
  else if (listed.version !== manifest.version) fail(`marketplace.json lists ${listed.version}, plugin.json says ${manifest.version}`)
}

// The skill is not named after the plugin: a skill `auto-router` in plugin
// `auto-router` answers to /auto-router, the name the mod's own command needs.
const skill = frontmatter(join(root, 'skills', 'routing', 'SKILL.md'))
if (skill?.fields.name !== 'routing') fail('skills/routing/SKILL.md has no name')
if (!(skill?.body ?? '').includes('mcp__auto-router__configure')) fail('the skill does not name the configure tool')
if (existsSync(join(root, 'skills', 'auto-router'))) fail('skills/auto-router would take the /auto-router command name from the mod')

if (!validateConfig(defaultConfig()).isValid) fail('the default configuration does not validate')
if (CONFIG_SCHEMA.additionalProperties !== false) fail('the schema lets unknown settings through')

for (const file of ['README.md', 'types/index.d.ts', 'hooks/register.tsx', 'hooks/ui/pane.tsx']) {
  if (!existsSync(join(root, file))) fail(`${file} is missing`)
}

if (problems.length > 0) {
  console.error(`verify-static: ${problems.length} problem(s)`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`verify-static: ok (${Object.keys(AGENT_DEFS).length} agents, manifests, skill, schema)`)
