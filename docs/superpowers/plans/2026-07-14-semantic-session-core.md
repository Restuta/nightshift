# Semantic Session Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build one pure, replay-safe semantic session model that supplies clocks, lifecycle, phase spans, PR truth, tools, roadmap progress, and provenance for every Nightshift view.

**Architecture:** A new zero-dependency ES module consumes a sorted, retraction-aware event prefix and returns immutable derived truth. It never reads the clock or network; live GitHub reconciliation remains append-only tape input, while replay excludes facts recorded after its cutoff. A sanitized golden tape fixes the reference session’s expected retrospective meaning before any view migrates.

**Tech Stack:** Node.js 18+, browser-native ES modules, node:test, node:assert, append-only JSONL v2 events.

## Global Constraints

- The root app remains zero dependency and requires no build step.
- The event reducer remains pure; external facts must be recorded before rendering.
- Event envelope v2 remains {id, source, v: 2}; v1 tapes remain readable.
- Raw Claude transcripts are never a second runtime input to a view.
- Stable replay ordering uses event t; GitHub fact time uses occurredAt; recovery provenance uses recordedAt.
- Every duration has a noun; no UI consumer may render a bare duration.
- Collapsed wall categories are coding, testing, preflight, other, waiting, idle, and unknown and must partition 100 percent of recorded wall time.
- Heartbeat, usage, GitHub reconciliation, and repeated status polling never create active time.
- Tool point observations do not prove runtime, blockage, or a missing result.
- Recorded and current PR state remain separate snapshots.

---

## File Structure

- Create public/session-insights-model.js: the only canonical semantic derivation.
- Create test/session-insights-model.test.mjs: focused unit, property, and golden assertions.
- Create test/tapes/semantic-reference.jsonl: minimized sanitized reference-session prefix plus recovery and later current facts.
- Modify docs/EVENTS.md: additive work phase, tool lifecycle, notification, recovery, validation-check, and assessment contracts.

### Task 1: Freeze the additive event contract

**Files:**
- Modify: docs/EVENTS.md
- Test: test/session-insights-model.test.mjs

**Interfaces:**
- Consumes: existing v2 event envelope and pr, pr_ref, ci, session, item, todos, tool, edit, say, commit events.
- Produces: documented work_phase, tool_call, notification, pr_ref recovery fields, check, and assessment fields.

- [ ] **Step 1: Write the contract-shape test**

Create test/session-insights-model.test.mjs with a contract smoke test that imports buildSessionInsights and folds explicit phase and tool lifecycles:

~~~js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionInsights } from '../public/session-insights-model.js';

test('explicit work and tool lifecycle events retain their compound identity', () => {
  const events = [
    { t: 0, id: 's', source: 'hook', v: 2, type: 'session', phase: 'start', sessionId: 's1' },
    { t: 10, id: 'w1', source: 'hook', v: 2, type: 'work_phase', state: 'start', phase: 'preflight', stage: 'local_validation', runId: 'r1', agentId: 'a1' },
    { t: 20, id: 'tc1', source: 'hook', v: 2, type: 'tool_call', state: 'start', sessionId: 's1', agentId: 'a1', toolUseId: 'u1', tool: 'Bash', parentRunId: 'r1' },
    { t: 40, id: 'tc2', source: 'hook', v: 2, type: 'tool_call', state: 'success', sessionId: 's1', agentId: 'a1', toolUseId: 'u1', tool: 'Bash', parentRunId: 'r1' },
    { t: 50, id: 'w2', source: 'hook', v: 2, type: 'work_phase', state: 'end', phase: 'preflight', stage: 'local_validation', runId: 'r1', agentId: 'a1', outcome: 'pass' },
    { t: 60, id: 'e', source: 'hook', v: 2, type: 'session', phase: 'end' },
  ];
  const x = buildSessionInsights(events, { untilT: 60, displayNow: 60 });
  assert.equal(x.phases.find(p => p.source === 'work_phase').confidence, 'explicit');
  assert.deepEqual(x.toolCalls.lifecycles[0].key, ['s1', 'a1', 'u1']);
  assert.equal(x.toolCalls.lifecycles[0].outcome, 'success');
});
~~~

- [ ] **Step 2: Run the focused test and verify RED**

Run: node --test test/session-insights-model.test.mjs

Expected: FAIL with ERR_MODULE_NOT_FOUND for public/session-insights-model.js.

- [ ] **Step 3: Document exact additive shapes**

Append to docs/EVENTS.md:

~~~markdown
### work_phase

{type:"work_phase", state:"start"|"end", phase:"coding"|"testing"|"preflight"|"other", stage?, runId, sessionId?, agentId?, item?, pr?, outcome?}

runId is the lifecycle identity. An unmatched start has outcome unknown.

### tool_call

{type:"tool_call", state:"start"|"success"|"failure"|"cancelled"|"unknown", sessionId, agentId, toolUseId, tool, item?, parentRunId?, outcome?}

The compound identity is (sessionId, agentId, toolUseId). A missing terminal event means only tool outcome not observed.

### notification

{type:"notification", reason:"next_prompt"|"permission"|"question"|"background_complete"|"system_notice", text?}

Only permission and question request human input.

### recovery provenance

A retrospectively recovered pr_ref keeps t equal to the transcript observation time and adds recordedAt, recovery:"transcript", and evidenceRef. Narrative prose alone is not authoritative PR state.

### validation check

{type:"ci", pr, repo?, status:"pending"|"pass"|"fail"|"unknown", checks?:[{name,status,required:boolean}], fetchedAt?}

An in-progress advisory check does not make gating validation pending.

### assessment

{type:"assessment", subject:"roadmap", value, text, evidenceRef?}

Assessments are explicit agent claims, not authoritative task state.
~~~

- [ ] **Step 4: Add the minimal exported module shell and verify GREEN**

Create public/session-insights-model.js:

~~~js
export const ACTIVE_GAP_MS = 10 * 60 * 1000;

export function buildSessionInsights(events, { untilT = Infinity, displayNow } = {}) {
  const prefix = events.filter(e => Number.isFinite(e.t) && e.t <= untilT)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.t - b.e.t || a.i - b.i)
    .map(x => x.e);
  const now = displayNow ?? (Number.isFinite(untilT) ? untilT : (prefix.at(-1)?.t ?? 0));
  const phases = [];
  const starts = new Map();
  const tools = new Map();
  for (const e of prefix) {
    if (e.type === 'work_phase' && e.state === 'start') starts.set(e.runId, e);
    if (e.type === 'work_phase' && e.state === 'end' && starts.has(e.runId)) {
      const start = starts.get(e.runId);
      phases.push({ startT: start.t, endT: e.t, phase: start.phase, stage: start.stage ?? null, disposition: 'active', wallCategory: start.phase, confidence: 'explicit', source: 'work_phase', evidenceEventIds: [start.id, e.id].filter(Boolean) });
    }
    if (e.type === 'tool_call') {
      const key = [e.sessionId, e.agentId, e.toolUseId];
      const k = key.join('\u0000');
      if (e.state === 'start') tools.set(k, { key, startT: e.t, endT: null, tool: e.tool, outcome: 'unknown', evidenceEventIds: [e.id].filter(Boolean) });
      else if (tools.has(k)) Object.assign(tools.get(k), { endT: e.t, outcome: e.state, evidenceEventIds: [...tools.get(k).evidenceEventIds, e.id].filter(Boolean) });
    }
  }
  return { asOfT: prefix.at(-1)?.t ?? 0, bounds: { recordedStart: prefix[0]?.t ?? 0, recordedEnd: prefix.at(-1)?.t ?? 0, displayNow: now, producerStart: null, producerEnd: null }, clocks: {}, lifecycle: {}, phases, phaseTotals: { byWallCategory: {}, percentages: {} }, prStack: { prs: [], recordedRoots: [], currentRoots: [] }, toolCalls: { lifecycles: [...tools.values()], pointObservations: [], matchedTranscriptPairs: 0, tapeObservations: 0, missingOutcomeCount: [...tools.values()].filter(x => !x.endT).length }, blockers: [], roadmap: {}, attributionGaps: [], diagnostics: [] };
}
~~~

Run: node --test test/session-insights-model.test.mjs

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add docs/EVENTS.md public/session-insights-model.js test/session-insights-model.test.mjs
git commit -m "feat: define semantic session event contract"
~~~

### Task 2: Derive replay-safe bounds, lifecycle, phases, and clocks

**Files:**
- Modify: public/session-insights-model.js
- Modify: test/session-insights-model.test.mjs

**Interfaces:**
- Consumes: buildSessionInsights(events, {untilT, displayNow}).
- Produces: visiblePrefix, bounds, clocks, lifecycle, phases, phaseTotals, blockers; all returned objects use the field names in this plan header.

- [ ] **Step 1: Add failing normalization and clock tests**

Add tests covering stable sort, retractions, cutoff, explicit closures, ten-minute activity cap, and human wait:

~~~js
test('wall categories exactly partition recorded time without heartbeat work', () => {
  const H = 60 * 60 * 1000;
  const events = [
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 1000, id: 'prompt', type: 'item', id: 'turn-1', status: 'doing' },
    { t: 2 * H, id: 'edit', type: 'edit', path: 'src/a.js' },
    { t: 2 * H + 60_000, id: 'alive', type: 'alive' },
    { t: 4 * H, id: 'idle', type: 'session', phase: 'idle' },
    { t: 5 * H, id: 'attention', type: 'notification', reason: 'next_prompt' },
  ];
  const x = buildSessionInsights(events, { untilT: 5 * H, displayNow: 7 * H });
  const total = Object.values(x.phaseTotals.byWallCategory).reduce((a, b) => a + b, 0);
  assert.equal(total, x.clocks.recordedSessionMs);
  assert.equal(Math.round(Object.values(x.phaseTotals.percentages).reduce((a, b) => a + b, 0)), 100);
  assert.equal(x.bounds.recordedEnd, 5 * H);
  assert.equal(x.clocks.liveHumanWaitMs, 2 * H);
  assert.equal(x.lifecycle.turn, 'complete');
  assert.equal(x.lifecycle.nextActor, 'human');
});

test('retracted evidence and events after replay cutoff are invisible', () => {
  const events = [
    { t: 0, type: 'session', phase: 'start' },
    { t: 10, id: 'bad', type: 'edit', path: 'bad.js' },
    { t: 20, type: 'retract', target: { event: 'bad' } },
    { t: 30, id: 'future', type: 'edit', path: 'future.js' },
  ];
  const x = buildSessionInsights(events, { untilT: 25, displayNow: 25 });
  assert.ok(x.phases.every(p => !p.evidenceEventIds.includes('bad') && !p.evidenceEventIds.includes('future')));
});
~~~

- [ ] **Step 2: Run the focused test and verify RED**

Run: node --test test/session-insights-model.test.mjs

Expected: FAIL because clocks and phase coverage are absent.

- [ ] **Step 3: Implement pure normalization and derivation helpers**

Replace the module shell with focused private functions:

~~~js
export const ACTIVE_GAP_MS = 10 * 60 * 1000;
const WALL = ['coding', 'testing', 'preflight', 'other', 'waiting', 'idle', 'unknown'];
const PRODUCER = new Set(['say', 'tool', 'tool_call', 'edit', 'commit', 'todos', 'item', 'work_phase']);
const PASSIVE = new Set(['alive', 'usage', 'pr', 'pr_ref', 'ci']);

function visiblePrefix(events, untilT) {
  const retractedEvents = new Set();
  const retractedItems = new Set();
  for (const e of events) {
    if (e.type !== 'retract') continue;
    if (e.target?.event) retractedEvents.add(e.target.event);
    if (e.target?.item) retractedItems.add(e.target.item);
  }
  return events.map((e, i) => ({ e, i }))
    .filter(({ e }) => Number.isFinite(e.t) && e.t <= untilT && e.type !== 'retract' && !retractedEvents.has(e.id) && !retractedItems.has(e.id) && !retractedItems.has(e.item))
    .sort((a, b) => a.e.t - b.e.t || a.i - b.i).map(x => x.e);
}

function unionIntervals(intervals) {
  const sorted = intervals.filter(x => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const pair of sorted) {
    const last = out.at(-1);
    if (!last || pair[0] > last[1]) out.push([...pair]);
    else last[1] = Math.max(last[1], pair[1]);
  }
  return out;
}
~~~

Implement deriveBounds, deriveLifecycle, deriveSemanticSpans, partitionWallTime, and deriveBlockers with the precedence from the design spec. partitionWallTime must split at every boundary, choose disposition before phase, fill every gap with idle or unknown, and coalesce adjacent equal spans. Treat declared work_phase spans as explicit; test/build commands as strong testing; edits/commits as heuristic coding; declared preflight evidence as strong preflight; all other producer evidence as other. Cap inferred active continuity at ACTIVE_GAP_MS. Ignore PASSIVE events as active evidence.

- [ ] **Step 4: Run model tests and verify GREEN**

Run: node --test test/session-insights-model.test.mjs

Expected: PASS, including exact partition and no heartbeat inflation.

- [ ] **Step 5: Add property cases and run full suite**

Add a deterministic loop that generates 100 small event sequences and asserts non-overlap, non-negative duration, full coverage, and 100 percent totals. Add explicit tests for preflight skill reading remaining other, declared preflight substages, testing outside preflight, conditional PR publishing, concurrent explicit agent-span union, permission/question input, generic next_prompt, and blockers contributing zero duration.

Run: npm test

Expected: all tests pass.

- [ ] **Step 6: Commit**

~~~bash
git add public/session-insights-model.js test/session-insights-model.test.mjs
git commit -m "feat: derive semantic session clocks and phases"
~~~

### Task 3: Fold tools, PR registry, topology, roadmap, and provenance

**Files:**
- Modify: public/session-insights-model.js
- Modify: test/session-insights-model.test.mjs

**Interfaces:**
- Consumes: visible replay prefix and recordedEnd from Task 2.
- Produces: toolCalls, prStack, roadmap, attributionGaps, diagnostics.

- [ ] **Step 1: Add failing truth-axis tests**

Add inline tests that assert:

~~~js
test('recorded and post-session current PR truth remain separate', () => {
  const events = [
    { t: 0, type: 'session', phase: 'start' },
    { t: 10, id: 'p1', source: 'poll-github', type: 'pr', repo: 'o/r', number: 1, state: 'open', base: null },
    { t: 20, id: 'c1', source: 'poll-github', type: 'ci', repo: 'o/r', pr: 1, status: 'pending' },
    { t: 30, type: 'notification', reason: 'next_prompt' },
    { t: 40, id: 'c2', source: 'poll-github', type: 'ci', repo: 'o/r', pr: 1, status: 'pass', checks: [{ name: 'required', status: 'pass', required: true }, { name: 'bot', status: 'pending', required: false }], fetchedAt: 40 },
  ];
  const x = buildSessionInsights(events, { untilT: 40, displayNow: 40 });
  const pr = x.prStack.prs[0];
  assert.equal(pr.recorded.validation, 'pending');
  assert.equal(pr.current.validation, 'pass');
  assert.equal(pr.current.advisoryRunning, 1);
  assert.equal(x.lifecycle.nextActor, 'human');
});

test('recovered references join the registry at observation time, not recordedAt', () => {
  const events = [
    { t: 0, type: 'session', phase: 'start' },
    { t: 20, id: 'r', source: 'recovery', type: 'pr_ref', repo: 'o/r', number: 104, url: 'https://github.com/o/r/pull/104', recordedAt: 1000, recovery: 'transcript', evidenceRef: 'subagent-result' },
  ];
  assert.equal(buildSessionInsights(events, { untilT: 19 }).prStack.prs.length, 0);
  assert.equal(buildSessionInsights(events, { untilT: 20 }).prStack.prs[0].discovery.kind, 'recovered');
});

test('an unmatched tool start is unknown outcome, never blocked or running', () => {
  const x = buildSessionInsights([
    { t: 0, type: 'session', phase: 'start', sessionId: 's' },
    { t: 10, type: 'tool_call', state: 'start', sessionId: 's', agentId: 'a', toolUseId: 'u', tool: 'Bash' },
  ], { untilT: 10, displayNow: 20 });
  assert.equal(x.toolCalls.missingOutcomeCount, 1);
  assert.equal(x.toolCalls.lifecycles[0].outcome, 'unknown');
  assert.ok(x.blockers.every(b => b.kind !== 'permission_block'));
});
~~~

- [ ] **Step 2: Run the focused test and verify RED**

Run: node --test test/session-insights-model.test.mjs

Expected: FAIL because PR, roadmap, and complete tool folds are absent.

- [ ] **Step 3: Implement the remaining pure folds**

Implement:

~~~js
function prKey(e) {
  return (e.repo || repoFromUrl(e.url) || 'unknown') + '#' + e.number;
}

function validationOf(ci) {
  const checks = Array.isArray(ci?.checks) ? ci.checks : [];
  const required = checks.filter(c => c.required !== false);
  if (required.some(c => c.status === 'fail')) return 'fail';
  if (required.some(c => c.status === 'pending')) return 'pending';
  if (required.length && required.every(c => ['pass', 'neutral', 'skipped'].includes(c.status))) return 'pass';
  return ci?.status || 'unknown';
}
~~~

derivePrStack must union pr and pr_ref by repo-qualified key, preserve discovery evidence, split facts at recordedEnd, calculate recordedRoots and currentRoots from authoritative base facts only, count advisory pending checks separately, and never infer topology from number or title. foldToolCalls must isolate the compound identity, retain legacy point observations separately, accept transcript_metrics events for matchedTranscriptPairs and tapeObservations, and close no lifecycle implicitly. deriveRoadmap must retain the latest todos snapshot, compute completed/total, retain the latest roadmap assessment, and mark staleSnapshot when later assessment/handoff evidence conflicts. attributionGaps must list unattributed PRs and producer events. diagnostics must identify stale/missing poller, recovery, conflicting lifecycle, and unclassified spans.

- [ ] **Step 4: Run focused and full tests**

Run: node --test test/session-insights-model.test.mjs

Expected: PASS.

Run: npm test

Expected: all tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add public/session-insights-model.js test/session-insights-model.test.mjs
git commit -m "feat: fold session artifacts and provenance"
~~~

### Task 4: Lock the sanitized reference-session acceptance fixture

**Files:**
- Create: test/tapes/semantic-reference.jsonl
- Modify: test/session-insights-model.test.mjs

**Interfaces:**
- Consumes: buildSessionInsights from Tasks 1–3.
- Produces: a stable retrospective acceptance oracle used by view tests.

- [ ] **Step 1: Create the minimized fixture**

Build test/tapes/semantic-reference.jsonl from the reference prefix ending at 1700041531012. Keep only session/turn boundaries, two prompt cards, representative implementation/test/preflight evidence, final 8/10 todos, six structured recorded PRs, recorded CI, a recovered #104 reference at its transcript observation t, post-session current PR/CI facts, the final notification, and aggregate transcript_metrics {matchedToolPairs:345,tapeToolObservations:587}. Replace command payloads with neutral labels. Shift the epoch by a fixed offset while preserving relative durations, and use synthetic repository, PR, and topology identifiers.

Use these fixed acceptance facts:

~~~js
const AUDIT = {
  finalAttentionT: 1700041531012,
  structuredPrs: [101, 102, 103, 105, 106, 107],
  recoveredPr: 104,
  recordedBase: { 101: null, 102: 101, 103: 101, 105: 102, 106: 102, 107: 102 },
  currentBase: { 101: null, 102: 101, 103: 102, 104: 102, 105: 102, 106: 102, 107: 102 },
  recordedCi: { 101: 'pass', 102: 'pending', 103: 'pending', 105: 'pass', 106: 'pending', 107: 'pending' },
  currentCi: { 101: 'pass', 102: 'pass', 103: 'pass', 104: 'pass', 105: 'pass', 106: 'pass', 107: 'pass' },
};
~~~

- [ ] **Step 2: Add failing golden assertions**

Read the JSONL and assert recordedSessionMs is within one minute of 11h32m, producerWindowMs within one minute of 11h29m, 7 open/0 merged after recovery, recorded/current topology, recorded/current CI, #106 advisory running only, 8/10 checklist and stale snapshot, human next actor, turn complete, session open, no missing transcript tool result, separate 345 and 587 provenance metrics, and recovered #104 invisibility immediately before its observation time.

- [ ] **Step 3: Run the golden test and verify RED**

Run: node --test test/session-insights-model.test.mjs

Expected: FAIL on at least one fixture-derived assertion until fixture fields and model edge cases agree.

- [ ] **Step 4: Make only fixture/model corrections required by the golden contract**

Keep model logic general. Do not special-case session id, PR number, or title. Any correction must be covered by a small inline test before changing the model.

- [ ] **Step 5: Verify and commit**

Run: npm test

Expected: all tests pass.

~~~bash
git add test/tapes/semantic-reference.jsonl test/session-insights-model.test.mjs public/session-insights-model.js
git commit -m "test: lock semantic reference session truth"
~~~

## Self-Review

- Spec coverage: bounds, clocks, lifecycle axes, exclusive phase partition, tool truth, PR registry/topology, recorded/current truth, roadmap conflict, provenance, retractions, replay, and the reference fixture are assigned.
- Placeholder scan: all production interfaces and test commands are concrete.
- Type consistency: every later task consumes buildSessionInsights(events, {untilT, displayNow}) and the return fields defined in Task 1.
