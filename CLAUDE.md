# nightshift

A live "flight recorder" for AI agent sessions: a kanban board + replay timeline
rendered from an append-only event log. This project observes agent sessions —
including the ones building it.

## Architecture invariants (do not break these)

1. **The event log is the contract.** `docs/EVENTS.md` is the source of truth.
   Server, UI, hooks, and importers are all producers or pure consumers of
   JSONL events. New features start by asking "what event is this?"
2. **The reducer is pure.** UI state is `reduce(events[0..t])`. Never fetch
   external state (CI, PR status, GitHub) at render time — record it as an
   event. This is what makes replay work; breaking it breaks time travel.
3. **Zero dependencies, no build step.** Plain Node ≥18 for the server, vanilla
   ES modules for the UI. `git clone && npm run demo` must always work offline
   (fonts may degrade gracefully). If a feature seems to need a dependency,
   redesign the feature.
4. **Facts come from hooks, intent comes from the model.** Commits, edits, CI
   are emitted deterministically (git hooks, Claude Code hooks). Work items and
   notes are emitted by the agent on purpose. Never make the model responsible
   for facts — it forgets; hooks don't.

## Layout

- `server.js` — zero-dep static + SSE server; tails the log, broadcasts
  appends; `POST /event` appends (stamps `t` if missing).
- `public/` — the board. `reducer.js` (pure fold), `app.js` (render, FLIP
  animations, tickers, replay engine), `style.css`, `index.html`.
- `hooks/claude-hook.js` — single entrypoint for all Claude Code hooks; routes
  on `hook_event_name`. Must never crash or block: always exit 0, fail silent.
- `.githooks/post-commit` — emits `commit` events with shortstat numbers.
  Enabled by `npm run setup` (sets `core.hooksPath`).
- `tools/emit.js` — append an event from the CLI; used by the agent (see below)
  and humans.
- `tools/import-transcript.js` — synthesize a tape from a past Claude Code
  transcript; `--repo` sources commit facts from `git log`, not model output.
- `tools/attach.js` — one-command wiring into another project: vendors the
  hook kit into `<target>/.nightshift/`, merges `.claude/settings.json`,
  installs the git hook. Idempotent.
- `tools/poll-github.js` — records PR/CI facts as events via gh; folds the
  log's known state each tick and appends only deltas (stateless, idempotent).
- `demo/generate.js` — synthesizes a realistic session log for demos and UI work.

## Commands

- `npm run demo` — generate demo log, serve board at http://localhost:4173
- `npm start` — serve the live dogfood log (`.nightshift/events.jsonl`)
- `npm run setup` — enable the git post-commit hook (once per clone)

## Dogfooding protocol (for the agent working in this repo)

This repo watches itself. Claude Code hooks in `.claude/settings.json` emit
`edit`/`todos`/`session` events automatically. What hooks can't know is intent,
so you (the agent) maintain the work-item layer:

- When you start a distinct piece of work, register it:
  `node tools/emit.js item --id <slug> --title "..." --status doing`
- Move it as it progresses: `--status pr` when a PR opens, `--status done` when
  it lands. One item ≈ one PR-sized deliverable, not one todo.
- Mark milestones worth remembering with
  `node tools/emit.js note --text "..."` (sparingly — it's a recorder, not chat).
- At the start of a turn, if the UserPromptSubmit hook reports inbox cards,
  treat them as work requests from the human: acknowledge by moving the card to
  `doing` (or leave it and say why).

## Style

- Vanilla JS, ES modules, no semicolons-vs-semicolons debates: match existing
  files (semicolons yes, 2-space indent).
- The UI follows Linear's visual language (per Anton's direction): flat
  near-black, quiet hairlines, Inter for UI text with IBM Plex Mono reserved
  for numbers/ids/log lines, status-icon column headers, pill badges with
  progress rings. No gradients, no glow, no serif, no frameworks. Motion =
  data changing, never decoration.
- Commit messages: imperative, scoped (`server:`, `ui:`, `hooks:`, `demo:`,
  `docs:`). Commit and push as you go.
