# Event Log Schema

The event log is the single contract of nightshift. Everything else — server, UI,
hooks, replay — is a producer or a pure consumer of this log.

- Storage: one JSON object per line (JSONL), append-only. Default location:
  `.nightshift/events.jsonl` in the project being observed.
- The UI state is `reduce(events[0..t])`. Live mode is `t = now`; replay is any
  earlier `t`. This only works if reducers are pure over the log, so:
- **Rule: external facts are recorded as events, never fetched at render time.**
  CI status, PR state, etc. enter the system as appended events. If the UI
  fetched them live, replay would show today's status in yesterday's session.

## Envelope

Every event has:

| field | type | meaning |
|-------|------|---------|
| `t`   | number | epoch milliseconds. Stamped by the producer; the server stamps it on `POST /event` if missing. |
| `type` | string | one of the types below |
| `item` | string? | optional work-item id this event belongs to |

Unknown event types must be ignored by consumers (forward compatibility).

### Envelope v2 — `id`, `source`, `v`

Every event a producer writes now also carries:

| field | type | meaning |
|-------|------|---------|
| `id` | string | a unique per-event identity (`crypto.randomUUID()`). See the item-event exception below. |
| `source` | string | which producer wrote it (the registry below) |
| `v` | number | envelope version — currently `2` |

Why: without an identity, duplicated events were invisible. One real tape
(`grade-v7-n154`) had its entire 14k-event stream re-appended by a second
recorder — 9,105 out-of-order events and a 10-hour backward time jump — and
nothing could tell the copy from the original. `id` makes duplication detectable
(the server's `POST /event` dedupe guard; `tools/tape-doctor.js --dedupe`).

**Source registry** — a producer writes its own name, one of:
`hook` · `codex-tail` · `poll-github` · `server` · `emit` · `ui` · `import` ·
`backfill` · `demo`. (`tape-doctor`'s corrective `retract` events use `backfill`
— it is a tape-maintenance producer.)

**The item-event exception.** `item` events already key on `id` as the *work-item*
id (`{type:"item", id:"wi-2", …}`), and that id is legitimately reused across a
card's transitions (`doing`→`done`). So an item event's `id` is its work-item id,
NOT a per-event UUID — producers stamp the UUID only when `id` is missing (a
`{ …, ...ev }` spread does this naturally). Consumers that dedupe by `id` must
therefore treat item events as exact-line-only (their ids repeat by design), and
`retract`'s `target.item` (below) is how you address a card.

**v1 compatibility is forever.** Events without `id`/`source`/`v` are fully valid;
consumers MUST NOT require the new fields. Old tapes keep folding unchanged. `v`
is informational, not a gate.

## Types

### `session`
Session lifecycle. `{phase: "start" | "resume" | "attention" | "idle" | "end", title?, text?, session?, cwd?, agent?}`
- `agent` identifies who works the shift (`"claude"`, `"codex"`, …) and is
  shown as a badge next to the session title. Unknown values still render —
  new producers need no UI change.
- `start` opens the board clock; `resume` fires on each user prompt; `idle`
  means the agent finished a turn and is waiting for input; `end` closes the
  session. `start`/`resume` flip the badge to LIVE, `idle` to IDLE.
- `attention` (from Claude Code's `Notification` hook) means the agent is
  blocked on the human — permission prompt or a question. The board surfaces
  it loudly: red banner, badge, and tab title. It clears on `resume`/`idle`
  or on any subsequent tool activity (`edit`/`commit`), since activity means
  the request was answered.

### `item`
Work item upsert — the kanban cards. `{id, title?, status?, note?, emoji?}`
- `emoji` pins the card's corner mark; when absent the UI infers one from the
  title (a pure function of state, so live and replay agree).
- `status`: `inbox` → `doing` → `pr` → `done` (any transition is legal;
  `inbox` cards may also come from the UI or another human).
- Partial updates merge by `id`: `{type:"item", id:"wi-2", status:"pr"}` just
  moves the card.

### `todos`
Replaces the current fine-grained plan (the drill-in view on the active card).
`{todos: [{text, done}], item?}`

### `edit`
A file was touched. `{path, tool?}` — emitted by the PostToolUse hook for
Edit/Write tools. Feeds the activity column and per-item "warmth".

### `commit`
`{sha, message, add, del, files}` — emitted by the git `post-commit` hook with
numbers from `git diff --shortstat`. Drives the line counters and tickers.

### `pr_ref`
A SIGHTING that a PR is relevant to this session. `{number, url?, title?, item?}`
- Emitted by the hook and the codex tailer wherever they detect PR activity — a
  `gh pr create` URL, a rollout mention, a `gh pr merge` success line. It carries
  **no state** and **never moves a card to done**. Its only jobs: register the
  number as session-relevant (so `poll-github` knows to fetch it) and link the
  owning card (`item` ↔ `number`) so the poller's later `pr` events carry that card
  `pr → done`. It must NOT create a PR-panel row by itself — the panel folds from
  real `pr` events; a ref only lands in `state.prRefs`. This is plan 1.4: **PR
  state has exactly one writer**, and a sighting is not a state.

### `pr`
`{number, repo?, title?, url?, state: "open" | "merged" | "closed", occurredAt?, createdAt?}`
- **Single writer (plan 1.4).** Only `poll-github` — and the offline whole-tape
  synthesizers `emit` / `import` / `demo` — may author a v2 `pr` STATE event. A v2
  `pr` from any other source (`hook`, `codex-tail`, …) is IGNORED by the reducer
  for state changes; those producers now emit `pr_ref` instead. v1 events (no
  `source`/`v`) stay honored forever for back-compat. This closes the four-writer
  race that false-merged #404 and conjured 17+ title-less rows.
- **Terminal state (`merged`/`closed`) comes only from `poll-github`'s gh queries**
  — never inferred from the agent's prose ("merged #404" while #404 was still open
  false-merged it) or from a `gh pr merge` command running (invariant #4).
- `repo` (owner/name) — `poll-github` stamps it (`gh repo view`, once per run). The
  reducer keys `state.prs` by `repo#number` when present (bare number for v1), and
  the PR panel prefixes the repo only when a session spans more than one — killing
  cross-repo `#1`–`#4` collisions inside one panel.
- `occurredAt` / `createdAt` — gh's REAL fact-times in epoch ms (the actual
  merge/close from `mergedAt`/`closedAt`, and the open time from `createdAt`),
  distinct from `t` (when recorded). The reducer's `mergedAt`/`openedAt` use these,
  so replay shows a 2am merge at 2am even though the poller only recorded it at 9am.
- Freshness is reconciled by the board server (which spawns `poll-github`), not a
  standalone daemon — see `server.js`. A merge that lands while no poller was alive
  still appears the next time the board is opened.

### `ci`
`{status: "pending" | "pass" | "fail", pr?, repo?}` — also written solely by
`poll-github` (plan 1.4). `repo` keys it onto the same `repo#number` PR as the
`pr` events, so CI attaches to the right row when a session spans repos.

### `usage`
Token accounting for a model turn. `{in?, out?, cacheRead?, cacheWrite?, model?}`
— all token counts; `model` is the model id (used to pick a price). Accumulates
into the masthead tokens/cost meters. Mostly emitted by the transcript importer
(live hooks have no token visibility). Kept out of the activity feed — too
frequent — and cost is an approximate local estimate, not a billing record.

### `say`
The agent's plaintext narration / running status — what it tells you in the CLI
between tool calls ("waiting one more interval for the harvest to finish").
`{text, item?}`. Emitted from Codex `agent_message` rollout entries and Claude
assistant text blocks (tailed from the transcript). The reducer keeps the latest
on the owning card and shows it as the live "now" line on the active card, so a
turn spent thinking and watching a job still reads as alive instead of frozen.
Distinct from `note` (which is a deliberate, sparse milestone): `say` is the
ambient status stream and can be frequent.

### `note`
Free-form narration from the agent. `{text}` — used sparingly for milestones,
not a chat log.

### `retract`
Correct a recording error. `{type:"retract", target:{event?:<event id>, item?:<item id>}, reason?}`
- `target.event` names an envelope `id`; `target.item` names a work-item id.
- **Semantics: retraction is META-level and applies at ALL replay times.** Before
  folding, `fold()` pre-scans the ENTIRE array (ignoring `untilT`) for retracts,
  then skips any event whose `id` is retracted and drops any retracted item
  entirely — it vanishes from board, counts, and feed at every scrub time, even
  times *before* the retract's own `t`.
- **This is the ONE documented exception to "replay shows history as it was."**
  The rationale: a recording bug is *not* history. Two cards titled
  `<task-notification>` from a producer bug, or a whole re-appended stream, were
  never real work — replaying them faithfully just reproduces the bug forever. An
  append-only tape can't delete, so `retract` is the append-only way to say "this
  line was never true." Genuine history (a card that really moved `doing`→`done`,
  a PR that really merged) is never retracted — only recording errors are.
- `fold` stays a pure, deterministic function of `(events, untilT)`.

## Ordering

The log is *meant* to be time-ordered, but a tape can arrive out of order (a late
backfill, or the n154 re-append seam). So:

- **Consumers sort by `t`.** The board stable-sorts on load and inserts late live
  arrivals at their position (`public/app.js`); the server sorts before any
  whole-file scan (`prScan`, `scanMeta`); `tools/tape-doctor.js --sort` rewrites a
  tape in order. Array sort is stable, so equal `t` preserves file order.
- **`fold()` never stops early.** Its per-event guard is `continue`, not `break`:
  a single event whose `t` exceeds `untilT` is skipped, not treated as the end —
  otherwise an out-of-order tape made scrub-to-end and live-fold disagree.
- **Producers should still append in time order** (they nearly always do), but no
  consumer may rely on it.

## Attribution heuristic

Hooks usually don't know which work item an event belongs to. The reducer
attributes unattributed `edit`/`commit`/`todos`/`ci` events to the single item
currently in `doing`; if several are `doing`, to the most recently touched one;
if none, to session totals only. Producers that *do* know should set `item`
explicitly — explicit always wins.
