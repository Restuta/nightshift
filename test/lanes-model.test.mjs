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
