// Zero-dep reducer tests (node:test + node:assert). Run: npm test
//
// These guard the category "a conversation boundary must not push a card past
// its real work state": a turn ends, but the card it owns can't be 'done' while
// its PR is still open — the PR's own merge/close carries it to done.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialState, reduce, fold, sessionPausedAt } from '../public/reducer.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Tiny event-stream helper: monotonically increasing t, fresh state.
function stream() {
  const s = initialState();
  let t = 1_000;
  return {
    state: s,
    emit(o) { reduce(s, { t: (t += 1000), ...o }); return s; },
    item: id => s.items.get(id),
    at: () => t,           // the t of the last emitted event (for frozen-time asserts)
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

// Plan fossils: agents rewrite the plan constantly. A step witnessed in_progress
// on a card, then DROPPED from the next snapshot, must not keep ticking forever —
// it freezes as 'superseded' with its run time frozen at the moment it vanished.
const dEntry = (it, text) => it.delta && it.delta.get(text);

test('a step dropped from the plan while in_progress freezes as superseded', () => {
  const x = stream();
  x.emit({ type: 'item', id: 'turn-1', status: 'doing' });
  x.emit({ type: 'todos', item: 'turn-1', todos: [
    { text: 'A', status: 'pending' }, { text: 'B', status: 'pending' },
  ] });
  // A completes, B goes in_progress → both witnessed into turn-1's delta.
  x.emit({ type: 'todos', item: 'turn-1', todos: [
    { text: 'A', status: 'completed' }, { text: 'B', status: 'in_progress' },
  ] });
  const startedAt = x.at();
  assert.equal(dEntry(x.item('turn-1'), 'B').status, 'in_progress', 'B is a live delta step');

  // Next snapshot reworded the plan: B is gone, replaced by C. B is now a fossil.
  x.emit({ type: 'todos', item: 'turn-1', todos: [
    { text: 'A', status: 'completed' }, { text: 'C', status: 'in_progress' },
  ] });
  const supersededAt = x.at();
  const b = dEntry(x.item('turn-1'), 'B');
  assert.equal(b.status, 'superseded', 'a dropped in_progress step is marked superseded');
  assert.equal(b.supersededAt, supersededAt, 'frozen at the snapshot that dropped it');
  assert.equal(b.startedAt, startedAt, 'startedAt is kept → elapsed freezes as supersededAt − startedAt');
  assert.equal(b.doneAt, undefined, 'a superseded step never completed');
  // A (completed) is untouched by the sweep — only in_progress fossils freeze.
  assert.equal(dEntry(x.item('turn-1'), 'A').status, 'completed', 'a completed step is not swept');
});

test('a superseded fossil freezes on EVERY card, not just the active one', () => {
  const x = stream();
  // turn-1 starts step S, then its turn ends without S ever completing.
  x.emit({ type: 'item', id: 'turn-1', status: 'doing' });
  x.emit({ type: 'todos', item: 'turn-1', todos: [{ text: 'S', status: 'pending' }] });
  x.emit({ type: 'todos', item: 'turn-1', todos: [{ text: 'S', status: 'in_progress' }] });
  x.emit({ type: 'item', id: 'turn-1', status: 'done' });
  // turn-2 opens with a wholly rewritten plan that no longer contains S.
  x.emit({ type: 'item', id: 'turn-2', status: 'doing' });
  x.emit({ type: 'todos', item: 'turn-2', todos: [{ text: 'T', status: 'pending' }] });
  assert.equal(dEntry(x.item('turn-1'), 'S').status, 'superseded',
    "turn-1's fossil freezes even though turn-2 is the active card");
});

test('a superseded step that reappears and completes lands completed, not stuck', () => {
  const x = stream();
  x.emit({ type: 'item', id: 'turn-1', status: 'doing' });
  x.emit({ type: 'todos', item: 'turn-1', todos: [{ text: 'B', status: 'pending' }] });
  x.emit({ type: 'todos', item: 'turn-1', todos: [{ text: 'B', status: 'in_progress' }] });
  x.emit({ type: 'todos', item: 'turn-1', todos: [{ text: 'X', status: 'in_progress' }] }); // drops B
  assert.equal(dEntry(x.item('turn-1'), 'B').status, 'superseded', 'B fossilized');

  // The agent restores B and it goes in_progress again → the fossil un-freezes.
  x.emit({ type: 'todos', item: 'turn-1', todos: [
    { text: 'B', status: 'in_progress' }, { text: 'X', status: 'in_progress' },
  ] });
  assert.equal(dEntry(x.item('turn-1'), 'B').status, 'in_progress', 'a restored step resumes witnessing');
  assert.equal(dEntry(x.item('turn-1'), 'B').supersededAt, undefined, 'the frozen stamp is cleared on resume');

  // …and then completes → completed, never stranded superseded.
  x.emit({ type: 'todos', item: 'turn-1', todos: [
    { text: 'B', status: 'completed' }, { text: 'X', status: 'in_progress' },
  ] });
  assert.equal(dEntry(x.item('turn-1'), 'B').status, 'completed', 'the restored step completes normally');
  assert.ok(dEntry(x.item('turn-1'), 'B').doneAt, 'and carries a real completion time');
});

test('a fossil that reappears DIRECTLY as completed still counts (no in_progress step between)', () => {
  const x = stream();
  x.emit({ type: 'item', id: 'turn-1', status: 'doing' });
  x.emit({ type: 'todos', item: 'turn-1', todos: [{ text: 'B', status: 'pending' }] });
  x.emit({ type: 'todos', item: 'turn-1', todos: [{ text: 'B', status: 'in_progress' }] });
  x.emit({ type: 'todos', item: 'turn-1', todos: [{ text: 'X', status: 'in_progress' }] }); // drops B
  assert.equal(dEntry(x.item('turn-1'), 'B').status, 'superseded');
  // Directly reintroduced as completed (no in_progress snapshot in between).
  x.emit({ type: 'todos', item: 'turn-1', todos: [{ text: 'B', status: 'completed' }] });
  assert.equal(dEntry(x.item('turn-1'), 'B').status, 'completed', 'a restored-and-completed fossil is completed');
});

test('superseded folding is replay-pure: incremental reduce == fold at the end and mid-scrub', () => {
  const events = [
    { t: 1000, type: 'item', id: 'turn-1', status: 'doing' },
    { t: 2000, type: 'todos', item: 'turn-1', todos: [{ text: 'B', status: 'pending' }] },
    { t: 3000, type: 'todos', item: 'turn-1', todos: [{ text: 'B', status: 'in_progress' }] },
    { t: 4000, type: 'todos', item: 'turn-1', todos: [{ text: 'C', status: 'in_progress' }] }, // drop B
    { t: 5000, type: 'todos', item: 'turn-1', todos: [{ text: 'B', status: 'completed' }, { text: 'C', status: 'in_progress' }] },
  ];
  const norm = st => [...(st.items.get('turn-1').delta || new Map()).entries()]
    .map(([k, v]) => [k, v.status, v.startedAt || 0, v.doneAt || 0, v.supersededAt || 0]).sort();

  // Incremental reduce (the live path) equals a whole-tape fold (replay to end).
  const incr = initialState();
  for (const ev of events) reduce(incr, ev);
  assert.deepEqual(norm(fold(events)), norm(incr), 'end-of-tape fold == incremental live reduce');

  // Mid-scrub (t=4500, after the drop, before the restore): B reads superseded.
  const mid = fold(events, 4500);
  assert.equal(mid.items.get('turn-1').delta.get('B').status, 'superseded',
    'scrubbed to the fossil window, B is superseded at that replay time');
  assert.equal(mid.items.get('turn-1').delta.get('B').supersededAt, 4000, 'frozen at the drop, not "now"');
});

test('a plan that never drops a step gains no superseded entries (v1 behavior unchanged)', () => {
  const x = stream();
  x.emit({ type: 'item', id: 'turn-1', status: 'doing' });
  x.emit({ type: 'todos', item: 'turn-1', todos: [{ text: 'a', status: 'pending' }, { text: 'b', status: 'pending' }] });
  x.emit({ type: 'todos', item: 'turn-1', todos: [{ text: 'a', status: 'in_progress' }, { text: 'b', status: 'pending' }] });
  x.emit({ type: 'todos', item: 'turn-1', todos: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }] });
  x.emit({ type: 'todos', item: 'turn-1', todos: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'completed' }] });
  const entries = delta(x.item('turn-1'));
  assert.ok(entries.every(e => e.status !== 'superseded'), 'no step ever dropped → nothing superseded');
  assert.ok(entries.every(e => e.supersededAt === undefined), 'no supersededAt is ever stamped');
  assert.deepEqual(entries.map(e => [e.text, e.status]).sort(), [['a', 'completed'], ['b', 'completed']]);
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

// Regression against the tape that surfaced this bug, now a hermetic in-repo
// fixture (test/tapes/pr-parking.jsonl) instead of a mutable machine-local tape
// that had since rotated away — the old test could never pass on any other
// machine. The referenced .bak-1782904052 could not reproduce it (its PR events
// carry no item link, so no card ever attaches a PR), so the fixture is a faithful
// synthesis of the same two assertions — see the Phase 0 report.
test('pr-parking tape: turn-5 sits in PR until #381 merges', () => {
  const tape = path.join(here, 'tapes', 'pr-parking.jsonl');
  const evs = fs.readFileSync(tape, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

  // Mid-scrub: after the turn-boundary "done", before the merge — #381 still open.
  const midT = evs.find(e => e.type === 'item' && e.id === 'turn-5' && e.status === 'done').t + 30_000;
  const atScreenshot = fold(evs, midT);
  assert.equal(atScreenshot.items.get('turn-5').status, 'pr',
    'at mid time turn-5 belongs in PR-open, not Done');

  // End of tape: #381 has merged, so turn-5 is legitimately done.
  const final = fold(evs);
  assert.equal(final.items.get('turn-5').status, 'done');
  assert.equal(final.items.get('turn-5').pr.state, 'merged');
});

// The `base` field (stacked-PR chain) rides through the reducer onto state.prs,
// and is sticky — a later state-only event without base keeps the earlier link.
// The /graph view draws the chain edge from it; old tapes (no base) draw none.
test('pr base is stored on state.prs and is sticky across later state events', () => {
  const x = stream();
  x.emit({ type: 'pr', number: 1, repo: 'o/r', state: 'merged', source: 'poll-github', v: 2 });
  x.emit({ type: 'pr', number: 2, repo: 'o/r', state: 'open', base: 1, source: 'poll-github', v: 2 });
  assert.equal(x.state.prs.get('o/r#2').base, 1, 'base recorded from the pr event');
  // a later state-only event (the merge) carries no base — the link must persist
  x.emit({ type: 'pr', number: 2, repo: 'o/r', state: 'merged', source: 'poll-github', v: 2 });
  assert.equal(x.state.prs.get('o/r#2').base, 1, 'base survives a later state-only event');
  assert.equal(x.state.prs.get('o/r#1').base, null, 'a PR with no base stays null');
});

// PR diff size (add/del) rides through the reducer onto state.prs and is sticky —
// a later state-only echo (a merge with no numbers) must NOT erase the size, so the
// /graph diff chip keeps rendering. Absent on old tapes → undefined (no chip).
test('pr add/del are stored on state.prs and are sticky across a size-less echo', () => {
  const x = stream();
  // First sighting carries the diff size.
  x.emit({ type: 'pr', number: 7, repo: 'o/r', state: 'open', add: 1284, del: 56, source: 'poll-github', v: 2 });
  assert.equal(x.state.prs.get('o/r#7').add, 1284, 'add recorded from the pr event');
  assert.equal(x.state.prs.get('o/r#7').del, 56, 'del recorded from the pr event');
  // The merge is a state-only echo (no add/del) — the numbers must persist.
  x.emit({ type: 'pr', number: 7, repo: 'o/r', state: 'merged', source: 'poll-github', v: 2 });
  assert.equal(x.state.prs.get('o/r#7').add, 1284, 'add survives a later size-less event');
  assert.equal(x.state.prs.get('o/r#7').del, 56, 'del survives a later size-less event');
  assert.equal(x.state.prs.get('o/r#7').state, 'merged', 'the echo still applied the state change');
});

test('a pr event with no size leaves state.prs without add/del (old-tape / no chip)', () => {
  const x = stream();
  x.emit({ type: 'pr', number: 8, repo: 'o/r', state: 'open', source: 'poll-github', v: 2 });
  assert.equal(x.state.prs.get('o/r#8').add, undefined, 'no size event → no add (chip omitted)');
  assert.equal(x.state.prs.get('o/r#8').del, undefined, 'no size event → no del');
});

// sessionPausedAt — the pure display helper behind the paused board card (Fix A)
// and the paused /graph step node (Fix B). Non-null ONLY on the recorded idle
// phase, frozen to the last producer moment; a working / attention / stale-but-
// working session returns null (nothing is paused).
test('sessionPausedAt returns the quiet moment on recorded idle, null otherwise', () => {
  const x = stream();
  x.emit({ type: 'session', phase: 'start' });
  x.emit({ type: 'item', id: 'wi', title: 'work', status: 'doing' });
  const workAt = x.emit({ type: 'edit', path: 'a.js' }) && x.at();
  assert.equal(sessionPausedAt(x.state), null, 'a working session is not paused');

  // The turn ends: the recorder emits a real idle phase.
  const idleAt = x.emit({ type: 'session', phase: 'idle' }) && x.at();
  assert.equal(sessionPausedAt(x.state), idleAt, 'idle → frozen at the last producer event (the idle mark)');

  // A reconcile append (poll-github) after idle must NOT move the frozen moment —
  // it isn't producer work, so the paused clock stays put (else it ticks phantom).
  x.emit({ type: 'pr', number: 1, repo: 'o/r', state: 'open', source: 'poll-github', v: 2 });
  assert.equal(sessionPausedAt(x.state), idleAt, 'a reconcile append does not advance the frozen moment');
  assert.ok(idleAt > workAt);

  // Any real activity wakes the session (awake) → back to working → not paused.
  x.emit({ type: 'edit', path: 'b.js' });
  assert.equal(x.state.session.phase, 'working');
  assert.equal(sessionPausedAt(x.state), null, 'resumed work clears the paused state');
});

// affirmedAt (Fix A) — the per-step freshness signal. Every snapshot that STILL
// claims a step in_progress re-stamps affirmedAt to that snapshot's t (always the
// latest), while startedAt is set once at the first in_progress and never moves. It
// answers "is this step actually still being worked", so /graph can honestly un-
// pause only the steps a recent snapshot re-affirmed.
const stepOf = (st, text) => st.todos.find(s => s.text === text);

test('a todos snapshot stamps affirmedAt; a re-affirming snapshot bumps it while startedAt stays fixed', () => {
  const x = stream();
  x.emit({ type: 'item', id: 'turn-1', status: 'doing' });
  const t1 = x.emit({ type: 'todos', item: 'turn-1', todos: [{ text: 'grind', status: 'in_progress' }] }) && x.at();
  let step = stepOf(x.state, 'grind');
  assert.equal(step.startedAt, t1, 'startedAt is the first in_progress moment');
  assert.equal(step.affirmedAt, t1, 'affirmedAt is stamped on the first in_progress snapshot');

  // A later snapshot STILL lists the step in_progress → affirmedAt advances to the
  // newer t; startedAt is unchanged.
  const t2 = x.emit({ type: 'todos', item: 'turn-1', todos: [{ text: 'grind', status: 'in_progress' }] }) && x.at();
  step = stepOf(x.state, 'grind');
  assert.ok(t2 > t1);
  assert.equal(step.startedAt, t1, 'startedAt never moves off the first in_progress');
  assert.equal(step.affirmedAt, t2, 'affirmedAt tracks the most recent re-affirmation');
});

test('a completed step keeps its startedAt; affirmedAt holds the LAST in_progress, not the completion', () => {
  const x = stream();
  x.emit({ type: 'item', id: 'turn-1', status: 'doing' });
  const t1 = x.emit({ type: 'todos', item: 'turn-1', todos: [{ text: 'a', status: 'in_progress' }] }) && x.at();
  const t2 = x.emit({ type: 'todos', item: 'turn-1', todos: [{ text: 'a', status: 'completed' }] }) && x.at();
  const step = stepOf(x.state, 'a');
  assert.ok(t2 > t1);
  assert.equal(step.startedAt, t1, 'startedAt is fixed at the first in_progress');
  assert.equal(step.doneAt, t2, 'doneAt is the completion');
  assert.equal(step.affirmedAt, t1, 'affirmedAt is the last in_progress affirmation — completion does not re-stamp it');
});

test('affirmedAt is purely additive: startedAt/doneAt semantics are unchanged (replay-pure)', () => {
  const events = [
    { t: 1000, type: 'item', id: 'turn-1', status: 'doing' },
    { t: 2000, type: 'todos', item: 'turn-1', todos: [{ text: 'a', status: 'in_progress' }] },
    { t: 3000, type: 'todos', item: 'turn-1', todos: [{ text: 'a', status: 'in_progress' }] },
    { t: 4000, type: 'todos', item: 'turn-1', todos: [{ text: 'a', status: 'completed' }] },
  ];
  // Incremental live reduce equals a whole-tape fold, affirmedAt included.
  const incr = initialState();
  for (const ev of events) reduce(incr, ev);
  const norm = st => stepOf(st, 'a');
  assert.deepEqual(norm(fold(events)), norm(incr), 'end-of-tape fold == incremental live reduce');
  // Mid-scrub before the second affirmation: affirmedAt is the first, not "now".
  const mid = stepOf(fold(events, 2500), 'a');
  assert.equal(mid.affirmedAt, 2000, 'scrubbed to t=2500, affirmedAt is the first in_progress snapshot');
  assert.equal(mid.startedAt, 2000, 'startedAt matches');
});
