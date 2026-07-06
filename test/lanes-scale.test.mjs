// Lane-scale tests — hermetic, zero-dep (node:test + node:assert). The compressed
// time axis of /lanes is a pure, invertible, piecewise-linear mapping
// (public/lanes-scale.js): active spans keep real proportions, idle gaps collapse
// to a fixed sliver. These lock the load-bearing invariants the view relies on —
// round-trip inside active spans, gap interiors landing in the fixed slot,
// monotonicity, linear-mode identity, and the degenerate cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScale, MIN_GAP_MS } from '../public/lanes-scale.js';

const M = 60 * 1000;
const H = 60 * M;

// A realistic shape: two active bursts split by a long idle gap.
const T0 = 1_000_000;
const GAP = { fromT: T0 + 30 * M, toT: T0 + 30 * M + 9 * H }; // 9h silence
const T1 = GAP.toT + 20 * M;

test('linear mode (no gaps) is an identity-ish shift: x(t) = t - t0', () => {
  const s = buildScale([], T0, T1);
  assert.equal(s.compressedSpan, T1 - T0);
  assert.equal(s.x(T0), 0);
  assert.equal(s.x(T1), T1 - T0);
  for (const frac of [0, 0.13, 0.5, 0.77, 1]) {
    const t = T0 + frac * (T1 - T0);
    assert.equal(s.x(t), t - T0);
    assert.equal(s.t(s.x(t)), t); // exact round trip
  }
  assert.equal(s.gaps.length, 0);
});

test('compressed: active spans keep real ms; the gap becomes a fixed slot', () => {
  const s = buildScale([GAP], T0, T1);
  // The active total is 30m + 20m = 50m; the 9h gap collapses to one slot.
  const activeMs = 30 * M + 20 * M;
  assert.equal(s.gaps.length, 1);
  const slot = s.gaps[0].u1 - s.gaps[0].u0;
  assert.ok(slot > 0, 'the gap has a positive slot');
  // The gap slot is a small fraction of the axis, not its real 9h/50m dominance.
  assert.ok(slot < activeMs, 'the 9h gap renders narrower than the 50m of activity');
  assert.equal(s.compressedSpan, activeMs + slot);
  // The first active burst occupies exactly its real 30m of units.
  assert.equal(s.x(GAP.fromT) - s.x(T0), 30 * M);
});

test('round trip t(x(t)) is exact for many samples inside active spans', () => {
  const s = buildScale([GAP], T0, T1);
  const activeSamples = [];
  for (let k = 0; k <= 20; k++) activeSamples.push(T0 + (k / 20) * 30 * M);       // burst 1
  for (let k = 0; k <= 20; k++) activeSamples.push(GAP.toT + (k / 20) * 20 * M);  // burst 2
  for (const t of activeSamples) {
    const back = s.t(s.x(t));
    assert.ok(Math.abs(back - t) < 1e-6, `round trip within active span: ${t} → ${back}`);
  }
});

test('a gap interior maps into the fixed gap slot and inverts within the gap', () => {
  const s = buildScale([GAP], T0, T1);
  const g = s.gaps[0];
  const mid = (GAP.fromT + GAP.toT) / 2;
  const u = s.x(mid);
  assert.ok(u > g.u0 && u < g.u1, 'a time mid-gap lands strictly inside the slot');
  // Inverting a unit inside the slot returns a time inside the gap (not exact to
  // the input ms — the gap is compressed — but strictly within [fromT,toT]).
  const backT = s.t((g.u0 + g.u1) / 2);
  assert.ok(backT > GAP.fromT && backT < GAP.toT, 'slot midpoint inverts inside the gap');
});

test('x is monotonically non-decreasing across the whole span', () => {
  const s = buildScale([GAP], T0, T1);
  let prev = -Infinity;
  for (let k = 0; k <= 400; k++) {
    const t = T0 + (k / 400) * (T1 - T0);
    const x = s.x(t);
    assert.ok(x >= prev - 1e-9, `x monotonic at t=${t}`);
    prev = x;
  }
});

test('gaps at or under the threshold do not collapse (stay linear)', () => {
  const small = { fromT: T0 + 10 * M, toT: T0 + 10 * M + MIN_GAP_MS }; // exactly threshold
  const s = buildScale([small], T0, T1);
  assert.equal(s.gaps.length, 0, 'a gap == threshold is not collapsed');
  assert.equal(s.compressedSpan, T1 - T0, 'so the axis stays fully linear');
});

test('gap flush against the tape edges (leading + trailing idle)', () => {
  const lead = { fromT: T0, toT: T0 + 5 * H };            // idle from the very start
  const tail = { fromT: T1 - 3 * H, toT: T1 };            // idle to the very end
  const s = buildScale([lead, tail], T0, T1);
  assert.equal(s.gaps.length, 2);
  assert.equal(s.x(T0), 0);
  assert.equal(s.x(T1), s.compressedSpan);
  // Endpoints still invert to the exact bounds.
  assert.equal(s.t(0), T0);
  assert.equal(s.t(s.compressedSpan), T1);
  // Monotonic through both edge gaps.
  let prev = -Infinity;
  for (let k = 0; k <= 100; k++) { const x = s.x(T0 + (k / 100) * (T1 - T0)); assert.ok(x >= prev - 1e-9); prev = x; }
});

test('degenerate: a single instant (t0 === t1) never divides by zero', () => {
  const s = buildScale([], 5000, 5000);
  assert.equal(s.compressedSpan, 0);
  assert.equal(s.x(5000), 0);
  assert.equal(s.x(4000), 0);
  assert.equal(s.x(6000), 0);
  assert.equal(s.t(0), 5000);
});

test('degenerate: no gaps and a tiny span is still exact', () => {
  const s = buildScale([], 0, 1000);
  assert.equal(s.x(0), 0);
  assert.equal(s.x(500), 500);
  assert.equal(s.x(1000), 1000);
  assert.equal(s.t(500), 500);
});

test('all-gap tape (no active time) spreads gaps evenly and stays invertible', () => {
  const g = { fromT: 0, toT: 100 * M };
  const s = buildScale([g], 0, 100 * M);
  assert.equal(s.gaps.length, 1);
  assert.ok(s.compressedSpan > 0);
  assert.equal(s.x(0), 0);
  assert.equal(s.x(100 * M), s.compressedSpan);
  assert.equal(s.t(0), 0);
  assert.equal(s.t(s.compressedSpan), 100 * M);
});

test('gapAt reports the collapsed segment for a mid-gap time, null in active', () => {
  const s = buildScale([GAP], T0, T1);
  assert.ok(s.gapAt((GAP.fromT + GAP.toT) / 2), 'mid-gap is inside a collapsed slot');
  assert.equal(s.gapAt(T0 + 5 * M), null, 'a time inside the first burst is not a gap');
});

test('every collapsed gap gets the SAME fixed slot regardless of real length', () => {
  const g1 = { fromT: T0 + 10 * M, toT: T0 + 10 * M + 30 * M };   // 30m gap
  const g2 = { fromT: T0 + 60 * M, toT: T0 + 60 * M + 6 * H };    // 6h gap
  const end = T0 + 8 * H;
  const s = buildScale([g1, g2], T0, end);
  assert.equal(s.gaps.length, 2);
  const w0 = s.gaps[0].u1 - s.gaps[0].u0;
  const w1 = s.gaps[1].u1 - s.gaps[1].u0;
  assert.ok(Math.abs(w0 - w1) < 1e-6, 'a 30m and a 6h gap collapse to the same width');
});
