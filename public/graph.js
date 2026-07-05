// The /graph view — an interactive work-structure node canvas that competes with
// the kanban board as a way to see a session's shape. Hand-rolled SVG (crisp text
// + easy hit-testing), zero dependencies, no build step.
//
// Data flow mirrors the sibling /lanes view: fetch the whole tape once (GET
// /events), build the PURE model (public/graph-model.js — a fold of the reducer's
// state into nodes/edges/columns), lay it out deterministically left→right, and
// paint it as SVG. Then subscribe to the session SSE for the live pulse: a node
// whose entity just changed glows briefly, a merging PR pulses its edges. Pan/zoom
// and per-node drag positions are the view's own concern (drag persists to
// localStorage, keyed by session+node, until "reset layout").

import { fold, liveness } from './reducer.js';
import { buildGraphModel, COLUMNS } from './graph-model.js';
import { sessionLabel } from './session-label.js';
import { turnLabel } from './turn-id.js';
import { initSessionPicker } from './session-picker.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const $ = sel => document.querySelector(sel);
const svg = $('#graph-svg');
const gCols = $('#graph-cols');
const gEdges = $('#graph-edges');
const gNodes = $('#graph-nodes');
const main = $('#graph-main');
const tip = $('#graph-tooltip');

// --------------------------------------------------------------- geometry
const ROOT_X = 20;
const COL0_X = 276;
const COL_GAP = 300;
const TOP = 24;
const VGAP = 20;
const CHAIN_DX = 26; // rightward step per base-chain depth, within a column

const DIM = {
  session: { w: 216, h: 82 },
  intent: { w: 212, h: 66 },
  pr: { w: 218, h: 66 },
  collapsed: { w: 182, h: 48 },
  plan: { w: 250 }, // height computed from step count
  step: { w: 214 },  // compact running-step node; height computed from wrapped text
  'step-more': { w: 182, h: 42 },
  now: { w: 230 },   // transient live-turn node; height computed from prompt + now-line
};
const PLAN_HEAD = 30, PLAN_ROW = 18, PLAN_MAX_ROWS = 7, PLAN_PAD = 12;
// Running-step node geometry: a glyph column on the left, up-to-2 wrapped text
// lines, then a duration row.
const STEP_TXT_X = 34, STEP_PAD_TOP = 14, STEP_LINE = 15, STEP_DUR_ROW = 15, STEP_PAD_BOT = 11;
// "now" node geometry: a header row (dot + "now"/"needs you"), up-to-2 wrapped
// prompt lines, then the now-line (up-to-2 wrapped) with the session strip's TTL
// re-tensing. A left inset for the text, the header pulse dot sits above it.
const NOW_TXT_X = 16, NOW_PROMPT_TOP = 40, NOW_PROMPT_LINE = 17, NOW_LINE_STEP = 15;
const NOW_HEAD_TO_BODY = 4, NOW_PAD_BOT = 12;

// A PR / intent node grows by one row when it carries diff-size data, so the
// "+N −N" chip gets its own line without crowding the title/meta. These nodes are
// fixed-height (unlike the measured session root), so measureHeight() adds this
// row iff the node HAS size — an absent-size node keeps its original height.
const DIFF_ROW = 17;
const hasSize = n => (n.add || 0) > 0 || (n.del || 0) > 0;

// The session root's live activity strip. Past this age the "now" line is honestly
// re-tensed to "last seen Xm ago: …" and loses its pulse — the same 10-min TTL the
// board uses, so a dead recorder's 1am narration stops reading as current at 9am.
const NOW_TTL = 10 * 60e3;
const ACT_DIV_Y = 86;    // hairline under the base block, where activity begins
const ACT_LINE1 = 15;    // baseline offset of the first activity line below the divider
const ACT_PROMPT_DY = 17;// vertical step after the "on: <prompt>" label line
const ACT_BODY_DY = 15;  // vertical step per wrapped now/attention line
const ACT_BOT_PAD = 10;  // padding below the last line
const ACT_DOT_X = 18, ACT_TXT_X = 30; // pulse dot + body text insets

// PR status ring colors (per the /graph spec): open amber, merged violet, closed
// grey. Distinct from the board's green so the ring reads as "still cooking".
const RING = { open: '#d29922', merged: '#a371f7', closed: '#5d6781' };
const STATUS_ACCENT = { inbox: '#5d6781', doing: '#d29922', pr: '#4cb782', done: '#5e6ad2' };

// --------------------------------------------------------------- text measure
const meas = document.createElement('canvas').getContext('2d');
function truncate(text, maxW, font) {
  meas.font = font;
  text = String(text == null ? '' : text);
  if (meas.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && meas.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}
const SANS = "13px 'Inter', system-ui, sans-serif";
const SANS_SM = "11px 'Inter', system-ui, sans-serif";
const MONO_SM = "10.5px 'IBM Plex Mono', ui-monospace, monospace";

// Wrap `str` to at most `maxLines` lines within `maxW` at `font`, ellipsizing the
// final line when text remains — the SVG equivalent of the board's CSS
// -webkit-line-clamp on the now-line. Pure over the canvas measurer.
function wrapLines(str, maxW, font, maxLines) {
  meas.font = font;
  str = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
  if (!str) return [];
  const words = str.split(' ');
  const lines = [];
  let cur = '', idx = 0;
  while (idx < words.length && lines.length < maxLines) {
    const trial = cur ? cur + ' ' + words[idx] : words[idx];
    if (!cur || meas.measureText(trial).width <= maxW) { cur = trial; idx++; }
    else { lines.push(cur); cur = ''; }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  // Words still remaining → we hit the line cap; fold them into the last line so
  // truncate() ellipsizes it, signalling "more".
  if (idx < words.length && lines.length) {
    lines[lines.length - 1] += ' ' + words.slice(idx).join(' ');
  }
  return lines.map(l => truncate(l, maxW, font));
}

// --------------------------------------------------------------- helpers
const pad = n => String(n).padStart(2, '0');
function ageText(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function costText(c) {
  if (!c) return '$0';
  return c >= 1 ? `$${c.toFixed(2)}` : `$${c.toFixed(3)}`;
}
function hhmm(t) { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
const escAttr = s => String(s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function el(tag, attrs, ...kids) {
  const n = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
  for (const kid of kids) if (kid != null) n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  return n;
}
function text(x, y, str, cls, font) {
  const t = el('text', { x, y, class: cls });
  t.textContent = str;
  if (font) t.setAttribute('data-font', font);
  return t;
}

// A compact mono diff chip — "+1,234 −56", adds green / dels red, the same palette
// as the masthead adds/dels counters and the session root's line. Two tspans so
// each number colors independently inside one <text>; the true minus sign (−)
// reads cleaner than a hyphen at this size.
function diffChip(x, y, add, del) {
  const t = el('text', { x, y, class: 'gn-diff' });
  t.appendChild(el('tspan', { class: 'a' }, '+' + Number(add || 0).toLocaleString()));
  t.appendChild(el('tspan', { class: 'd', dx: 7 }, '−' + Number(del || 0).toLocaleString()));
  return t;
}

// --------------------------------------------------------------- state
let sessionId = new URLSearchParams(location.search).get('session');
let sessionsMeta = [];          // /sessions list (for title/agent fallback)
let events = [];
let model = null;
let nodeById = new Map();       // id → laid-out node (with x,y,w,h)
let dragPos = {};               // nodeId → {x,y} — user overrides (localStorage + live)
let view = { x: 40, y: 60, k: 1 };
let sigMap = new Map();         // nodeId → signature (glow detection)
let firstPaint = true;
let draggingNode = null;
let pendingRebuild = false;

// --------------------------------------------------------------- activity strip
// Resolve the session root's live-activity section into concrete draw items +
// height, so measureHeight() and buildNode() agree on the (grown) node size. The
// ONE turn-card title allowed on the graph rides in here as the current prompt.
// Returns null when there's nothing live to show (empty tape / no prompt).
function activityView(n) {
  const a = n.activity;
  if (!a) return null;
  const attn = a.phase === 'attention' && !!a.attentionText;
  const nowText = a.now && a.now.text;
  if (!a.prompt && !attn && !nowText) return null;

  const items = [];
  let y = ACT_DIV_Y + ACT_LINE1;
  if (a.prompt) {
    items.push({ type: 'prompt', text: truncate('on: ' + a.prompt, n.w - 28, MONO_SM), y });
    y += ACT_PROMPT_DY;
  }
  let pulse = false, dot = null;
  if (attn) {
    // The loud state: the agent is blocked on the human. Board's attention red,
    // prefixed "needs you:", no pulse.
    const lines = wrapLines('needs you: ' + a.attentionText, n.w - 28, SANS_SM, 2);
    dot = { y: y - 4, cls: 'attn' };
    items.push({ type: 'body', lines, cls: 'attn', y });
    y += lines.length * ACT_BODY_DY;
  } else if (nowText) {
    const age = Math.max(0, Date.now() - (a.now.t || Date.now()));
    const past = age > NOW_TTL;
    pulse = a.phase === 'working' && !past;
    const label = past ? `last seen ${ageText(age)} ago: ${a.now.text}` : a.now.text;
    const lines = wrapLines(label, n.w - (ACT_TXT_X + 12), SANS_SM, 2);
    dot = { y: y - 4, cls: (past ? 'past ' : '') + (a.now.kind || 'say') };
    items.push({ type: 'body', lines, cls: (past ? 'past ' : '') + (a.now.kind || 'say'), y });
    y += lines.length * ACT_BODY_DY;
  }
  return { items, pulse, dot, height: y + ACT_BOT_PAD };
}

// Resolve the transient "now" node's live section into draw items + measured
// height, so measureHeight() and buildNode() agree on the size. Mirrors the session
// strip's now-line treatment: honestly re-tensed past the 10-min TTL, a single
// subtle pulse while working+fresh, the board's attention red on `attention`. Pure
// over the canvas measurer; the only wall-clock read is the display-side age (same
// as the session strip), never the model.
function nowView(n) {
  const w = DIM.now.w;
  const attn = n.phase === 'attention';
  const promptLines = wrapLines(n.prompt || turnLabel(n.turnId) || 'current turn', w - (NOW_TXT_X + 10), SANS, 2);
  let y = NOW_PROMPT_TOP + Math.max(1, promptLines.length) * NOW_PROMPT_LINE;
  let bodyLines = [], bodyCls = '', pulse = false;
  const nowText = n.now && n.now.text;
  if (nowText) {
    const age = Math.max(0, Date.now() - (n.now.t || Date.now()));
    const past = age > NOW_TTL;
    // Pulse only while the session is working AND the line is fresh — never on
    // attention (the loud state is red + "needs you", not a live pulse).
    pulse = !attn && n.phase === 'working' && !past;
    const label = past ? `last seen ${ageText(age)} ago: ${nowText}` : nowText;
    bodyLines = wrapLines(label, w - (NOW_TXT_X + 10), SANS_SM, 2);
    bodyCls = (attn ? 'attn ' : '') + (past ? 'past ' : '') + (n.now.kind || 'say');
    y += NOW_HEAD_TO_BODY + bodyLines.length * NOW_LINE_STEP;
  } else {
    // No narration line yet: a bare pulse under the prompt while working (motion =
    // liveness); attention stays static (loud red header, no pulse).
    pulse = !attn && n.phase === 'working';
  }
  return { attn, promptLines, bodyLines, bodyCls, pulse, height: y + NOW_PAD_BOT };
}

// --------------------------------------------------------------- layout
function measureHeight(n) {
  if (n.kind === 'plan') {
    const rows = Math.min(n.steps.length, PLAN_MAX_ROWS) + (n.steps.length > PLAN_MAX_ROWS ? 1 : 0);
    return PLAN_HEAD + rows * PLAN_ROW + PLAN_PAD;
  }
  if (n.kind === 'session') {
    const av = n._av = activityView(n); // cache so buildNode paints the measured size
    return av ? av.height : DIM.session.h;
  }
  if (n.kind === 'step') {
    const nLines = Math.max(1, wrapLines(n.text, DIM.step.w - (STEP_TXT_X + 8), SANS_SM, 2).length);
    return STEP_PAD_TOP + nLines * STEP_LINE + STEP_DUR_ROW + STEP_PAD_BOT;
  }
  if (n.kind === 'now') {
    const nv = n._nav = nowView(n); // cache so buildNode paints the measured size
    return nv.height;
  }
  // PR / intent nodes grow one row for the diff chip, but only when sized — an
  // absent-size node keeps its compact original height (no "+0 −0" gap).
  if ((n.kind === 'pr' || n.kind === 'intent') && hasSize(n)) return DIM[n.kind].h + DIFF_ROW;
  return DIM[n.kind].h;
}
function widthOf(n) { return DIM[n.kind].w; }

// Deterministic left→right layout: each node gets (x,y,w,h). Columns stack by the
// model's `order`; the session root is vertically centered against the whole graph.
function layout() {
  nodeById = new Map();
  const cols = [[], [], [], []];
  let session = null;
  for (const n of model.nodes) {
    if (n.kind === 'session') { session = n; continue; }
    cols[n.col].push(n);
  }
  for (const c of cols) c.sort((a, b) => a.order - b.order);

  let minY = Infinity, maxY = -Infinity;
  for (let c = 0; c < cols.length; c++) {
    let y = TOP;
    for (const n of cols[c]) {
      n.w = widthOf(n);
      n.h = measureHeight(n);
      n.x = COL0_X + c * COL_GAP + Math.min(n.chainDepth || 0, 3) * CHAIN_DX;
      n.y = y;
      y += n.h + VGAP;
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y + n.h);
      nodeById.set(n.id, n);
    }
  }
  if (!isFinite(minY)) { minY = TOP; maxY = TOP + 80; }
  if (session) {
    // Measured, not fixed: the activity strip grows the root, so read its real
    // height before vertically centering it against the columns.
    session.w = DIM.session.w; session.h = measureHeight(session);
    session.x = ROOT_X;
    session.y = Math.max(TOP, (minY + maxY) / 2 - session.h / 2);
    nodeById.set(session.id, session);
  }
  // Apply user drag overrides (persisted + live).
  for (const [id, p] of Object.entries(dragPos)) {
    const n = nodeById.get(id);
    if (n) { n.x = p.x; n.y = p.y; }
  }
}

// --------------------------------------------------------------- node signatures
function sigOf(n) {
  switch (n.kind) {
    case 'pr': return `${n.prState}|${n.ci}|${n.add}|${n.del}|${n.lastTouched}`;
    case 'intent': return `${n.status}|${n.commits}|${n.edits}|${n.add}|${n.del}|${n.lastTouched}`;
    case 'plan': return `${n.total}|${n.counts.completed}|${n.counts.in_progress}|${n.lastTouched}`;
    // A step's startedAt (identity) or paused flip re-signs the node so a newly
    // running / just-paused step glows. A step leaving in_progress drops the node.
    case 'step': return `${n.text}|${n.startedAt}|${n.paused}`;
    case 'step-more': return `${n.count}|${n.paused}`;
    // A fresh say (now.t), a phase flip, or a changed prompt re-signs the now node so
    // it glows; a brand-new now-node glows once via paint()'s new-entity path.
    case 'now': return `${n.phase}|${n.now ? n.now.t : 0}|${n.prompt}|${n.turnId}`;
    case 'session': {
      // Include the live-activity fields so a new say/tool (now.t), a phase flip,
      // or a changed prompt/attention re-signs the root — otherwise a fresh
      // narration wouldn't glow the node it just updated.
      const a = n.activity || {};
      const nowT = a.now ? a.now.t : 0;
      return `${n.cost.toFixed(3)}|${n.commits}|${n.lastTouched}|${a.phase}|${nowT}|${a.attentionText || ''}|${a.prompt || ''}`;
    }
    case 'collapsed': return `${n.count}`;
    default: return '';
  }
}

// --------------------------------------------------------------- edge paths
function nodeCenter(n) { return { x: n.x + n.w / 2, y: n.y + n.h / 2 }; }
function edgePath(a, b) {
  const ay = a.y + a.h / 2, by = b.y + b.h / 2;
  // Connect the facing sides based on relative x; same-column edges bulge right.
  if (b.x >= a.x + a.w - 2) {
    const sx = a.x + a.w, ex = b.x, dx = Math.max(24, (ex - sx) * 0.5);
    return `M${sx},${ay} C${sx + dx},${ay} ${ex - dx},${by} ${ex},${by}`;
  }
  if (b.x + b.w <= a.x + 2) {
    const sx = a.x, ex = b.x + b.w, dx = Math.max(24, (sx - ex) * 0.5);
    return `M${sx},${ay} C${sx - dx},${ay} ${ex + dx},${by} ${ex},${by}`;
  }
  // Overlapping x (same column): loop out to the right.
  const sx = a.x + a.w, ex = b.x + b.w, bulge = 40;
  return `M${sx},${ay} C${sx + bulge},${ay} ${ex + bulge},${by} ${ex},${by}`;
}

// --------------------------------------------------------------- paint
const EDGE_CLASS = { 'item-pr': 'e-item', 'pr-base': 'e-base', 'plan-item': 'e-plan', 'plan-step': 'e-step', session: 'e-session' };

function paintColumns() {
  gCols.textContent = '';
  const laneH = 100000; // full-bleed backdrop band; view clipping is by pan
  for (let c = 0; c < COLUMNS.length; c++) {
    const x = COL0_X + c * COL_GAP;
    const band = el('rect', { x: x - 26, y: -40, width: COL_GAP, height: laneH, class: 'gcol-band ' + (c % 2 ? 'alt' : '') });
    gCols.appendChild(band);
    const head = el('g', { class: 'gcol-head' });
    head.appendChild(text(x, -12, COLUMNS[c].label, 'gcol-label'));
    head.appendChild(text(x + widthOf({ kind: 'pr' }) + 6, -12, String(model.columns[c].count || ''), 'gcol-count'));
    gCols.appendChild(head);
  }
}

function paintEdges(pulseIds) {
  gEdges.textContent = '';
  for (const e of model.edges) {
    const a = nodeById.get(e.from), b = nodeById.get(e.to);
    if (!a || !b) continue;
    const cls = 'gedge ' + (EDGE_CLASS[e.kind] || '');
    const p = el('path', { d: edgePath(a, b), class: cls, fill: 'none' });
    if (pulseIds && (pulseIds.has(e.from) || pulseIds.has(e.to)) && e.kind !== 'session') p.classList.add('pulse');
    gEdges.appendChild(p);
  }
}

// Build the SVG group for one node. Pure function of the node's fields.
function buildNode(n) {
  const g = el('g', { class: 'gnode gnode-' + n.kind, transform: `translate(${n.x},${n.y})`, 'data-id': n.id });
  g.appendChild(el('rect', { x: 0, y: 0, width: n.w, height: n.h, rx: 9, class: 'gnode-box' }));

  if (n.kind === 'session') {
    g.appendChild(el('rect', { x: 0, y: 0, width: 4, height: n.h, rx: 2, class: 'gnode-accent', fill: '#F0E2C0' }));
    g.appendChild(text(16, 22, truncate(n.title, n.w - 84, SANS), 'gn-title'));
    if (n.agent) {
      const badge = el('g', { class: 'gn-agent agent-' + n.agent });
      const label = n.agent.toUpperCase();
      meas.font = MONO_SM; const bw = meas.measureText(label).width + 14;
      badge.appendChild(el('rect', { x: n.w - bw - 12, y: 10, width: bw, height: 16, rx: 8, class: 'gn-agent-box' }));
      badge.appendChild(text(n.w - bw - 12 + bw / 2, 21, label, 'gn-agent-txt'));
      g.appendChild(badge);
    }
    g.appendChild(text(16, 44, `${costText(n.cost)} · ${n.commits} commits`, 'gn-meta'));
    g.appendChild(text(16, 62, `+${n.add.toLocaleString()} / -${n.del.toLocaleString()} lines`, 'gn-meta'));
    if (n.startedAt) g.appendChild(text(16, 76, `since ${hhmm(n.startedAt)}`, 'gn-sub'));
    paintActivity(g, n);
  } else if (n.kind === 'plan') {
    g.appendChild(text(14, 20, 'Plan', 'gn-title'));
    g.appendChild(text(n.w - 14, 20, `${n.counts.completed}/${n.total}`, 'gn-frac'));
    let y = PLAN_HEAD + 4;
    const shown = n.steps.slice(0, PLAN_MAX_ROWS);
    for (const s of shown) {
      g.appendChild(el('circle', { cx: 20, cy: y - 4, r: 3.2, class: 'gn-step-dot step-' + s.status }));
      g.appendChild(text(32, y, truncate(s.text, n.w - 44, SANS_SM), 'gn-step ' + (s.status === 'completed' ? 'done' : '')));
      y += PLAN_ROW;
    }
    if (n.steps.length > PLAN_MAX_ROWS) {
      g.appendChild(text(32, y, `+${n.steps.length - PLAN_MAX_ROWS} more steps`, 'gn-step muted'));
    }
  } else if (n.kind === 'intent') {
    g.appendChild(el('rect', { x: 0, y: 0, width: 4, height: n.h, rx: 2, class: 'gnode-accent', fill: STATUS_ACCENT[n.status] || '#5d6781' }));
    g.appendChild(text(16, 24, truncate(n.title, n.w - 26, SANS), 'gn-title'));
    const stats = [];
    if (n.commits) stats.push(`${n.commits} commit${n.commits > 1 ? 's' : ''}`);
    if (n.edits) stats.push(`${n.edits} edit${n.edits > 1 ? 's' : ''}`);
    g.appendChild(text(16, 46, truncate(stats.join(' · ') || n.status, n.w - 26, MONO_SM), 'gn-meta'));
    // Diff size as its own colored chip line (the size of the work at a glance),
    // rendered only when the item's attributed commits carry any lines.
    if (hasSize(n)) g.appendChild(diffChip(16, 63, n.add, n.del));
    const chip = n.abandoned ? 'abandoned?' : n.status;
    g.appendChild(text(n.w - 12, n.h - 10, chip, 'gn-chip ' + (n.abandoned ? 'abandoned' : '')));
  } else if (n.kind === 'pr') {
    const ring = RING[n.prState] || RING.open;
    g.appendChild(el('circle', { cx: 18, cy: 20, r: 6.5, class: 'gn-ring', fill: 'none', stroke: ring, 'stroke-width': 2.4 }));
    if (n.prState === 'merged') g.appendChild(el('circle', { cx: 18, cy: 20, r: 2.6, fill: ring }));
    const label = (n.repo ? n.repo + '#' : '#') + n.number;
    // Title: the real PR title, or a bare #number when the tape recorded none.
    g.appendChild(text(34, 24, truncate(n.title || '#' + n.number, n.w - 70, SANS), 'gn-title'));
    // Meta (repo#number) shares its row with the right-anchored age, so leave the
    // age a clear gutter — a long repo path must not collide with it.
    g.appendChild(text(34, 46, truncate(label, n.w - 92, MONO_SM), 'gn-meta'));
    const at = n.mergedAt || n.openedAt || n.lastTouched;
    if (at) g.appendChild(text(n.w - 12, 46, ageText(Date.now() - at), 'gn-age'));
    // Diff size as a colored chip line (only when the PR has recorded size — old
    // tapes and never-polled merged PRs render nothing, no "+0 −0" noise).
    if (hasSize(n)) g.appendChild(diffChip(34, 63, n.add, n.del));
    // CI glyph, top-right
    if (n.ci === 'fail') g.appendChild(ciMark(n.w - 20, 20, 'fail'));
    else if (n.ci === 'pass') g.appendChild(ciMark(n.w - 20, 20, 'pass'));
    else if (n.ci === 'pending') g.appendChild(el('circle', { cx: n.w - 20, cy: 20, r: 4, class: 'gn-ci-pending', fill: 'none' }));
    // external-link affordance
    if (n.url) {
      const link = el('g', { class: 'gn-ext', 'data-url': n.url, transform: `translate(${n.w - 20},${n.h - 20})` });
      link.appendChild(el('rect', { x: -8, y: -8, width: 18, height: 18, rx: 4, class: 'gn-ext-hit' }));
      link.appendChild(el('path', { d: 'M0 6 L6 0 M2 0 H6 V4', class: 'gn-ext-icon', fill: 'none', 'stroke-width': 1.3 }));
      g.appendChild(link);
    }
  } else if (n.kind === 'collapsed') {
    g.setAttribute('class', 'gnode gnode-collapsed');
    g.appendChild(el('path', { d: `M6 8 h${n.w - 12} M4 14 h${n.w - 8} M2 20 h${n.w - 4}`, class: 'gn-stack', fill: 'none' }));
    g.appendChild(text(n.w / 2, n.h / 2 + 8, n.label, 'gn-collapsed-txt'));
  } else if (n.kind === 'step') {
    if (n.paused) g.classList.add('paused');
    const gy = 19;
    g.appendChild(el('rect', { x: 0, y: 0, width: 4, height: n.h, rx: 2, class: 'gnode-accent', fill: n.paused ? '#5d6781' : '#d29922' }));
    if (n.paused) {
      // Static pause glyph (two bars) — the spinner is a lie while the session is
      // idle; nothing is advancing.
      g.appendChild(el('rect', { x: 14, y: gy - 5, width: 2.6, height: 10, rx: 1, class: 'gn-step-pause' }));
      g.appendChild(el('rect', { x: 19.4, y: gy - 5, width: 2.6, height: 10, rx: 1, class: 'gn-step-pause' }));
    } else {
      // Dashed spinner ring — the live "still running" motion (motion = liveness).
      g.appendChild(el('circle', { cx: 18, cy: gy, r: 6, class: 'gn-step-ring', fill: 'none' }));
    }
    const lines = wrapLines(n.text, n.w - (STEP_TXT_X + 8), SANS_SM, 2);
    let ty = STEP_PAD_TOP + 2;
    for (const line of lines) { g.appendChild(text(STEP_TXT_X, ty, line, 'gn-step-text' + (n.paused ? ' paused' : ''))); ty += STEP_LINE; }
    // Running duration from startedAt; frozen at the idle moment when paused.
    const ms = n.paused
      ? (n.pausedAt != null && n.startedAt ? Math.max(0, n.pausedAt - n.startedAt) : null)
      : (n.startedAt ? Math.max(0, Date.now() - n.startedAt) : null);
    if (ms != null) {
      const label = n.paused ? `paused · ${ageText(ms)}` : ageText(ms);
      g.appendChild(text(STEP_TXT_X, n.h - STEP_PAD_BOT, label, 'gn-step-dur' + (n.paused ? ' paused' : '')));
    }
  } else if (n.kind === 'step-more') {
    g.setAttribute('class', 'gnode gnode-step-more' + (n.paused ? ' paused' : ''));
    g.appendChild(text(n.w / 2, n.h / 2 + 4, `…${n.count} more running`, 'gn-collapsed-txt'));
  } else if (n.kind === 'now') {
    // The transient live-turn node: amber "live" accent (red on attention), a single
    // pulse dot, a header, the current prompt, and the now-line. Flat/quiet — one
    // subtle pulse, never decoration.
    const nv = n._nav || nowView(n);
    if (nv.attn) g.classList.add('attn');
    const hy = 15;
    g.appendChild(el('rect', { x: 0, y: 0, width: 4, height: n.h, rx: 2, class: 'gnode-accent', fill: nv.attn ? '#eb6e64' : '#d29922' }));
    if (nv.pulse) g.appendChild(el('circle', { cx: 18, cy: hy, r: 3.5, class: 'gn-now-ping' + (nv.attn ? ' attn' : '') }));
    g.appendChild(el('circle', { cx: 18, cy: hy, r: 3.5, class: 'gn-now-dot' + (nv.attn ? ' attn' : '') }));
    g.appendChild(text(30, hy + 4, nv.attn ? 'needs you' : 'now', 'gn-now-head' + (nv.attn ? ' attn' : '')));
    // The one turn-card title allowed as a node's headline — the current prompt.
    let ty = NOW_PROMPT_TOP;
    for (const line of nv.promptLines) { g.appendChild(text(NOW_TXT_X, ty, line, 'gn-now-prompt')); ty += NOW_PROMPT_LINE; }
    // The now-line, honestly re-tensed past the TTL (same treatment as the strip).
    ty += NOW_HEAD_TO_BODY;
    for (const line of nv.bodyLines) { g.appendChild(text(NOW_TXT_X, ty, line, 'gn-now-line ' + nv.bodyCls)); ty += NOW_LINE_STEP; }
  }
  return g;
}

function ciMark(cx, cy, kind) {
  const g = el('g', { class: 'gn-ci gn-ci-' + kind });
  if (kind === 'fail') {
    g.appendChild(el('path', { d: `M${cx - 4},${cy - 4} L${cx + 4},${cy + 4} M${cx + 4},${cy - 4} L${cx - 4},${cy + 4}`, 'stroke-width': 1.8, fill: 'none' }));
  } else {
    g.appendChild(el('path', { d: `M${cx - 4},${cy} L${cx - 1},${cy + 3} L${cx + 4},${cy - 4}`, 'stroke-width': 1.8, fill: 'none' }));
  }
  return g;
}

// The session root's live activity strip: a divider, an "on: <prompt>" label, and
// the board's now-line — pulsing dot while the session is working and the data is
// fresh, honestly re-tensed past the 10-min TTL, and the attention ask in red.
function paintActivity(g, n) {
  const av = n._av || activityView(n);
  if (!av) return;
  g.appendChild(el('line', { x1: 12, y1: ACT_DIV_Y, x2: n.w - 12, y2: ACT_DIV_Y, class: 'gn-act-div' }));
  if (av.dot) {
    if (av.pulse) g.appendChild(el('circle', { cx: ACT_DOT_X, cy: av.dot.y, r: 3, class: 'gn-act-ping ' + av.dot.cls }));
    g.appendChild(el('circle', { cx: ACT_DOT_X, cy: av.dot.y, r: 3, class: 'gn-act-dot ' + av.dot.cls }));
  }
  for (const it of av.items) {
    if (it.type === 'prompt') {
      g.appendChild(text(16, it.y, it.text, 'gn-act-on'));
    } else {
      let y = it.y;
      for (const line of it.lines) {
        g.appendChild(text(ACT_TXT_X, y, line, 'gn-act-now ' + it.cls));
        y += ACT_BODY_DY;
      }
    }
  }
}

function paintNodes(glowIds) {
  gNodes.textContent = '';
  for (const n of model.nodes) {
    const g = buildNode(n);
    if (glowIds && glowIds.has(n.id)) {
      g.classList.add('glow');
      setTimeout(() => g.classList.remove('glow'), 1400);
    }
    gNodes.appendChild(g);
  }
}

function applyView() {
  const t = `translate(${view.x},${view.y}) scale(${view.k})`;
  gCols.setAttribute('transform', t);
  gEdges.setAttribute('transform', t);
  gNodes.setAttribute('transform', t);
}

// A full repaint. Detects entity changes since the last paint to glow/pulse.
function paint() {
  const glow = new Set(), pulse = new Set();
  const nextSig = new Map();
  for (const n of model.nodes) {
    const s = sigOf(n);
    nextSig.set(n.id, s);
    if (!firstPaint && sigMap.has(n.id) && sigMap.get(n.id) !== s) {
      glow.add(n.id);
      if (n.kind === 'pr' && (n.prState === 'merged' || n.prState === 'closed')) pulse.add(n.id);
    }
    if (!firstPaint && !sigMap.has(n.id)) glow.add(n.id); // a brand-new entity
  }
  sigMap = nextSig;
  paintColumns();
  paintEdges(pulse.size ? pulse : null);
  paintNodes(glow.size ? glow : null);
  applyView();
  firstPaint = false;
}

// Rebuild the model from the current tape, re-layout, repaint. Debounced under
// live traffic; deferred while a node is being dragged.
let rebuildScheduled = false;
function scheduleRebuild() {
  if (rebuildScheduled) return;
  rebuildScheduled = true;
  setTimeout(() => {
    rebuildScheduled = false;
    if (draggingNode) { pendingRebuild = true; return; }
    rebuild();
  }, 180);
}
function rebuild() {
  model = buildGraphModel(events);
  $('#graph-empty').hidden = model.nodes.length > 1;
  layout();
  paint();
  renderStatus();
}

// --------------------------------------------------------------- honesty banner
function renderStatus() {
  const state = fold(events);
  const lv = liveness(state, Date.now());
  const badge = $('#status-badge'), txt = $('#status-text');
  badge.className = 'badge';
  if (lv.state === 'stale') {
    badge.classList.add('is-stale');
    txt.textContent = `STALE · data ends ${hhmm(lv.dataEndsAt)}`;
    badge.hidden = false;
  } else if (lv.state === 'live') {
    badge.classList.add('is-live'); txt.textContent = 'LIVE'; badge.hidden = false;
  } else if (lv.state === 'idle') {
    badge.classList.add('is-idle'); txt.textContent = 'IDLE'; badge.hidden = false;
  } else if (lv.state === 'attention') {
    badge.classList.add('is-attn'); txt.textContent = 'NEEDS YOU'; badge.hidden = false;
  } else if (lv.state === 'ended') {
    badge.classList.add('is-stale'); txt.textContent = 'ENDED'; badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

// --------------------------------------------------------------- interactions
function localPos(e) {
  const r = svg.getBoundingClientRect();
  return { px: e.clientX - r.left, py: e.clientY - r.top };
}
const worldOf = (px, py) => ({ x: (px - view.x) / view.k, y: (py - view.y) / view.k });

// wheel = zoom around the cursor.
svg.addEventListener('wheel', e => {
  e.preventDefault();
  const { px, py } = localPos(e);
  const w = worldOf(px, py);
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const k = Math.max(0.15, Math.min(2.6, view.k * factor));
  view.x = px - w.x * k;
  view.y = py - w.y * k;
  view.k = k;
  applyView();
  tip.hidden = true;
}, { passive: false });

// pan the canvas (pointerdown on empty space), or drag a node.
let panning = false, panStart = null, moved = 0, nodeStart = null;
svg.addEventListener('pointerdown', e => {
  const nodeG = e.target.closest('.gnode');
  moved = 0;
  if (nodeG) {
    // start a node drag
    const n = nodeById.get(nodeG.dataset.id);
    if (!n) return;
    draggingNode = { n, g: nodeG, startX: e.clientX, startY: e.clientY, ox: n.x, oy: n.y };
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  panning = true; panStart = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  svg.setPointerCapture(e.pointerId);
  svg.classList.add('panning');
});
svg.addEventListener('pointermove', e => {
  if (draggingNode) {
    const dx = (e.clientX - draggingNode.startX) / view.k;
    const dy = (e.clientY - draggingNode.startY) / view.k;
    moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    const n = draggingNode.n;
    n.x = draggingNode.ox + dx; n.y = draggingNode.oy + dy;
    draggingNode.g.setAttribute('transform', `translate(${n.x},${n.y})`);
    paintEdges(null);
    tip.hidden = true;
    return;
  }
  if (panning) {
    view.x = panStart.vx + (e.clientX - panStart.x);
    view.y = panStart.vy + (e.clientY - panStart.y);
    moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    applyView();
    tip.hidden = true;
    return;
  }
  hover(e);
});
svg.addEventListener('pointerup', e => {
  if (draggingNode) {
    const n = draggingNode.n;
    if (moved > 3) { dragPos[n.id] = { x: n.x, y: n.y }; saveDrag(); }
    else onNodeClick(n, e);
    draggingNode = null;
    if (pendingRebuild) { pendingRebuild = false; rebuild(); }
    return;
  }
  panning = false;
  svg.classList.remove('panning');
});
svg.addEventListener('pointerleave', () => { tip.hidden = true; });

function onNodeClick(n, e) {
  // PR external-link affordance opens the gh URL, not replay.
  const ext = e.target.closest('.gn-ext');
  if (ext && ext.dataset.url) { window.open(ext.dataset.url, '_blank', 'noopener'); return; }
  if (n.kind === 'collapsed' || n.kind === 'step-more') return; // aggregate — nothing to deep-link into
  const q = new URLSearchParams();
  if (sessionId) q.set('session', sessionId);
  // A step node deep-links to when the step STARTED running (n.lastTouched = startedAt).
  if (n.lastTouched) q.set('t', String(Math.round(n.lastTouched)));
  location.href = '/?' + q.toString();
}

// hover tooltip (mono, matches lanes).
function hover(e) {
  const nodeG = e.target.closest('.gnode');
  if (!nodeG) { tip.hidden = true; svg.style.cursor = 'default'; return; }
  const n = nodeById.get(nodeG.dataset.id);
  if (!n) { tip.hidden = true; return; }
  svg.style.cursor = e.target.closest('.gn-ext') ? 'alias' : 'pointer';
  tip.innerHTML = tooltipHtml(n);
  tip.hidden = false;
  const r = main.getBoundingClientRect();
  let left = e.clientX - r.left + 14, top = e.clientY - r.top + 16;
  if (left + tip.offsetWidth > r.width - 8) left = r.width - tip.offsetWidth - 8;
  if (top + tip.offsetHeight > r.height - 8) top = e.clientY - r.top - tip.offsetHeight - 12;
  tip.style.left = left + 'px'; tip.style.top = top + 'px';
}
function tooltipHtml(n) {
  const head = s => `<span class="tt-t">${escAttr(s)}</span>`;
  const body = s => `<span class="tt-b">${escAttr(s)}</span>`;
  if (n.kind === 'pr') {
    const label = (n.repo ? n.repo + '#' : '#') + n.number;
    const bits = [`${n.prState}`];
    if (n.ci) bits.push(`CI ${n.ci}`);
    const when = n.mergedAt ? `merged ${hhmm(n.mergedAt)}` : n.openedAt ? `opened ${hhmm(n.openedAt)}` : '';
    const size = hasSize(n) ? `\n+${n.add.toLocaleString()} / −${n.del.toLocaleString()} lines` : '';
    return head(label) + body((n.title || '') + '\n' + bits.join(' · ') + (when ? '\n' + when : '') + size + (n.base != null ? `\nbased on #${n.base}` : ''));
  }
  if (n.kind === 'intent') {
    return head(turnLabel(n.itemId)) + body(`${n.title}\n${n.status}${n.abandoned ? ' · abandoned?' : ''}\n${n.commits} commits · ${n.edits} edits · +${n.add.toLocaleString()} / −${n.del.toLocaleString()} lines`);
  }
  if (n.kind === 'plan') return head('Plan') + body(`${n.counts.completed} done · ${n.counts.in_progress} in progress · ${n.counts.pending} pending`);
  if (n.kind === 'step') {
    const ms = n.paused
      ? (n.pausedAt != null && n.startedAt ? Math.max(0, n.pausedAt - n.startedAt) : null)
      : (n.startedAt ? Math.max(0, Date.now() - n.startedAt) : null);
    const when = ms != null ? (n.paused ? `paused · ${ageText(ms)}` : `running ${ageText(ms)}`) : (n.paused ? 'paused' : 'running');
    return head(n.paused ? 'paused step' : 'running step') + body(`${n.text}\n${when}`);
  }
  if (n.kind === 'now') {
    const nowLine = n.now && n.now.text ? '\n' + n.now.text : '';
    return head('current turn') + body(`${n.prompt || turnLabel(n.turnId)}${nowLine}\n${turnLabel(n.turnId)}`);
  }
  if (n.kind === 'step-more') return head(`${n.count} more running`) + body('additional in-progress plan steps, folded to keep the graph legible');
  if (n.kind === 'session') return head(n.title) + body(`${n.agent || 'agent'}\n${costText(n.cost)} · ${n.commits} commits\nsince ${n.startedAt ? hhmm(n.startedAt) : '—'}`);
  if (n.kind === 'collapsed') return head(n.label) + body('the oldest PRs in this column, folded to keep the graph legible');
  return head(n.kind);
}

// --------------------------------------------------------------- toolbar
$('#btn-fit').addEventListener('click', fitView);
$('#btn-reset').addEventListener('click', () => {
  dragPos = {}; saveDrag(); layout(); paint(); fitView();
});

function fitView() {
  if (!model || !model.nodes.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of model.nodes) {
    const nn = nodeById.get(n.id); if (!nn) continue;
    x0 = Math.min(x0, nn.x); y0 = Math.min(y0, nn.y);
    x1 = Math.max(x1, nn.x + nn.w); y1 = Math.max(y1, nn.y + nn.h);
  }
  if (!isFinite(x0)) return;
  const padX = 56, topPad = 54, botPad = 44;
  const W = svg.clientWidth, H = svg.clientHeight;
  const k = Math.max(0.15, Math.min(1.4,
    Math.min((W - padX * 2) / (x1 - x0), (H - topPad - botPad) / (y1 - y0))));
  view.k = k;
  view.x = padX - x0 * k;
  // center the content vertically in the plot area below the column headers
  view.y = topPad - y0 * k + Math.max(0, (H - topPad - botPad - (y1 - y0) * k) / 2);
  applyView();
}

// --------------------------------------------------------------- persistence
const dragKey = () => 'nsGraphPos:' + (sessionId || 'default');
function loadDrag() { try { dragPos = JSON.parse(localStorage.getItem(dragKey())) || {}; } catch { dragPos = {}; } }
function saveDrag() { try { localStorage.setItem(dragKey(), JSON.stringify(dragPos)); } catch { /* quota */ } }

// --------------------------------------------------------------- sizing
function sizeSvg() {
  svg.setAttribute('width', main.clientWidth);
  svg.setAttribute('height', main.clientHeight);
}
window.addEventListener('resize', () => { sizeSvg(); });

// --------------------------------------------------------------- data load + live
// Mount the shared session switcher, resolve the tape to open, then load it. The
// picker fetches /sessions once; we reuse that list for the title/agent fallback.
async function load() {
  const picker = await initSessionPicker({
    mount: $('#session-picker'),
    currentId: sessionId,
    onSelect: id => {
      const p = new URLSearchParams(location.search);
      p.set('session', id);
      history.replaceState(null, '', '?' + p.toString());
      loadSession(id);
    },
  });
  sessionsMeta = picker.sessions;
  if (picker.multi) $('#session-title').hidden = true;
  await loadSession(picker.current);
}

// (Re)build the whole view for a session: tear down the old stream + live state,
// re-read that tape's saved drag positions, fetch its events, rebuild the model,
// refit, and re-subscribe. No page reload — switching sessions runs this.
async function loadSession(id) {
  teardownStream();
  sessionId = id;
  // Reset the live-diff state so the new tape paints clean (no glow-everything).
  sigMap = new Map();
  firstPaint = true;
  draggingNode = null;
  pendingRebuild = false;
  loadDrag();

  const q = sessionId ? '?session=' + encodeURIComponent(sessionId) : '';
  let raw = '';
  try { raw = await (await fetch('/events' + q)).text(); } catch { raw = ''; }
  events = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(ev => ev && typeof ev.t === 'number' && typeof ev.type === 'string');

  const state = fold(events);
  const meta = sessionsMeta.find(s => s.id === sessionId) || null;
  const title = state.session.title || (meta && meta.title) || sessionLabel({ id: sessionId || '', cwd: state.session.cwd, title: null }) || 'session';
  document.title = `graph — ${title}`;
  $('#session-title').textContent = title;
  const agent = state.session.agent || (meta && meta.agent);
  const b = $('#agent-badge');
  if (agent) { b.textContent = agent; b.hidden = false; b.className = 'agent-badge agent-' + agent; }
  else { b.hidden = true; }
  $('#board-link').href = '/?session=' + encodeURIComponent(sessionId || '');

  sizeSvg();
  rebuild();
  fitView();
  if (sessionId) openStream(sessionId);
}

// Live pulse via the session SSE, reusing the board's buffered-replay pattern: the
// server replays full history then emits `ready`; we swap the buffered replay in
// wholesale (so a reconnect can't double-count) and thereafter fold new events in.
let es = null;
function teardownStream() { if (es) { es.onerror = null; es.close(); es = null; } }
function openStream(id) {
  teardownStream();
  let buf = [], connReady = false;
  es = new EventSource('/sse?session=' + encodeURIComponent(id));
  es.onmessage = ev => {
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    if (typeof e.t !== 'number' || typeof e.type !== 'string') return;
    if (!connReady) { buf.push(e); return; }
    events.push(e);
    scheduleRebuild();
  };
  es.addEventListener('ready', () => {
    connReady = true;
    events = buf.slice().sort((a, b) => a.t - b.t);
    buf = [];
    rebuild();
  });
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) setTimeout(() => { if (sessionId === id) openStream(id); }, 2000); };
}

load();
