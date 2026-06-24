// Zero-dep reducer tests (node:test + node:assert). Run: npm test
//
// These guard the category "a conversation boundary must not push a card past
// its real work state": a turn ends, but the card it owns can't be 'done' while
// its PR is still open — the PR's own merge/close carries it to done.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initialState, reduce, fold } from '../public/reducer.js';

// Tiny event-stream helper: monotonically increasing t, fresh state.
function stream() {
  const s = initialState();
  let t = 1_000;
  return {
    state: s,
    emit(o) { reduce(s, { t: (t += 1000), ...o }); return s; },
    item: id => s.items.get(id),
  };
}

test('a turn-boundary "done" cannot override a card whose PR is still open', () => {
  const x = stream();
  x.emit({ type: 'item', id: 'turn-1', title: 'ship it', status: 'doing' });
  x.emit({ type: 'pr', number: 42, state: 'open', item: 'turn-1' });
  assert.equal(x.item('turn-1').status, 'pr', 'opening a PR parks the card in pr');

  // The Stop hook (or next-prompt close) marks the turn done while CI runs.
  x.emit({ type: 'item', id: 'turn-1', status: 'done' });
  assert.equal(x.item('turn-1').status, 'pr', 'done must defer to the open PR');
});

test('PR merge finishes the parked card even with no ev.item (matched by number)', () => {
  const x = stream();
  x.emit({ type: 'item', id: 'turn-1', status: 'doing' });
  x.emit({ type: 'pr', number: 42, state: 'open', item: 'turn-1' });
  x.emit({ type: 'item', id: 'turn-1', status: 'done' }); // parked in pr
  // Poller emits the merge with no item — must still reach the owning card.
  x.emit({ type: 'pr', number: 42, state: 'merged' });
  assert.equal(x.item('turn-1').status, 'done', 'merge carries the card to done');
  assert.equal(x.item('turn-1').pr.state, 'merged', 'card pill refreshes to merged');
});

test('a closed (unmerged) PR also resolves the card', () => {
  const x = stream();
  x.emit({ type: 'item', id: 'turn-1', status: 'doing' });
  x.emit({ type: 'pr', number: 7, state: 'open', item: 'turn-1' });
  x.emit({ type: 'item', id: 'turn-1', status: 'done' });
  assert.equal(x.item('turn-1').status, 'pr');
  x.emit({ type: 'pr', number: 7, state: 'closed' });
  assert.equal(x.item('turn-1').status, 'done', 'a resolved PR never strands a card in pr');
});

test('a plain turn with no PR still goes straight to done', () => {
  const x = stream();
  x.emit({ type: 'item', id: 'turn-1', status: 'doing' });
  x.emit({ type: 'item', id: 'turn-1', status: 'done' });
  assert.equal(x.item('turn-1').status, 'done');
});

test('an unrelated PR number never hijacks a card', () => {
  const x = stream();
  x.emit({ type: 'item', id: 'turn-1', title: 'analysis only', status: 'doing' });
  // A poller event for a PR this card never opened (no item link, different number).
  x.emit({ type: 'pr', number: 999, state: 'merged' });
  assert.equal(x.item('turn-1').pr, null, 'card never claimed #999, so it is untouched');
  assert.equal(x.item('turn-1').status, 'doing');
});

// Regression against the real tape that surfaced this bug (best-effort: skipped
// if the recording isn't on this machine).
test('prove.health tape: turn-5 sits in PR until #381 merges', (t) => {
  const tape = path.join(
    process.env.HOME || '', '.nightshift', 'sessions',
    'Users-restuta-Projects-prove.health-ridiculous.health.jsonl'
  );
  if (!fs.existsSync(tape)) return t.skip('tape not present');
  const evs = fs.readFileSync(tape, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

  // The moment in the screenshot: ~2s after #380 merged, #381 still running.
  const atScreenshot = fold(evs, 1782291643000);
  assert.equal(atScreenshot.items.get('turn-5').status, 'pr',
    'at screenshot time turn-5 belongs in PR-open, not Done');

  // End of tape: #381 has merged, so turn-5 is legitimately done.
  const final = fold(evs);
  assert.equal(final.items.get('turn-5').status, 'done');
  assert.equal(final.items.get('turn-5').pr.state, 'merged');
});
