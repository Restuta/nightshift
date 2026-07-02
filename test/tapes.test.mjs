// Golden-tape tests — hermetic, zero-dep (node:test + node:assert). Run: npm test
//
// These lock in the failure shapes Phase 0 fixes, using SMALL fixture tapes under
// test/tapes/ (no machine-local paths, no network). Every future producer bug in
// this class becomes a failing test instead of a confusing morning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initialState, reduce, fold } from '../public/reducer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TAPES = path.join(here, 'tapes');
const DOCTOR = path.join(here, '..', 'tools', 'tape-doctor.js');

const readTape = f => fs.readFileSync(path.join(TAPES, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const parseFile = p => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

// The way the live board applies events (see public/app.js): reduce forward, but
// on a `retract` (meta — applies at all times) or an OLDER-than-last event (a
// late arrival) re-fold the whole log from scratch. For an in-order, retract-free
// tape this is exactly reduce-event-by-event.
function liveFold(events) {
  let s = initialState();
  const seen = [];
  let lastT = -Infinity;
  for (const ev of events) {
    seen.push(ev);
    if (ev.type === 'retract' || ev.t < lastT) s = fold(seen);
    else reduce(s, ev);
    lastT = Math.max(lastT, ev.t);
  }
  return s;
}

// Copy a fixture to a throwaway temp file so a --apply run never mutates the
// committed tape. Returns the temp path; caller cleans up.
function tempCopy(fixture) {
  const dst = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tape-doctor-')), fixture);
  fs.copyFileSync(path.join(TAPES, fixture), dst);
  return dst;
}
const doctor = (...args) => execFileSync(process.execPath, [DOCTOR, ...args], { encoding: 'utf8' });

const FIXTURES = ['healthy.jsonl', 'reappend-seam.jsonl', 'junk-cards.jsonl', 'pr-parking.jsonl'];

// (i) replay == live on ALL fixtures ------------------------------------------
for (const f of FIXTURES) {
  test(`replay == live: fold(${f}) equals the incremental live fold`, () => {
    const evs = readTape(f);
    assert.deepEqual(fold(evs), liveFold(evs),
      'folding the whole tape must equal applying it event-by-event the way the board does live');
  });
}

// (ii) dedupe recovers the clean half, and is idempotent ----------------------
test('reappend-seam: --dedupe recovers the clean half; doctor is idempotent', () => {
  const clean = fold(readTape('reappend-clean-half.jsonl'));
  const tmp = tempCopy('reappend-seam.jsonl');

  const report1 = doctor(tmp, '--dedupe', '--apply');
  assert.match(report1, /re-append seam/, 'the backward-time seam is detected and reported');
  assert.match(report1, /removed 9 exact-duplicate/, 'the 9 re-appended lines are removed');

  const deduped = fold(parseFile(tmp));
  assert.equal(deduped.items.get('wi-x').status, 'done');
  assert.equal(deduped.items.get('wi-x').pr.state, 'merged');
  assert.equal(deduped.totals.commits, clean.totals.commits, 'commits are not double-counted');
  assert.equal(deduped.totals.add, clean.totals.add, 'added lines are not double-counted');
  assert.equal(deduped.totals.cost.toFixed(9), clean.totals.cost.toFixed(9), 'cost is not double-counted');
  assert.deepEqual(deduped.items, clean.items, 'deduped item state equals the clean half');

  const report2 = doctor(tmp, '--dedupe', '--apply');
  assert.match(report2, /no changes/, 'a second dedupe run changes nothing (idempotent)');

  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
});

// (iii) retracted items vanish at EVERY scrub time ----------------------------
test('retracted junk cards appear at no scrub time', () => {
  const evs = readTape('junk-cards.jsonl');
  const junk = ['junk-1', 'junk-2', 'junk-3', 'junk-4'];
  // Scrub to every event's t (including times BEFORE the retract events fire) —
  // retraction is meta, so a retracted item must never be on the board.
  for (const ev of evs) {
    const s = fold(evs, ev.t);
    for (const id of junk) assert.ok(!s.items.has(id), `${id} must be absent at t=${ev.t}`);
  }
  const end = fold(evs);
  for (const id of junk) assert.ok(!end.items.has(id), `${id} must be absent at end`);
  assert.ok(end.items.has('good-1'), 'a real card is untouched by the retractions');
  // The edit attributed to a retracted item drops out of the counts too.
  assert.equal(end.totals.edits, 0, 'a retracted item leaves no trace in counts');
});

// (iv) the continue-guard doesn't let an out-of-order tail hide earlier events -
test('continue-guard: an out-of-order future event does not stop the fold', () => {
  const evs = [
    { t: 100, type: 'item', id: 'a', status: 'doing' },
    { t: 500, type: 'item', id: 'b', status: 'doing' }, // a FUTURE event, out of order
    { t: 200, type: 'item', id: 'c', status: 'doing' }, // earlier than b, but after it in the file
  ];
  const s = fold(evs, 300);
  assert.ok(s.items.has('a'), 'a (t=100) folds');
  assert.ok(s.items.has('c'), 'c (t=200) folds even though a t=500 event precedes it in file order');
  assert.ok(!s.items.has('b'), 'b (t=500) is beyond untilT=300 and is skipped, not a stop signal');
});

// tape-doctor --retract-junk generates the corrections ------------------------
test('--retract-junk retracts harness-injected cards and is idempotent', () => {
  // Start from the junk fixture stripped of its retracts, so the doctor has to
  // generate them.
  const stripped = readTape('junk-cards.jsonl').filter(e => e.type !== 'retract');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-doctor-'));
  const tmp = path.join(dir, 'junk.jsonl');
  fs.writeFileSync(tmp, stripped.map(e => JSON.stringify(e)).join('\n') + '\n');

  const report = doctor(tmp, '--retract-junk', '--apply');
  assert.match(report, /4 junk card\(s\) retracted/);

  const s = fold(parseFile(tmp));
  for (const id of ['junk-1', 'junk-2', 'junk-3', 'junk-4']) assert.ok(!s.items.has(id), `${id} retracted`);
  assert.ok(s.items.has('good-1'), 'real card survives');

  assert.match(doctor(tmp, '--retract-junk', '--apply'), /no changes/, 'idempotent');
  fs.rmSync(dir, { recursive: true, force: true });
});

// tape-doctor --sort orders an out-of-order tape ------------------------------
test('--sort reorders an out-of-order tape by t (stable)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-doctor-'));
  const tmp = path.join(dir, 't.jsonl');
  const rows = [
    { t: 300, id: 'e3', type: 'note', text: 'c' },
    { t: 100, id: 'e1', type: 'note', text: 'a' },
    { t: 200, id: 'e2', type: 'note', text: 'b' },
  ];
  fs.writeFileSync(tmp, rows.map(e => JSON.stringify(e)).join('\n') + '\n');
  doctor(tmp, '--sort', '--apply');
  const ts = parseFile(tmp).map(e => e.t);
  assert.deepEqual(ts, [100, 200, 300], 'lines are ordered by t');
  fs.rmSync(dir, { recursive: true, force: true });
});

// envelope v2: every producer stamps id/source/v; v1 events still fold ---------
test('v1 events (no id/source/v) still fold alongside v2 events', () => {
  const mixed = [
    { t: 1, type: 'session', phase: 'start', title: 'mixed', agent: 'claude' }, // v1: no envelope
    { t: 2, source: 'hook', v: 2, type: 'item', id: 'wi-1', title: 'x', status: 'doing' }, // v2 item
    { t: 3, type: 'edit', path: 'f.js', item: 'wi-1' }, // v1
  ];
  const s = fold(mixed);
  assert.equal(s.session.title, 'mixed');
  assert.ok(s.items.has('wi-1'));
  assert.equal(s.totals.edits, 1, 'a v1 edit still counts');
});
