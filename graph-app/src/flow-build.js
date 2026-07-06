// Translate the PURE graph model (+ digest chapters) into React Flow nodes and
// edges with deterministic positions. This is the React-era sibling of
// graph.js's layout(): same left→right column geometry, same measured node
// heights (canvas text measurement, so layout is a single deterministic pass —
// no measure/re-layout loop), plus the LANDED redesign: merged/closed PRs fold
// into collapsible chapter groups sourced from buildDigest's prompt chapters.
//
// Everything here is view logic. The models stay pure and are passed IN.

import {
  ageText, wrapLines, truncate, measureText, fmtSpan, hhmm,
  SANS, SANS_SM, SANS_STEP, MONO_SM, NOW_TTL,
} from './format.js';

// ------------------------------------------------------------------ geometry
export const ROOT_X = 20;
export const COL0_X = 276;
export const COL_GAP = 300;
export const TOP = 24;
export const VGAP = 20;
const CHAIN_DX = 26;

const W = {
  session: 216, intent: 212, pr: 218, collapsed: 182, plan: 250,
  step: 214, 'step-more': 182, now: 230, chapter: 252,
};

const PLAN_HEAD = 34, PLAN_ROW = 18, PLAN_MAX_ROWS = 7, PLAN_PAD = 12;
const DIFF_ROW = 17;
const SANS_CH = "12.5px 'Inter', system-ui, sans-serif";
const MONO_CHIP = "10px 'IBM Plex Mono', ui-monospace, monospace";
const CHIP_MAX = 8;          // chips shown on a collapsed chapter before "+k"
const CH_PAD_X = 14;

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
    case 'pr': return { view: null, h: 66 + (hasSize(n) ? DIFF_ROW : 0) };
    case 'intent': return { view: null, h: 66 + (hasSize(n) ? DIFF_ROW : 0) };
    case 'collapsed': return { view: null, h: 48 };
    case 'step-more': return { view: null, h: 42 };
    default: return { view: null, h: 48 };
  }
}

// -------------------------------------------------------------- chapters
// Rebuild the LANDED column as chapter groups. The model's own landed nodes
// (and the data of the ones it folded into "N more") are grouped by the digest
// chapter their PR belongs to. PR nodes the digest can't place stay loose.

function repoFromUrl(url) {
  const m = (url || '').match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/);
  return m ? m[1] : null;
}

// A node-shaped record for a PR the model collapsed away, read straight off the
// SAME reducer state the model folded (state.prs) — data recovery, not a rival
// derivation. Field-for-field the shape of graph-model's pr nodes.
function prNodeFromKey(key, state) {
  const pr = state.prs.get(key);
  if (!pr) return null;
  return {
    id: 'pr:' + key, kind: 'pr', key,
    number: pr.number, repo: pr.repo || repoFromUrl(pr.url),
    title: pr.title || null, prState: pr.state || 'open', ci: pr.ci || null,
    url: pr.url || null, add: pr.add || 0, del: pr.del || 0,
    base: pr.base != null ? pr.base : null,
    openedAt: pr.openedAt || null, mergedAt: pr.mergedAt || null,
    lastTouched: pr.t != null ? pr.t : pr.mergedAt != null ? pr.mergedAt : pr.openedAt || 0,
    chainDepth: 0,
  };
}

function chapterChips(members) {
  const chips = members.slice(0, CHIP_MAX).map(m => ({
    label: '#' + m.number, state: m.prState, w: measureText('#' + m.number, MONO_CHIP) + 18,
  }));
  const over = members.length - chips.length;
  if (over > 0) chips.push({ label: '+' + over, state: 'more', w: measureText('+' + over, MONO_CHIP) + 18 });
  // row count for height: chips flow-wrap within the card width
  const maxW = W.chapter - CH_PAD_X * 2;
  let rows = 1, x = 0;
  for (const c of chips) {
    if (x > 0 && x + c.w > maxW) { rows++; x = 0; }
    x += c.w + 5;
  }
  return { chips, rows };
}

function buildChapters(model, digest, state) {
  const landedPrs = model.nodes.filter(n => n.kind === 'pr' && n.col === 3);
  const folded = model.nodes.find(n => n.kind === 'collapsed' && n.colKey === 'landed');
  const hidden = folded
    ? folded.hiddenIds
      .filter(id => id.startsWith('pr:'))
      .map(id => prNodeFromKey(id.slice(3), state))
      .filter(Boolean)
    : [];
  const all = [...landedPrs, ...hidden];
  const byNumber = new Map();
  for (const n of all) if (!byNumber.has(n.number)) byNumber.set(n.number, n);

  const groups = [];
  const grouped = new Set();
  digest.chapters.forEach((ch, i) => {
    if (!ch.prs.length) return;
    const members = [];
    for (const p of ch.prs) {
      const n = byNumber.get(p.number);
      if (n && !grouped.has(n.id)) { grouped.add(n.id); members.push(n); }
    }
    if (!members.length) return;
    members.sort((a, b) => (a.lastTouched || 0) - (b.lastTouched || 0)); // chronological inside
    groups.push({
      id: 'chapter:' + (ch.id || 'ch' + i),
      title: ch.title || '(before first prompt)',
      startT: ch.startT, endT: ch.endT, activeMs: ch.activeMs,
      members,
      lastTouched: Math.max(...members.map(m => m.lastTouched || 0), ch.endT || 0),
    });
  });

  const loose = all.filter(n => !grouped.has(n.id));
  return { groups, loose, foldedId: folded ? folded.id : null };
}

function measureChapter(group, expandedSet, clock) {
  const expanded = expandedSet.has(group.id);
  const meta = `${hhmm(group.startT)} · ${group.members.length} PR${group.members.length === 1 ? '' : 's'} · ${fmtSpan(group.activeMs)} active`;
  const titleLines = expanded
    ? [truncate(group.title, W.chapter - CH_PAD_X * 2 - 18, SANS_CH)]
    : wrapLines(group.title, W.chapter - CH_PAD_X * 2 - 18, SANS_CH, 2);
  let h, chips = null, children = null;
  const headH = 12 + 15 + 5 + Math.max(1, titleLines.length) * 17;
  if (expanded) {
    children = group.members.map(m => {
      const { view, h: mh } = measure(m, clock);
      return { node: m, view, h: mh };
    });
    h = headH + 10 + children.reduce((s, c) => s + c.h + 10, 0) + 4;
  } else {
    chips = chapterChips(group.members);
    h = headH + 8 + chips.rows * 22 + 10;
  }
  return { expanded, meta, titleLines, chips, children, headH, h };
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
export function buildFlow({ model, digest, state, columns, expanded, dragPos, clock, scrubbed, glowIds, pulseIds }) {
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

  // LANDED redesign: replace the model's landed pile (and its "N more" fold)
  // with digest chapter groups. Loose nodes (intents, unplaced PRs) remain.
  const { groups, loose } = buildChapters(model, digest, state);
  const landedItems = [
    ...groups.map(g => ({ type: 'chapter', g, lastTouched: g.lastTouched })),
    ...cols[3].filter(n => n.kind !== 'pr' && n.kind !== 'collapsed')
      .map(n => ({ type: 'node', n, lastTouched: n.lastTouched || 0 })),
    ...loose.map(n => ({ type: 'node', n, lastTouched: n.lastTouched || 0 })),
  ].sort((a, b) => (b.lastTouched || 0) - (a.lastTouched || 0));

  const groupedPr = new Map(); // pr node id → { chapterId, expanded }
  for (const g of groups) {
    const isOpen = expanded.has(g.id);
    for (const m of g.members) groupedPr.set(m.id, { chapterId: g.id, expanded: isOpen });
  }

  // ---- stack the columns
  let minY = Infinity, maxY = -Infinity;
  const colBottom = [TOP, TOP, TOP, TOP];
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
    });
    track(p.y, h);
    return h;
  };

  for (let c = 0; c < 4; c++) {
    let y = TOP;
    const baseX = COL0_X + c * COL_GAP;
    if (c === 3) {
      for (const item of landedItems) {
        if (item.type === 'chapter') {
          const g = item.g;
          const m = measureChapter(g, expanded, clock);
          const p = pos(g.id) || { x: baseX, y };
          nodes.push({
            id: g.id,
            type: 'chapter',
            position: p,
            width: W.chapter,
            height: m.h,
            data: {
              group: g, meta: m.meta, titleLines: m.titleLines, chips: m.chips,
              expanded: m.expanded, clock, scrubbed,
              glow: g.members.some(mm => glow(mm.id)),
            },
            connectable: false,
          });
          track(p.y, m.h);
          // children (always in the array so expand/collapse animates; hidden
          // when the chapter is closed)
          if (m.expanded && m.children) {
            let cy = m.headH + 10;
            for (const ch of m.children) {
              const cp = pos(ch.node.id) || { x: (W.chapter - W.pr) / 2, y: cy };
              nodes.push({
                id: ch.node.id,
                type: 'pr',
                position: cp,
                parentId: g.id,
                extent: 'parent',
                width: W.pr,
                height: ch.h,
                data: { node: ch.node, view: ch.view, clock, scrubbed, inChapter: true, glow: glow(ch.node.id) },
                connectable: false,
              });
              cy += ch.h + 10;
            }
          }
          y += m.h + VGAP;
        } else {
          const h = pushModelNode(item.n, baseX + Math.min(item.n.chainDepth || 0, 3) * CHAIN_DX, y);
          y += h + VGAP;
        }
      }
    } else {
      for (const n of cols[c]) {
        const h = pushModelNode(n, baseX + Math.min(n.chainDepth || 0, 3) * CHAIN_DX, y);
        y += h + VGAP;
      }
    }
    colBottom[c] = y;
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
    });
    track(p.y, h);
  }

  // ---- column backdrop bands (part of the zoomable plane, behind everything)
  const bandTop = -46;
  const bandH = Math.max(maxY, TOP + 80) - bandTop + 40;
  // Rendered counts, not the model's raw ones — LANDED now counts chapter
  // groups + loose nodes, not the pile the chapters replaced.
  const rendered = [cols[0].length, cols[1].length, cols[2].length, landedItems.length];
  const bands = columns.map((col, c) => ({
    id: 'band:' + col.key,
    type: 'colband',
    position: { x: COL0_X + c * COL_GAP - 26, y: bandTop },
    width: COL_GAP,
    height: bandH,
    data: { label: col.label, count: rendered[c], alt: c % 2 === 1 },
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
    let from = e.from, to = e.to;
    // The landed "N more" node is replaced by chapters; drop its edges.
    if (from === 'collapsed:landed' || to === 'collapsed:landed') continue;
    // A session→landed-PR edge is superseded by the chapter containment edge.
    const gFrom = groupedPr.get(from), gTo = groupedPr.get(to);
    if (e.kind === 'session' && gTo) continue;
    // Edges touching a PR inside a COLLAPSED chapter re-point at the chapter.
    if (gFrom && !gFrom.expanded) from = gFrom.chapterId;
    if (gTo && !gTo.expanded) to = gTo.chapterId;
    if (from === to) continue;
    if (!nodeIds.has(from) || !nodeIds.has(to)) continue;
    const key = `${e.kind}|${from}|${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pulse = e.kind !== 'session' && !!(pulseIds && (pulseIds.has(e.from) || pulseIds.has(e.to)));
    edges.push(flowEdge({ ...e, from, to }, i++, pulse));
  }
  // Session → chapter containment (the chapter is the landed unit now).
  for (const g of groups) {
    edges.push(flowEdge({ from: 'session', to: g.id, kind: 'session' }, i++));
  }

  return { nodes: [...bands, ...nodes], edges };
}
