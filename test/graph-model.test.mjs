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
import { buildGraphModel, COLUMNS, MAX_PER_COL, STEP_CAP, TURN_RE } from '../public/graph-model.js';
import { fold, sessionPausedAt } from '../public/reducer.js';
import { buildSessionInsights } from '../public/session-insights-model.js';
import { buildSummaryViewModel } from '../public/session-summary.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TAPES = path.join(here, 'tapes');
const readTape = f => fs.readFileSync(path.join(TAPES, f), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l));

const nodeById = (m, id) => m.nodes.find(n => n.id === id);
const hasEdge = (m, from, to, kind) =>
  m.edges.some(e => e.from === from && e.to === to && (!kind || e.kind === kind));

const referenceEvents = () => readTape('semantic-reference.jsonl');

// --- canonical semantic projection -----------------------------------------
test('reference graph uses the canonical current PR registry and topology', () => {
  const events = referenceEvents();
  const insights = buildSessionInsights(events, { untilT: Infinity, displayNow: events.at(-1).t });
  const m = buildGraphModel(events, insights);
  const prs = m.nodes.filter(node => node.kind === 'pr');

  assert.deepEqual(prs.map(pr => pr.key).sort(), insights.prStack.prs.map(pr => pr.key).sort());
  assert.deepEqual(prs.map(pr => pr.number).sort((a, b) => a - b), [101, 102, 103, 104, 105, 106, 107]);
  assert.equal(m.topology.axis, 'current');
  assert.deepEqual(m.topology.edges, insights.prStack.currentEdges);
  assert.deepEqual(
    m.edges.filter(edge => edge.kind === 'pr-base').map(({ fromKey, toKey }) => ({ from: fromKey, to: toKey })),
    insights.prStack.currentEdges,
  );
  assert.ok(prs.every(pr => pr.currentTruth.startsWith('Current:')));
  assert.ok(prs.every(pr => pr.recordedTruth == null || pr.recordedTruth.startsWith('Recorded:')));
  assert.ok(prs.every(pr => pr.provenance && pr.confidence));
  assert.ok(prs.every(pr => pr.milestone === 'Unassigned'));
  assert.ok(prs.every(pr => /no explicit milestone attribution/i.test(pr.milestoneConfidence)));
  assert.equal(m.semantic.state, 'attention');
  assert.equal(m.semantic.nextActor, 'human');
  assert.equal(m.semantic.currentBlocker, 'No execution blocker');
  assert.equal(m.semantic.uncertainty, null);
  assert.equal(m.semantic.uncertaintyText, 'No unresolved tool outcomes');
});

test('replay graph uses only recorded topology and recovery adds the seventh PR without invented edges', () => {
  const events = referenceEvents();
  const recoveryT = events.find(event => event.id === 'recovered-pr-104').t;
  const before = buildSessionInsights(events, { untilT: recoveryT - 1, displayNow: recoveryT - 1 });
  const beforeGraph = buildGraphModel(before.visiblePrefix, before);
  assert.equal(beforeGraph.nodes.some(node => node.kind === 'pr' && node.number === 104), false);
  assert.equal(beforeGraph.topology.axis, 'recorded', 'late tape facts without a fetch stamp are not current reconciliation');
  assert.ok(beforeGraph.nodes.filter(node => node.kind === 'pr').every(node => node.currentTruth == null));

  const finalAttentionT = events.find(event => event.id === 'final-attention').t;
  const recoveredAt = events.find(event => event.id === 'recovered-pr-104').recordedAt;
  const recovered = buildSessionInsights(events, {
    untilT: finalAttentionT,
    asOfT: recoveredAt,
    displayNow: finalAttentionT,
  });
  const recoveredGraph = buildGraphModel(recovered.visiblePrefix, recovered);
  const pr104 = recoveredGraph.nodes.find(node => node.kind === 'pr' && node.number === 104);
  assert.equal(recoveredGraph.nodes.filter(node => node.kind === 'pr').length, 7);
  assert.equal(recoveredGraph.topology.axis, 'recorded');
  assert.equal(pr104.recordedTruth, null);
  assert.equal(pr104.currentTruth, null);
  assert.match(pr104.provenance, /recovery/i);
  assert.equal(pr104.confidence, 'strong');
  assert.deepEqual(recoveredGraph.topology.edges, recovered.prStack.recordedEdges);
  assert.ok(recoveredGraph.edges
    .filter(edge => edge.kind === 'pr-base')
    .every(edge => edge.from !== pr104.id && edge.to !== pr104.id));
});

test('graph semantic projection carries the shared summary vocabulary, phase spine, and labeled tool evidence', () => {
  const events = referenceEvents();
  const insights = buildSessionInsights(events, { untilT: Infinity, displayNow: events.at(-1).t });
  const m = buildGraphModel(events, insights);
  const summary = buildSummaryViewModel(insights);

  assert.equal(summary.prs, '7 PRs open · 0 merged');
  assert.equal(summary.checklist, 'Session checklist: 8/10');
  assert.equal(summary.roadmap, 'Product roadmap: roughly one-third');
  assert.deepEqual(m.semantic.phases, insights.phases);
  assert.ok(m.semantic.phases.some(phase => phase.phase === 'preflight'));
  assert.ok(m.semantic.toolEvidence.every(tool => tool.label && tool.provenance && tool.confidence));
});

test('unknown tool outcomes remain uncertainty and never fabricate a Graph blocker', () => {
  const events = [
    { t: 0, id: 'session', type: 'session', phase: 'start', sessionId: 's' },
    { t: 10, id: 'tool-start', type: 'tool_call', state: 'start', sessionId: 's', agentId: 'a', toolUseId: 'u', tool: 'Bash' },
    { t: 20, id: 'next-prompt', type: 'notification', reason: 'next_prompt' },
  ];
  const insights = buildSessionInsights(events, { untilT: 20, displayNow: 20 });
  const model = buildGraphModel(events, insights);

  assert.equal(insights.toolCalls.missingOutcomeCount, 1);
  assert.equal(model.semantic.state, 'attention');
  assert.equal(model.semantic.currentBlocker, 'No execution blocker');
  assert.equal(model.semantic.uncertainty.label, '1 tool outcome not observed');
  assert.equal(model.semantic.uncertaintyText, '1 tool outcome not observed');
});

test('only explicit current permission evidence marks the Graph blocked', () => {
  const events = [
    { t: 0, id: 'session', type: 'session', phase: 'start' },
    { t: 10, id: 'permission', type: 'notification', reason: 'permission' },
  ];
  const insights = buildSessionInsights(events, { untilT: 10, displayNow: 10 });
  const model = buildGraphModel(events, insights);

  assert.equal(model.semantic.state, 'blocked');
  assert.equal(model.semantic.currentBlocker, 'Permission decision required');
  assert.equal(model.semantic.uncertainty, null);
  assert.equal(model.semantic.uncertaintyText, 'No unresolved tool outcomes');
});

test('recovered PR discovery and effective live snapshot expose separate provenance', () => {
  const events = referenceEvents();
  const insights = buildSessionInsights(events, { untilT: Infinity, displayNow: events.at(-1).t });
  const model = buildGraphModel(events, insights);
  const recovered = model.nodes.find(node => node.kind === 'pr' && node.number === 104);

  assert.equal(recovered.discoveryProvenance, 'Transcript recovery · recovery');
  assert.equal(recovered.snapshotProvenance, 'Current snapshot · poll-github');
  assert.equal(recovered.provenance, 'Transcript recovery · recovery; Current snapshot · poll-github');
  assert.equal(recovered.confidence, 'explicit');
});

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

  // Base PR → child PR: the topology reads in execution order.
  assert.ok(hasEdge(m, 'pr:o/r#1', 'pr:o/r#2', 'pr-base'), 'base-chain edge present');
  assert.equal(nodeById(m, 'pr:o/r#2').chainDepth, 1, 'stacked PR sits one deeper in the chain');
  assert.equal(nodeById(m, 'pr:o/r#1').chainDepth, 0);

  // plan step → the intent item it advanced under
  assert.ok(hasEdge(m, 'plan', 'intent:wi-schema', 'plan-item'));
  assert.ok(hasEdge(m, 'plan', 'intent:wi-server', 'plan-item'));

  // Session containment reaches the orphan root; #1 remains reached through its
  // explicit intent and #2 through both intent and base topology.
  assert.ok(hasEdge(m, 'session', 'pr:o/r#3', 'session'), 'orphan PR hangs off the session');
  assert.ok(!hasEdge(m, 'session', 'pr:o/r#1', 'session'), 'intent-owned root is not duplicated');
  assert.ok(!hasEdge(m, 'session', 'pr:o/r#2', 'session'), 'stack child is reached through its base edge');
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

// --- running plan-step nodes (Fix B) ----------------------------------------
test('an in_progress plan step yields an ACTIVE step node linked to the plan cluster', () => {
  const m = buildGraphModel([
    { t: 1, type: 'session', phase: 'start', title: 's' },
    { t: 2, type: 'todos', todos: [
      { text: 'wire the recorder', status: 'completed' },
      { text: 'Update E-B4 tracker rows', status: 'in_progress' },
      { text: 'ship it', status: 'pending' },
    ] },
  ]);
  const step = m.nodes.find(n => n.kind === 'step');
  assert.ok(step, 'the running step becomes a node');
  assert.equal(step.text, 'Update E-B4 tracker rows');
  assert.equal(step.col, 1, 'the step node sits in ACTIVE');
  assert.equal(step.paused, false, 'a working session is not paused');
  assert.equal(step.startedAt, 2, 'startedAt is the moment it went in_progress');
  assert.equal(step.lastTouched, 2, 'the deep-link targets the step start');
  assert.ok(hasEdge(m, 'plan', step.id, 'plan-step'), 'a dashed edge links back to the plan cluster');
  // exactly one running-step node — the completed / pending steps are not nodes
  assert.equal(m.nodes.filter(n => n.kind === 'step').length, 1);
});

test('a completed or vanished step drops its node (no fossils)', () => {
  // in_progress → completed: the node is gone next fold
  const done = buildGraphModel([
    { t: 1, type: 'session', phase: 'start' },
    { t: 2, type: 'todos', todos: [{ text: 'a', status: 'in_progress' }] },
    { t: 3, type: 'todos', todos: [{ text: 'a', status: 'completed' }] },
  ]);
  assert.equal(done.nodes.filter(n => n.kind === 'step').length, 0, 'a finished step has no step node');

  // dropped from the plan entirely: also gone (the superseded sweep handles the
  // card-side fossil; the node just isn't sourced)
  const gone = buildGraphModel([
    { t: 1, type: 'session', phase: 'start' },
    { t: 2, type: 'todos', todos: [{ text: 'a', status: 'in_progress' }] },
    { t: 3, type: 'todos', todos: [{ text: 'b', status: 'pending' }] },
  ]);
  assert.equal(gone.nodes.filter(n => n.kind === 'step').length, 0, 'a vanished step has no step node');
});

test('idle phase renders the step node paused with a frozen duration', () => {
  const m = buildGraphModel([
    { t: 1000, type: 'session', phase: 'start' },
    { t: 2000, type: 'todos', todos: [{ text: 'long step', status: 'in_progress' }] },
    { t: 5000, type: 'session', phase: 'idle' },
  ]);
  const step = m.nodes.find(n => n.kind === 'step');
  assert.ok(step, 'the step node persists through idle');
  assert.equal(step.paused, true, 'idle marks it paused');
  assert.equal(step.startedAt, 2000);
  assert.equal(step.pausedAt, 5000, 'the frozen "now" is when the session went idle');
  // frozen elapsed = pausedAt − startedAt = 3s, never a live tick
  assert.equal(step.pausedAt - step.startedAt, 3000);
});

test('more than STEP_CAP in_progress steps: the freshest cap render + a "…N more" node', () => {
  const todos = [];
  for (let i = 1; i <= STEP_CAP + 2; i++) todos.push({ text: 'step ' + i, status: 'in_progress' });
  const m = buildGraphModel([
    { t: 1, type: 'session', phase: 'start' },
    { t: 2, type: 'todos', todos },
  ]);
  const steps = m.nodes.filter(n => n.kind === 'step');
  assert.equal(steps.length, STEP_CAP, 'capped at STEP_CAP step nodes');
  const more = m.nodes.find(n => n.kind === 'step-more');
  assert.ok(more, 'the overflow folds into one step-more node');
  assert.equal(more.count, 2, 'it hides exactly the overflow');
  assert.equal(more.col, 1, 'the overflow node lives in ACTIVE too');
  for (const s of [...steps, more]) assert.ok(hasEdge(m, 'plan', s.id, 'plan-step'), 'all link to the plan');
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

// --- transient "now" node (Fix B2) ------------------------------------------
// The ONE deliberate exception to "turn-cards are never nodes": a single, transient
// node for the CURRENT live turn, so "what's happening now" has presence in ACTIVE.
// Singular, never historical, only while the session is actually live.
test('nowNode: a doing turn card + working phase yields ONE now node in ACTIVE', () => {
  const m = buildGraphModel([
    { t: 1, type: 'session', phase: 'start', title: 's' },
    { t: 2, type: 'item', id: 'turn-7', title: 'wire the live strip', status: 'doing' },
  ]);
  const now = nodeById(m, 'now');
  assert.ok(now, 'the now node exists');
  assert.equal(now.kind, 'now');
  assert.equal(now.col, 1, 'the now node sits in ACTIVE');
  assert.equal(now.prompt, 'wire the live strip', 'the prompt is the current turn title');
  assert.equal(now.turnId, 'turn-7');
  assert.equal(now.phase, 'working');
  assert.ok(hasEdge(m, 'session', 'now', 'session'), 'a session→now containment edge (kind session)');
  // singular — exactly one, ever
  assert.equal(m.nodes.filter(n => n.kind === 'now').length, 1);
  // and the turn card is STILL never an intent node (the invariant holds)
  assert.ok(!nodeById(m, 'intent:turn-7'), 'the turn card is not an intent node');
});

test('nowNode: sorts to the TOP of ACTIVE, above a running step', () => {
  const m = buildGraphModel([
    { t: 1, type: 'session', phase: 'start' },
    { t: 2, type: 'todos', todos: [{ text: 'grind', status: 'in_progress' }] },
    { t: 5, type: 'item', id: 'turn-3', title: 'current work', status: 'doing' },
  ]);
  const active = m.nodes.filter(n => n.col === 1).sort((a, b) => a.order - b.order);
  assert.equal(active[0].kind, 'now', 'the freshest-touched now node is first in ACTIVE');
  assert.ok(active.some(n => n.kind === 'step'), 'the running step is also in ACTIVE, below it');
});

test('nowNode: absent when the turn is done, when idle, and when ended', () => {
  const done = buildGraphModel([
    { t: 1, type: 'session', phase: 'start' },
    { t: 2, type: 'item', id: 'turn-1', title: 'x', status: 'doing' },
    { t: 3, type: 'item', id: 'turn-1', title: 'x', status: 'done' },
  ]);
  assert.ok(!nodeById(done, 'now'), 'a finished turn conjures no now node');

  const idle = buildGraphModel([
    { t: 1, type: 'session', phase: 'start' },
    { t: 2, type: 'item', id: 'turn-1', title: 'x', status: 'doing' },
    { t: 3, type: 'session', phase: 'idle' },
  ]);
  assert.ok(!nodeById(idle, 'now'), 'an idle session shows no phantom now node even with a stuck doing card');

  const ended = buildGraphModel([
    { t: 1, type: 'session', phase: 'start' },
    { t: 2, type: 'item', id: 'turn-1', title: 'x', status: 'doing' },
    { t: 3, type: 'session', phase: 'end' },
  ]);
  assert.ok(!nodeById(ended, 'now'), 'an ended session shows no now node');
});

test('nowNode: attention is a live state → the now node persists (the loud "needs you")', () => {
  const m = buildGraphModel([
    { t: 1, type: 'session', phase: 'start' },
    { t: 2, type: 'item', id: 'turn-1', title: 'approve the migration?', status: 'doing' },
    { t: 3, type: 'session', phase: 'attention', text: 'approve?' },
  ]);
  const now = nodeById(m, 'now');
  assert.ok(now, 'attention keeps the now node');
  assert.equal(now.phase, 'attention');
  assert.equal(now.prompt, 'approve the migration?');
});

test('nowNode: a non-turn doing intent does NOT get a now node (no double-count)', () => {
  const m = buildGraphModel([
    { t: 1, type: 'session', phase: 'start' },
    { t: 2, type: 'item', id: 'wi-schema', title: 'schema work', status: 'doing' },
  ]);
  assert.ok(!nodeById(m, 'now'), 'a declared work item renders as an intent node, not a now node');
  assert.ok(nodeById(m, 'intent:wi-schema'), 'and it IS an intent node');
});

test('nowNode: the now-line follows the turn card, else falls back to lastSay', () => {
  const withNow = buildGraphModel([
    { t: 1, type: 'session', phase: 'start' },
    { t: 2, type: 'item', id: 'turn-1', title: 'ship it', status: 'doing' },
    { t: 3, type: 'tool', text: 'running the calibration sweep', item: 'turn-1' },
  ]);
  const n1 = nodeById(withNow, 'now');
  assert.deepEqual({ text: n1.now.text, kind: n1.now.kind }, { text: 'running the calibration sweep', kind: 'tool' });
  assert.equal(n1.now.t, 3, 'the now timestamp is the tool event t, not wall-clock');

  const fallback = buildGraphModel([
    { t: 1, type: 'session', phase: 'start' },
    { t: 2, type: 'say', text: 'waiting for the harvest to finish' },
    { t: 3, type: 'item', id: 'turn-1', title: 'ship it', status: 'doing' },
  ]);
  const n2 = nodeById(fallback, 'now');
  assert.equal(n2.now.text, 'waiting for the harvest to finish', 'now falls back to lastSay');
  assert.equal(n2.now.kind, 'say');
});

// --- honest per-step un-pause (Fix B1) --------------------------------------
// A step reads live ONLY while its in_progress claim is FRESH. An unrelated resume
// (a quick Q&A turn) must not relight a step whose in_progress claim is hours stale.
const STEP_STALE_MS = 10 * 60e3; // mirror of the model's constant

test('a step whose in_progress claim is stale reads paused even while the session works', () => {
  const t0 = 2_000, ref = t0 + STEP_STALE_MS + 60_000;
  const m = buildGraphModel([
    { t: 1_000, type: 'session', phase: 'start' },
    { t: t0, type: 'todos', todos: [{ text: 'long grind', status: 'in_progress' }] },
    // Much later (> STEP_STALE_MS) the session produces UNRELATED activity — a resume
    // then a say — WITHOUT re-affirming the step. Its in_progress claim is now stale.
    { t: ref - 1_000, type: 'session', phase: 'resume' },
    { t: ref, type: 'say', text: 'answering a quick unrelated question' },
  ]);
  const step = m.nodes.find(n => n.kind === 'step');
  assert.ok(step, 'the step is still sourced');
  assert.equal(step.paused, true, 'a stale in_progress claim is honestly paused, not live-ticking');
  assert.equal(step.pausedAt, t0, 'the duration freezes at the last affirmation (affirmedAt)');
  assert.equal(step.startedAt, t0, 'startedAt is unchanged');
});

test('a step a fresh snapshot re-affirms stays live even after a long gap', () => {
  const t0 = 2_000, later = t0 + STEP_STALE_MS + 60_000;
  const m = buildGraphModel([
    { t: 1_000, type: 'session', phase: 'start' },
    { t: t0, type: 'todos', todos: [{ text: 'grind', status: 'in_progress' }] },
    // A long time passes, but a FRESH snapshot RE-AFFIRMS the step in_progress, so
    // ref − affirmedAt == 0 ≤ STEP_STALE_MS → still live.
    { t: later, type: 'todos', todos: [{ text: 'grind', status: 'in_progress' }] },
  ]);
  const step = m.nodes.find(n => n.kind === 'step');
  assert.ok(step, 'the step is sourced');
  assert.equal(step.paused, false, 'a freshly re-affirmed step reads live');
  assert.equal(step.pausedAt, null, 'no frozen moment — the view ticks it live');
  assert.equal(step.startedAt, t0, 'startedAt stays the first in_progress');
});

test('existing idle-pause still holds: paused with pausedAt === sessionPausedAt', () => {
  const evs = [
    { t: 1000, type: 'session', phase: 'start' },
    { t: 2000, type: 'todos', todos: [{ text: 'long step', status: 'in_progress' }] },
    { t: 5000, type: 'session', phase: 'idle' },
  ];
  const m = buildGraphModel(evs);
  const step = m.nodes.find(n => n.kind === 'step');
  assert.equal(step.paused, true, 'recorded idle marks the step paused (unchanged path)');
  assert.equal(step.pausedAt, sessionPausedAt(fold(evs)), 'the frozen moment ties exactly to sessionPausedAt');
  assert.equal(step.pausedAt, 5000);
});
