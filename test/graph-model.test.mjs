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

// --- diff-size chips --------------------------------------------------------
test('PR nodes expose diff size (add/del), sticky across a size-less merge echo', () => {
  const m = buildGraphModel(readTape('graph.jsonl'));
  // #1 was sighted open with size 1284/56, then merged with a size-less echo — the
  // node must still carry the sticky numbers the chip renders.
  const pr1 = nodeById(m, 'pr:o/r#1');
  assert.equal(pr1.add, 1284, 'PR node exposes additions');
  assert.equal(pr1.del, 56, 'PR node exposes deletions');
  assert.equal(pr1.prState, 'merged', 'and the sticky size survived the merge');
});

test('a PR with no recorded size exposes add=0/del=0 → the view draws no chip', () => {
  const m = buildGraphModel(readTape('graph.jsonl'));
  // #3 was never given a size (an old-style pr event) → 0/0, so hasSize() is false.
  const pr3 = nodeById(m, 'pr:o/r#3');
  assert.equal(pr3.add, 0, 'absent size folds to 0');
  assert.equal(pr3.del, 0, 'absent size folds to 0');
});

test('intent nodes expose commit-derived diff size for the chip', () => {
  const m = buildGraphModel(readTape('graph.jsonl'));
  // wi-schema accrued one commit of +120/-8 (event g5) — surfaced on the node.
  const wi = nodeById(m, 'intent:wi-schema');
  assert.equal(wi.add, 120, 'intent node exposes attributed additions');
  assert.equal(wi.del, 8, 'intent node exposes attributed deletions');
  // wi-ui is inbox-only (no commits) → no size, so no chip.
  const ui = nodeById(m, 'intent:wi-ui');
  assert.equal(ui.add, 0);
  assert.equal(ui.del, 0);
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

// --- session live-activity strip --------------------------------------------
const activityOf = m => nodeById(m, 'session').activity;

test('activity: the most-recently-touched doing item wins the prompt — turn cards INCLUDED', () => {
  const m = buildGraphModel([
    { t: 1, type: 'session', phase: 'start', title: 's' },
    { t: 2, type: 'item', id: 'wi-early', title: 'schema work', status: 'doing' },
    // a synthesized turn card, touched later than wi-early → it owns the prompt,
    // even though it is never a NODE.
    { t: 3, type: 'item', id: 'turn-7', title: 'wire up the live strip', status: 'doing' },
  ]);
  const a = activityOf(m);
  assert.equal(a.prompt, 'wire up the live strip', 'the freshest doing item (a turn card) is the prompt');
  // and it is still not a node
  assert.ok(!nodeById(m, 'intent:turn-7'), 'the turn card is a prompt, never a node');
});

test('activity: a fresher declared work item overtakes an older turn card', () => {
  const m = buildGraphModel([
    { t: 1, type: 'session', phase: 'start' },
    { t: 2, type: 'item', id: 'turn-1', title: 'hold on…', status: 'doing' },
    { t: 5, type: 'item', id: 'wi-server', title: 'Zero-dep SSE server', status: 'doing' },
  ]);
  assert.equal(activityOf(m).prompt, 'Zero-dep SSE server');
});

test('activity: now is the active card line; falls back to lastSay when the card has none', () => {
  // A tool line on the active card is the "now".
  const withNow = buildGraphModel([
    { t: 1, type: 'session', phase: 'start' },
    { t: 2, type: 'item', id: 'wi', title: 'do a thing', status: 'doing' },
    { t: 3, type: 'tool', text: 'running the calibration sweep', item: 'wi' },
  ]);
  assert.deepEqual(
    { text: activityOf(withNow).now.text, kind: activityOf(withNow).now.kind },
    { text: 'running the calibration sweep', kind: 'tool' });

  // A say that landed with NO doing item still sets session.lastSay; a later card
  // with no line of its own falls back to it.
  const fallback = buildGraphModel([
    { t: 1, type: 'session', phase: 'start' },
    { t: 2, type: 'say', text: 'waiting for the harvest to finish' },
    { t: 3, type: 'item', id: 'wi', title: 'do a thing', status: 'doing' },
  ]);
  const a = activityOf(fallback);
  assert.equal(a.prompt, 'do a thing');
  assert.equal(a.now.text, 'waiting for the harvest to finish', 'now falls back to lastSay');
  assert.equal(a.now.kind, 'say', 'the lastSay fallback is wrapped as a say');
});

test('activity: attention phase + text are exposed on the root', () => {
  const m = buildGraphModel([
    { t: 1, type: 'session', phase: 'start' },
    { t: 2, type: 'item', id: 'wi', title: 'do a thing', status: 'doing' },
    { t: 3, type: 'session', phase: 'attention', text: 'approve the migration?' },
  ]);
  const a = activityOf(m);
  assert.equal(a.phase, 'attention');
  assert.equal(a.attentionText, 'approve the migration?');
});

test('activity: a tape with no doing items yields a null prompt', () => {
  const m = buildGraphModel([
    { t: 1, type: 'session', phase: 'start' },
    { t: 2, type: 'item', id: 'wi-done', title: 'shipped', status: 'done' },
    { t: 3, type: 'item', id: 'wi-later', title: 'someday', status: 'inbox' },
  ]);
  assert.equal(activityOf(m).prompt, null, 'no doing item → no current prompt');
});

test('activity derivation is pure/deterministic (no Date.now, order-independent)', () => {
  const evs = [
    { t: 1, type: 'session', phase: 'start' },
    { t: 2, type: 'item', id: 'wi', title: 'a thing', status: 'doing' },
    { t: 3, type: 'say', text: 'narrating progress', item: 'wi' },
  ];
  const a = activityOf(buildGraphModel(evs));
  const b = activityOf(buildGraphModel(evs.slice().reverse()));
  assert.deepEqual(a, b, 'same events (any order) → identical activity block');
  assert.equal(a.now.t, 3, 'the now timestamp is the say event t, not wall-clock');
});

// --- empty / degenerate -----------------------------------------------------
test('an empty tape still yields a session node and no crash', () => {
  const m = buildGraphModel([]);
  assert.equal(m.nodes.length, 1);
  assert.equal(m.nodes[0].kind, 'session');
  assert.deepEqual(m.edges, []);
  // the activity block is present but empty — no prompt, no now, no attention.
  const a = m.nodes[0].activity;
  assert.equal(a.prompt, null);
  assert.equal(a.now, null);
  assert.equal(a.attentionText, null);
});
