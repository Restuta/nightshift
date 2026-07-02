// Fleet summary builder tests — hermetic, zero-dep (node:test + node:assert).
// Run: npm test
//
// The summary is a PURE fold of one tape into a Fleet-home row. These lock in the
// three behaviors the plan calls out — needs-input detection, freshness tiers,
// PR counts — plus card counts, cost, span, label reuse, and the cache-friendly
// now/base split, using the same golden fixtures under test/tapes/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, summarizeBase, applyNow } from '../public/fleet-summary.js';
import { sessionLabel, freshness } from '../public/session-label.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TAPES = path.join(here, 'tapes');
const readTape = f => fs.readFileSync(path.join(TAPES, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

// Tiny in-order event stream helper (monotonic t).
function make() {
  let t = 1000;
  const evs = [];
  return { evs, emit(o) { evs.push({ t: (t += 1000), ...o }); return this; } };
}

// healthy.jsonl: one merged PR (passing CI), two finished cards, one usage event.
test('healthy tape: PR/card counts, cost, span, label', () => {
  const evs = readTape('healthy.jsonl');
  const lastT = evs[evs.length - 1].t;
  const s = summarize(evs, { id: 'healthy', now: lastT + 1000 });

  assert.equal(s.label, 'healthy', 'label from the shared sessionLabel');
  assert.equal(s.agent, 'claude');
  assert.equal(s.openPRs, 0, 'the one PR merged');
  assert.equal(s.mergedPRs, 1);
  assert.equal(s.failingCI, 0, 'CI passed');
  assert.equal(s.cardsDoing, 0);
  assert.equal(s.cardsDone, 2, 'both work items finished');
  assert.equal(s.needsInput, false, 'ended idle, not blocked');
  assert.equal(s.phase, 'idle');
  assert.equal(s.span, 1_080_000, 'start→last span (18m)');
  // usage: opus, in 1000 / out 200 / cacheRead 500 → (1000*15 + 200*75 + 500*1.5)/1e6
  assert.ok(Math.abs(s.cost - 0.03075) < 1e-9, `cost ≈ 0.03075, got ${s.cost}`);
});

// Freshness tiers are the picker's thresholds (<90s live, <30m recent, else stale).
test('freshness tiers track the age of the last event', () => {
  const evs = readTape('healthy.jsonl');
  const lastT = evs[evs.length - 1].t;
  assert.equal(summarize(evs, { id: 'h', now: lastT + 10e3 }).freshness, 'live');
  assert.equal(summarize(evs, { id: 'h', now: lastT + 5 * 60e3 }).freshness, 'recent');
  assert.equal(summarize(evs, { id: 'h', now: lastT + 45 * 60e3 }).freshness, 'stale');
  // and the standalone helper agrees
  assert.equal(freshness(lastT, lastT + 89e3), 'live');
  assert.equal(freshness(lastT, lastT + 91e3), 'recent');
  assert.equal(freshness(lastT, lastT + 31 * 60e3), 'stale');
});

// needsInput: a trailing unresolved `attention` phase, with the question text.
test('needs-input detection: unresolved attention at tape end', () => {
  const m = make();
  m.emit({ type: 'session', phase: 'start', title: 'blocked', agent: 'claude', cwd: '/repo' })
   .emit({ type: 'item', id: 'wi-1', title: 'do a thing', status: 'doing' })
   .emit({ type: 'session', phase: 'attention', text: 'Approve deploy to prod?' });
  const s = summarize(m.evs, { id: 'blk', now: m.evs[m.evs.length - 1].t + 1000 });
  assert.equal(s.needsInput, true);
  assert.equal(s.needsInputText, 'Approve deploy to prod?');
});

test('needs-input clears when later activity answers it (reducer awake())', () => {
  const m = make();
  m.emit({ type: 'session', phase: 'start', title: 'answered', agent: 'claude', cwd: '/repo' })
   .emit({ type: 'session', phase: 'attention', text: 'ok?' })
   .emit({ type: 'edit', path: 'a.js' }); // activity resolves the block
  const s = summarize(m.evs, { id: 'ans', now: m.evs[m.evs.length - 1].t + 1000 });
  assert.equal(s.needsInput, false, 'activity after attention means no longer blocked');
  assert.equal(s.needsInputText, null);
});

// PR counts across mixed states, and the failing-CI tally.
test('PR counts: open / merged / failing-CI are tallied independently', () => {
  const m = make();
  m.emit({ type: 'session', phase: 'start', title: 'prs', agent: 'codex', cwd: '/repo' })
   .emit({ type: 'item', id: 'a', status: 'doing' })
   .emit({ type: 'pr', number: 10, state: 'open', item: 'a' })
   .emit({ type: 'ci', pr: 10, status: 'fail' })
   .emit({ type: 'item', id: 'b', status: 'doing' })
   .emit({ type: 'pr', number: 11, state: 'open', item: 'b' })
   .emit({ type: 'item', id: 'c', status: 'doing' })
   .emit({ type: 'pr', number: 12, state: 'open', item: 'c' })
   .emit({ type: 'pr', number: 12, state: 'merged' });
  const now = m.evs[m.evs.length - 1].t + 1000;
  const s = summarize(m.evs, { id: 'prs', now });
  assert.equal(s.openPRs, 2, '#10 and #11 still open');
  assert.equal(s.mergedPRs, 1, '#12 merged');
  assert.equal(s.failingCI, 1, '#10 CI failed');
  assert.equal(s.mergedRecent, 1, '#12 merged just now → within 24h');

  // Same tape a day later: the merge is no longer "recent".
  const later = summarize(m.evs, { id: 'prs', now: now + 25 * 3600e3 });
  assert.equal(later.mergedRecent, 0, 'merge falls out of the 24h window');
  assert.equal(later.mergedPRs, 1, 'but the all-time merged count is unchanged');
});

// Retracted junk cards never count toward doing/done.
test('junk tape: retracted cards are not counted', () => {
  const evs = readTape('junk-cards.jsonl');
  const s = summarize(evs, { id: 'junk', now: evs[evs.length - 1].t + 1000 });
  assert.equal(s.cardsDone, 1, 'only good-1 counts');
  assert.equal(s.cardsDoing, 0, 'the junk doing-cards were retracted');
});

// lastSay snippet surfaces the latest narration.
test('lastSay carries the most recent narration', () => {
  const m = make();
  m.emit({ type: 'session', phase: 'start', title: 'talky', agent: 'codex', cwd: '/repo' })
   .emit({ type: 'item', id: 'a', status: 'doing' })
   .emit({ type: 'say', text: 'starting the grading pipeline', item: 'a' })
   .emit({ type: 'say', text: 'waiting for the harvest to finish', item: 'a' });
  const s = summarize(m.evs, { id: 'talky', now: m.evs[m.evs.length - 1].t + 1000 });
  assert.equal(s.lastSay, 'waiting for the harvest to finish');
});

// label reuse: a worktree-style slug + repo cwd resolves to the worktree tail —
// exactly what the board picker shows for the same tape.
test('label reuses the worktree-suffix logic (matches the picker)', () => {
  const id = 'Users-me-Projects-nightshift-p2b-fleet';
  const cwd = '/Users/me/Projects/nightshift';
  const s = summarizeBase(
    [{ t: 1, type: 'session', phase: 'start', cwd, title: 'anything' }],
    { id },
  );
  assert.equal(s.label, 'p2b-fleet');
  assert.equal(s.label, sessionLabel({ id, cwd, title: 'anything' }), 'same as the shared fn');
});

// The now/base split is what lets the server cache a fold yet keep freshness live.
test('applyNow re-derives freshness/mergedRecent from one cached base', () => {
  const evs = readTape('pr-parking.jsonl');
  const base = summarizeBase(evs, { id: 'pp' });
  assert.ok(!('freshness' in base), 'the cached base is clock-free');
  assert.ok(!('mergedRecent' in base), 'the cached base is clock-free');
  assert.ok(!('mergedAts' in applyNow(base, base.lastEventAt)), 'internal field is dropped');

  const fresh = applyNow(base, base.lastEventAt + 10e3);
  const stale = applyNow(base, base.lastEventAt + 60 * 60e3);
  assert.equal(fresh.freshness, 'live');
  assert.equal(stale.freshness, 'stale', 'same base, later clock → stale, no re-fold');
  assert.equal(fresh.mergedRecent, 1, '#381 merged within 24h');
  assert.equal(applyNow(base, base.lastEventAt + 26 * 3600e3).mergedRecent, 0);
});

// An empty tape must summarize without throwing (a freshly-created log file).
test('an empty tape summarizes to zeroes', () => {
  const s = summarize([], { id: 'empty', now: Date.now() });
  assert.equal(s.events, 0);
  assert.equal(s.openPRs, 0);
  assert.equal(s.cardsDone, 0);
  assert.equal(s.freshness, 'stale');
  assert.equal(s.needsInput, false);
});
