// Story-page layout tests — hermetic, zero-dep (node:test + node:assert). The
// load-bearing derivations of /story are pure (public/story-model.js): beat-run
// grouping, idle-gap separator placement (incl. the intra-chapter attribution
// that seam math misses), day rules, and the wall-clock strip's active segments.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStoryBlocks, activeSegments, dayKey, SEPARATOR_GAP_MS,
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
