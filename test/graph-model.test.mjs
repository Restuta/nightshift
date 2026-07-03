// Graph-model tests — hermetic, zero-dep (node:test + node:assert). Run: npm test.
// The load-bearing derivations of the /graph view are pure (public/graph-model.js):
// node sourcing (PRs / plan / intent items / session, and NO turn-cards), edge
// derivation (item→PR, base-chain, plan-step→item), column assignment, and
// deterministic layer ordering. All asserted here on a golden tape + inline arrays.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraphModel, COLUMNS, MAX_PER_COL, TURN_RE } from '../public/graph-model.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TAPES = path.join(here, 'tapes');
const readTape = f => fs.readFileSync(path.join(TAPES, f), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l));

const nodeById = (m, id) => m.nodes.find(n => n.id === id);
const hasEdge = (m, from, to, kind) =>
  m.edges.some(e => e.from === from && e.to === to && (!kind || e.kind === kind));

// --- node sourcing: real entities, never turn-cards -------------------------
test('nodes come from PRs / plan / intent items / session — NOT turn-cards', () => {
  const m = buildGraphModel(readTape('graph.jsonl'));

  // exactly one session root
  assert.equal(m.nodes.filter(n => n.kind === 'session').length, 1);
  assert.equal(nodeById(m, 'session').agent, 'claude');

  // the turn card (turn-1, "hold on....") must NOT become a node
  assert.ok(!m.nodes.some(n => n.kind === 'intent' && TURN_RE.test(n.itemId || '')),
    'no turn-<n> intent node');
  assert.ok(!m.nodes.some(n => n.id === 'intent:turn-1'), 'turn-1 is not a node');

  // the three declared work items ARE intent nodes
  for (const id of ['wi-schema', 'wi-server', 'wi-ui'])
    assert.ok(nodeById(m, 'intent:' + id), `${id} is an intent node`);

  // one plan cluster node (the session plan), not one node per step
  assert.equal(m.nodes.filter(n => n.kind === 'plan').length, 1);
  const plan = nodeById(m, 'plan');
  assert.ok(plan.steps.length >= 1 && plan.total === plan.steps.length);

  // PR nodes for #1, #2, #3, keyed by repo#number
  for (const key of ['o/r#1', 'o/r#2', 'o/r#3'])
    assert.ok(nodeById(m, 'pr:' + key), `PR ${key} is a node`);
  const pr1 = nodeById(m, 'pr:o/r#1');
  assert.equal(pr1.prState, 'merged');
  assert.equal(pr1.ci, 'pass');
  assert.equal(pr1.repo, 'o/r');
});

test('a v1 pr with no repo but a URL still shows repo#number from the URL', () => {
  const evs = [
    { t: 1, type: 'session', phase: 'start', title: 't' },
    { t: 2, type: 'pr', number: 9, url: 'https://github.com/acme/widget/pull/9', state: 'open' },
  ];
  const m = buildGraphModel(evs);
  const pr = m.nodes.find(n => n.kind === 'pr' && n.number === 9);
  assert.equal(pr.repo, 'acme/widget', 'repo parsed from the PR URL');
});

// --- edges ------------------------------------------------------------------
test('edge derivation: item→PR, base-chain, plan-step→item', () => {
  const m = buildGraphModel(readTape('graph.jsonl'));

  // intent item → its PR
  assert.ok(hasEdge(m, 'intent:wi-schema', 'pr:o/r#1', 'item-pr'));
  assert.ok(hasEdge(m, 'intent:wi-server', 'pr:o/r#2', 'item-pr'));

  // PR → base PR (the stacked chain): #2 is based on #1
  assert.ok(hasEdge(m, 'pr:o/r#2', 'pr:o/r#1', 'pr-base'), 'base-chain edge present');
  assert.equal(nodeById(m, 'pr:o/r#2').chainDepth, 1, 'stacked PR sits one deeper in the chain');
  assert.equal(nodeById(m, 'pr:o/r#1').chainDepth, 0);

  // plan step → the intent item it advanced under
  assert.ok(hasEdge(m, 'plan', 'intent:wi-schema', 'plan-item'));
  assert.ok(hasEdge(m, 'plan', 'intent:wi-server', 'plan-item'));

  // session containment reaches the top-level orphan PR (#3, no owning item) but
  // NOT #1/#2 (owned by their intent items → not top-level).
  assert.ok(hasEdge(m, 'session', 'pr:o/r#3', 'session'), 'orphan PR hangs off the session');
  assert.ok(!hasEdge(m, 'session', 'pr:o/r#1', 'session'), 'owned PR is not a session child');
});

test('base-chain edge is only drawn when base data is present (old tapes: none)', () => {
  // Same two PRs, but the newer one carries no base → no pr-base edge.
  const evs = [
    { t: 1, type: 'session', phase: 'start' },
    { t: 2, type: 'pr', number: 1, repo: 'o/r', state: 'merged', url: 'https://github.com/o/r/pull/1' },
    { t: 3, type: 'pr', number: 2, repo: 'o/r', state: 'open', url: 'https://github.com/o/r/pull/2' },
  ];
  const m = buildGraphModel(evs);
  assert.ok(!m.edges.some(e => e.kind === 'pr-base'), 'no base field → no base edge');
});

// --- column assignment ------------------------------------------------------
test('column assignment: plan / active / review / landed', () => {
  const m = buildGraphModel(readTape('graph.jsonl'));
  const col = id => nodeById(m, id).col; // 0 plan, 1 active, 2 review, 3 landed

  assert.equal(col('plan'), 0, 'the plan cluster sits in the plan column');
  assert.equal(col('intent:wi-ui'), 0, 'an inbox item is backlog (plan column)');

  // wi-server is promoted to status 'pr' by its open PR #2, and follows that PR's
  // column — #2 is open with running CI, so both land in Active together.
  assert.equal(col('pr:o/r#2'), 1, 'an open PR with running CI is active');
  assert.equal(col('intent:wi-server'), 1, 'an item with an open+CI-running PR sits with it in active');

  assert.equal(col('pr:o/r#3'), 2, 'an open PR (CI not running) is in review');

  assert.equal(col('intent:wi-schema'), 3, 'a done item has landed');
  assert.equal(col('pr:o/r#1'), 3, 'a merged PR has landed');

  // session root sits left of column 0
  assert.equal(nodeById(m, 'session').col, -1);
});

// --- collapse at scale ------------------------------------------------------
test('a column past MAX_PER_COL collapses its overflow into one "N more" node', () => {
  const evs = [{ t: 0, type: 'session', phase: 'start', title: 'many PRs' }];
  const N = MAX_PER_COL + 8; // enough merged PRs to overflow the landed column
  for (let i = 1; i <= N; i++) {
    evs.push({ t: 100 + i, type: 'pr', number: i, repo: 'o/r', state: 'merged',
      url: `https://github.com/o/r/pull/${i}`, occurredAt: 100 + i });
  }
  const m = buildGraphModel(evs);
  const landed = m.nodes.filter(n => n.col === 3);
  const collapsed = landed.find(n => n.kind === 'collapsed');
  assert.ok(collapsed, 'a collapsed stack node exists');
  assert.equal(collapsed.count, N - MAX_PER_COL, 'it hides exactly the overflow');
  assert.match(collapsed.label, /more merged/);
  // visible PR nodes + the collapsed node never exceed the cap
  assert.ok(landed.length <= MAX_PER_COL + 1);
  // every landed PR is accounted for: shown individually or hidden in the stack
  const shownPrs = landed.filter(n => n.kind === 'pr').length;
  assert.equal(shownPrs + collapsed.count, N);
});

test('failing-CI PRs are pinned visible even when a column overflows', () => {
  const evs = [{ t: 0, type: 'session', phase: 'start' }];
  const N = MAX_PER_COL + 6;
  for (let i = 1; i <= N; i++) {
    evs.push({ t: 100 + i, type: 'pr', number: i, repo: 'o/r', state: 'open',
      url: `https://github.com/o/r/pull/${i}`, createdAt: 100 + i });
  }
  // the OLDEST PR (#1) fails CI — recency would hide it, but it must stay pinned.
  // (emitted after #1 exists, and later than every PR's own event, but a ci event
  // doesn't bump the PR's lastTouched, so #1 stays the oldest by recency)
  evs.push({ t: 100 + N + 100, type: 'ci', pr: 1, repo: 'o/r', status: 'fail' });
  const m = buildGraphModel(evs);
  const review = m.nodes.filter(n => n.col === 2 && n.kind === 'pr');
  assert.ok(review.some(n => n.number === 1), 'the failing-CI PR is not collapsed away');
});

// --- determinism ------------------------------------------------------------
test('buildGraphModel is deterministic: same input → identical nodes, edges, order', () => {
  const evs = readTape('graph.jsonl');
  const a = buildGraphModel(evs);
  const b = buildGraphModel(evs);
  assert.deepEqual(a, b);
  // shuffling the input array must not change the (t-sorted) fold result…
  const shuffled = evs.slice().reverse();
  const c = buildGraphModel(shuffled);
  assert.deepEqual(a.nodes.map(n => [n.id, n.col, n.order]),
    c.nodes.map(n => [n.id, n.col, n.order]),
    'layout order is independent of input order (fold sorts by t)');
});

test('columns metadata is the fixed pipeline', () => {
  const m = buildGraphModel(readTape('graph.jsonl'));
  assert.deepEqual(m.columns.map(c => c.key), COLUMNS.map(c => c.key));
  assert.deepEqual(m.columns.map(c => c.key), ['plan', 'active', 'review', 'landed']);
});

// --- empty / degenerate -----------------------------------------------------
test('an empty tape still yields a session node and no crash', () => {
  const m = buildGraphModel([]);
  assert.equal(m.nodes.length, 1);
  assert.equal(m.nodes[0].kind, 'session');
  assert.deepEqual(m.edges, []);
});
