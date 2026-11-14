---
name: routing
description: Change or explain the Auto Router's settings and routing. Use when the user asks, in words, to switch budget mode (economical, balanced, quality), change which model a tier or kind of work uses, limit parallel agents, turn the dashboard or independent reviews on or off, restrict Fable to certain areas, or asks why a task was routed to a model.
---

# Auto Router

The Auto Router is a mod that runs by itself. It classifies every request locally, picks the cheapest capable model and effort, routes subagents, and shows it all in the Auto Router pane. Nobody has to invoke this skill for routing to happen. Load it only to change a setting or explain a decision.

## Changing a setting the user asked for in words

Use the mod's own tool. It validates the change against the schema, backs up the previous file, replaces it in one step, and reloads. Never edit `config.json` by hand while the tool is available.

1. The tool is deferred. Load it with ToolSearch: `select:mcp__auto-router__configure`.
2. For a request in the user's words, pass it through:
   `{ "action": "request", "request": "switch to economical mode" }`
3. If that answers "not understood", read the configuration with `{ "action": "get" }` and set exact paths:
   `{ "action": "set", "changes": [{ "path": "budgetMode", "value": "economical" }] }`
4. Report what the tool answered. If it refused the change, say why in its words. Do not retry with a different value the user did not ask for, and do not change any other setting.

| The user says | Path and value |
| --- | --- |
| Switch to economical mode | `budgetMode`: `economical` |
| Use Opus for complex frontend work | append to `routing.overrides`: `{ "domain": "frontend", "complexity": "complex", "model": "opus" }` |
| Limit parallel agents to one | `guardrails.maxParallelAgents`: `1` (and `guardrails.defaultParallelAgents`: `1`) |
| Disable the dashboard | `sidePanel.enabled`: `false`, `sidePanel.autoOpen`: `false` |
| Use Fable only for architecture and security | `routing.headChef`: `{ "domains": ["architecture", "security"], "exceptional": false }` |
| Require independent reviews for high-risk changes | `guardrails.independentReview`: `true`, `guardrails.reviewMode`: `remind` |

A change to a guardrail, a risk floor or the protected sessions is always put to the user for confirmation. That is by design: do not look for a way round it.

If the tool is not available (the mod is not loaded in this session), say so. The user can run `/auto-router config <request>` themselves, or the file can be edited at `~/.claude/auto-router/config.json` against `config.schema.json` in the same folder, after copying the old file into `backups/`.

## Explaining a decision

`/auto-router status` prints the current task's route and the reason. The pane's Router card shows the same. A model line reads "assigned" for what the router asked for and "answered (API)" for what the API reported; only the second is evidence of what ran.

## The kitchen

| Agent | Type | Default model | For |
| --- | --- | --- | --- |
| Head Chef | `auto-router:head-chef` | fable | Complex architecture, security, exceptional reasoning |
| Sous Chef | `auto-router:sous-chef` | opus | Advanced development, debugging, difficult research |
| Line Cook | `auto-router:line-cook` | sonnet | Standard development, testing, routine work |
| Prep Cook | `auto-router:prep-cook` | haiku | Simple searches, summaries, repetitive edits |
| Independent Reviewer | `auto-router:independent-reviewer` | opus | Fresh-context, read-only review |

## Delegation rules

- Keep simple questions, wording fixes, small edits and anything that leans on this conversation in the main session. A subagent starts cold and re-reads what you already know.
- Delegate independent research, an isolated implementation, a complex investigation, or parts that can truly run apart.
- One agent at a time by default. Two at most; a third is refused by the mod.
- For substantial work: inspect, plan, implement, test, review. Not one agent per stage.
- Ask each agent for a short report. Give it the files and the definition of done, not the whole conversation.
- High-risk work gets an independent review before it is called done: give the reviewer the original requirements and the files changed.

## Failure rules

- Two substantive failures (a failing test, a type error, a crash) move the task up one tier; the mod does this and says so beside the error.
- An environment failure (a missing program, a permission, a timeout, the network) is not a reasoning problem. Fix the environment or ask the user.
- Never repeat a failing call unchanged.

## What the router never does

It never approves a tool call, never sets a permission mode, never changes settings.json, and never reports a model as having run without the API saying so.
