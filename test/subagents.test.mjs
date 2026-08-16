// Subagent lifecycle folding (the `agent` event → state.subagents). The invariant
// family: three producers sight the same agentId (SubagentStart/Stop boundaries,
// the spawning call's enriched response) and the fold must MERGE them into one
// honest row — enrichment, never duplication; boundary math only as fallback;
// a subagent's own activity attributed, its plan quarantined from the session's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, subagentList } from '../public/reducer.js';

function stream() {
  const s = initialState();
  let t = 1_000;
  return {
    state: s,
    emit(o) { reduce(s, { t: (t += 1000), ...o }); return s; },
    sub: id => s.subagents.get(id),
    at: () => t,
  };
}

test('foreground lifecycle merges three sightings into one enriched row', () => {
  const x = stream();
  x.emit({ type: 'agent', state: 'start', agentId: 'a1', agentType: 'Explore' });   // SubagentStart
  const startedAt = x.at();
  assert.equal(x.sub('a1').status, 'running');
  assert.equal(x.sub('a1').startedAt, startedAt);

  x.emit({ type: 'agent', state: 'done', agentId: 'a1', agentType: 'Explore' });    // SubagentStop
  x.emit({ type: 'agent', state: 'done', agentId: 'a1', agentType: 'Explore',      // PostToolUse enrich
    desc: 'find flaky tests', model: 'claude-sonnet-5', durMs: 5285, tokens: 25044, toolUses: 3, outcome: 'completed' });

  assert.equal(x.state.subagents.size, 1, 'three sightings, one row');
  const sub = x.sub('a1');
  assert.equal(sub.status, 'done');
  assert.equal(sub.desc, 'find flaky tests');
  assert.equal(sub.model, 'claude-sonnet-5');
  assert.equal(sub.durMs, 5285, 'spawner-reported duration is authoritative over boundary math');
  assert.equal(sub.tokens, 25044);
  assert.equal(sub.toolUses, 3);
});

test('background lifecycle: described start now, bare stop later — boundary duration', () => {
  const x = stream();
  x.emit({ type: 'agent', state: 'start', agentId: 'bg1', agentType: 'claude', desc: 'long research', background: true });
  const t0 = x.at();
  x.emit({ type: 'tool', tool: 'run', text: 'grep …', agentId: 'bg1' });
  x.emit({ type: 'agent', state: 'done', agentId: 'bg1', agentType: 'claude' }); // SubagentStop, no metrics
  const t1 = x.at();

  const sub = x.sub('bg1');
  assert.equal(sub.status, 'done');
  assert.equal(sub.background, true);
  assert.equal(sub.desc, 'long research');
  assert.equal(sub.durMs, t1 - t0, 'no reported metrics → duration from recorded boundaries');
});

test('an enriched done with no witnessed start derives its span from durMs', () => {
  const x = stream();
  x.emit({ type: 'agent', state: 'done', agentId: 'a2', desc: 'late sighting', durMs: 4000, outcome: 'completed' });
  const sub = x.sub('a2');
  assert.equal(sub.endedAt, x.at());
  assert.equal(sub.startedAt, x.at() - 4000, 'startedAt backfilled so the row still has a real span');
});

test('a subagent todos snapshot parks on its row and never clobbers the session plan', () => {
  const x = stream();
  x.emit({ type: 'todos', todos: [{ text: 'parent step', status: 'in_progress' }] });
  x.emit({ type: 'agent', state: 'start', agentId: 'a3', agentType: 'general' });
  x.emit({ type: 'todos', agentId: 'a3', todos: [{ text: 'sub step A', status: 'pending' }, { text: 'sub step B', status: 'completed' }] });

  assert.equal(x.state.todos.length, 1, 'session plan untouched');
  assert.equal(x.state.todos[0].text, 'parent step');
  assert.equal(x.sub('a3').todos.length, 2, 'subagent keeps its own plan');
  // and the parent's in-progress step was NOT swept superseded by the sub's list
  assert.equal(x.state.todos[0].status, 'in_progress');
});

test('agentId-stamped tool/edit activity counts on the subagent row AND session totals', () => {
  const x = stream();
  x.emit({ type: 'agent', state: 'start', agentId: 'a4' });
  x.emit({ type: 'tool', tool: 'run', text: 'npm test', agentId: 'a4' });
  x.emit({ type: 'edit', path: 'src/x.js', agentId: 'a4' });

  assert.equal(x.sub('a4').tools, 1);
  assert.equal(x.sub('a4').edits, 1);
  assert.equal(x.state.totals.tools, 1, 'still session work');
  assert.equal(x.state.totals.edits, 1);
  assert.equal(x.state.files.get('src/x.js').edits, 1, 'churn map still sees the file');
});

test('session end sweeps a still-running subagent to abandoned', () => {
  const x = stream();
  x.emit({ type: 'agent', state: 'start', agentId: 'a5', desc: 'never came back' });
  x.emit({ type: 'session', phase: 'end' });
  assert.equal(x.sub('a5').status, 'abandoned');
  assert.equal(x.sub('a5').endedAt, x.at(), 'clock stops at the recorded end, not forever');
});

test('subagentList orders running first, then done by completion (newest first)', () => {
  const x = stream();
  x.emit({ type: 'agent', state: 'start', agentId: 'd1' });
  x.emit({ type: 'agent', state: 'done', agentId: 'd1' });
  x.emit({ type: 'agent', state: 'start', agentId: 'd2' });
  x.emit({ type: 'agent', state: 'done', agentId: 'd2' });
  x.emit({ type: 'agent', state: 'start', agentId: 'r1' });
  assert.deepEqual(subagentList(x.state).map(s => s.id), ['r1', 'd2', 'd1']);
});

test('a nested spawn keeps the child identity; the spawner lands as parentAgentId', () => {
  const x = stream();
  x.emit({ type: 'agent', state: 'start', agentId: 'child', agentType: 'general', parentAgentId: 'parent' });
  assert.equal(x.sub('child').parentAgentId, 'parent');
  assert.equal(x.state.subagents.has('parent'), false, 'a parent reference alone conjures no row');
});
