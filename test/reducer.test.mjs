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

// The plan is session-scoped: its full state lives on state.todos (the sidebar
// Plan panel), and each turn card carries only the steps it advanced (its delta).
const delta = it => (it.delta ? [...it.delta.values()] : []);

test('the full plan lives at session level, never on a card', () => {
  const x = stream();
  x.emit({ type: 'item', id: 'turn-1', status: 'doing' });
  x.emit({ type: 'todos', item: 'turn-1', todos: [
    { text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }, { text: 'c', status: 'pending' },
  ] });
  assert.equal(x.state.todos.length, 3, 'whole plan is on state.todos');
  assert.equal(x.item('turn-1').todos, undefined, 'card has no full-plan field');
});

test('a card carries only the steps it advanced (its delta)', () => {
  const x = stream();
  x.emit({ type: 'item', id: 'turn-1', status: 'doing' });
  // turn-1 lays out the plan (nothing moved yet), then starts step a.
  x.emit({ type: 'todos', item: 'turn-1', todos: [
    { text: 'a', status: 'pending' }, { text: 'b', status: 'pending' },
  ] });
  assert.equal(delta(x.item('turn-1')).length, 0, 'just writing the plan is not a delta');
  x.emit({ type: 'todos', item: 'turn-1', todos: [
    { text: 'a', status: 'in_progress' }, { text: 'b', status: 'pending' },
  ] });
  assert.deepEqual(delta(x.item('turn-1')).map(s => s.text), ['a'], 'turn-1 started a');

  // turn-2 opens; the hook re-seeds the identical plan — no advance, no delta.
  x.emit({ type: 'item', id: 'turn-1', status: 'done' });
  x.emit({ type: 'item', id: 'turn-2', status: 'doing' });
  x.emit({ type: 'todos', item: 'turn-2', todos: [
    { text: 'a', status: 'in_progress' }, { text: 'b', status: 'pending' },
  ] });
  assert.equal(delta(x.item('turn-2')).length, 0, 'a re-seed of an unchanged plan adds no delta');

  // turn-2 finishes a and starts b → those are turn-2's delta; turn-1 unchanged.
  x.emit({ type: 'todos', item: 'turn-2', todos: [
    { text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' },
  ] });
  assert.deepEqual(delta(x.item('turn-2')).map(s => s.text).sort(), ['a', 'b'], 'turn-2 advanced a and b');
  assert.deepEqual(delta(x.item('turn-1')).map(s => s.text), ['a'], 'turn-1 delta is untouched');
  assert.equal(x.state.todos.filter(t => t.done).length, 1, 'session plan reflects the completion');
});

test('steps already done when first seen are not attributed to a turn', () => {
  const x = stream();
  x.emit({ type: 'item', id: 'turn-1', status: 'doing' });
  // A continued session (or a checklist written pre-checked): the first snapshot
  // already shows items completed. They were not moved during turn-1.
  x.emit({ type: 'todos', item: 'turn-1', todos: [
    { text: 'a', status: 'completed' }, { text: 'b', status: 'completed' }, { text: 'c', status: 'pending' },
  ] });
  assert.equal(delta(x.item('turn-1')).length, 0, "pre-done work is not this turn's delta");
  assert.equal(x.state.todos.filter(t => t.done).length, 2, 'but the sidebar plan still shows them done');
});

// The live "now" line: a card surfaces the latest of its narration / commands so
// a turn spent thinking and watching still reads as alive. Latest activity wins,
// but narration outranks nothing newer than itself — it's just the most recent.
test('say narration and commands fill the active card\'s live now line', () => {
  const x = stream();
  x.emit({ type: 'item', id: 'turn-1', status: 'doing' });
  assert.equal(x.item('turn-1').now, null, 'no activity yet → no now line');

  x.emit({ type: 'tool', tool: 'run', text: 'ps -axo pid,etime | rg eval', item: 'turn-1' });
  assert.equal(x.item('turn-1').now.kind, 'tool', 'a command fills the now line');

  x.emit({ type: 'say', text: 'Waiting one more interval for the harvest', item: 'turn-1' });
  assert.equal(x.item('turn-1').now.kind, 'say', 'newer narration takes the slot');
  assert.match(x.item('turn-1').now.text, /harvest/);
  assert.equal(x.state.session.lastSay, 'Waiting one more interval for the harvest');

  x.emit({ type: 'tool', tool: 'run', text: 'find . -name "*.json"', item: 'turn-1' });
  assert.equal(x.item('turn-1').now.kind, 'tool', 'the newest activity always wins');
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
