// preflightRuns is a pure projection over the tape: a /preflight turn card plus
// the skill's own "Phase N:" task snapshots ARE the run — no producer changes,
// old tapes gain the panel retroactively, and replay scrubs mid-run honestly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflightRuns } from '../public/preflight-model.js';

let T = 0;
const at = () => (T += 1000);
function run1(itemId = 'turn-ab12cd34-3') {
  // A realistic recorded run: card → task list evolving → PR → CI → done.
  return [
    { t: at(), type: 'item', id: itemId, title: '/preflight', status: 'doing' },
    { t: at(), type: 'todos', item: itemId, todos: [
      { text: 'Phase 1: Detect tooling', status: 'in_progress' },
      { text: 'Phase 2: Build (parallel)', status: 'pending' },
      { text: 'Phase 2: Test (parallel)', status: 'pending' },
      { text: 'Phase 3: Create PR + request reviewers (parallel)', status: 'pending' },
    ] },
    { t: at(), type: 'todos', item: itemId, todos: [
      { text: 'Phase 1: Detect tooling', status: 'completed' },
      { text: 'Phase 2: Build (parallel)', status: 'in_progress' },
      { text: 'Phase 2: Test (parallel)', status: 'in_progress' },
      { text: 'Phase 3: Create PR + request reviewers (parallel)', status: 'pending' },
    ] },
    { t: at(), type: 'pr_ref', item: itemId, number: 77 },
    { t: at(), type: 'ci', pr: 77, status: 'pending' },
    { t: at(), type: 'todos', item: itemId, todos: [
      { text: 'Phase 1: Detect tooling', status: 'completed' },
      { text: 'Phase 2: Build (parallel)', status: 'completed' },
      { text: 'Phase 2: Test (parallel)', status: 'completed' },
      { text: 'Phase 3: Create PR + request reviewers (parallel)', status: 'completed' },
    ] },
    { t: at(), type: 'ci', pr: 77, status: 'pass' },
    { t: at(), type: 'item', id: itemId, status: 'done' },
  ];
}

test('one recorded run: phases fold from tagged steps, PR and CI attach, outcome pass', () => {
  T = 0;
  const runs = preflightRuns(run1());
  assert.equal(runs.length, 1);
  const r = runs[0];
  assert.equal(r.seq, 1);
  assert.equal(r.status, 'done');
  assert.equal(r.outcome, 'pass');
  assert.equal(r.phasesCompleted, 3);
  assert.equal(r.pr, 77);
  assert.equal(r.ci, 'pass');
  assert.equal(r.phases.find(p => p.n === 2).steps.length, 2, 'parallel steps grouped under one phase');
  assert.ok(r.durMs > 0);
});

test('replay mid-run: untilT freezes the run running with the active phase', () => {
  T = 0;
  const events = run1();
  const midT = events[2].t; // after the second snapshot: phase 1 done, phase 2 active
  const [r] = preflightRuns(events, midT);
  assert.equal(r.status, 'running');
  assert.equal(r.activePhase, 2);
  assert.equal(r.phasesCompleted, 1);
  assert.equal(r.outcome, null, 'no outcome claimed before the run ends');
});

test('run count: two /preflight cards are two runs, numbered in order', () => {
  T = 0;
  const events = [...run1('turn-aa-1'), ...run1('turn-aa-5')];
  const runs = preflightRuns(events);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map(r => r.seq), [1, 2]);
  assert.equal(runs[1].pr, 77);
});

test('a run ended with phases incomplete reads incomplete, never pass', () => {
  T = 0;
  const itemId = 'turn-bb-2';
  const events = [
    { t: at(), type: 'item', id: itemId, title: '/preflight', status: 'doing' },
    { t: at(), type: 'todos', item: itemId, todos: [
      { text: 'Phase 1: Detect tooling', status: 'completed' },
      { text: 'Phase 2: Build (parallel)', status: 'in_progress' },
    ] },
    { t: at(), type: 'item', id: itemId, status: 'done' },
  ];
  const [r] = preflightRuns(events);
  assert.equal(r.status, 'done');
  assert.equal(r.outcome, 'incomplete');
});

test('session end sweeps a still-running preflight to abandoned', () => {
  T = 0;
  const itemId = 'turn-cc-1';
  const events = [
    { t: at(), type: 'item', id: itemId, title: '/preflight run please', status: 'doing' },
    { t: at(), type: 'todos', item: itemId, todos: [{ text: 'Phase 1: Detect tooling', status: 'in_progress' }] },
    { t: at(), type: 'session', phase: 'end' },
  ];
  const [r] = preflightRuns(events);
  assert.equal(r.status, 'abandoned');
});

test('unattributed todos join the single open run (attribution heuristic)', () => {
  T = 0;
  const events = [
    { t: at(), type: 'item', id: 'turn-dd-1', title: '/preflight', status: 'doing' },
    { t: at(), type: 'todos', todos: [{ text: 'Phase 1: Detect tooling', status: 'in_progress' }] }, // no item
  ];
  const [r] = preflightRuns(events);
  assert.equal(r.activePhase, 1);
});

test('non-phase-tagged steps in the same snapshot are ignored, not miscounted', () => {
  T = 0;
  const events = [
    { t: at(), type: 'item', id: 'turn-ee-1', title: '/preflight', status: 'doing' },
    { t: at(), type: 'todos', item: 'turn-ee-1', todos: [
      { text: 'Phase 1: Detect tooling', status: 'completed' },
      { text: 'fix the flaky test first', status: 'in_progress' },
    ] },
  ];
  const [r] = preflightRuns(events);
  assert.equal(r.phases.length, 1);
  assert.equal(r.phases[0].steps.length, 1);
});

test('an explicit work_phase preflight lane is honored, outcome from the end event', () => {
  T = 0;
  const events = [
    { t: at(), type: 'work_phase', state: 'start', phase: 'preflight', runId: 'r9', item: 'turn-ff-1' },
    { t: at(), type: 'todos', item: 'turn-ff-1', todos: [{ text: 'Phase 6: Verify CI green', status: 'in_progress' }] },
    { t: at(), type: 'work_phase', state: 'end', phase: 'preflight', runId: 'r9', outcome: 'pass' },
  ];
  const [r] = preflightRuns(events);
  assert.equal(r.status, 'done');
  assert.equal(r.outcome, 'pass', 'an explicit producer outcome wins over the derived one');
});

test('an ordinary session with no preflight yields zero runs', () => {
  T = 0;
  const events = [
    { t: at(), type: 'item', id: 'turn-gg-1', title: 'fix the login bug', status: 'doing' },
    { t: at(), type: 'todos', item: 'turn-gg-1', todos: [{ text: 'Phase 1 of the migration plan', status: 'pending' }] },
    { t: at(), type: 'item', id: 'turn-gg-1', status: 'done' },
  ];
  assert.equal(preflightRuns(events).length, 0, 'phase-shaped steps alone are not a run without a /preflight declaration');
});
