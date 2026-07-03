// Unit tests for the shared turn-id display/identity helper (public/turn-id.js),
// used by the board (app.js) and the graph (graph-model.js node-exclusion +
// graph.js tooltips). Plan 1.3.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnLabel, sid8, TURN_RE, isTurnId } from '../public/turn-id.js';

test('turnLabel short-forms namespaced ids and passes legacy / real ids through', () => {
  // Namespaced turn-<sid8>-<n> → "turn <n>" (the sid8 is plumbing, noise to a reader).
  assert.equal(turnLabel('turn-019f0a00-14'), 'turn 14');
  assert.equal(turnLabel('turn-019f0a00-1'), 'turn 1');
  // Legacy un-namespaced ids render EXACTLY as before (unchanged).
  assert.equal(turnLabel('turn-3'), 'turn-3');
  // Real declared work items are never rewritten.
  assert.equal(turnLabel('wi-2'), 'wi-2');
  assert.equal(turnLabel('ship-it'), 'ship-it');
  // Degenerate input never throws.
  assert.equal(turnLabel(''), '');
  assert.equal(turnLabel(undefined), '');
  assert.equal(turnLabel(null), '');
});

test('TURN_RE / isTurnId match BOTH legacy and namespaced turn ids, and nothing else', () => {
  assert.ok(isTurnId('turn-3'), 'legacy');
  assert.ok(isTurnId('turn-019f0a00-14'), 'namespaced');
  assert.ok(!isTurnId('wi-2'), 'a real work item is not a turn');
  assert.ok(!isTurnId('turn-xyz'), 'the namespace must be hex');
  assert.ok(!isTurnId('turn-019f0a00-'), 'a namespaced turn needs a number');
  assert.ok(!isTurnId('turn-'), 'a bare prefix is not a turn');
  assert.ok(!TURN_RE.test('intent-turn-1'), 'anchored — a substring match does not count');
});

test('sid8 is the first 8 hex chars of a session id, lowercased', () => {
  assert.equal(sid8('019f0a00-0000-7000-8000-000000000001'), '019f0a00');
  assert.equal(sid8('019F0A00-0000-7000-8000-000000000001'), '019f0a00', 'lowercased');
  assert.equal(sid8(''), '');
  assert.equal(sid8(undefined), '');
});
