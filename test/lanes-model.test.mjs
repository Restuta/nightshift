// Lane-timeline model tests — hermetic, zero-dep (node:test + node:assert).
// Run: npm test. The load-bearing derivations of the /lanes page are pure
// (public/lanes-model.js), so they're tested here on a golden tape and on small
// inline arrays: episode splitting at gaps, top-N lane selection, and mark
// extraction (commits / PR open+merge / CI fail / attention / day boundaries).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  splitEpisodes, buildItems, selectLanes, sessionPhases, attentionMarks,
  dayBoundaries, densityTimes, buildModel, applyRetractions,
  EPISODE_GAP_MS, TOP_ITEMS, DAY_MS,
} from '../public/lanes-model.js';
import { fold } from '../public/reducer.js';
import { ACTIVE_GAP_MS, buildSessionInsights } from '../public/session-insights-model.js';
import { parseViewContext } from '../public/session-view-context.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TAPES = path.join(here, 'tapes');
const readTape = f => fs.readFileSync(path.join(TAPES, f), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l));

// --- splitEpisodes: a >gap silence starts a new episode -----------------------
test('splitEpisodes groups consecutive activity and splits on gaps', () => {
  const gap = EPISODE_GAP_MS;
  const ts = [0, 60e3, 120e3, /* gap */ 120e3 + gap + 1, 120e3 + gap + 61e3];
  const eps = splitEpisodes(ts, gap);
  assert.equal(eps.length, 2, 'one gap wider than EPISODE_GAP_MS → two episodes');
  assert.deepEqual([eps[0].start, eps[0].end], [0, 120e3]);
  assert.equal(eps[0].count, 3);
  assert.equal(eps[1].count, 2);
});

test('splitEpisodes: unsorted input is sorted; empty → []', () => {
  assert.deepEqual(splitEpisodes([]), []);
  const eps = splitEpisodes([300e3, 0, 60e3], EPISODE_GAP_MS);
  assert.equal(eps.length, 1);
  assert.deepEqual([eps[0].start, eps[0].end, eps[0].count], [0, 300e3, 3]);
});

test('splitEpisodes: a gap exactly equal to the threshold stays one episode', () => {
  const eps = splitEpisodes([0, EPISODE_GAP_MS], EPISODE_GAP_MS); // diff == gap, not >
  assert.equal(eps.length, 1);
});

// --- buildItems / mark extraction on the golden tape --------------------------
test('buildItems extracts episodes and marks from the golden lanes tape', () => {
  const items = buildItems(readTape('lanes.jsonl'));
  const hot = items.get('wi-hot');
  const warm = items.get('wi-warm');
  assert.ok(hot && warm, 'both items are reconstructed');

  // wi-hot: edits at 2,3,6,20min + commit(4) + tool(5) + say(9) → gap 9→20min
  // (11min > 10min) splits into two episodes.
  assert.equal(hot.episodes.length, 2, 'the 11-minute silence splits wi-hot into two episodes');
  assert.equal(hot.commits, 1);
  assert.equal(hot.commitMarks.length, 1);
  assert.equal(hot.commitMarks[0].sha, 'c1a2b3c');

  // PR marks: one open, one merged (the merge event carries no item — matched by
  // number to the card that opened it).
  const kinds = hot.prMarks.map(p => p.kind).sort();
  assert.deepEqual(kinds, ['merged', 'open']);
  assert.equal(hot.ciMarks.filter(c => c.status === 'fail').length, 1, 'the CI failure is captured');

  assert.equal(warm.episodes.length, 1);
  assert.equal(warm.commitMarks.length, 0);
  assert.ok(hot.activity > warm.activity, 'wi-hot outranks wi-warm on activity');
});

// --- selectLanes: top-N and the "…n more" remainder ---------------------------
test('selectLanes returns the golden tape items, no overflow', () => {
  const { lanes, more } = selectLanes(buildItems(readTape('lanes.jsonl')));
  assert.deepEqual(lanes.map(l => l.id), ['wi-hot', 'wi-warm'], 'newest-active first');
  assert.equal(more.length, 0);
});

test('selectLanes caps visible lanes at TOP_ITEMS and collapses the rest', () => {
  // 15 items with strictly decreasing activity (item-01 busiest). Each edit is
  // explicitly attributed so ranking is deterministic.
  const evs = [{ t: 0, type: 'session', phase: 'start', title: 'many' }];
  let t = 1000;
  for (let i = 1; i <= 15; i++) {
    const id = 'it-' + String(i).padStart(2, '0');
    evs.push({ t: t++, type: 'item', id, title: id, status: 'doing' });
    for (let k = 0; k < (16 - i); k++) evs.push({ t: t++, type: 'edit', path: 'f', item: id });
  }
  const { lanes, more } = selectLanes(buildItems(evs));
  assert.equal(lanes.length, TOP_ITEMS, 'exactly the top 12 get a lane');
  assert.equal(more.length, 3, 'the remaining 3 collapse into "…n more"');
  // the busiest 12 are it-01..it-12; the collapsed 3 are the least active.
  const moreIds = more.map(m => m.id).sort();
  assert.deepEqual(moreIds, ['it-13', 'it-14', 'it-15']);
  // items with zero activity never earn a lane
  const none = selectLanes(buildItems([{ t: 0, type: 'item', id: 'ghost', status: 'inbox' }]));
  assert.equal(none.lanes.length, 0);
});

// --- session lane pieces ------------------------------------------------------
test('sessionPhases yields working/attention/idle strips; activity re-wakes', () => {
  const evs = readTape('lanes.jsonl');
  const t0 = evs[0].t, t1 = evs[evs.length - 1].t;
  const phases = sessionPhases(evs, t0, t1);
  const seq = phases.map(p => p.phase);
  assert.ok(seq.includes('attention'), 'the attention window is a strip');
  assert.ok(seq.includes('idle'), 'the final idle is a strip');
  // strips are contiguous and non-overlapping
  for (let i = 1; i < phases.length; i++) assert.ok(phases[i].start >= phases[i - 1].end);

  // awake(): an edit during an idle window flips the strip back to working.
  const woke = sessionPhases([
    { t: 0, type: 'session', phase: 'start' },
    { t: 100, type: 'session', phase: 'idle' },
    { t: 200, type: 'edit', path: 'f' },
  ], 0, 300);
  assert.equal(woke[woke.length - 1].phase, 'working', 'activity re-wakes an idle session');
});

test('attentionMarks + densityTimes pull the right events', () => {
  const evs = readTape('lanes.jsonl');
  const att = attentionMarks(evs);
  assert.equal(att.length, 1);
  assert.match(att[0].text, /permission/);
  // density = say + tool only (say@9min, tool@5min, tool@15min)
  assert.equal(densityTimes(evs).length, 3);
});

// --- day boundaries -----------------------------------------------------------
test('dayBoundaries: none within 24h, one per midnight across a multi-day span', () => {
  assert.deepEqual(dayBoundaries(0, DAY_MS), [], 'a <=24h span has no day lines');
  const start = new Date(2024, 0, 1, 18, 0, 0).getTime(); // Jan 1 18:00 local
  const end = new Date(2024, 0, 3, 6, 0, 0).getTime();    // Jan 3 06:00 local
  const lines = dayBoundaries(start, end);
  assert.equal(lines.length, 2, 'midnights of Jan 2 and Jan 3');
  for (const m of lines) {
    const d = new Date(m);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
    assert.ok(m > start && m < end);
  }
});

// --- buildModel composes it all, purely, on a real golden tape ----------------
test('buildModel folds the healthy golden tape into a coherent timeline', () => {
  const m = buildModel(readTape('healthy.jsonl'));
  assert.ok(m.t1 > m.t0);
  assert.ok(m.lanes.length >= 1, 'at least one item lane');
  const a = m.lanes.find(l => l.id === 'wi-a');
  assert.ok(a, 'wi-a is a lane');
  assert.equal(a.commitMarks.length, 1, 'the single commit is a mark');
  assert.ok(a.prMarks.some(p => p.kind === 'open'), 'PR open mark');
  assert.ok(a.prMarks.some(p => p.kind === 'merged'), 'PR merge mark');
  assert.equal(m.more.count, 0);
  // buildModel is a pure function of the events — same input, identical output.
  assert.deepEqual(buildModel(readTape('healthy.jsonl')), m);
});

// --- retract: a recording bug is not history, so it must not resurrect on /lanes
// Retraction is META-level (docs/EVENTS.md): a retracted card and everything
// attributed to it vanish from the board, counts, and feed at EVERY scrub time.
// The lanes page is a pure second fold over the same tape, so it must agree with
// the reducer. Without this the junk fixture below resurrected a
// `<task-notification>` lane with a phantom edit (regression guard).
test('applyRetractions drops retracted items, their events, and the retract meta-events', () => {
  const kept = applyRetractions(readTape('junk-cards.jsonl'));
  assert.ok(!kept.some(e => e.type === 'retract'), 'retract meta-events are stripped');
  for (const id of ['junk-1', 'junk-2', 'junk-3', 'junk-4'])
    assert.ok(!kept.some(e => e.type === 'item' && e.id === id), `${id} item upserts dropped`);
  assert.ok(!kept.some(e => e.item && String(e.item).startsWith('junk')),
    'events attributed to a junk card drop out');
  assert.ok(kept.some(e => e.type === 'item' && e.id === 'good-1'), 'the real card survives');
});

test('buildModel honors retract: junk cards get no lane and their activity is uncounted', () => {
  const evs = readTape('junk-cards.jsonl');
  const m = buildModel(evs);
  const shown = [...m.lanes.map(l => l.id)];
  for (const id of ['junk-1', 'junk-2', 'junk-3', 'junk-4'])
    assert.ok(!shown.includes(id), `${id} must not render a lane`);
  // The edit j1 was attributed to junk-1; retracted, it must not be counted on any
  // lane (nor re-attributed to a real card via the activeDoing fallback).
  const laneEdits = m.lanes.reduce((n, l) => n + l.edits, 0) +
    (m.more.episodes || []).reduce((n, e) => n + e.count, 0);
  assert.equal(laneEdits, 0, 'a retracted card leaves no activity in the lanes');
  // Parity with the board: the reducer folds the same tape to zero edits and no
  // junk items — the two second-folds now agree.
  const s = fold(evs);
  assert.equal(s.totals.edits, 0);
  for (const id of ['junk-1', 'junk-2', 'junk-3', 'junk-4'])
    assert.ok(!s.items.has(id), `${id} absent from the reducer too`);
});

test('buildModel honors retract by event id (target.event), dropping the retracted mark', () => {
  const evs = [
    { t: 0, type: 'session', phase: 'start' },
    { t: 1000, type: 'item', id: 'wi-x', title: 'x', status: 'doing' },
    { t: 2000, id: 'e-bad', type: 'commit', sha: 'deadbee', add: 5, del: 1, item: 'wi-x' },
    { t: 3000, id: 'e-good', type: 'commit', sha: 'c0ffee0', add: 2, del: 0, item: 'wi-x' },
    { t: 4000, type: 'retract', target: { event: 'e-bad' }, reason: 'phantom commit' },
  ];
  const x = buildModel(evs).lanes.find(l => l.id === 'wi-x');
  assert.ok(x, 'wi-x still has a lane');
  assert.equal(x.commits, 1, 'only the un-retracted commit is counted');
  assert.deepEqual(x.commitMarks.map(c => c.sha), ['c0ffee0'], 'the retracted commit mark is gone');
});

// --- semantic forensic lanes -------------------------------------------------
test('reference insights become semantic, expanded preflight, and seven-PR rows', () => {
  const events = readTape('semantic-reference.jsonl');
  const insights = buildSessionInsights(events, {
    untilT: Infinity,
    displayNow: events.at(-1).t,
  });
  const context = parseViewContext('?session=reference-session&t=1700041531012&at=1700120426802');
  const m = buildModel(events, insights, context);

  assert.equal(m.semanticRows.primary.length, insights.phases.length,
    'the primary row is the canonical wall-time partition');
  assert.deepEqual(
    [...new Set(m.semanticRows.preflight.map(segment => segment.stage))].sort(),
    ['cross_ai_review', 'local_validation', 'prepare'],
    'preflight is expanded into the canonical substages present on the tape',
  );
  assert.equal(m.semanticRows.prs.length, 7, 'the recovered PR is present in the swimlane');

  const recovered = m.semanticRows.prs.find(row => row.number === 104);
  assert.equal(recovered.recorded, null);
  assert.equal(recovered.current.state, 'open');
  assert.equal(recovered.discovery.kind, 'recovered');
  assert.match(recovered.currentTruth, /^Current: open · validation pass/);
  assert.match(recovered.stackTruth, /Base: #102/);

  const staleThenCurrent = m.semanticRows.prs.find(row => row.number === 102);
  assert.match(staleThenCurrent.recordedTruth, /^Recorded: open · validation pending/);
  assert.match(staleThenCurrent.currentTruth, /^Current: open · validation pass/);
  assert.equal(staleThenCurrent.attention, true, 'recorded/current disagreement is inspectable');
  assert.ok(staleThenCurrent.transitions.some(mark => mark.kind === 'recorded_validation'));
  assert.ok(staleThenCurrent.transitions.some(mark => mark.kind === 'current_validation'));

  assert.ok(m.marks.some(mark => mark.kind === 'human_input'), 'attention is an explicit marker');
  assert.ok(m.marks.some(mark => mark.kind === 'tool_observation'), 'historical tool points stay visible as points');
  assert.equal(m.overlays.items.length, m.lanes.length, 'legacy item episodes are demoted to an overlay');
  assert.ok(m.overlays.eventActivity.length > 0, 'filtered event activity is available as an overlay');
  assert.ok(m.overlays.eventActivity.every(t => Number.isFinite(t)));

  const phase = m.semanticRows.primary.find(segment => segment.evidenceEventIds.length);
  assert.equal(phase.replayHref,
    `/?session=reference-session&t=${phase.startT}&at=1700120426802`);
  for (const key of ['id', 'label', 'startT', 'endT', 'confidence', 'evidenceEventIds', 'replayHref']) {
    assert.ok(Object.hasOwn(phase, key), `evidence descriptor contains ${key}`);
  }
});

test('semantic activity includes canonical producer events only', () => {
  const events = [
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 10, id: 'edit', source: 'hook', type: 'edit', path: 'a.js' },
    { t: 20, id: 'alive', source: 'hook', type: 'alive' },
    { t: 30, id: 'usage', source: 'hook', type: 'usage', input: 2 },
    { t: 40, id: 'poll', source: 'poll-github', type: 'ci', pr: 1, status: 'pending' },
    { t: 50, id: 'server', source: 'server', type: 'pr', number: 1, state: 'open' },
    { t: 60, id: 'tool', source: 'hook', type: 'tool', tool: 'Read', text: 'read a.js' },
    { t: 70, id: 'end', source: 'hook', type: 'session', phase: 'end' },
  ];
  const insights = buildSessionInsights(events, { untilT: 70, displayNow: 70 });
  const m = buildModel(events, insights);
  assert.deepEqual(m.overlays.eventActivity, [10, 60]);
});

test('agent coverage closes at the canonical attention boundary', () => {
  const events = [
    { t: 0, id: 'start', source: 'hook', type: 'session', phase: 'start' },
    { t: 10, id: 'phase-start', source: 'hook', type: 'work_phase', state: 'start', phase: 'coding', runId: 'r1', agentId: 'worker-1' },
    { t: 20, id: 'attention', source: 'hook', type: 'session', phase: 'attention' },
    { t: 30, id: 'resume', source: 'hook', type: 'session', phase: 'resume' },
    { t: 40, id: 'phase-end', source: 'hook', type: 'work_phase', state: 'end', phase: 'coding', runId: 'r1', agentId: 'worker-1', outcome: 'pass' },
    { t: 50, id: 'end', source: 'hook', type: 'session', phase: 'end' },
  ];
  const insights = buildSessionInsights(events, { untilT: 50, displayNow: 50 });
  const segment = buildModel(events, insights).semanticRows.agents[0].segments[0];

  assert.equal(segment.startT, 10);
  assert.equal(segment.endT, 20, 'the late terminal cannot extend work through attention');
  assert.equal(segment.durationMs, 10);
  assert.equal(segment.disposition, 'active');
  assert.equal(segment.wallCategory, 'coding');
});

test('agent readiness wait uses canonical waiting semantics and idle closure', () => {
  const events = [
    { t: 0, id: 'start', source: 'hook', type: 'session', phase: 'start' },
    { t: 10, id: 'wait-start', source: 'hook', type: 'work_phase', state: 'start', phase: 'preflight', stage: 'readiness_wait', runId: 'r1', agentId: 'worker-1' },
    { t: 20, id: 'idle', source: 'hook', type: 'session', phase: 'idle' },
    { t: 30, id: 'wait-end', source: 'hook', type: 'work_phase', state: 'end', phase: 'preflight', stage: 'readiness_wait', runId: 'r1', agentId: 'worker-1' },
    { t: 40, id: 'end', source: 'hook', type: 'session', phase: 'end' },
  ];
  const insights = buildSessionInsights(events, { untilT: 40, displayNow: 40 });
  const segment = buildModel(events, insights).semanticRows.agents[0].segments[0];

  assert.equal(segment.endT, 20);
  assert.equal(segment.disposition, 'waiting');
  assert.equal(segment.wallCategory, 'waiting');
});

test('agent readiness wait closes at its owning span before human attention', () => {
  const events = [
    { t: 0, id: 'start', source: 'hook', type: 'session', phase: 'start' },
    { t: 10, id: 'wait-start', source: 'hook', type: 'work_phase', state: 'start', phase: 'preflight', stage: 'readiness_wait', runId: 'r1', agentId: 'worker-1' },
    { t: 20, id: 'human', source: 'hook', type: 'notification', reason: 'next_prompt' },
    { t: 30, id: 'wait-end', source: 'hook', type: 'work_phase', state: 'end', phase: 'preflight', stage: 'readiness_wait', runId: 'r1', agentId: 'worker-1' },
    { t: 40, id: 'end', source: 'hook', type: 'session', phase: 'end' },
  ];
  const insights = buildSessionInsights(events, { untilT: 40, displayNow: 40 });
  const segment = buildModel(events, insights).semanticRows.agents[0].segments[0];

  assert.equal(segment.endT, 20, 'human attention shares waiting disposition but not the owning work phase');
  assert.deepEqual(segment.evidenceEventIds, ['wait-start', 'wait-end']);
});

test('overlapping explicit agents keep their own phase and stage labels', () => {
  const events = [
    { t: 0, id: 'start', source: 'hook', type: 'session', phase: 'start' },
    { t: 10, id: 'coding-start', source: 'hook', type: 'work_phase', state: 'start', phase: 'coding', runId: 'coding-run', agentId: 'coder' },
    { t: 10, id: 'preflight-start', source: 'hook', type: 'work_phase', state: 'start', phase: 'preflight', stage: 'local_validation', runId: 'preflight-run', agentId: 'reviewer' },
    { t: 20, id: 'preflight-end', source: 'hook', type: 'work_phase', state: 'end', phase: 'preflight', stage: 'local_validation', runId: 'preflight-run', agentId: 'reviewer', outcome: 'pass' },
    { t: 30, id: 'coding-end', source: 'hook', type: 'work_phase', state: 'end', phase: 'coding', runId: 'coding-run', agentId: 'coder', outcome: 'pass' },
    { t: 40, id: 'end', source: 'hook', type: 'session', phase: 'end' },
  ];
  const insights = buildSessionInsights(events, { untilT: 40, displayNow: 40 });
  const rows = buildModel(events, insights).semanticRows.agents;
  const coder = rows.find(row => row.agentId === 'coder').segments[0];
  const reviewer = rows.find(row => row.agentId === 'reviewer').segments[0];

  assert.equal(coder.label, 'Coding');
  assert.equal(coder.phase, 'coding');
  assert.equal(coder.stage, null);
  assert.equal(coder.endT, 30, 'canonical lifecycle may close but never relabel explicit agent evidence');
  assert.equal(reviewer.label, 'Preflight · Local Validation');
  assert.equal(reviewer.phase, 'preflight');
  assert.equal(reviewer.stage, 'local_validation');
});

test('unmatched tool execution stays unknown while elapsed duration reaches the model cutoff', () => {
  const events = [
    { t: 0, id: 'start', source: 'hook', type: 'session', phase: 'start' },
    { t: 10, id: 'tool-start', source: 'hook', type: 'tool_call', state: 'start', sessionId: 's1', agentId: 'worker-1', toolUseId: 'u1', tool: 'Bash' },
    { t: 40, id: 'end', source: 'hook', type: 'session', phase: 'end' },
  ];
  const insights = buildSessionInsights(events, { untilT: 40, displayNow: 40 });
  const mark = buildModel(events, insights).marks.find(candidate => candidate.kind === 'tool_outcome_unknown');

  assert.equal(mark.outcome, 'unknown');
  assert.equal(mark.startT, 10);
  assert.equal(mark.endT, 40);
  assert.equal(mark.durationMs, 30);
});

test('unmatched tail tool measures elapsed time against the insights display clock', () => {
  const events = [
    { t: 0, id: 'start', source: 'hook', type: 'session', phase: 'start' },
    { t: 10, id: 'tool-start', source: 'hook', type: 'tool_call', state: 'start', sessionId: 's1', agentId: 'worker-1', toolUseId: 'u1', tool: 'Bash' },
  ];
  const insights = buildSessionInsights(events, { untilT: 40, displayNow: 40 });
  const mark = buildModel(events, insights).marks.find(candidate => candidate.kind === 'tool_outcome_unknown');

  assert.equal(insights.bounds.recordedEnd, 10);
  assert.equal(mark.outcome, 'unknown');
  assert.equal(mark.endT, 40);
  assert.equal(mark.durationMs, 30);
  assert.equal(mark.percent, null, 'an open tool has no truthful recorded-session percentage');
});

test('PR rows and transitions retain occurrence, observation, and provenance separately', () => {
  const events = [
    { t: 0, id: 'start', source: 'hook', type: 'session', phase: 'start' },
    { t: 100, id: 'pr', source: 'poll-github', type: 'pr', repo: 'org/repo', number: 7, title: 'Temporal truth', state: 'open', createdAt: 20, occurredAt: 25 },
    { t: 200, id: 'end', source: 'hook', type: 'session', phase: 'end' },
  ];
  const insights = buildSessionInsights(events, { untilT: 200, displayNow: 200 });
  const context = parseViewContext('?session=s1&at=200');
  const row = buildModel(events, insights, context).semanticRows.prs[0];
  const recorded = row.transitions.find(transition => transition.transitionKind === 'recorded_state');

  assert.equal(row.startT, 20, 'the rail starts at canonical creation rather than poll observation');
  assert.equal(row.createdAt, 20);
  assert.equal(row.occurredAt, 25);
  assert.equal(row.observedAt, 100);
  assert.equal(recorded.startT, 25, 'state transition prefers occurredAt');
  assert.equal(recorded.occurredAt, 25);
  assert.equal(recorded.observedAt, 100);
  assert.equal(recorded.source, 'poll-github');
  assert.equal(row.replayHref, '/?session=s1&t=100&at=200', 'row replay waits until its evidence is observable');
  assert.equal(recorded.replayHref, '/?session=s1&t=100&at=200', 'transition replay waits until its evidence is observable');
});

test('explicit agent and tool lifecycles preserve detail, provenance, and confidence', () => {
  const events = [
    { t: 0, id: 'start', source: 'hook', type: 'session', phase: 'start', sessionId: 's1' },
    { t: 10, id: 'phase-start', source: 'hook', type: 'work_phase', state: 'start', phase: 'preflight', stage: 'local_validation', runId: 'r1', agentId: 'worker-1' },
    { t: 15, id: 'tool-start', source: 'hook', type: 'tool_call', state: 'start', sessionId: 's1', agentId: 'worker-1', toolUseId: 'u1', tool: 'Bash', input: { command: 'npm test' } },
    { t: 25, id: 'tool-end', source: 'hook', type: 'tool_call', state: 'success', sessionId: 's1', agentId: 'worker-1', toolUseId: 'u1', tool: 'Bash' },
    { t: 30, id: 'phase-end', source: 'hook', type: 'work_phase', state: 'end', phase: 'preflight', stage: 'local_validation', runId: 'r1', agentId: 'worker-1', outcome: 'pass' },
    { t: 40, id: 'end', source: 'hook', type: 'session', phase: 'end' },
  ];
  const insights = buildSessionInsights(events, { untilT: 40, displayNow: 40 });
  const m = buildModel(events, insights, parseViewContext('?session=s1'));

  assert.equal(m.semanticRows.agents.length, 1);
  assert.equal(m.semanticRows.agents[0].agentId, 'worker-1');
  assert.equal(m.semanticRows.agents[0].segments[0].confidence, 'explicit');
  assert.equal(m.semanticRows.agents[0].segments[0].outcome, 'pass');

  const tool = m.marks.find(mark => mark.kind === 'tool_execution');
  assert.equal(tool.label, 'Bash · success');
  assert.equal(tool.confidence, 'explicit');
  assert.equal(tool.evidence.length, 2);
  assert.equal(tool.evidence[0].toolUseId, 'u1');
  assert.equal(tool.evidence[0].detail, 'npm test');
  assert.equal(tool.evidence[0].provenance, 'hook');
});

test('recorder staleness is a labeled forensic marker', () => {
  const events = [
    { t: 0, id: 'start', source: 'hook', type: 'session', phase: 'start' },
    { t: 10, id: 'edit', source: 'hook', type: 'edit', path: 'a.js' },
    { t: 20, id: 'pr', source: 'poll-github', type: 'pr', repo: 'org/repo', number: 1, state: 'open' },
  ];
  const insights = buildSessionInsights(events, { untilT: 20, displayNow: ACTIVE_GAP_MS + 30 });
  const m = buildModel(events, insights);
  assert.ok(m.marks.some(mark => mark.kind === 'recorder_gap' && /Recorder stale/.test(mark.label)));
});
