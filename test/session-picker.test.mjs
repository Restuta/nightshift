// Session-picker tests — the pure bits lifted out of app.js into the shared
// switcher (public/session-picker.js): the freshness dot and the freshest-first
// sort. Hermetic, zero-dep (node:test + node:assert), no DOM — the popover DOM
// wiring is exercised in the browser, not here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionMark, sortSessions } from '../public/session-picker.js';
import { FRESH_LIVE_MS, FRESH_RECENT_MS } from '../public/session-label.js';

const NOW = 1_700_000_000_000;

test('sessionMark: live / recent / stale dots track the shared freshness tiers', () => {
  // live — an event within the last 90s
  assert.equal(sessionMark(NOW - 1_000, NOW), '🟢');
  assert.equal(sessionMark(NOW - (FRESH_LIVE_MS - 1), NOW), '🟢');
  // recent — quiet under 30m
  assert.equal(sessionMark(NOW - FRESH_LIVE_MS, NOW), '🟡');
  assert.equal(sessionMark(NOW - (FRESH_RECENT_MS - 1), NOW), '🟡');
  // stale — no events in over 30m
  assert.equal(sessionMark(NOW - FRESH_RECENT_MS, NOW), '⚪');
  assert.equal(sessionMark(NOW - 3 * 60 * 60e3, NOW), '⚪');
});

test('sessionMark: a missing/zero lastT reads stale, never crashes', () => {
  assert.equal(sessionMark(0, NOW), '⚪');
  assert.equal(sessionMark(undefined, NOW), '⚪');
});

test('sortSessions: freshest lastT first, missing lastT sinks to the bottom', () => {
  const rows = [
    { id: 'old', lastT: NOW - 60 * 60e3 },
    { id: 'freshest', lastT: NOW - 5_000 },
    { id: 'never' },                          // no lastT
    { id: 'mid', lastT: NOW - 10 * 60e3 },
  ];
  const out = sortSessions(rows);
  assert.deepEqual(out.map(r => r.id), ['freshest', 'mid', 'old', 'never']);
});

test('sortSessions: pure — does not mutate the input array', () => {
  const rows = [{ id: 'a', lastT: 1 }, { id: 'b', lastT: 2 }];
  const before = rows.map(r => r.id);
  sortSessions(rows);
  assert.deepEqual(rows.map(r => r.id), before);
});
