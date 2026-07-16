# Semantic Session Timeline — Coherent Retrospective Design

**Date:** 2026-07-13
**Status:** Implemented and locally verified
**Reference session:** reference-session
**Reference tape:** semantic-reference

## Problem

Nightshift currently renders one session through several views that answer with
different clocks, different entity sets, and different attribution rules.
That makes individually defensible UI elements add up to an incoherent story.

In the reference session:

- GitHub has seven open PRs: the execution-plan PR #101 plus six feature PRs
  #102–#107. The tape contains only six PR state records because #104 was
  opened by a subagent and never registered with the session poller.
- The board's PR rows show an unlabeled duration derived from PR age. Card
  duration is instead inferred worked time. The fleet row age is time since the
  latest event, while its tooltip is total wall span. Similar-looking numbers
  therefore mean different things.
- The root timeline's gray bars are raw event-density buckets and include
  recorder heartbeats. Yellow means a bucket contains a commit. Neither color
  communicates coding, review, validation, blocked time, or preflight.
- Story reports six opened PRs and zero merged PRs internally, but its headline
  emphasizes merged PRs and its chapters show only PRs attributable to recorded
  turns. It does not make “seven open, zero merged, about one-third of roadmap”
  legible.
- Lanes is organized around two prompt-derived items, even though most work was
  performed by subagents and continued after those item cards were closed. PR
  marks without item attribution disappear from the work-item lanes.
- The GitHub poller registry was empty by 05:15 while Claude continued until
  12:37. The tape therefore preserves stale CI states even though GitHub later
  became green. At the audit checkpoint, GitHub showed #101, #102–#105, and
  #107 green; only #106 still had an advisory CodeRabbit check in progress.
  The board still showed #102, #103, #106, and #107 as running.
- The final task snapshot still has “Roadmap” and “Final handoff” in progress,
  while the final assistant message says the run deliberately stopped after
  roughly the first third of the roadmap and is awaiting human direction.
- The final attention event means “waiting for another prompt,” not a blocked
  tool request. The Claude transcript contains 345 matched tool-use/result
  pairs. The tape contains 587 PostToolUse observations; those are not a
  one-to-one tool-call ledger and cannot prove lifecycle completeness alone.

The product must distinguish recorded fact, current external fact, explicit
agent intent, and retrospective inference. It must not make those sources look
equally authoritative.

## Product goal

Within ten seconds, a user opening any session view should be able to answer:

1. What was accomplished, and what remains?
2. Which PRs were created, how are they stacked, and what is their current
   readiness?
3. Where did elapsed time go: coding, validation, preflight/review, waiting, or
   unclassified work?
4. Was the agent actively working, waiting for a tool, waiting for CI/review,
   idle, or waiting for the human?
5. Which claims are exact recorded facts and which are retrospective estimates?

The same compact summary must appear in board, Story, Lanes, and Graph because
all four consume one canonical derived session model. Each view may specialize
the detail beneath it.

## Chosen approach: hybrid semantic timeline

Three approaches were considered:

1. Keep the raw event-density strip and add a legend. This is cheap but still
   answers “how many events occurred,” not “what work consumed time.”
2. Render only explicit phase events. This is exact for future sessions but
   leaves existing tapes, including the reference run, mostly blank.
3. Use explicit phases when available and conservative inference otherwise.

The approved design is option 3. Future producers emit exact phase and tool
lifecycle events. Historical tapes are classified retrospectively with visible
confidence. Users get useful history now without presenting guesses as facts.

## Canonical session model

Add a pure shared model layer, public/session-insights-model.js, derived from a
sorted, retraction-aware event prefix. Raw Claude transcripts are never a second
runtime input. A retrospective importer converts selected transcript evidence
into provenance-stamped append-only recovery events first. The model is the only
source for session clocks, phase spans, PR registry, readiness snapshots,
blockers, and summary totals.
The existing reducer remains the event-state fold for the live board; this model
adds cross-view retrospective semantics without mutating the tape.

The model returns:

- bounds: recordedStart, recordedEnd, displayNow
- clocks: recordedSessionMs, producerWindowMs, observedActiveMs,
  inferredIdleMs, liveHumanWaitMs, and unclassifiedMs
- phases: semantic spans with phase, disposition, wallCategory, and confidence
- prStack: every known PR, topology, recorded state, optional current state,
  source freshness, and attribution evidence
- toolCalls: explicit future lifecycles plus historical point events
- blockers: human input, permission block, tool outcome unknown, CI/review wait,
  recorder gap, and unknown silence, each with confidence
- roadmap: current todo snapshot plus completion evidence and stale-snapshot
  warning
- attributionGaps: work, PRs, and milestones that could not be assigned to an
  item or phase
- diagnostics: missing poller, stale sources, conflicting lifecycle signals,
  and retrospective recovery notes

The model also keeps independent lifecycle and progress axes. They must never be
collapsed into one “progress” badge:

- session lifecycle: open, explicitly ended, or recorder-stale
- turn lifecycle: working or complete
- next actor: agent, human, external system, or none
- input request: none, permission, or question
- task state: pending, in progress, done, abandoned, or superseded
- artifact state: PR open, closed, or merged
- validation state: pending, pass, fail, needs-fix, or awaiting review

All consumers receive the same two explicit horizons. The session-semantic
cursor (`t`) caps occurrence time for lifecycle, clocks, phases, tools,
narrative, checklist, and recorded work. The knowledge horizon (`at`) controls
when append-only evidence becomes available and supplies the displayed “as of”
value. A recovery event whose historical `t` is at or before the cursor joins
the semantic prefix once `at` reaches its later `recordedAt`; an event whose
`t` is after the cursor can never extend session semantics. Later PR/CI
reconciliation may still project separately labeled current GitHub truth. Its
freshness ages against the knowledge horizon, not the frozen session display
clock. Replay performs no present-day fetch; it may only project facts already
present in its one-shot tape snapshot. In live mode the server may append a
fresh authoritative reconciliation.

## Time semantics

Every displayed duration uses a noun. Bare values such as “7h” are forbidden.

### Recorded session span

From the first recorded session event to the final recorded lifecycle event in
the selected replay prefix. Reconcile heartbeats do not extend it. The reference
snapshot is about 11h 32m. Label: “11h 32m recorded session.”

### Producer work window

From the first agent-producer event to the final agent-producer event. The
reference snapshot is about 11h 29m. This is a boundary, not a claim that the
agent worked continuously. Label: “11h 29m producer window.”

### Observed active time

Continuity of agent-producer events within a bounded gap, interrupted by
explicit idle, attention, or end events. Historical continuity gaps are capped
and reported as estimates. Polling and reconcile traffic never create work.
Label the result “observed work” with an Estimated badge when any inferred span
contributes. The new filtered classifier owns the fixture value; the legacy
digest's 2h 33m result is diagnostic input, not a required result.

### Waiting and idle

These are separate:

- Human wait: explicit session attention or notification indicating the agent
  needs user input.
- Tool execution: an explicit start/end lifecycle with measured duration.
- Tool outcome unknown: a start without a matching terminal event. This is not
  called running or blocked without another live/process/permission signal.
- Permission block: an explicit permission request without a decision.
- Readiness wait: explicit preflight/review run waiting on CI or reviewers.
- Idle: explicit idle/end, or conservative historical silence after the active
  gap cap.
- Unknown silence: a long gap without evidence that identifies its cause.

Historical tool point events cannot prove how long a call ran. A gray gap near
a tool event remains “unknown silence,” never “blocked tool call,” unless the
transcript contains lifecycle evidence.

The recorded span freezes at the last event. A live human-wait timer may extend
from the final attention event to displayNow, but it is a separate open-ended
status timer and never inflates recorded span or observed work.

### PR time

- “Open for 7h” means current time minus GitHub createdAt.
- “Opened 7h ago” means the relative creation time.
- “CI waiting 11m” requires an observed pending-to-terminal lifecycle.
- “Ready since 09:42” requires an authoritative readiness transition.

PR age is never presented as agent effort or blocked time.

## Phase taxonomy

Every semantic span has startT, endT, phase, disposition, wallCategory, optional
stage, confidence, source, and evidenceEventIds.

Work phases:

- coding
- testing
- preflight
- other

Disposition is one of active, waiting, idle, or unknown. The mutually exclusive
wallCategory is derived for the collapsed ribbon:

- coding
- testing
- preflight
- other
- waiting
- idle
- unknown

Preflight substages:

- prepare
- local_validation
- visual_qa
- self_review
- cross_ai_review
- publish_pr
- readiness_wait
- readiness_fix

Confidence:

- explicit: produced by a work_phase lifecycle event
- strong: supported by a command, named skill, or structured output whose
  purpose unambiguously identifies the phase
- heuristic: inferred from nearby edits, tools, narration, or silence

Rendering:

- explicit spans use a solid fill
- strong inferred spans use a lightly hatched fill
- heuristic spans use a dotted outline and reduced opacity
- unknown gaps remain neutral gray rather than being forced into a phase

### Historical inference rules

Inference is deterministic and ordered by precedence:

1. Explicit session idle/attention/end closes any active work span.
2. Explicit future work_phase events win over all inference.
3. Preflight requires an active declared preflight/ship run or explicit intent.
   Within that run, Toast, review, visual QA, build, lint, and test evidence can
   identify strong substages. Merely reading a preflight skill or timing script
   is other/audit, not preflight.
4. Edits and commits surrounded by implementation narration classify as coding.
5. Test/build commands outside a declared preflight classify as testing.
6. PR creation and description work classify as preflight/publish_pr only when
   they are part of a declared ship or preflight run; otherwise they are other.
7. Inferred activity ends after ten minutes without supporting producer
   evidence. The remainder is idle or unknown silence depending on lifecycle
   signals.

Heartbeat, usage, GitHub reconcile, and repeated status polling are evidence
marks only. They never create active work time.

### Concurrency semantics

Subagents make a single exclusive “what happened at this moment?” answer
impossible. The collapsed ribbon therefore uses an exclusive primary phase for
each wall-time slice, chosen by explicit evidence first and then the inference
precedence above. This ribbon partitions recorded wall time and its percentages
sum to 100 percent.

More precisely, wallCategory uses disposition first: waiting, idle, and unknown
win their matching categories. Active spans use their coding, testing,
preflight, or other phase. A preflight readiness_wait span therefore remains
phase preflight/stage readiness_wait in expanded detail but contributes to the
collapsed waiting category. Blocker marks are overlays and never add duration.

Expanded per-agent lanes preserve overlapping phases. Per-phase “coverage” is
the union of that phase across all lanes; coverage values can overlap and are
explicitly labeled “parallel coverage,” so they are not summed as wall time.
An optional “agent time” total may sum work across lanes, but must use that name
and never be compared directly with recorded span.

## Future event contract

### Work phases

Producers should emit:

    {
      type: "work_phase",
      phase: "preflight",
      stage: "cross_ai_review",
      runId: "preflight-104-1",
      state: "start",
      item: "...",
      pr: 104
    }

and a matching end event containing outcome when known. runId makes concurrent
subagents and nested validation stages unambiguous.

### Tool lifecycle

Replace point-only tool observations with start and end events keyed by the
compound identity sessionId, agentId, and toolUseId:

    {
      type: "tool_call",
      toolUseId: "toolu_...",
      sessionId: "...",
      agentId: "...",
      state: "start",
      tool: "Bash",
      item: "...",
      parentRunId: "preflight-104-1"
    }

The rollout must register PreToolUse in the global Claude installer, Codex hook
installer, and vendored/local attach installer. PostToolUse records success;
available failure, cancel, and interruption hooks record their own outcomes.
When a harness has no terminal signal, Stop/SessionEnd may close the lifecycle
as outcome unknown, never success.

A matching result ends the span, even if the enclosing turn later continues.
An unmatched start means only “tool outcome not observed.” It cannot distinguish
a running process from a permission gate or lost hook, so the UI shows elapsed
time and confidence without calling it blocked. A separate permission-request
and decision lifecycle is required before the UI may say “permission blocked.”

### Subagent work

Subagent start/end notifications carry agentId, taskId, parent item, purpose,
and optional phase/runId. Their work may overlap; top-level summaries calculate
union time, while the expanded agent lanes preserve concurrency.

## PR discovery and truth

### Session PR registry

The registry is the union of:

- authoritative pr events already in the tape
- pr_ref events
- structured PR URLs/numbers in tool inputs and tool results
- subagent completion records containing a GitHub PR URL
- current server reconciliation for registered repo/branch relationships in
  live mode

Narrative prose alone may propose a PR candidate but cannot author state.
Recovered candidates are shown with “discovered retrospectively” until an
authoritative GitHub record confirms them.

This recovers #104 from its subagent completion record and GitHub URL even
though the poller never recorded it. Recovery emits a provenance-stamped,
append-only pr_ref event whose event time is the transcript observation time and
whose recordedAt is the later import time. The poller therefore consumes
the same canonical registry as the views instead of depending on a derived
in-memory result it cannot see.

### Stack topology

Use authoritative base/head branch facts. Do not infer stack order from PR
numbers or title text. The reference session's current GitHub topology should
render:

    #101 execution plan
      └─ #102 M1a decisions
           ├─ #103 M2 typed evidence
           ├─ #104 M1c admission policy
           ├─ #105 M1d reviewer authority
           ├─ #106 M1b time semantics
           └─ #107 M3 persisted snapshot

The tape's recorded topology is different and incomplete: #102 and #103 were
recorded as children of #101; #104 is absent; and #105–#107 were recorded as
children of #102. Live mode shows that as “recorded then” beside the current
topology above, with timestamps. Replay uses only facts known by its `at`
horizon while its recorded topology and all session semantics remain frozen at
`t`.

### Recorded versus current state

Every live PR row can contain two clearly separated snapshots:

- Recorded: latest state in the tape, including its recorded time and source.
- Current: optional GitHub reconciliation, including fetched time.

A stale recorded failure beside a current green result is not silently
overwritten. The UI says “Tape ended with CI pending · GitHub now green.” This
preserves retrospective truth while making the live page useful.

Current reconciliation is never ephemeral UI data. The single authoritative
poller appends new pr/ci events with recorded and occurred times; a replay prefix
before those events continues to show the old tape state. The model's “current”
snapshot is the latest authoritative event at the live cutoff.

Validation summaries distinguish gating checks from advisory checks. Completed
success, neutral, and skipped checks do not render as running. An in-progress
advisory is labeled “advisory running” and does not make the gating result
pending unless repository policy says it is required. On reconciliation failure,
the recorded truth remains visible with “current unavailable” and the last
successful refresh time; stale cached data is never silently presented as now.

The board server is the sole poller supervisor. It owns a durable lease keyed by
log and session; the Nightshift skill registers the session/repo but does not
spawn a competing detached worker. “Session open” means no explicit end/off and
either a fresh producer/active marker or at least one discovered nonterminal PR
still inside its reconciliation retention window. Polling backs off by state:
15 seconds during fresh work, 60 seconds during attention/idle, and five minutes
after producer staleness. It stops after all PRs become terminal or the retention
window expires. A dead lease is recovered with backoff; many inactive tapes are
rate-limited. Poller freshness and expiration are visible diagnostics.

## View design

Navigation among Board, Story, Lanes, and Graph preserves session, scrub time,
and as-of cutoff. Replay mode never starts current reconciliation. Live mode
shares one reconciled snapshot and refresh timestamp across all views.

### Lanes: primary forensic timeline

The top of Lanes becomes a semantic phase ribbon with:

- summary chips for recorded span, observed work, coding, testing, preflight,
  waiting, idle, and unknown
- one top-level row for semantic phases
- an expandable preflight row with the substages above
- a PR-stack swimlane showing open, CI/review, ready, and merged transitions
- optional per-agent rows for overlapping subagent work
- explicit attention and recorder-staleness markers

Hover shows phase/stage, duration, percent of recorded span, start/end, outcome,
confidence, and evidence count. Click opens an evidence drawer containing the
commands, narration, PR/check transitions, and links to replay at that time.

The current blue item episodes remain available as an attribution overlay, not
the primary timeline. The current gray/yellow density histogram is demoted to an
optional “event activity” overlay with a legend. Heartbeats are excluded.

### Story: morning progress report

Story leads with:

- “7 PRs opened · 0 merged · 6 feature slices plus plan”
- “Session checklist: 8/10 complete,” naming Roadmap and Final handoff as the
  two checklist items still marked in progress
- “Product roadmap: roughly one-third,” followed by “Milestone 1 complete;
  first slices of M2 and M3; M4–M7 not started”
- current disposition: “turn completed; session not explicitly ended; human is
  next actor; no tool outcome is missing”
- phase totals and the longest waiting/unknown intervals
- PR stack grouped by milestone, with recorded and current readiness
- stale task snapshot warning when checklist state conflicts with later handoff
- the later “roughly one-third complete” statement as the latest explicit agent
  assessment, visibly superseding the earlier agent completion claim while
  remaining labeled as assessment rather than authoritative roadmap fact

Chapters remain useful, but unattributed work and PRs appear in an explicit
“Unattached activity” chapter rather than disappearing. PR chips link to GitHub
and to the relevant replay moment.

### Board: live state

The board continues to optimize for “what is happening now,” but uses the same
model and language:

- distinguish Work items, Pull requests, and Tool calls as separate entities
- replace bare PR hours with “open for …”
- label card duration “observed work,” not elapsed
- show “waiting for your next instruction” separately from permission/tool
  blocking
- exclude heartbeats from density
- label totals precisely, for example “978 non-heartbeat events · 960
  heartbeats excluded” rather than calling every non-heartbeat event activity
- surface stale GitHub source/poller state
- show recovered/unattached PRs instead of hiding them

### Graph

Graph consumes the same PR registry and stack topology. It includes the shared
compact summary header for as-of time, PR totals, session checklist, current
disposition, clocks, and provenance. It does not maintain an independent PR
count or current-state interpretation.

## Recording consistency fixes in scope

These are required because the UI cannot be coherent when the tape omits the
session boundary or relevant PRs.

### Mid-turn Nightshift attachment

Starting Nightshift after UserPromptSubmit currently misses the turn because
recording was disabled when that hook ran. The Nightshift skill creates a
session-scoped attach sentinel containing activation time and deterministic
recovered turn identity. The next PostToolUse hook atomically claims it,
reconstructs the latest real human prompt, opens exactly one deterministically
named turn card, attaches the current task snapshot, and marks the claim
consumed. A retry after a crash upserts the same card and cannot create a second
turn.

Recovery rejects harness/meta prompts such as task notifications, system
reminders, and local-command output. A missing/truncated transcript produces a
diagnostic and leaves the sentinel retryable. Existing open cards, reset versus
continue tapes, and the next normal UserPromptSubmit each have explicit state
transitions rather than relying on “latest prompt” alone.

### Turn closure versus continued work

Turn, work-item, and subagent-task lifecycles are separate. Stop closes the
conversational turn immediately. It does not close the work item or any active
subagent task, and later subagent events do not accrue worked time to the closed
turn. A work item closes from its own explicit completion policy. Each subagent
task closes from its matching task completion/cancellation event and remains
visible while the parent conversation is idle.

### Notification semantics

Notification events carry one of next_prompt, permission, question,
background_complete, or system_notice. Only permission and question set
needsInput. next_prompt after Stop preserves normal idle/turn-complete rather
than promoting it to actionable attention. background_complete and
system_notice are informational. Later lifecycle evidence supersedes earlier
notification severity deterministically; the UI never infers severity from
generic message text.

### Poller supervision and discovery

The server watches the session's append-only PR registry under the sole-owner
lease described above and restarts or replaces a retired poller while the
session is open. Newly recovered pr_ref events are reconciled immediately.
Source freshness is displayed in every view.

## Retrospective capability and limits

Yes, the reference run can be reconstructed retrospectively. The tape and
Claude transcript preserve enough evidence to recover:

- the seven-PR set and stack
- approximate coding/testing/preflight spans
- subagent preflight completion reports and durations
- the long gap between major work and final handoff
- the final roadmap correction and stop state
- stale versus current GitHub readiness

It cannot recover exact historical tool runtime or prove a tool was blocked
because current hook records are point observations taken after tool use. Those
spans must remain unknown/heuristic. Exact future blocked-time reporting depends
on the tool lifecycle contract above.

The retrospective importer must never rewrite the original tape. It creates a
derived in-memory index or an append-only import/recovery event with provenance.

## Reference-session acceptance fixture

Create a minimized, sanitized fixture derived from the reference tape and its
relevant transcript records. Preserve event timing and provenance but remove
unrelated command payloads and sensitive content.

At the 2026-07-13 audit checkpoint, tests must assert:

- recorded session span is approximately 11h 32m and producer window is
  approximately 11h 29m
- two prompt cards do not imply only two work episodes
- the tape has six structured PRs; #104 is absent from structured tape state,
  then becomes the seventh PR through a provenance-stamped recovery event
- zero PRs are merged
- recorded topology keeps #102/#103 under #101, #104 absent, and #105–#107
  under #102; current topology keeps #101 as root, #102 as its child, and
  #103–#107 as children of #102
- recorded CI ends pass for #101/#105 and pending for #102/#103/#106/#107;
  later readiness narration and current GitHub facts cannot rewrite that state
- at the frozen current audit checkpoint, #102/#103/#107 are not running and
  #106 alone has an advisory CodeRabbit check in progress
- Story says seven open rather than reporting only merged progress
- Lanes includes a PR-stack swimlane and semantic preflight spans
- the final turn is complete, the session is not explicitly ended, the human is
  next actor, and no transcript tool call lacks a result
- the 345 transcript tool pairs and 587 tape tool observations remain separate
  metrics with explicit provenance
- final human attention starts at 12:38:24 and extends to displayNow in live
  mode or the scrub cutoff in replay, without extending recorded span
- stale todo items are flagged against the later final handoff
- tape-recorded CI state and current GitHub state are visually distinct
- heartbeat volume does not inflate work time or the semantic density display
- a recovered PR appears no earlier than its transcript observation timestamp

## Testing strategy

### Model tests

- deterministic phase classification and precedence
- non-overlap and complete wallCategory coverage: every millisecond maps once,
  collapsed percentages total 100 percent, and blocker overlays add no duration
- active-time union under concurrent subagent work
- idle/unknown gap caps
- explicit work_phase and tool_call lifecycle folding
- PR registry union, deduplication, recovery, and provenance
- imported recovery ordering by observed timestamp and later recordedAt
- stack topology from base/head branch facts
- replay never consumes current snapshots
- stale todo/handoff conflict detection

### Golden fixture tests

- the reference acceptance assertions above
- a future explicit-phase tape where no inference is needed
- a tape with an unmatched tool start
- a tape with a dead poller and later current reconciliation
- a mid-turn attachment fixture proving exactly one recovered item
- repeated PostToolUse delivery and a process crash after recovered-item append
- missing/truncated transcript and rejected meta-prompt attachment
- attachment with an existing open card under both reset and continue
- attachment followed by the next normal UserPromptSubmit

### View tests

- Board, Story, Lanes, and Graph render the same compact as-of, PR, checklist,
  lifecycle, next-actor, clock, and provenance summary
- all views report the same PR totals and topology at the same scrub point
- all views report 8/10 task progress and the same two remaining checklist items
- all views use the separate labels “Session checklist: 8/10” and “Product
  roadmap: roughly one-third”
- every duration includes a semantic label
- inferred spans expose confidence in accessible text, not color alone
- Story includes open PR progress and unattached activity
- Lanes hover/click evidence works via keyboard and pointer
- Board distinguishes human wait, measured tool execution, tool outcome
  unknown, permission blocked, and idle
- populated Story and Lanes views remove their hidden/accessible empty-state
  message so screen readers do not announce “no events” over real content
- cross-view navigation preserves session, scrub time, as-of cutoff, and current
  refresh state; replay performs no present-state fetch
- current reconciliation failure preserves recorded state and exposes
  unavailable/stale status accessibly

## Rollout

1. Build and test the shared session-insights model against the reference
   fixture.
2. Fix mid-turn attachment and PR discovery/poller supervision so new tapes are
   more complete.
3. Replace Lanes' primary strip with the semantic ribbon and PR swimlane.
4. Move Story summaries and chapters to the shared model.
5. Align Board and Graph labels/counts with the shared model.
6. Add explicit work_phase and tool_call producers; retain historical inference
   for old tapes.
7. Verify all views against the live reference-session URLs and a future
   explicit-phase recording.

Each step is independently shippable, but the feature is complete only when all
views agree on reference-session PR count, state provenance, and clock labels.

## Verification — 2026-07-14

The deterministic reference was served from the sanitized fixture under a
synthetic session id. The frozen semantic cursor was `t=1700041531012`; the
knowledge horizon was `at=1700120426802`. This deliberately keeps session work
and clocks frozen while admitting retrospective recovery and later GitHub facts.

Automated verification:

- `npm test`: 379 passed, 0 failed.
- `npm run build:graph`: passed; consecutive builds produced identical Graph
  HTML, CSS, and JavaScript artifacts.
- `git diff --check` and JavaScript syntax checks passed.
- Poller lifecycle regressions cover cached recovered/empty expired-session
  scans and bounded, mixed-version ABA-safe lease retirement under repeated
  polling.
- The cross-view contract asserts identical as-of, 7 open / 0 merged, checklist
  8/10, roadmap assessment, lifecycle, next actor, blocker, clocks, provenance,
  replay navigation, and exact duration nouns.

Browser verification covered Board (`/`), Story (`/story`), Lanes (`/lanes`),
and Graph (`/graph`) with the reference `session`, `t`, and `at` parameters:

- all four showed 7 PRs open, 0 merged, session checklist 8/10, product roadmap
  roughly one-third, 11h 32m recorded session, Human next, and no execution
  blocker;
- replay made one-shot event reads and opened no SSE connection; live Board and
  Graph opened SSE as designed;
- Board playback, Story disclosure controls, Lanes evidence by pointer and
  keyboard with focus return, and Graph Home/End/PageUp timeline controls passed;
- desktop `1440x1000` and narrow `390x844` layouts rendered without console
  errors; all four documents fit the narrow viewport without horizontal
  document overflow;
- the Lanes drawer exposed labeled duration, stage, confidence, evidence count,
  provenance, and replay link for the selected phase.

Retrospective limits remain explicit. Historical phase timing contains visible
inference, point-only tool observations do not prove runtime, and the reference
fixture's current GitHub facts are frozen at the `at` horizon. The machine's
original tape continued after this reference cutoff, so its later live counts
are not expected to equal the frozen acceptance fixture. Production freshness
must continue to come from the durable reconciler, not from replay.

## Non-goals

- Replacing the append-only tape with a database
- Using an LLM to author authoritative facts
- Claiming exact historical tool-block duration from point events
- Treating every shell command as coding or every silence as idle
- Merging or changing the reference session's application PRs

## Success criteria

The reference session should read consistently everywhere:

“The recorded session spans about 11.5 hours. Seven PRs are open and none are
merged. Session checklist: 8/10. Product roadmap: roughly one-third; Milestone 1
is complete, M2 and M3 have first slices, and M4–M7 are untouched. Work included
coding and multiple preflight/review runs, with some timing inferred from the
historical tape. The turn completed, the session was not explicitly ended, and
the human is next actor. No transcript tool result is missing. GitHub state shown
as current may be newer than the last state recorded in the tape.”

The detailed timeline then makes every part of that summary inspectable.
