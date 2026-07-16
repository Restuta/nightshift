// Translate the pure canonical graph model into React Flow nodes and edges with
// deterministic positions. Registry membership, PR truth, topology, and gate
// state have already been decided by public/graph-model.js.
//
// Everything here is view logic. The models stay pure and are passed IN.

import {
  ageText, wrapLines, truncate,
  SANS, SANS_SM, SANS_STEP, MONO_SM, NOW_TTL,
} from './format.js';
import { graphNodeAriaLabel } from './runtime.js';

// ------------------------------------------------------------------ geometry
export const ROOT_X = 20;
export const COL0_X = 276;
export const COL_GAP = 300;
export const TOP = 24;
export const VGAP = 20;
const CHAIN_DX = 52;

const W = {
  session: 216, intent: 212, pr: 218, collapsed: 182, plan: 250,
  step: 214, 'step-more': 182, now: 230,
};

const PLAN_HEAD = 34, PLAN_ROW = 18, PLAN_MAX_ROWS = 7, PLAN_PAD = 12;
const DIFF_ROW = 17;
const hasSize = n => (n.add || 0) > 0 || (n.del || 0) > 0;

// --------------------------------------------------------------- node views
// Precompute the wrapped/truncated text a node renders, so its height is a pure
// function of the data and the component just paints the lines.

function sessionView(n, clock) {
  const a = n.activity || {};
  const attn = a.phase === 'attention' && !!a.attentionText;
  const nowText = a.now && a.now.text;
  let act = null;
  if (a.prompt || attn || nowText) {
    const prompt = a.prompt ? truncate('on: ' + a.prompt, W.session - 28, MONO_SM) : null;
    let body = null;
    if (attn) {
      body = { lines: wrapLines('needs you: ' + a.attentionText, W.session - 28, SANS_SM, 2), cls: 'attn', pulse: false };
    } else if (nowText) {
      const age = Math.max(0, clock - (a.now.t || clock));
      const past = age > NOW_TTL;
      const label = past ? `last seen ${ageText(age)} ago: ${a.now.text}` : a.now.text;
      body = {
        lines: wrapLines(label, W.session - 42, SANS_SM, 2),
        cls: (past ? 'past ' : '') + (a.now.kind || 'say'),
        pulse: a.phase === 'working' && !past,
      };
    }
    act = { prompt, body };
  }
  const h = 84 + (act ? 10 + (act.prompt ? 17 : 0) + (act.body ? act.body.lines.length * 15 : 0) + 12 : 0);
  return { view: act, h };
}

function nowNodeView(n, clock) {
  const attn = n.phase === 'attention';
  const promptLines = wrapLines(n.prompt || 'current turn', W.now - 26, SANS, 2);
  let body = null, pulse = !attn && n.phase === 'working';
  const nowText = n.now && n.now.text;
  if (nowText) {
    const age = Math.max(0, clock - (n.now.t || clock));
    const past = age > NOW_TTL;
    pulse = !attn && n.phase === 'working' && !past;
    const label = past ? `last seen ${ageText(age)} ago: ${nowText}` : nowText;
    body = {
      lines: wrapLines(label, W.now - 26, SANS_SM, 2),
      cls: (attn ? 'attn ' : '') + (past ? 'past ' : '') + (n.now.kind || 'say'),
    };
  }
  const h = 12 + 18 + 4 + Math.max(1, promptLines.length) * 17 + (body ? 4 + body.lines.length * 15 : 0) + 12;
  return { view: { attn, promptLines, body, pulse }, h };
}

function stepView(n) {
  const lines = wrapLines(n.text, W.step - 42, SANS_STEP, 2);
  const h = 12 + Math.max(1, lines.length) * 15 + 17 + 10;
  return { view: { lines }, h };
}

function planView(n) {
  const shown = n.steps.slice(0, PLAN_MAX_ROWS).map(s => ({
    text: truncate(s.text, W.plan - 44, SANS_SM), status: s.status,
  }));
  const more = n.steps.length - shown.length;
  const rows = shown.length + (more > 0 ? 1 : 0);
  return { view: { shown, more }, h: PLAN_HEAD + rows * PLAN_ROW + PLAN_PAD };
}

function measure(n, clock) {
  switch (n.kind) {
    case 'session': return sessionView(n, clock);
    case 'now': return nowNodeView(n, clock);
    case 'step': return stepView(n);
    case 'plan': return planView(n);
    case 'pr': return { view: null, h: 154 + (hasSize(n) ? DIFF_ROW : 0) };
    case 'intent': return { view: null, h: 66 + (hasSize(n) ? DIFF_ROW : 0) };
    case 'collapsed': return { view: null, h: 48 };
    case 'step-more': return { view: null, h: 42 };
    default: return { view: null, h: 48 };
  }
}

// -------------------------------------------------------------- signatures
// Entity signature per node (ported from graph.js sigOf) — the live view glows
// a node whose signature changed since the last append, and pulses the edges
// of a PR that just merged/closed. Motion = data changing, never decoration.
export function sigOf(n) {
  switch (n.kind) {
    case 'pr': return `${n.prState}|${n.ci}|${n.add}|${n.del}|${n.lastTouched}`;
    case 'intent': return `${n.status}|${n.commits}|${n.edits}|${n.add}|${n.del}|${n.lastTouched}`;
    case 'plan': return `${n.total}|${n.counts.completed}|${n.counts.in_progress}|${n.lastTouched}`;
    case 'step': return `${n.text}|${n.startedAt}|${n.paused}`;
    case 'step-more': return `${n.count}|${n.paused}`;
    case 'now': return `${n.phase}|${n.now ? n.now.t : 0}|${n.prompt}|${n.turnId}`;
    case 'session': {
      const a = n.activity || {};
      const nowT = a.now ? a.now.t : 0;
      return `${(n.cost || 0).toFixed(3)}|${n.commits}|${n.lastTouched}|${a.phase}|${nowT}|${a.attentionText || ''}|${a.prompt || ''}`;
    }
    case 'collapsed': return `${n.count}`;
    default: return '';
  }
}

// ----------------------------------------------------------------- assembly

const EDGE_STYLE = {
  'item-pr': { stroke: '#38507e', strokeWidth: 1.6 },
  'pr-base': { stroke: '#a371f7', strokeWidth: 1.6, opacity: 0.7 },
  'plan-item': { stroke: '#2d6f52', strokeWidth: 1.4, opacity: 0.6 },
  'plan-step': { stroke: '#6b5320', strokeWidth: 1.4, strokeDasharray: '4 4', opacity: 0.6 },
  session: { stroke: '#18202f', strokeWidth: 1.2, strokeDasharray: '3 4', opacity: 0.6 },
};

function flowEdge(e, i, pulse) {
  return {
    id: `e${i}:${e.kind}:${e.from}->${e.to}`,
    source: e.from,
    target: e.to,
    style: EDGE_STYLE[e.kind] || EDGE_STYLE.session,
    className: pulse ? 'pulse' : undefined,
    focusable: false,
  };
}

// Build the full React Flow graph. `clock` is the display clock: Date.now()
// live, the scrub cursor when time-traveling — so ages stay honest in both.
// `glowIds` / `pulseIds` mark entities that changed on the latest append.
export function buildFlow({ model, columns, dragPos, clock, scrubbed, glowIds, pulseIds }) {
  const nodes = [];
  const edges = [];
  const pos = id => dragPos[id] || null;

  // Split the model's flat list back into columns (the model's order field).
  const cols = [[], [], [], []];
  let sessionNode = null;
  for (const n of model.nodes) {
    if (n.kind === 'session') { sessionNode = n; continue; }
    cols[n.col].push(n);
  }
  for (const c of cols) c.sort((a, b) => a.order - b.order);

  // ---- stack the columns
  let minY = Infinity, maxY = -Infinity;
  const track = (y, h) => { minY = Math.min(minY, y); maxY = Math.max(maxY, y + h); };

  const glow = id => !!(glowIds && glowIds.has(id));
  const pushModelNode = (n, x, y) => {
    const { view, h } = measure(n, clock);
    const p = pos(n.id) || { x, y };
    nodes.push({
      id: n.id,
      type: n.kind,
      position: p,
      width: W[n.kind],
      height: h,
      data: { node: n, view, clock, scrubbed, glow: glow(n.id) },
      connectable: false,
      focusable: true,
      ariaLabel: graphNodeAriaLabel(n),
    });
    track(p.y, h);
    return h;
  };

  for (let c = 0; c < 4; c++) {
    let y = TOP;
    const baseX = COL0_X + c * COL_GAP;
    for (const n of cols[c]) {
      const h = pushModelNode(n, baseX + Math.min(n.chainDepth || 0, 3) * CHAIN_DX, y);
      y += h + VGAP;
    }
  }
  if (!isFinite(minY)) { minY = TOP; maxY = TOP + 80; }

  // ---- the session root, vertically centered against the columns
  if (sessionNode) {
    const { view, h } = measure(sessionNode, clock);
    const p = pos('session') || { x: ROOT_X, y: Math.max(TOP, (minY + maxY) / 2 - h / 2) };
    nodes.push({
      id: 'session',
      type: 'session',
      position: p,
      width: W.session,
      height: h,
      data: { node: sessionNode, view, clock, scrubbed, glow: glow('session') },
      connectable: false,
      focusable: true,
      ariaLabel: graphNodeAriaLabel(sessionNode),
    });
    track(p.y, h);
  }

  // ---- column backdrop bands (part of the zoomable plane, behind everything)
  const bandTop = -46;
  const bandH = Math.max(maxY, TOP + 80) - bandTop + 40;
  const bands = columns.map((col, c) => ({
    id: 'band:' + col.key,
    type: 'colband',
    position: { x: COL0_X + c * COL_GAP - 26, y: bandTop },
    width: COL_GAP,
    height: bandH,
    data: { label: col.label, count: cols[c].length, alt: c % 2 === 1 },
    draggable: false,
    selectable: false,
    focusable: false,
    zIndex: -20,
  }));

  // ---- edges
  const nodeIds = new Set(nodes.map(n => n.id));
  const seen = new Set();
  let i = 0;
  for (const e of model.edges) {
    const from = e.from, to = e.to;
    if (from === to) continue;
    if (!nodeIds.has(from) || !nodeIds.has(to)) continue;
    const key = `${e.kind}|${from}|${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pulse = e.kind !== 'session' && !!(pulseIds && (pulseIds.has(e.from) || pulseIds.has(e.to)));
    edges.push(flowEdge({ ...e, from, to }, i++, pulse));
  }

  return { nodes: [...bands, ...nodes], edges };
}
