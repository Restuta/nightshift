// Honest-liveness + session-boundary tests (P1A). Hermetic, zero-dep. Run: npm test
//
// These lock the F3 failure family: a heartbeat updates freshness but nothing
// else; a reconcile append (poll-github/server) during a working phase accrues NO
// phantom work-time; a session `end` sweeps still-`doing` cards to abandoned; and
// the badge derives HONEST staleness from freshest-producer age, not a latched
// phase. Plus back-compat: a v1 tape folds to the same projection as main.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initialState, reduce, fold, liveness, freshestProducerAt,
} from '../public/reducer.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Event-stream helper: monotonically increasing t, explicit source per event.
function stream(t0 = 1_000_000) {
  const s = initialState();
  let t = t0;
  return {
    state: s,
    at: () => t,
    emit(o, dt = 1000) { t += dt; reduce(s, { t, ...o }); return s; },
    item: id => s.items.get(id),
  };
}

const MIN = 60e3;

// --- alive: freshness only, never activity ----------------------------------

test('alive updates per-source freshness but not feed / timers / activity', () => {
  const x = stream();
  x.emit({ source: 'codex-tail', type: 'session', phase: 'start', agent: 'codex' });
  x.emit({ source: 'codex-tail', type: 'item', id: 'turn-1', status: 'doing' });
  x.emit({ source: 'codex-tail', type: 'edit', path: 'a.js', item: 'turn-1' });

  const feedLen = x.state.feed.length;
  const events = x.state.totals.events;
  const touched = x.item('turn-1').touchedAt;
  const activeMs = x.item('turn-1').activeMs;
  const lastProd = x.state.session.lastProducerAt;

  const beat = x.emit({ source: 'codex-tail', type: 'alive' }, 30e3);
  assert.equal(beat.sources.get('codex-tail'), x.at(), 'alive advances its source freshness');
  assert.equal(beat.feed.length, feedLen, 'alive does not enter the feed');
  assert.equal(beat.totals.events, events, 'alive does not count as an event');
  assert.equal(x.item('turn-1').touchedAt, touched, 'alive does not touch the card');
  assert.equal(x.item('turn-1').activeMs, activeMs, 'alive accrues no work-time');
  assert.equal(beat.session.lastProducerAt, lastProd, 'alive is not producer activity');
  assert.equal(beat.session.lastAt, lastProd, 'alive does not bump the display clock either');
});

test('alive never wakes an idle session', () => {
  const x = stream();
  x.emit({ source: 'codex-tail', type: 'session', phase: 'start', agent: 'codex' });
  x.emit({ source: 'codex-tail', type: 'session', phase: 'idle' });
  assert.equal(x.state.session.phase, 'idle');
  x.emit({ source: 'codex-tail', type: 'alive' }, 30e3);
  assert.equal(x.state.session.phase, 'idle', 'a heartbeat is not activity — it must not call awake()');
});

// --- phantom accrual: the overnight reconcile scenario ----------------------

test('poll-github reconcile during a working phase accrues NO phantom activeMs', () => {
  const x = stream();
  x.emit({ source: 'hook', type: 'session', phase: 'start', agent: 'claude' });
  x.emit({ source: 'hook', type: 'item', id: 'turn-1', status: 'doing' });
  x.emit({ source: 'hook', type: 'edit', path: 'a.js', item: 'turn-1' });

  const activeMsBefore = x.item('turn-1').activeMs;
  const lastProdBefore = x.state.session.lastProducerAt;

  // Agent asleep; the board server's reconciler appends a poll-github pr event
  // every 30s for 8 hours (phase never leaves 'working' — no idle/end was ever
  // emitted, which is exactly the 0/20 real-tape reality).
  for (let i = 0; i < (8 * 3600) / 30; i++) {
    x.emit({ source: 'poll-github', type: 'pr', number: 1, state: 'open' }, 30e3);
  }

  assert.equal(x.item('turn-1').activeMs, activeMsBefore,
    'a reconcile append must not accrue work-time onto the active card');
  assert.equal(x.state.session.lastProducerAt, lastProdBefore,
    'reconcile appends do not advance the producer (quiet) clock');
  assert.ok(x.state.session.lastAt > lastProdBefore,
    'but the display clock (lastAt) does advance — feed timestamps stay honest');
  assert.equal(x.state.sources.get('poll-github'), x.at(),
    'per-source freshness still tracks the poller');
});

// --- session boundaries: end sweeps doing → abandoned -----------------------

test('a session end sweeps still-doing cards to abandoned', () => {
  const x = stream();
  x.emit({ source: 'hook', type: 'session', phase: 'start', agent: 'claude' });
  x.emit({ source: 'hook', type: 'item', id: 'turn-1', status: 'doing' });
  x.emit({ source: 'hook', type: 'item', id: 'turn-2', status: 'doing' });
  x.emit({ source: 'hook', type: 'item', id: 'turn-2', status: 'done' });
  x.emit({ source: 'hook', type: 'session', phase: 'end' });

  assert.equal(x.state.session.phase, 'ended');
  assert.equal(x.item('turn-1').abandoned, true, 'a card left in doing at end is abandoned');
  assert.equal(x.item('turn-2').abandoned, false, 'a card already done is not abandoned');
});

test('abandoned is derived purely — it holds at replay times and clears on reopen', () => {
  const evs = [
    { t: 1000, source: 'hook', type: 'session', phase: 'start', agent: 'claude' },
    { t: 2000, source: 'hook', type: 'item', id: 'turn-1', status: 'doing' },
    { t: 3000, source: 'hook', type: 'session', phase: 'end' },
    // recorder comes back, same card resumes and ships
    { t: 4000, source: 'hook', type: 'session', phase: 'resume' },
    { t: 5000, source: 'hook', type: 'edit', path: 'a.js', item: 'turn-1' },
    { t: 6000, source: 'hook', type: 'item', id: 'turn-1', status: 'done' },
  ];
  // At the end boundary, turn-1 is abandoned.
  assert.equal(fold(evs, 3000).items.get('turn-1').abandoned, true);
  // Before the end, it was not.
  assert.equal(fold(evs, 2500).items.get('turn-1').abandoned, false);
  // After the reopen + activity, the flag is cleared (and the card shipped).
  const end = fold(evs);
  assert.equal(end.items.get('turn-1').abandoned, false, 're-activation un-abandons the card');
  assert.equal(end.items.get('turn-1').status, 'done');
});

// --- freshest producer age --------------------------------------------------

test('freshestProducerAt takes heartbeats but ignores the reconcile lanes', () => {
  const x = stream();
  x.emit({ source: 'hook', type: 'session', phase: 'start', agent: 'claude' });
  x.emit({ source: 'hook', type: 'edit', path: 'a.js' });
  const afterEdit = x.at();
  // A codex-tail heartbeat is a fresher producer signal than the last real event.
  x.emit({ source: 'codex-tail', type: 'alive' }, 30e3);
  assert.equal(freshestProducerAt(x.state), x.at(), 'a heartbeat counts as a fresh producer signal');
  // A later poll-github / server append must NOT count — they are reconcile lanes.
  x.emit({ source: 'poll-github', type: 'pr', number: 5, state: 'open' }, 30e3);
  x.emit({ source: 'server', type: 'pr', number: 5, state: 'merged' }, 30e3);
  const beat = x.state.sources.get('codex-tail');
  assert.equal(freshestProducerAt(x.state), beat, 'poll-github/server do not freshen the agent signal');
  assert.ok(freshestProducerAt(x.state) > afterEdit);
});

// --- honest badge derivation ------------------------------------------------

test('liveness: a working codex session goes STALE 5m after its last heartbeat', () => {
  const x = stream();
  x.emit({ source: 'codex-tail', type: 'session', phase: 'start', agent: 'codex' });
  x.emit({ source: 'codex-tail', type: 'edit', path: 'a.js' });
  const at = x.at();
  assert.equal(liveness(x.state, at + 4 * MIN).state, 'live', 'fresh within 5m → LIVE');
  const stale = liveness(x.state, at + 6 * MIN);
  assert.equal(stale.state, 'stale', 'past 5m with no heartbeat → STALE');
  assert.equal(stale.dataEndsAt, at, 'STALE reports the real time data ends');
});

test('liveness: a hook-based session gets a 15m grace (no heartbeat is possible)', () => {
  const x = stream();
  x.emit({ source: 'hook', type: 'session', phase: 'start', agent: 'claude' });
  x.emit({ source: 'hook', type: 'edit', path: 'a.js' });
  const at = x.at();
  assert.equal(liveness(x.state, at + 10 * MIN).state, 'live', 'event-driven recorder: quiet <15m is still LIVE');
  assert.equal(liveness(x.state, at + 16 * MIN).state, 'stale', 'past 15m → STALE');
});

test('liveness: idle / attention / ended pass through the recorded phase', () => {
  const x = stream();
  x.emit({ source: 'hook', type: 'session', phase: 'start', agent: 'claude' });
  x.emit({ source: 'hook', type: 'session', phase: 'idle' });
  assert.equal(liveness(x.state, x.at() + 60 * MIN).state, 'idle', 'idle never masquerades as STALE');
  x.emit({ source: 'hook', type: 'session', phase: 'attention', text: 'need input' });
  assert.equal(liveness(x.state, x.at()).state, 'attention');
  x.emit({ source: 'hook', type: 'session', phase: 'end' });
  assert.equal(liveness(x.state, x.at() + 60 * MIN).state, 'ended');
});

test('liveness: a live poll-github stream can NOT hold a dead session LIVE', () => {
  const x = stream();
  x.emit({ source: 'hook', type: 'session', phase: 'start', agent: 'claude' });
  x.emit({ source: 'hook', type: 'edit', path: 'a.js' });
  const at = x.at();
  // The server reconciler keeps appending long after the agent (and its recorder)
  // is gone — the exact shape of the "board looks LIVE all night" bug.
  for (let i = 0; i < 40; i++) x.emit({ source: 'poll-github', type: 'alive' }, 30e3);
  assert.equal(liveness(x.state, x.at()).state, 'stale',
    'poll-github heartbeats are a reconcile lane — they must not keep the badge LIVE');
});

// --- replay == live on a heartbeat/end tape ---------------------------------

// The way the live board applies events: reduce forward, re-folding only on a
// retract or an older-than-last arrival (see public/app.js). For an in-order tape
// (alive + end included) this must equal folding the whole thing.
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

test('replay == live on a tape with alive heartbeats and a session end', () => {
  const evs = fs.readFileSync(path.join(here, 'tapes', 'heartbeat-end.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(fold(evs), liveFold(evs),
    'folding the whole tape must equal applying it event-by-event');
  const end = fold(evs);
  assert.equal(end.session.phase, 'ended');
  assert.equal(end.items.get('turn-2').abandoned, true, 'turn-2 was doing at end → abandoned');
  assert.equal(end.items.get('turn-1').abandoned, false, 'turn-1 was superseded, not doing at end');
  // Heartbeats never entered the feed.
  assert.ok(!end.feed.some(e => e.type === 'alive'), 'no alive event reaches the feed');
});

// --- back-compat: v1 tapes fold exactly as main -----------------------------

test('v1 tape folds to the SAME item/pr/totals projection as main', () => {
  const evs = fs.readFileSync(path.join(here, 'tapes', 'v1-backcompat.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
  const expected = JSON.parse(fs.readFileSync(path.join(here, 'tapes', 'v1-backcompat.expected.json'), 'utf8'));

  const s = fold(evs);
  const items = {};
  for (const [id, it] of s.items) {
    items[id] = { status: it.status, add: it.add, del: it.del, commits: it.commits, edits: it.edits, activeMs: it.activeMs, pr: it.pr ? { number: it.pr.number, state: it.pr.state } : null };
  }
  const prs = {};
  for (const [n, pr] of s.prs) prs[n] = { state: pr.state, ci: pr.ci };

  // The golden snapshot was captured by folding this tape with origin/main's
  // reducer — so passing proves the split-lastAt / sources / alive changes leave
  // v1 projections byte-identical (every v1 event is producer activity).
  assert.deepEqual({ items, prs, totals: s.totals }, expected);
});
