# Contributing

Thanks for looking. Bug reports, ideas and pull requests are all welcome.

## Reporting a problem

Open an issue with:

- your Claude Code version (`claude --version`) and where it runs (terminal, desktop app, VS Code);
- what you sent, what the router did, and what you expected;
- the matching lines of `~/.claude/auto-router/logs/router.log`, if there are any.

Check a log or a config file for anything private before you paste it. The router masks credentials in what it logs, but the file is yours to read first.

## Working on the code

Clone the repository and install it from the folder. Claude Code reads it in place:

```bash
git clone https://github.com/Velavalapallisairam/auto-router
claude plugin marketplace add ./auto-router
claude plugin install auto-router@auto-router --scope user
```

Edit a file, run `/reload-plugins` in an open session, and the change is live.

## Checks

Run all three before opening a pull request:

```bash
claude plugin validate .
claude plugin test .
node tests/verify-static.mjs
```

Neither plugin command type-checks. To type-check, write a `tsconfig.json` outside the repository whose `include` names the engine's `claude-code.d.ts` (Claude Code's plugin-authoring skill prints its path and the compiler options) and this repository's `hooks`, `types` and `tests`, add `"allowImportingTsExtensions": true`, and run `tsc -p` on it.

## Rules the code follows

- **The engine modules are pure.** Everything under `hooks/engine/` takes values and returns values. Only `hooks/register.tsx` reads files, the clock or a model.
- **The pane is a pure drawing.** `hooks/ui/pane.tsx` is handed elements and data and returns a tree. A button carries a key; `register.tsx` answers the press.
- **State is declared.** Every value kept in `$.state` is in `types/index.d.ts`. Add a field there first.
- **Nothing is guessed.** A figure the engine did not report, or one that cannot be worked out, reads Unavailable. Estimates are labelled as estimates.
- **Quality floors only tighten.** No setting, profile or learned outcome may lower a risk floor.
- **Telemetry is metadata.** Never log a file's content, a tool's result or a whole prompt. New log text goes through `sanitize.ts`.
- **Every behaviour has a test.** Tests fire mocked events through the real hooks (`tests/helpers.ts`). No test calls a model or touches the disk.

## Pull requests

- Keep one change per pull request.
- Say what changed and why, and how you checked it.
- Update `README.md` and `CHANGELOG.md` when behaviour changes.

By contributing you agree that your work is released under the [MIT License](LICENSE).
