# Morning Truth — diagnosis & plan (2026-07-02)

The goal restated: wake up after an overnight run (one agent or a fleet) and know,
in under a minute, what shipped, what failed, what's blocked on you, and what it
cost — with the ability to drill into any moment. Today the board can't answer
that, and the same bug families keep recurring despite fixes. This doc is the
root-cause diagnosis (grounded in the 20 real tapes in `~/.nightshift/sessions/`,
247,689 events, folded with the production reducer) and the plan.

## Part 1 — What the tapes actually say

Every number below is from real tapes, not hypotheticals.

**F1. The fleet is a hall of mirrors.** The 15 "parallel agent" tapes of
2026-06-30 are one Codex session recorded into 15 worktree-named files —
identical except 12 lines. One tape (grade-v7-n154) attached a second recorder
and contains the whole session **twice** (14,135 duplicated lines, a 10-hour
backward time-jump at line 9113, cost $220.67 = 2 × $110.33). Aggregate cost
across boards reads **$1,855; real unique spend ≈ $200**. Each copy ran its own
GitHub poller which died at a different time, so the copies disagree about the
same repo: PR #482 is "open" on 13 boards and "merged" on 1; open-PR counts of
56/48/4 for identical reality.

**F2. Done means nothing; the kanban has collapsed.** Across all 20 tapes:
**428 cards, 428 in Done, zero in any other column.** 72% of cards have no plan
delta; 45 megablock cards have zero recorded activity at all. Cards are chat
turns titled by prompt prefix (`"s"`, `"hold on...."`, two `<task-notification>`
cards baked in from a June 22 producer bug). Meanwhile megablock's own Plan
panel lists 6 unfinished items and 3 open PRs with failing CI. The columns and
the side panels tell opposite stories — and the panels are the ones telling the
truth.

**F3. Liveness lies.** 0/20 tapes ever received a `session end` event. A dead
recorder is indistinguishable from a working agent: `phase` latches at
`working`, the badge shows LIVE forever, the "now" line shows 1am narration as
present tense indefinitely, and — because the server's PR reconciler appends
events every 30s — `lastAt` keeps advancing and the active card **accrues
phantom "time worked" all night** (reducer.js:111–117). The board server itself
died again today (board.json pointed at a dead pid); nothing supervises it, the
tailers, or the pollers.

**F4. Replay diverges from live.** `fold()` stops at the first event newer than
the scrub point **in file order** (`break`, reducer.js:354). The n154 tape has
9,105 out-of-order events; scrubbing to the end and pressing LIVE produce
different boards — the core invariant (replay = truth) is broken on real tapes.
Also, PR merge times are recorded at *poller-noticed* time, not gh's `mergedAt`,
so replay shows fabricated history (a 2am merge appears at 9am).

**F5. Sessions have no boundaries.** Tapes are keyed by project directory, so
megablock-h1 glues ~10 calendar days into one board: 10 `start` events, 152
resumes, 125 attention events, a 29-hour silent gap, "elapsed 239:50:07", and
week-old prompt-cards beside last night's work. The final facts of the night
(CI failed on #588 at 15:29) arrive as the literal last line of the tape with
nothing surfacing them.

**F6. The schema can't defend itself.** Events have no `id` (duplicates are
undetectable — F1 was silent), no `source` (no authority ranking for PR facts,
no per-producer liveness), no `seq` (no ordering contract — F4), no
`occurredAt` vs `recordedAt` (fabricated history), no schema version (old tapes
silently change meaning under new reducer semantics). And the tape being
append-only means every historical producer bug renders forever — there is no
amend/retract.

## Part 2 — Why the same bugs keep recurring

The repo's own invariant #4 says *"facts come from hooks, intent from the model —
never make the model responsible for facts."* That invariant is honored for
commits and edits, but violated for **exactly the four states the board exists
to show**:

| State | How it's produced today | Bug family it spawns |
|---|---|---|
| Turn/card boundaries | Synthesized from prompt regexes + 60s-quiet heuristics by 3–4 racing writers with per-process counters (`turn-N` double-minted in production tapes) | 8+ fixes, still recurring |
| Card completion | Inferred from Stop hooks / idle timers / reducer second-guessing (`done`→`pr` parking) | 6008462, dce1259, … |
| Liveness | Inferred from log silence; latched enum; no heartbeat | 6+ "board looks dead" fixes |
| PR state | Four competing writers (hook regex, tailer parse, poller, server reconcile), no source tags, freshness coupled to mortal daemons | 6+ fixes incl. the false-merge |

Every past fix tuned a heuristic or moved a daemon. None made the state a
**recorded fact with a single owner**. That is why the classes recur, and why
they will keep recurring until the schema and ownership change. The fix pattern
is always the same: *one producer, explicit events, heartbeat + staleness
instead of latching, authoritative sources for external state.*

## Part 3 — Is kanban the wrong medium?

Partly. The precise statement: **kanban answers "what is in flight right now";
the morning question is "what happened while I was gone" — a narrative, not a
state.** No state-shaped view (kanban, mind map, react-flow graph) answers a
narrative question. A node-graph would be a lateral move: graphs are good at
*relationships without time*, and a flight recorder's primary dimension is
time. The scrubbable timeline is closer to right than a graph would be.

What the evidence says people actually consume on this board: the Plan panel
and the PR panel (the sidebar) — while the kanban center shows 128 prompt-cards
in one column. The sidebar quietly became the product.

So the medium plan is three views over the same tapes, by question:

1. **Shift Report** (new — the morning answer). A generated debrief page:
   *Shipped* (PRs merged, with links and real merge times), *Failed / needs
   you* (CI failures, attention events, blocked PRs), *Still open*, *The story*
   (chapters segmented by real gaps: "18:21–02:40 grading pipeline, 14 commits,
   $71"), *Cost*, per-session and fleet-aggregated. Pure fold over the tape(s) —
   deterministic, no LLM required for v1 (optionally an LLM-written 3-sentence
   abstract on top, clearly marked as prose, never as facts). Renderable at
   `/report?since=` and postable to Slack.
2. **Fleet home** (new — the missing aggregate). The board is per-tape; an
   overnight fleet is N tapes; today the only "fleet view" is a dropdown. One
   screen: a row per session — status honesty dot, needs-input flag, last
   narration, open/merged PR counts, cost — sorted by needs-attention. The
   picker becomes navigation *from* this page, not the primary UI.
3. **Kanban stays as the live single-session view** — it's good at that — but
   its cards must become real work items (Part 4, W3), not chat turns.
4. **Replay evolves into a lane timeline** (later): horizontal time, lanes per
   agent (fleet) or per work item (session), spans = work episodes, marks =
   commits/PR events/attention/CI. Click a mark → jump replay there. This is
   the legitimate kernel of the "react-flow" instinct — spatial layout, but
   with time as the x-axis, not a free-form graph.

## Part 4 — The plan

Ordered so trust comes first (a beautiful report over lying data is worse than
no report), then the morning medium, then the deeper re-architecture.

### Phase 0 — Trustworthy tape (~1–2 sessions)

- **0.1 Envelope v2**: every event gains `{id, source, seq?, v:2}`. `id` =
  producer-generated ULID-ish; `source` = `hook|codex-tail|poll-github|server|
  emit|ui`. Server appends reject exact-duplicate ids (kills F1's 2× class at
  the door). Reducer ignores unknown fields on v1 events — old tapes keep
  folding.
- **0.2 Ordering**: sort events by `t` on load (client + server scans);
  `fold()` `break` → `continue` as a belt-and-suspenders guard. Fixes F4's
  replay/live divergence immediately, even for existing damaged tapes.
- **0.3 `amend`/`retract` events**: `{type:"retract", target:<event id|item id>}`
  folded as tombstones. The append-only tape stays append-only, but producer
  bugs stop being permanent UI damage.
- **0.4 `tape-doctor` tool**: offline fixer — dedupe exact-duplicate lines
  (n154), collapse the 15-way fleet copies into one tape (+ preserve worktree
  labels as metadata), retract known-junk cards (`<task-notification>`), write
  `.bak` first. Run once over the existing corpus.
- **0.5 Golden-tape tests**: check 2–3 real (sanitized) tapes into `test/tapes/`
  and assert invariants in CI: replay(end) === live fold, no duplicate ids, no
  negative time jumps post-sort, cost totals within expected bounds, no card
  stuck `doing` after `end`. Every future producer bug becomes a failing test
  instead of a confusing morning.

### Phase 1 — Facts, not inference (~2–3 sessions)

- **1.1 Heartbeats + honest staleness** (kills the "dead board" family): every
  recorder emits `alive {source}` ~30s. Reducer derives per-source freshness;
  the UI distinguishes *agent idle* / *agent working* / **recorder dead — data
  ends at 03:12**. The now-line gets displayed age past a TTL ("last seen 47m
  ago: …" instead of present tense). `activeMs` accrual gates on
  recorder-alive, not on the latched phase (kills phantom overnight hours).
- **1.2 One recorder per rollout** (kills F1): recorder lock keyed by rollout
  path (not log path), so a second attach is a no-op. Plus: resolve the log
  slug from the *worktree* cwd correctly so 15 agents genuinely produce 15
  distinct tapes — or one tape with 15 `source` lanes (preferred once Fleet
  home exists).
- **1.3 Turns become recorded facts**: exactly one producer (the hook) emits
  `turn {id:"<sid>-<n>", phase:"start"|"end"}` with a session-scoped unique id.
  codex-tail/retire-turn/backfill are forbidden from minting or closing cards.
  Kills double-minted `turn-N` and the 60s-quiet false-retire flip-flops.
- **1.4 PR truth single-writer**: only server-driven `poll-github` writes
  `pr.state`; hook/tailer emit `pr_ref` (number/url sightings) that only make
  the poller aware of a PR. Record gh's real `mergedAt` as `occurredAt` so
  replay shows true history. (The prose-merge parser is already gone; this
  closes the remaining three writers.)
- **1.5 Supervision**: a LaunchAgent keeps the board server (and portless
  proxy) alive across restarts — it died again today. With 1.1, even when
  something does die, the board *says so* instead of lying.
- **1.6 Session boundaries**: emit `session end` from SessionEnd/rollout-close;
  an end (or 6h recorder-dead) sweeps still-`doing` cards to an explicit
  "abandoned" mark and freezes now-lines. Day-boundary markers on the timeline
  for multi-day tapes.

### Phase 2 — The morning medium (~2–3 sessions, can start in parallel after 0.4)

- **2.1 Shift Report v1** (`/report`, per session): Shipped / Failed–needs-you /
  Still open / Story chapters / Cost, every claim linking to a replay timestamp
  (`?session=…&t=…`). Deterministic fold, zero deps, server-rendered HTML.
- **2.2 Fleet home v1** (`/`): the session table described in Part 3, with
  needs-attention sort and staleness honesty from 1.1. Aggregate header:
  "overnight: 3 sessions, 5 PRs merged, 2 failed CI, $214".
- **2.3 Slack morning digest** (optional): the report's top section posted by a
  scheduled run — meets the "what happened overnight" question before you even
  open the board.
- **2.4 Lane timeline prototype** (spike, after 2.1/2.2): evolve the replay
  strip into per-source/per-item lanes with clickable marks. Decide from use
  whether it replaces the kanban center in replay mode.

### Phase 3 — Cards = work items (~2 sessions)

- **3.1 Demote turns**: turns render as feed/history and as thin rows inside
  the card they advanced — not as cards. Cards come from: explicit `item`
  events (agent-declared work), PRs, and plan epics. The Done wall disappears;
  columns regain meaning (megablock would show ~6 real items, not 128 turns).
- **3.2 Attribution hardening**: producers attach `item` explicitly where they
  know it (plan-step → item links, PR → item at open time); the
  most-recently-touched-doing fallback stays only as last resort and is marked
  low-confidence in state (UI can render "attributed by guess" subtly).

### Phase 4 — Scale (opportunistic)

- Checkpointed folds (every N events) so scrubbing 100k-event tapes stays
  smooth; incremental timeline density buckets; SSE resume via `Last-Event-ID`
  offsets instead of full-tape replays on every reconnect; `updateCard` skips
  untouched cards.

### Acceptance test for the whole plan

The morning scenario, executable: start a fleet in the evening, kill one
recorder at random, merge one PR at 2am, break CI on another, sleep. In the
morning, Fleet home says in one screen which sessions ran/died/need you; the
Shift Report names the merged PR (with the true 2am time), the CI failure, and
what's blocked; the dead recorder's session says "data ends at 03:12", not
LIVE; replay-to-end equals live fold on every tape; total cost is real dollars,
counted once.
