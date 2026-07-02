# nightshift

A live "flight recorder" for AI agent sessions: a kanban board + replay timeline
rendered from an append-only event log. This project observes agent sessions —
including the ones building it.

## Architecture invariants (do not break these)

1. **The event log is the contract.** `docs/EVENTS.md` is the source of truth.
   Server, UI, hooks, and importers are all producers or pure consumers of
   JSONL events. New features start by asking "what event is this?" Every event
   carries an envelope-v2 stamp `{id, source, v:2}` (unique id, producer name);
   v1 events without it stay valid forever (see EVENTS.md "Envelope v2").
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
  appends; `POST /event` appends (stamps `t` if missing). Serves multiple
  sessions via repeated `--log` or `--dir`; `GET /sessions` lists them and
  `/sse?session=` / `/event?session=` scope to one. **Owns PR reconciliation:**
  for any session a viewer is actually looking at that still has an open PR, it
  runs `poll-github --once` (on SSE connect + every 30s) with cwd = the session's
  repo, so merged PRs flip to merged within seconds of opening the board. This
  is the durable fix for "merged PR stuck showing open": freshness is tied to the
  board being up, NOT to a separate detached poller surviving a laptop restart /
  crash / self-retirement. And "the board being up" is no longer left to luck — a
  LaunchAgent (`tools/install-launchd.js`) supervises the board across restarts,
  crashes, and logout, and in supervised (`--managed`) mode the server owns
  `~/.nightshift/board.json` itself so nothing points at a dead pid. Still
  pure — the server records events, never renders fetched state.
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
- `tools/install-global.js` — one-time setup for on-demand recording: registers
  gated hooks in *global* `~/.claude/settings.json`, installs the `/nightshift`
  skill to `~/.claude/skills/`, writes `~/.nightshift/install.json`. Recording
  is opt-in **per session**: `/nightshift` creates `~/.nightshift/active/<sid>`
  and the hooks record only marked sessions. The shell pre-gate spawns node only
  when a session is recording; `claude-hook.js`'s `recording()` makes the
  authoritative per-session decision from the payload's `session_id`. Events go
  to central per-project logs under `~/.nightshift/sessions/` (no per-repo files,
  no git config); central mode captures commits from Bash output so attached
  projects aren't double-counted. Under a global install, a stray local
  `.nightshift/` in some OTHER repo is ignored (recording stays central, where the
  board looks) — only the nightshift repo itself records locally. `--remove` undoes it all.
- `skills/nightshift/SKILL.md` — the `/nightshift` skill (symlinked into
  `~/.claude/skills/` by the installer, so repo edits are live without a
  reinstall): toggles the per-session marker, emits the opening event, opens the
  board.
- `tools/resolve-log.js` — prints the log path `claude-hook.js` would use for the
  cwd, so the skill emits to / tails the right file.
- `tools/board.js` — ensures one board server is running (serving
  `~/.nightshift/sessions`), reused across sessions via `~/.nightshift/board.json`;
  prints the URL and, with `--open`, opens the browser at `?session=<slug>`. Emits
  the portless `http://<host>` URL instead of `localhost:<port>` when a host is
  installed (see below). Detection is robust: it reuses a board only when the
  recorded pid is alive AND `/whoami` confirms our sessions dir — so it finds the
  supervised (`--managed`) board and never spawns a rival, and ignores a stale
  `board.json` left by a dead process.
- `tools/install-launchd.js` — supervision (`--install` / `--remove` / `--status`).
  Installs `~/Library/LaunchAgents/com.nightshift.board.plist` (RunAtLoad +
  KeepAlive) running the board in the FOREGROUND — `node server.js --dir <sessions>
  --port 4173 --managed` — with the node binary resolved to an absolute path (launchd
  has a bare PATH) and logs to `~/.nightshift/logs/board.{out,err}.log`. Idempotent
  (`launchctl bootout`+`bootstrap`, legacy `unload`/`load` fallback). If portless is
  on PATH and supports a foreground run (`portless proxy start --foreground`), a
  second agent (`com.nightshift.portless`) keeps the proxy alive too; if not, it
  says so and skips (no hacks). Handles a busy port at install: `--stop-existing`
  stops an old *nightshift* board (verified via `/whoami`) after which KeepAlive
  takes over, else it notes the takeover-on-exit. This is why the board stopped
  dying on every laptop restart.
- `tools/install-host.js` + `tools/forward80.js` — optional portless URL.
  `sudo node tools/install-host.js` maps `nightshift.local` → loopback in
  `/etc/hosts` and installs a root LaunchDaemon (`com.nightshift.proxy`) running
  `forward80.js`, which forwards `127.0.0.1:80` → the board's live port (read from
  `board.json` per connection, so it follows restarts). A forwarder — not the
  board on :80 — so the board stays unprivileged and keeps owning its log writes
  (root writing logs would lock out the user-level hooks). Records `host` in
  `install.json`; `--remove` reverses /etc/hosts, the daemon, and the flag.
- `hooks/agent-hook.js` — single hook entrypoint for BOTH agents. Codex
  implements Claude's hook contract (`~/.codex/hooks.json`; payload carries
  `session_id`, `transcript_path`, `cwd`, normalized `tool_name`), so recording
  is hook-based for both. `hooks/claude-hook.js` is a back-compat shim requiring
  it. Synthesizes per-turn cards from `UserPromptSubmit` (Codex always, Claude
  everywhere except the nightshift repo itself, which self-curates via emit.js —
  central or locally-attached) — skipping harness-injected turns like `<task-notification>`
  so they don't litter the board; maps `apply_patch`→edit, `update_plan`→todos,
  `TodoWrite`→todos, `Bash`→commit/activity and `gh pr create|merge`→`pr_ref` (a
  sighting — never pr state; the poller is the single writer, plan 1.4). Claude's
  newer task tools (`TaskCreate`/`TaskUpdate`) live only in the transcript and
  aren't in the hook matcher, so on every firing tool the hook tails the transcript
  (by byte offset) and folds the task list into `todos` snapshots — live without a
  restart. Fail-open.
- `tools/tasks-fold.js` — shared reconstruction of Claude's task list from
  transcript lines (incremental `TaskCreate`/`TaskUpdate`/delete → full `todos`
  snapshot); used by both the hook (tail) and the backfill (full replay).
- `tools/backfill-tasks.js` — at `/nightshift` start, replays the session
  transcript once to seed the task state (and the offset the hook tails from) and
  emit the current plan, so a session that had tasks before recording shows them.
- `tools/install-codex.js` — Codex counterpart of the global install: symlinks
  the (shared) `/nightshift` skill into `~/.codex/skills/` and registers
  `agent-hook.js` in `~/.codex/hooks.json` behind a per-session pre-gate
  (`$CODEX_THREAD_ID` marker), merged append-only (Codex keys hook trust by
  index) and backed up.
- `tools/codex-tail.js` — the rollout tailer. In `--meter` mode it's the thin
  companion to hook recording: emits ONLY what hooks can't carry (token cost,
  `pr_ref` sightings — never pr/ci state, which is the poller's alone per plan 1.4 —
  idle + card retirement), so the two never double-count. Full mode is
  retained for `import-transcript` parity and as a fallback. Self-detaches; the
  worker registry (`~/.nightshift/codex-tails.json`) is keyed by **rollout path**,
  so exactly one recorder tails a rollout — a second `/nightshift` (e.g. from
  another worktree resolving a different log) is a no-op, never a duplicate
  recorder (duplicates fanned one session into 15 identical tapes). It attaches to
  **this** session's rollout by id (`$CODEX_THREAD_ID`), never "newest in the dir",
  and refuses rather than guess when nothing matches — so a worktree session
  records its OWN cwd and tape. `--stop` ends it (a scoped `--stop --log` pauses and
  keeps the resume checkpoint); it follows rotation within the same session id and
  resumes on restart. On re-attach with a lost checkpoint but a log that already
  holds this session, it resumes from the log instead of re-draining from zero (the
  n154 double-record).
- `tools/poll-github.js` — the **SOLE writer of `pr`/`ci` events (plan 1.4)**; folds
  the log's known state each tick and appends only deltas (stateless, idempotent).
  CI/review status comes from **toast review-ci** (Orba's CI — fast, authoritative)
  when installed, falling back to gh's check rollup; PR metadata (title/url/state)
  is from gh. Each `pr` event carries `repo` (owner/name, one `gh repo view` per run)
  so the board keys panel rows by `repo#number`, and gh's real `occurredAt`/
  `createdAt` so replay shows a 2am merge at 2am. `--known` polls only the PRs the
  tape itself surfaced — chiefly the `pr_ref` sightings the hook/tailer now emit,
  plus a legacy text-scan (PR URLs, `#N` in card titles, `gh pr` commands) for old
  tapes — instead of the whole repo, so one session's
  board isn't flooded by a repo's hundreds of PRs, AND only the non-terminal ones
  (a merged/closed PR never changes again, so re-polling it is waste — and over a
  long session the surfaced set grows to dozens, which made a reconcile take
  minutes). In `--known` mode it self-detaches ONE realtime worker per log
  (`--stop`/`--status` manage it; it retires itself once every surfaced PR is
  merged/closed). `server.js` is now the primary driver (it runs `--once` for
  watched sessions, see above); the realtime worker is a redundant low-latency
  optimization the `/nightshift` skill still starts and that dies on restart —
  harmless, since both are idempotent (delta-only over the folded log).
  **PR state (open/merged/closed) is only ever recorded here, from authoritative gh
  output** — never inferred from the agent's prose (that false-merged #404) nor from
  the hook/tailer, which now emit only `pr_ref` sightings (a PR is relevant to this
  session) and never `pr` state. The reducer ignores a v2 `pr` from any other
  source; v1 events stay honored for back-compat.
- `tools/prune-sessions.js` — keeps the board's session list bounded: archives
  (moves to `~/.nightshift/archive/`, reversible) or `--delete`s tapes untouched
  for `--days N` (default 14; freshness = file mtime). `--dry-run` previews. The
  server reconciles removals on its `--dir` rescan, so a prune reflects on the
  board within seconds without a restart. Run it when the switcher gets long.
- `tools/tape-doctor.js` — offline tape repair (zero deps, dry-run by default,
  writes a `.bak` before applying, NEVER touches `~/.nightshift` on its own).
  `--dedupe` removes re-append duplicates (the n154 corruption) and reports
  backward-time seams; `--sort` reorders by `t`; `--retract-junk` appends
  `retract` events for harness-injected cards; `--collapse-dupes <dir>` moves
  near-identical fleet copies of one session to an archive dir (never deletes).
- `demo/generate.js` — synthesizes a realistic session log for demos and UI work.

## Session switcher

A fleet board can serve dozens of tapes, so the masthead switcher is a filterable
popover (`#session-picker`), not a native `<select>`. Rows are labeled by the
WORKTREE (the slug's suffix), because parallel Codex agents all record cwd = the
main repo and often share a generic title — labeling by title·cwd renders N
identical rows. Freshest first, with a live/recent/stale dot.

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
