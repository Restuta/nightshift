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

### `pr`
`{number, title?, url?, state: "open" | "merged" | "closed"}`

### `ci`
`{status: "pending" | "pass" | "fail", pr?}`

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

## Attribution heuristic

Hooks usually don't know which work item an event belongs to. The reducer
attributes unattributed `edit`/`commit`/`todos`/`ci` events to the single item
currently in `doing`; if several are `doing`, to the most recently touched one;
if none, to session totals only. Producers that *do* know should set `item`
explicitly — explicit always wins.
