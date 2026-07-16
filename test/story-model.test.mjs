// Story-page layout tests — hermetic, zero-dep (node:test + node:assert). The
// load-bearing derivations of /story are pure (public/story-model.js): beat-run
// grouping, idle-gap separator placement (incl. the intra-chapter attribution
// that seam math misses), day rules, and the wall-clock strip's active segments.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDigest } from '../public/digest.js';
import { buildSessionInsights } from '../public/session-insights-model.js';
import {
  buildStoryBlocks, buildStoryReport, buildStoryNarrativeEvents,
  activeSegments, dayKey, SEPARATOR_GAP_MS,
} from '../public/story-model.js';

const MIN = 60e3, HOUR = 3600e3;

// Chapter stub — only the fields story-model reads (kind, startT, endT).
const ch = (kind, startT, endT, title = '') => ({ kind, startT, endT, title });

// --- activeSegments: the strip is the complement of the idle gaps ------------
test('activeSegments: no gaps → one full segment; gaps carve the complement', () => {
  assert.deepEqual(activeSegments(0, 100, []), [{ fromT: 0, toT: 100 }]);
  const segs = activeSegments(0, 100, [{ fromT: 20, toT: 50, ms: 30 }, { fromT: 70, toT: 90, ms: 20 }]);
  assert.deepEqual(segs, [
    { fromT: 0, toT: 20 },
    { fromT: 50, toT: 70 },
    { fromT: 90, toT: 100 },
  ]);
});

test('activeSegments: a gap touching an edge yields no zero-length segment', () => {
  const segs = activeSegments(0, 100, [{ fromT: 0, toT: 30, ms: 30 }, { fromT: 60, toT: 100, ms: 40 }]);
  assert.deepEqual(segs, [{ fromT: 30, toT: 60 }]);
});

// --- beat runs ----------------------------------------------------------------
test('consecutive beats collapse into one run; an episode splits runs', () => {
  const chapters = [
    ch('beat', 0, 1 * MIN),
    ch('beat', 2 * MIN, 3 * MIN),
    ch('episode', 4 * MIN, 20 * MIN),
    ch('beat', 21 * MIN, 22 * MIN),
  ];
  const blocks = buildStoryBlocks(chapters, []);
  assert.deepEqual(blocks.map(b => b.kind), ['beats', 'episode', 'beats']);
  assert.equal(blocks[0].chapters.length, 2, 'the first two beats share a run');
  assert.equal(blocks[2].chapters.length, 1, 'the beat after the episode starts fresh');
});

test('empty chapters → no blocks', () => {
  assert.deepEqual(buildStoryBlocks([], []), []);
  assert.deepEqual(buildStoryBlocks(null, []), []);
});

// --- gap separators -------------------------------------------------------------
test('a ≥30min seam gap renders between the two chapters', () => {
  const chapters = [
    ch('episode', 0, HOUR),                       // ends at 1h
    ch('episode', 3 * HOUR, 4 * HOUR),            // next prompt 2h later
  ];
  const gaps = [{ fromT: HOUR, toT: 3 * HOUR, ms: 2 * HOUR }];
  const blocks = buildStoryBlocks(chapters, gaps);
  assert.deepEqual(blocks.map(b => b.kind), ['episode', 'gap', 'episode']);
  assert.equal(blocks[1].ms, 2 * HOUR);
});

test('an intra-chapter gap is attributed to the chapter its silence began in', () => {
  // Chapter A's window runs to the next prompt, so the pre-prompt silence and a
  // stray reconcile event both land inside A: A.endT > gap.toT. Seam math sees
  // no gap (B.startT − A.endT = 0) — the separator must still appear after A.
  const chapters = [
    ch('episode', 0, 10 * HOUR),                  // trailing reconcile at 10h
    ch('episode', 10 * HOUR, 11 * HOUR),
  ];
  const gaps = [{ fromT: HOUR, toT: 9 * HOUR, ms: 8 * HOUR }];
  const blocks = buildStoryBlocks(chapters, gaps);
  assert.deepEqual(blocks.map(b => b.kind), ['episode', 'gap', 'episode']);
  assert.equal(blocks[1].ms, 8 * HOUR);
});

test('multiple big gaps inside one chapter merge into one separator', () => {
  const chapters = [
    ch('episode', 0, 10 * HOUR),
    ch('episode', 10 * HOUR, 11 * HOUR),
  ];
  const gaps = [
    { fromT: HOUR, toT: 3 * HOUR, ms: 2 * HOUR },
    { fromT: 4 * HOUR, toT: 9 * HOUR, ms: 5 * HOUR },
  ];
  const blocks = buildStoryBlocks(chapters, gaps);
  const gapBlocks = blocks.filter(b => b.kind === 'gap');
  assert.equal(gapBlocks.length, 1, 'one merged separator, not two in a row');
  assert.equal(gapBlocks[0].ms, 7 * HOUR);
  assert.equal(gapBlocks[0].count, 2);
});

test('gaps under the threshold render nothing; exactly 30min counts', () => {
  const chapters = [ch('episode', 0, HOUR), ch('episode', 2 * HOUR, 3 * HOUR)];
  const under = buildStoryBlocks(chapters, [{ fromT: HOUR, toT: HOUR + 29 * MIN, ms: 29 * MIN }]);
  assert.ok(!under.some(b => b.kind === 'gap'), '29min is not a pause line');
  const at = buildStoryBlocks(chapters, [{ fromT: HOUR, toT: HOUR + 30 * MIN, ms: SEPARATOR_GAP_MS }]);
  assert.ok(at.some(b => b.kind === 'gap'), 'exactly 30min is (≥, per spec)');
});

test('a gap separator breaks a beat run in two', () => {
  const chapters = [
    ch('beat', 0, MIN),
    ch('beat', 9 * HOUR, 9 * HOUR + MIN),
  ];
  const gaps = [{ fromT: MIN, toT: 9 * HOUR, ms: 9 * HOUR - MIN }];
  const blocks = buildStoryBlocks(chapters, gaps);
  assert.deepEqual(blocks.map(b => b.kind), ['beats', 'gap', 'beats'],
    'idle is a scene change — the dialogue does not read as continuous across it');
});

// --- day rules ------------------------------------------------------------------
// Local-time construction keeps these hermetic across timezones (same trick as
// lanes-model's dayBoundaries test).
test('multi-day tape: a day rule before the first chapter and at each day change', () => {
  const d1 = new Date(2024, 0, 1, 22, 0).getTime();   // Jan 1 22:00 local
  const d2 = new Date(2024, 0, 2, 1, 0).getTime();    // Jan 2 01:00 local
  const d2b = new Date(2024, 0, 2, 9, 0).getTime();   // Jan 2 09:00 local
  const chapters = [
    ch('episode', d1, d1 + HOUR),
    ch('episode', d2, d2 + HOUR),
    ch('beat', d2b, d2b + MIN),
  ];
  const blocks = buildStoryBlocks(chapters, []);
  assert.deepEqual(blocks.map(b => b.kind), ['day', 'episode', 'day', 'episode', 'beats']);
  assert.equal(blocks[0].t, d1, 'day 1 is labeled too, not just day 2');
  assert.equal(blocks[2].t, d2);
  assert.ok(dayKey(blocks[0].t) !== dayKey(blocks[2].t));
});

test('single-day tape: no day rules at all', () => {
  const t0 = new Date(2024, 0, 1, 9, 0).getTime();
  const blocks = buildStoryBlocks([
    ch('episode', t0, t0 + HOUR),
    ch('beat', t0 + 2 * HOUR, t0 + 2 * HOUR + MIN),
  ], []);
  assert.ok(!blocks.some(b => b.kind === 'day'));
});

test('a day rule also closes an open beat run', () => {
  const n1 = new Date(2024, 0, 1, 23, 0).getTime();
  const n2 = new Date(2024, 0, 2, 0, 30).getTime();
  const blocks = buildStoryBlocks([
    ch('beat', n1, n1 + MIN),
    ch('beat', n2, n2 + MIN),
  ], []);
  assert.deepEqual(blocks.map(b => b.kind), ['day', 'beats', 'day', 'beats']);
  assert.equal(blocks[1].chapters.length, 1);
  assert.equal(blocks[3].chapters.length, 1);
});

// --- ordering: gap then day rule then chapter -----------------------------------
test('when idle crosses midnight, the pause line precedes the new day rule', () => {
  const n1 = new Date(2024, 0, 1, 20, 0).getTime();
  const n2 = new Date(2024, 0, 2, 8, 0).getTime();
  const chapters = [
    ch('episode', n1, n1 + HOUR),
    ch('episode', n2, n2 + HOUR),
  ];
  const gaps = [{ fromT: n1 + HOUR, toT: n2, ms: n2 - (n1 + HOUR) }];
  const blocks = buildStoryBlocks(chapters, gaps);
  assert.deepEqual(blocks.map(b => b.kind), ['day', 'episode', 'gap', 'day', 'episode'],
    '…slept 11h, then a new day began — that is the reading order');
});

function referenceInsights() {
  const events = readFileSync(new URL('./tapes/semantic-reference.jsonl', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  return buildSessionInsights(events, { untilT: Infinity, displayNow: events.at(-1).t });
}

test('morning report distinguishes checklist progress from product-roadmap progress', () => {
  const report = buildStoryReport(referenceInsights());

  assert.equal(report.headline, '7 PRs opened · 0 merged · 7 without explicit milestone attribution');
  assert.equal(report.checklist.label, 'Session checklist: 8/10');
  assert.deepEqual(report.checklist.remaining, ['Roadmap', 'Final handoff']);
  assert.equal(report.roadmap.label, 'Product roadmap: roughly one-third');
  assert.deepEqual(report.roadmap.milestones, [
    { label: 'M1', progress: 'complete' },
    { label: 'M2', progress: 'first slice complete' },
    { label: 'M3', progress: 'first slice complete' },
    { label: 'M4–M7', progress: 'not started' },
  ]);
  assert.equal(report.roadmap.assessmentConfidence, 'Agent assessment · recovered evidence');
  assert.equal(report.roadmap.staleSnapshot, true);
  assert.match(report.roadmap.staleWarning, /checklist snapshot is stale/i);
  assert.deepEqual(report.roadmap.evidenceEventIds, ['final-todos', 'roadmap-assessment']);
});

test('morning report names the current disposition, blocker, next action, and uncertainty', () => {
  const report = buildStoryReport(referenceInsights());

  assert.equal(report.disposition.state, 'attention');
  assert.equal(report.disposition.label, 'Waiting for your next instruction');
  assert.equal(
    report.disposition.detail,
    'Turn complete · session open · human is next actor · no tool outcome is missing',
  );
  assert.equal(report.disposition.currentBlocker, 'No execution blocker');
  assert.notEqual(report.disposition.state, 'blocked');
  assert.equal(report.disposition.nextAction, 'Human: provide the next instruction');
  assert.equal(report.disposition.confidence, 'Explicit lifecycle evidence');
  assert.equal(report.disposition.uncertainty, null);
});

test('an unmatched tool outcome is uncertainty and never blocked without explicit permission evidence', () => {
  const insights = buildSessionInsights([
    { t: 0, id: 'start', type: 'session', phase: 'start', sessionId: 's' },
    { t: 10, id: 'tool-start', type: 'tool_call', state: 'start', sessionId: 's', agentId: 'a', toolUseId: 'u', tool: 'Bash' },
    { t: 20, id: 'attention', type: 'notification', reason: 'next_prompt' },
  ], { untilT: 20, displayNow: 20 });
  const report = buildStoryReport(insights);

  assert.equal(report.disposition.state, 'attention');
  assert.notEqual(report.disposition.state, 'blocked');
  assert.equal(report.disposition.currentBlocker, 'No execution blocker');
  assert.deepEqual(report.disposition.uncertainty, {
    kind: 'tool_outcome_unknown',
    label: '1 tool outcome not observed',
    detail: 'Outcome uncertainty is not evidence of blocked or running work.',
    confidence: 'Explicit unmatched tool lifecycle',
  });
});

test('an explicit permission request is the blocked branch', () => {
  const insights = buildSessionInsights([
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 10, id: 'permission', type: 'notification', reason: 'permission' },
  ], { untilT: 10, displayNow: 10 });
  const report = buildStoryReport(insights);

  assert.equal(report.disposition.state, 'blocked');
  assert.equal(report.disposition.currentBlocker, 'Permission decision required');
  assert.equal(report.disposition.uncertainty, null);
});

test('morning report phases expose duration, percentage, evidence, and confidence in text', () => {
  const report = buildStoryReport(referenceInsights());
  const preflight = report.phases.find(phase => phase.category === 'preflight');
  const longestUnknown = report.intervals.find(interval => interval.category === 'unknown');

  assert.ok(report.phases.some(phase => phase.category === 'coding'));
  assert.ok(report.phases.some(phase => phase.category === 'testing'));
  assert.ok(preflight.durationMs > 0);
  assert.ok(preflight.percent > 0);
  assert.ok(preflight.evidenceEventIds.length > 0);
  assert.match(preflight.confidenceText, /(explicit|strong|heuristic)/i);
  assert.ok(longestUnknown.durationMs > 0);
  assert.equal(longestUnknown.label, 'Longest unknown interval');
});

test('morning report PR stack preserves topology and gates without inventing milestone completion', () => {
  const report = buildStoryReport(referenceInsights());

  assert.equal(report.prs.length, 7);
  const plan = report.prs.find(pr => pr.number === 101);
  assert.equal(plan.milestone, 'Unassigned');
  assert.equal(plan.progress, 'PR contribution not explicitly attributed');
  assert.match(plan.milestoneConfidence, /no explicit milestone attribution/i);

  const pr102 = report.prs.find(pr => pr.number === 102);
  assert.equal(pr102.milestone, 'Unassigned');
  assert.equal(pr102.progress, 'PR contribution not explicitly attributed');
  assert.equal(pr102.recordedTruth, 'Recorded: open · gates pending');
  assert.equal(pr102.currentTruth, 'Current: open · gates pass');
  assert.equal(pr102.recordedTopology, 'Recorded parent: #101');
  assert.equal(pr102.currentTopology, 'Current parent: #101');
  assert.equal(pr102.changedSinceRecording, true);
  assert.match(pr102.provenance, /authoritative.*poll-github/i);
  assert.ok(pr102.evidenceEventIds.length >= 4);

  const pr103 = report.prs.find(pr => pr.number === 103);
  assert.equal(pr103.milestone, 'Unassigned');
  assert.equal(pr103.recordedTopology, 'Recorded parent: #101');
  assert.equal(pr103.currentTopology, 'Current parent: #102');

  const pr104 = report.prs.find(pr => pr.number === 104);
  assert.equal(pr104.milestone, 'Unassigned');
  assert.equal(pr104.recordedTruth, 'Recorded: unavailable');
  assert.equal(pr104.currentTruth, 'Current: open · gates pass');
  assert.match(pr104.provenance, /recovered from transcript/i);

  const pr106 = report.prs.find(pr => pr.number === 106);
  assert.equal(pr106.currentTruth, 'Current: open · gates pass · 1 advisory running');
  assert.ok(report.prs.every(pr => pr.progress !== 'Complete'));
  assert.deepEqual(report.prClassifications, { plan: 0, feature: 0, unassigned: 7 });
});

test('an explicit milestone on a recorded PR event survives canonical projection', () => {
  const insights = buildSessionInsights([
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    {
      t: 10, id: 'pr-10', type: 'pr', repo: 'acme/widgets', number: 10,
      title: 'A title that is not used for classification', state: 'open',
      milestone: 'M1b', source: 'poll-github',
    },
    { t: 20, id: 'say-20', type: 'say', text: 'Recorded after the PR snapshot.' },
  ], { untilT: 20, displayNow: 20 });

  const [pr] = buildStoryReport(insights).prs;
  assert.equal(pr.milestone, 'M1b');
  assert.equal(pr.milestoneClassification, 'feature');
  assert.equal(pr.milestoneConfidence, 'Explicit recorded milestone attribution');
});

test('PR report keeps occurrence, observation, recording, and current fetch times separate', () => {
  const report = buildStoryReport(referenceInsights());
  const pr102 = report.prs.find(pr => pr.number === 102);
  const pr104 = report.prs.find(pr => pr.number === 104);

  assert.deepEqual({
    occurredAt: pr102.occurredAt,
    observedAt: pr102.observedAt,
    recordedAt: pr102.recordedAt,
    recordedPrAt: pr102.recordedPrAt,
    currentPrAt: pr102.currentPrAt,
    currentFetchedAt: pr102.currentFetchedAt,
  }, {
    occurredAt: 1700002888101,
    observedAt: 1700004026186,
    recordedAt: 1700004026186,
    recordedPrAt: 1700004026186,
    currentPrAt: 1700120426301,
    currentFetchedAt: 1700120426302,
  });
  assert.equal(pr104.occurredAt, null);
  assert.equal(pr104.observedAt, 1700004331705);
  assert.equal(pr104.recordedAt, 1700120426101);
  assert.equal(pr104.recordedPrAt, null);
  assert.equal(pr104.currentPrAt, 1700120426501);
  assert.equal(pr104.currentFetchedAt, 1700120426502);
  assert.equal(pr104.replayT, pr104.observedAt, 'replay starts when recovery evidence became visible');
});

test('reference narrative input freezes at recorded end and semantic clocks retain the canonical timing probe', () => {
  const insights = referenceInsights();
  const narrativeEvents = buildStoryNarrativeEvents(insights);
  const digest = buildDigest(narrativeEvents, Infinity);
  const hours = value => Number((value / HOUR).toFixed(3));

  assert.deepEqual({
    recorded: hours(insights.clocks.recordedSessionMs),
    observed: hours(insights.clocks.observedActiveMs),
    idle: hours(insights.clocks.inferredIdleMs),
    unknown: hours(insights.clocks.unclassifiedMs),
  }, { recorded: 11.536, observed: 0.793, idle: 0.05, unknown: 1.673 });
  assert.ok(narrativeEvents.every(event => event.t <= insights.bounds.recordedEnd));
  assert.ok(narrativeEvents.every(event => !String(event.id).startsWith('current-')));
  assert.ok(digest.endT <= insights.bounds.recordedEnd);
  assert.ok(digest.wallMs < 12 * HOUR, 'post-recorded reconciliation cannot make a 33h narrative');
});

test('unattached activity is appended from canonical attribution gaps and recovers PR 104', () => {
  const insights = referenceInsights();
  const blocks = buildStoryBlocks([
    ch('episode', insights.bounds.recordedStart, insights.bounds.recordedEnd, 'Recorded work'),
  ], [], insights);
  const unattached = blocks.at(-1);

  assert.equal(unattached.kind, 'unattached');
  assert.equal(unattached.title, 'Unattached activity');
  assert.ok(unattached.prs.some(pr => pr.number === 104));
  assert.match(unattached.prs.find(pr => pr.number === 104).provenance, /recovered from transcript/i);
  assert.ok(unattached.evidenceEventIds.includes('recovered-pr-104'));
  assert.equal(unattached.confidence, 'Recorded artifacts · chapter attribution unavailable');
});
