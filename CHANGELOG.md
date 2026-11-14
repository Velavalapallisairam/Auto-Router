# Changelog

## 1.2.0 (2026-11-14)

- Home shows the task as labelled fields: task, task rating, the lead model, supporting agents, execution order and final result. The Status card is gone; plan limits are on Usage and the pause gate on Safety.
- Home lists ten activity events instead of four.
- Agents draws each model as its own shaded, animated character. Only the model whose state changes plays a transition.
- Usage has six sections, with cost by model and agent and savings by day, week and month. Savings compare reported tokens with the model Claude Code would have used with no router, and read Unavailable where that cannot be worked out.
- One set of parts and spacing across all five tabs.

## 1.1.0 (2026-11-14)

- A reported miss ("that is wrong", "try again") steps the task up: effort first, then the model.
- The judge is shown the start of the last answer and names each prompt a task, a follow-up or a failure.
- Routed subagents whose call named no model are judged by meaning (`judge.subagents`).
- A slash command's turn is left to the session's own model and effort.
- Two prompts typed over a running turn keep the stronger plan.
- The minimized pane draws a short glance view.
- Haiku's long-prompt price is counted when weighing a move down.
- The model-selector mod is detected as a second router.

## 1.0.0 (2026-11-14)

- First release: local classification, the semantic judge, four specialist tiers and an independent reviewer, risk floors, cache-aware switching, escalation after failures, per-kind learning, the pause gate, the dashboard and `/auto-router`.
