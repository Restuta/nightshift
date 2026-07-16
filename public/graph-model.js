// Pure model for the /graph view — the work-structure node canvas. Zero deps, no
// DOM, no fetches: a deterministic function of the event array, exactly like the
// reducer and lanes-model. Extracted so the load-bearing derivations (node
// sourcing, edge derivation, column assignment, deterministic layer ordering) are
// unit-testable on golden tapes (see test/graph-model.test.mjs).
//
// The design decision (see the /graph task): nodes are the REAL entities in the
// tape, NOT the turn-cards. Turn-cards are chat turns with prompt-fragment titles
// ("s", "hold on…") — a graph over them would just repeat the kanban's collapse.
// So we FOLD the tape with the pure reducer (which already attributes commits,
// edits, plan deltas, PRs, and CI to the right entity) and read nodes off the
// resulting state: PRs, plan steps, explicitly-declared work items, the session.
//
// This is a SECOND pure pass that does NOT modify the reducer. fold() already
// honors retracts (a recording bug is not history), so the graph agrees with the
// board at every replay time for free.

import { fold, sessionPausedAt, freshestProducerAt } from './reducer.js';
import { TURN_RE, turnLabel } from './turn-id.js';
import { buildSessionInsights } from './session-insights-model.js';
import { buildSessionDisposition } from './session-disposition.js';

// A work item whose id is a turn-card id (legacy `turn-<n>` OR namespaced
// `turn-<sid8>-<n>`) is a synthesized chat turn, never a node. Re-exported from the
// shared helper so both shapes are excluded and existing importers keep working.
export { TURN_RE };

// Left→right pipeline: backlog → in-progress → shipped. The session node lives in
// a root gutter to the left of column 0.
export const COLUMNS = [
  { key: 'plan', label: 'Plan' },
  { key: 'active', label: 'Active' },
  { key: 'review', label: 'Attention' },
  { key: 'landed', label: 'Complete' },
];
const COL_INDEX = { plan: 0, active: 1, review: 2, landed: 3 };

// Past this many nodes in one column, the oldest collapse into a single "N more"
// stack node so a 59-PR session stays legible (grade-v7-n154). Failing-CI PRs are
// always pinned visible — they're the loud ones you must not scroll past.
export const MAX_PER_COL = 12;

// --------------------------------------------------------------- node sources

function snapshotText(label, snapshot) {
  if (!snapshot) return null;
  const state = snapshot.state ?? 'state unknown';
  const validation = snapshot.validation ?? 'unknown';
  const base = Number.isFinite(snapshot.base) ? ` · based on #${snapshot.base}` : '';
  const advisory = snapshot.advisoryRunning ? ` · ${snapshot.advisoryRunning} advisory running` : '';
  return `${label}: ${state} · gates ${validation}${advisory}${base}`;
}

function semanticPrState(snapshot) {
  if (snapshot?.state === 'merged' || snapshot?.state === 'closed') return 'complete';
  if (snapshot?.validation === 'fail') return 'blocked';
  if (snapshot?.validation === 'pending') return 'active';
  return 'attention';
}

// PR nodes are sourced exclusively from the canonical insights registry. The
// reducer remains responsible for work items and plan activity, but it is not a
// second PR registry: recovered PRs and recorded/current axes must agree across
// Board, Story, Lanes, and Graph.
function prNodes(insights, topology, state) {
  return (insights.prStack?.prs ?? []).map(pr => {
    const recorded = pr.recorded;
    const current = topology.axis === 'current' ? pr.current : null;
    const effective = current ?? recorded;
    const displayMetadata = state.prs.get(pr.key) ?? null;
    const discovery = pr.discovery ?? {};
    const recovered = discovery.kind === 'recovered';
    const confidence = recovered && !recorded && !current ? 'strong' : 'explicit';
    const discoveryProvenance = recovered
      ? `${discovery.recovery === 'transcript' ? 'Transcript recovery' : 'Recovered reference'} · ${discovery.source ?? 'unknown source'}`
      : `${discovery.kind === 'authoritative' ? 'Authoritative discovery' : 'Observed reference'} · ${discovery.source ?? 'unknown source'}`;
    const snapshotProvenance = effective
      ? `${current ? 'Current snapshot' : 'Recorded snapshot'} · ${effective.source ?? 'unknown source'}`
      : 'No effective snapshot at this cutoff';
    const provenance = `${discoveryProvenance}; ${snapshotProvenance}`;
    return {
      id: 'pr:' + pr.key,
      kind: 'pr',
      key: pr.key,
      number: pr.number,
      repo: pr.repo,
      title: effective?.title ?? pr.title ?? null,
      prState: effective?.state ?? 'unknown',
      ci: effective?.validation ?? 'unknown',
      url: effective?.url ?? pr.url ?? null,
      // Size is display metadata only. Registry membership, truth, state, and
      // topology all come from insights.prStack.
      add: displayMetadata?.add ?? 0,
      del: displayMetadata?.del ?? 0,
      base: effective?.base ?? null,
      recordedBase: recorded?.base ?? null,
      currentBase: current?.base ?? null,
      openedAt: effective?.createdAt ?? discovery.observedAt ?? null,
      mergedAt: effective?.state === 'merged' ? (effective.occurredAt ?? effective.at ?? null) : null,
      lastTouched: effective?.at ?? discovery.observedAt ?? 0,
      replayT: discovery.observedAt ?? effective?.at ?? 0,
      chainDepth: 0,
      semanticState: semanticPrState(effective),
      truthAxis: topology.axis,
      recorded,
      current,
      recordedTruth: snapshotText('Recorded', recorded),
      currentTruth: snapshotText('Current', current),
      discoveryProvenance,
      snapshotProvenance,
      provenance,
      confidence,
      evidenceEventIds: pr.evidenceEventIds ?? [],
      milestone: pr.recorded?.milestone ?? pr.discovery?.milestone ?? 'Unassigned',
      milestoneConfidence: pr.recorded?.milestone || pr.discovery?.milestone
        ? 'Explicit recorded milestone attribution'
        : 'No explicit milestone attribution recorded',
    };
  });
}

// Intent nodes — explicitly-registered work items (id NOT turn-<n>): real declared
// work, e.g. via tools/emit.js. Carry status + commit/edit stats and the plan
// steps that advanced under them (the reducer's delta Map witnesses this).
function intentNodes(state) {
  const out = [];
  for (const it of state.items.values()) {
    if (TURN_RE.test(it.id)) continue; // a turn-card is never a node
    out.push({
      id: 'intent:' + it.id,
      kind: 'intent',
      itemId: it.id,
      title: it.title || it.id,
      status: it.status,
      abandoned: !!it.abandoned,
      commits: it.commits || 0,
      edits: it.edits || 0,
      add: it.add || 0,
      del: it.del || 0,
      prNumber: it.pr && it.pr.number != null ? it.pr.number : null,
      prRepo: it.pr && it.pr.repo ? it.pr.repo : null,
      deltaSteps: it.delta ? [...it.delta.keys()] : [],
      lastTouched: it.touchedAt || it.createdAt || 0,
    });
  }
  return out;
}

// The plan cluster — the whole session plan as ONE grouped node (compact task
// rows inside it), not one node per step, so it reads as a single column/cluster
// and never scatters 30 tiny nodes. null when the session has no plan.
function planNode(state) {
  const steps = state.todos || [];
  if (!steps.length) return null;
  let last = 0;
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  const rows = steps.map(td => {
    const status = td.status || (td.done ? 'completed' : 'pending');
    if (counts[status] != null) counts[status]++;
    const t = td.doneAt || td.startedAt || td.firstSeenAt || 0;
    if (t > last) last = t;
    return { text: td.text, status };
  });
  return {
    id: 'plan',
    kind: 'plan',
    steps: rows,
    counts,
    total: rows.length,
    lastTouched: last,
  };
}

// Past this many concurrent in-progress steps, the freshest STEP_CAP get their own
// node and the rest fold into one "…N more" node — a runaway plan can't wall the
// ACTIVE column.
export const STEP_CAP = 3;

// How old a step's last in_progress affirmation may be, relative to the freshest
// recorded producer signal, before we stop trusting it as live. Matches the view's
// now-line 10-min TTL (graph.js NOW_TTL) so a step and the session strip re-tense on
// the same clock. Compared against RECORDED timestamps only — no Date.now().
const STEP_STALE_MS = 10 * 60e3;

// The CURRENT plan's in-progress steps, as compact ACTIVE-column nodes — the live
// "moving part" the /graph was missing. Turn cards are (correctly) excluded, so
// when the only in-flight work is a running plan step, ACTIVE/REVIEW sit empty and
// progress reads as nothing; a step node gives that motion a home. Freshest first
// (by startedAt), capped at STEP_CAP + a fold node. A step that leaves in_progress
// (completed, or dropped from the plan) simply isn't in this list next fold — no
// fossil node. When the session is truly idle (recorded phase, via sessionPausedAt)
// the node is paused-tinted with a FROZEN duration, same language as the board's
// paused card. Pure over the fold: `pausedAt` is a recorded timestamp, the view
// does the (display-side) Date.now() ticking for the live case.
function stepNodes(state) {
  const idleAt = sessionPausedAt(state);   // non-null only when phase === 'idle'
  // Honest per-step liveness. A step reads live ONLY while its in_progress claim is
  // FRESH: we only KNOW a step is progressing if a recent plan snapshot re-affirmed
  // it (td.affirmedAt). Without that, an unrelated resume (a quick Q&A turn) must NOT
  // relight a step whose in_progress claim is hours stale and untouched by the
  // current work. We compare two RECORDED timestamps — the freshest producer signal
  // (ref) vs the step's last affirmation — so this stays pure (no Date.now()); the
  // honest display for a stale claim is paused-with-frozen-duration, the same ethos
  // as the board's paused card and the superseded-step fossil sweep.
  const ref = freshestProducerAt(state);
  const running = (state.todos || [])
    .filter(td => (td.status || (td.done ? 'completed' : 'pending')) === 'in_progress')
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .map(td => {
      const startedAt = td.startedAt || td.firstSeenAt || 0;
      const affirmedAt = td.affirmedAt || td.startedAt || td.firstSeenAt || 0;
      // Stale = working (NOT recorded-idle) but this step's last affirmation is old
      // relative to the freshest producer signal. The idle path is untouched.
      const stale = idleAt == null && ref != null && affirmedAt > 0 && (ref - affirmedAt) > STEP_STALE_MS;
      const paused = idleAt != null || stale;
      // Frozen "now" for the paused duration: idleAt on recorded idle (unchanged);
      // else the last affirmation, so the duration freezes at the last evidence the
      // step actually progressed; null when live (the view ticks it).
      const pausedAt = idleAt != null ? idleAt : (stale ? affirmedAt : null);
      return { text: td.text, startedAt, paused, pausedAt };
    });
  const shown = running.slice(0, STEP_CAP);
  const out = shown.map(r => ({
    id: 'step:' + r.text,
    kind: 'step',
    text: r.text,
    startedAt: r.startedAt,
    paused: r.paused,
    pausedAt: r.pausedAt,   // frozen "now" for the duration while paused (null when live)
    lastTouched: r.startedAt,
  }));
  if (running.length > shown.length) {
    // The fold node's paused reflects the whole running set: "…N more running" is
    // honest only if some of them are actually live, so it reads paused iff EVERY
    // running step is paused (recorded idle, or all individually stale).
    out.push({
      id: 'step:more',
      kind: 'step-more',
      count: running.length - shown.length,
      paused: running.every(r => r.paused),
      lastTouched: shown.length ? shown[shown.length - 1].lastTouched : 0,
    });
  }
  return out;
}

// The session's LIVE activity strip — the current prompt, the agent's latest
// narration ("now" line), and the attention state, folded straight off the
// reducer. This is the ONE place a turn-card's title is welcome in the graph: a
// turn card IS the current turn, so its prompt is exactly "what's being worked on
// now" — even though turns are never nodes. Pure over the fold: no Date.now(), no
// DOM. The view clamps/re-tenses; the model just exposes the facts.
function sessionActivity(state) {
  // Most-recently-touched item still in `doing` — turn cards INCLUDED (unlike the
  // node-sourcing pass, which drops them). Its title is the current prompt.
  let active = null;
  for (const it of state.items.values()) {
    if (it.status !== 'doing') continue;
    if (!active || (it.touchedAt || 0) > (active.touchedAt || 0)) active = it;
  }
  const s = state.session;
  // `now` is the active card's live line (a say/tool with its own t), falling back
  // to the session's last narration when the card carries none.
  let now = active && active.now ? { text: active.now.text, kind: active.now.kind, t: active.now.t } : null;
  if (!now && s.lastSay) now = { text: s.lastSay, kind: 'say', t: s.lastProducerAt || s.lastAt || 0 };
  return {
    prompt: active ? (active.title || turnLabel(active.id)) : null,
    now,
    phase: s.phase || null,
    attentionText: s.attentionText || null,
    lastEventT: s.lastAt || 0,
  };
}

// The session root — one node per session (agent badge, cost, span). Always
// present so an empty tape still shows the shift. Carries the live activity strip
// so the root becomes the graph's "what's happening now" surface.
function sessionNode(state) {
  const s = state.session;
  return {
    id: 'session',
    kind: 'session',
    title: s.title || 'session',
    agent: s.agent || null,
    cost: state.totals.cost || 0,
    commits: state.totals.commits || 0,
    add: state.totals.add || 0,
    del: state.totals.del || 0,
    startedAt: s.startedAt || null,
    lastTouched: s.lastAt || s.startedAt || 0,
    phase: s.phase || null,
    activity: sessionActivity(state),
  };
}

// The transient "now" node — the ONE deliberate, transient exception to the
// header's "nodes are REAL entities, NEVER turn-cards" rule. A future reader must
// NOT conclude the turns-as-nodes invariant eroded: this node is SINGULAR (at most
// one), NEVER historical (it vanishes the instant the current turn ends), and
// exists only to give "what's happening right now" spatial presence in the ACTIVE
// column — the funnel the owner scans, where the live turn today has no node (it
// rides only the session-root activity strip). No PAST turn is ever a node.
//
// Returns null unless the session is actually LIVE (phase working|attention) AND a
// real turn card (TURN_RE) is currently `doing`. Gating on phase means a stale
// stuck-`doing` card during idle/ended does NOT conjure a phantom now-node. Only a
// turn-card id qualifies: non-turn `doing` intents already render as intent nodes,
// so gating here avoids double-counting the same live work. Pure over the fold.
function nowNode(state) {
  const phase = state.session.phase;
  if (phase !== 'working' && phase !== 'attention') return null;
  // The freshest DOING turn card (by touchedAt) — a synthesized chat turn, never a
  // declared work item.
  let turn = null;
  for (const it of state.items.values()) {
    if (it.status !== 'doing' || !TURN_RE.test(it.id)) continue;
    if (!turn || (it.touchedAt || 0) > (turn.touchedAt || 0)) turn = it;
  }
  if (!turn) return null;
  const s = state.session;
  // `now` line: the turn's own live line (a say/tool with its own t), falling back
  // to the session's last narration — the SAME derivation as sessionActivity(), kept
  // in lock-step so the node and the root strip never disagree about "now".
  let now = turn.now ? { text: turn.now.text, kind: turn.now.kind, t: turn.now.t } : null;
  if (!now && s.lastSay) now = { text: s.lastSay, kind: 'say', t: s.lastProducerAt || s.lastAt || 0 };
  return {
    id: 'now',
    kind: 'now',
    turnId: turn.id,
    prompt: turn.title || turnLabel(turn.id),
    now,
    phase,
    startedAt: turn.createdAt || turn.touchedAt || 0,
    // Fresh touchedAt → sorts to the TOP of ACTIVE via byRecency, and the deep link
    // targets the turn's live moment.
    lastTouched: turn.touchedAt || 0,
  };
}

// --------------------------------------------------------------- columns

// Which column a PR node belongs to. Deterministic, pure over the node's fields.
function prColumn(node) {
  if (node.prState === 'merged' || node.prState === 'closed') return 'landed';
  if (node.prState === 'open' && node.ci === 'pending') return 'active';
  return 'review';
}

// Which column an intent item belongs to. An item with an open PR (the reducer
// promotes it to status 'pr') sits WITH its PR's column, so the two read together
// and the item→PR edge stays short; otherwise it's placed by its own status.
// `prCol` maps a PR number → its column key when the item's PR is known.
function intentColumn(node, prCol) {
  if (node.status === 'done') return 'landed';
  if (node.status === 'pr' && node.prNumber != null && prCol.has(node.prNumber)) return prCol.get(node.prNumber);
  if (node.status === 'pr') return 'review';
  if (node.status === 'doing') return 'active';
  return 'plan'; // inbox / backlog
}

// --------------------------------------------------------------- edges

function buildEdges(nodes, topology) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const prByNumber = new Map(); // number → node (first wins, deterministic order)
  for (const n of nodes) if (n.kind === 'pr' && !prByNumber.has(n.number)) prByNumber.set(n.number, n);
  const edges = [];

  // intent item → its PR (matched by number, repo when both carry it).
  for (const n of nodes) {
    if (n.kind !== 'intent' || n.prNumber == null) continue;
    const target = prByNumber.get(n.prNumber);
    if (target && (!n.prRepo || !target.repo || n.prRepo === target.repo)) {
      edges.push({ from: n.id, to: target.id, kind: 'item-pr' });
    }
  }

  // Canonical topology is parent → child. It is never reconstructed from node
  // labels or reducer fields: the selected recorded/current insight axis owns it.
  const prByKey = new Map(nodes.filter(n => n.kind === 'pr').map(n => [n.key, n]));
  for (const edge of topology.edges) {
    const parent = prByKey.get(edge.from);
    const child = prByKey.get(edge.to);
    if (parent && child && parent.id !== child.id) {
      edges.push({
        from: parent.id,
        to: child.id,
        fromKey: edge.from,
        toKey: edge.to,
        kind: 'pr-base',
        axis: topology.axis,
      });
    }
  }

  // plan step → intent item (the step advanced under that item — the reducer's
  // delta already witnessed it). One edge per (plan, item) pair. And plan → running
  // step node (the live moving part; a dashed leader back to its source cluster).
  const plan = byId.get('plan');
  if (plan) {
    for (const n of nodes) {
      if (n.kind === 'intent' && n.deltaSteps.length) {
        edges.push({ from: 'plan', to: n.id, kind: 'plan-item' });
      }
      if (n.kind === 'step' || n.kind === 'step-more') {
        edges.push({ from: 'plan', to: n.id, kind: 'plan-step' });
      }
    }
  }

  return edges;
}

// chainDepth: how many base-ancestors a PR has, so the view can offset stacked
// PRs rightward and the chain reads left→right. Cycle-guarded, deterministic.
function assignChainDepth(nodes, topology) {
  const byKey = new Map(nodes.filter(n => n.kind === 'pr').map(n => [n.key, n]));
  const parentByChild = new Map(topology.edges.map(edge => [edge.to, edge.from]));
  const depth = (n, seen) => {
    const parentKey = parentByChild.get(n.key);
    if (!parentKey) return 0;
    const base = byKey.get(parentKey);
    if (!base || base === n || seen.has(base.id)) return 0;
    seen.add(n.id);
    return 1 + depth(base, seen);
  };
  for (const n of nodes) if (n.kind === 'pr') n.chainDepth = depth(n, new Set());
}

function selectTopology(insights) {
  const stack = insights.prStack ?? {};
  // A post-recorded-envelope PR observation is not automatically a present-day
  // snapshot. Only a reconciliation carrying an explicit fetch timestamp may
  // select the current axis; this keeps historical replay gaps on recorded
  // topology instead of relabeling late tape observations as "current".
  const prs = stack.prs ?? [];
  const recordedCount = prs.filter(pr => pr.recorded != null).length;
  const currentCount = prs.filter(pr => pr.current != null).length;
  const hasCurrent = prs.some(pr => Number.isFinite(pr.current?.fetchedAt))
    || (recordedCount === 0 && currentCount > 0);
  const axis = hasCurrent ? 'current' : 'recorded';
  return {
    axis,
    roots: [...(stack[`${axis}Roots`] ?? [])],
    edges: (stack[`${axis}Edges`] ?? []).map(edge => ({ ...edge })),
  };
}

function semanticProjection(insights) {
  const disposition = buildSessionDisposition(insights);

  const pointEvidence = (insights.toolCalls?.pointObservations ?? []).map(event => ({
    id: event.id ?? `tool-point:${event.t}`,
    kind: 'point',
    label: event.tool ? `${event.tool}: ${event.text ?? 'recorded observation'}` : (event.text ?? 'Recorded tool observation'),
    startT: event.t,
    endT: event.t,
    outcome: 'observation only',
    provenance: 'Recorded post-tool observation',
    confidence: 'explicit point; duration unknown',
  }));
  const lifecycles = (insights.toolCalls?.lifecycles ?? []).map((tool, index) => ({
    id: tool.key?.join(':') ?? `tool-lifecycle:${index}`,
    kind: 'lifecycle',
    label: `${tool.tool ?? 'Tool'}: ${tool.outcome ?? 'unknown'}`,
    startT: tool.startT,
    endT: tool.endT,
    outcome: tool.outcome ?? 'unknown',
    provenance: 'Recorded tool lifecycle',
    confidence: 'explicit',
  }));
  return {
    ...disposition,
    phases: (insights.phases ?? []).map(phase => ({ ...phase })),
    toolEvidence: [...lifecycles, ...pointEvidence],
  };
}

// --------------------------------------------------------------- collapse

// A collapsed "N more" stack node, so a column never renders a wall of PRs.
function collapsedNode(colKey, hidden) {
  let merged = 0, closed = 0, open = 0;
  for (const n of hidden) {
    if (n.prState === 'merged') merged++;
    else if (n.prState === 'closed') closed++;
    else open++;
  }
  let label;
  if (merged && !closed && !open) label = `${hidden.length} more merged`;
  else if (open && !merged && !closed) label = `${hidden.length} more open`;
  else label = `${hidden.length} more`;
  return {
    id: 'collapsed:' + colKey,
    kind: 'collapsed',
    col: COL_INDEX[colKey],
    colKey,
    count: hidden.length,
    label,
    hiddenIds: hidden.map(n => n.id),
    // deep link into the oldest hidden node's moment
    lastTouched: Math.max(0, ...hidden.map(n => n.lastTouched || 0)),
  };
}

// --------------------------------------------------------------- layout order

// Barycenter crossing-minimization: reorder nodes within each column by the mean
// order of their neighbors in the adjacent column. A handful of sweeps; nodes with
// no cross-column neighbor keep their recency position (stable). Deterministic.
function barycenterOrder(columns, edges) {
  const adj = new Map(); // nodeId → [neighborId]
  const push = (a, b) => { (adj.get(a) || adj.set(a, []).get(a)).push(b); };
  for (const e of edges) { push(e.from, e.to); push(e.to, e.from); }

  const orderOf = new Map();
  const reindex = () => {
    for (const col of columns) col.forEach((n, i) => orderOf.set(n.id, i));
  };
  reindex();

  const sweep = () => {
    for (const col of columns) {
      const keyed = col.map((n, i) => {
        // mean of neighbor orders; no neighbor → keep current index (stable)
        const ns = (adj.get(n.id) || []).map(id => orderOf.get(id)).filter(v => v != null);
        const bary = ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : i;
        return { n, bary, i };
      });
      keyed.sort((a, b) => a.bary - b.bary || a.i - b.i);
      col.length = 0;
      for (const k of keyed) col.push(k.n);
    }
    reindex();
  };

  // A few passes converge these shallow graphs.
  for (let pass = 0; pass < 3; pass++) sweep();
}

// --------------------------------------------------------------- assembly

export function buildGraphModel(events, projectedInsights = null) {
  // Consumers sort by t (docs/EVENTS.md "Ordering"): a tape can arrive out of
  // order, and last-write-wins state (PR status, item column) must reflect the
  // latest fact by TIME, not by file position. Stable sort → equal t keeps order.
  const sorted = [...events].sort((a, b) => (a.t || 0) - (b.t || 0));
  const state = fold(sorted);
  const insights = projectedInsights ?? buildSessionInsights(sorted, {
    untilT: Infinity,
    displayNow: sorted.at(-1)?.t ?? 0,
  });
  const topology = selectTopology(insights);

  const session = sessionNode(state);
  const plan = planNode(state);
  const intents = intentNodes(state);
  const prs = prNodes(insights, topology, state);
  const steps = stepNodes(state);
  const now = nowNode(state);   // singular, transient — null unless the session is live

  // Column assignment. PRs first (so an intent item can follow its PR's column),
  // then plan (always column 0) and intent items. Running plan steps and the live
  // "now" node always live in ACTIVE — that IS "in progress".
  const prCol = new Map(); // PR number → column key
  for (const n of prs) { const key = prColumn(n); n.col = COL_INDEX[key]; prCol.set(n.number, key); }
  if (plan) plan.col = COL_INDEX.plan;
  for (const n of intents) n.col = COL_INDEX[intentColumn(n, prCol)];
  for (const n of steps) n.col = COL_INDEX.active;
  if (now) now.col = COL_INDEX.active;

  const placed = [];
  if (plan) placed.push(plan);
  for (const n of intents) placed.push(n);
  for (const n of prs) placed.push(n);
  for (const n of steps) placed.push(n);
  if (now) placed.push(now);

  // Edges first (over the full node set), so base chains resolve before collapse.
  assignChainDepth(prs, topology);
  let edges = buildEdges([session, ...placed], topology);

  // PRs that are the target of an item-pr/pr-base edge are "owned"; the rest are
  // top-level and hang off the session for containment.
  const owned = new Set();
  for (const e of edges) if (e.kind === 'item-pr' || e.kind === 'pr-base') owned.add(e.to);

  // Group into columns, order by recency (newest first), then collapse overflow.
  const columns = [[], [], [], []];
  for (const n of placed) columns[n.col].push(n);

  const byRecency = (a, b) => (b.lastTouched || 0) - (a.lastTouched || 0) || (a.id < b.id ? -1 : 1);
  for (let c = 0; c < columns.length; c++) {
    const col = columns[c];
    col.sort(byRecency);
    if (col.length <= MAX_PER_COL) continue;
    // Keep failing-CI PRs, the plan cluster, the live step nodes, and the transient
    // "now" node pinned; fill the rest by recency, fold the overflow into one "N
    // more" node pinned to the column's bottom.
    const pinned = [], rest = [];
    for (const n of col) ((n.kind === 'pr' && n.ci === 'fail') || n.kind === 'plan' || n.kind === 'step' || n.kind === 'step-more' || n.kind === 'now' ? pinned : rest).push(n);
    const keep = rest.slice(0, Math.max(0, MAX_PER_COL - pinned.length));
    const hidden = rest.slice(keep.length);
    if (hidden.length) {
      const cn = collapsedNode(COLUMNS[c].key, hidden);
      columns[c] = [...[...pinned, ...keep].sort(byRecency), cn];
    }
  }

  // Session containment edges: to the plan, to every intent node, and to every
  // VISIBLE top-level (unowned) PR or collapsed node. Subtle leader lines, capped
  // by the per-column collapse above so the root never becomes a hairball.
  const visibleIds = new Set();
  for (const col of columns) for (const n of col) visibleIds.add(n.id);
  for (const col of columns) {
    for (const n of col) {
      if (n.kind === 'plan' || n.kind === 'intent') edges.push({ from: 'session', to: n.id, kind: 'session' });
      else if (n.kind === 'now') edges.push({ from: 'session', to: n.id, kind: 'session' });
      else if (n.kind === 'collapsed') edges.push({ from: 'session', to: n.id, kind: 'session' });
      else if (n.kind === 'pr' && !owned.has(n.id)) edges.push({ from: 'session', to: n.id, kind: 'session' });
    }
  }
  // Drop edges pointing at a node that got collapsed away (not individually shown).
  edges = edges.filter(e =>
    (e.from === 'session' || visibleIds.has(e.from)) &&
    (e.to === 'session' || visibleIds.has(e.to)));

  // Crossing-minimization within columns (over the structural edges only).
  const structural = edges.filter(e => e.kind !== 'session');
  barycenterOrder(columns, structural);

  // Emit the flat node list with (col, order); the view turns that into pixels.
  const nodes = [{ ...session, col: -1, order: 0 }];
  for (let c = 0; c < columns.length; c++) {
    columns[c].forEach((n, i) => nodes.push({ ...n, col: c, order: i }));
  }

  return {
    nodes,
    edges,
    topology,
    semantic: semanticProjection(insights),
    columns: COLUMNS.map((c, i) => ({ ...c, index: i, count: columns[i].length })),
  };
}
