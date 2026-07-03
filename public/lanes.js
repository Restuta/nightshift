// Lane timeline — the visual "shape of the night". An additive, read-only view:
// fetch the whole tape once (GET /events), fold it with the pure reducer for the
// session header, build the lane model (public/lanes-model.js, a second pure pass
// that does NOT touch the reducer), and paint it on a canvas. x = time over the
// whole tape; lanes (rows) = the session on top, then one row per work item.
//
// Perf: the model + per-lane mark arrays are computed ONCE on load. Pan/zoom only
// remaps time→x and redraws (rAF-throttled) — never a refold — so a 29k-event
// tape stays interactive.

import { fold } from './reducer.js';
import { buildModel } from './lanes-model.js';
import { initSessionPicker } from './session-picker.js';

const $ = sel => document.querySelector(sel);
const canvas = $('#lanes-canvas');
const ctx = canvas.getContext('2d');
const tip = $('#lanes-tooltip');
const main = $('#lanes-main');

// Palette — the same hexes as :root in style.css (canvas can't read CSS vars
// cheaply per frame). Flat near-black, Linear-like; motion is data, not decor.
const C = {
  laneA: '#0a0e18', laneB: '#0c101c', line: '#1b2338', lineSoft: '#141b29',
  ink: '#e6eaf2', dim: '#8b93a8', faint: '#5d6781',
  working: 'rgba(210,153,34,.30)', idle: 'rgba(93,103,129,.20)',
  attention: 'rgba(235,110,100,.34)', ended: 'rgba(80,88,110,.14)',
  episode: 'rgba(78,167,252,.34)', episodeEdge: 'rgba(78,167,252,.55)',
  density: '#26314e', commit: '#d29922', prOpen: '#4cb782', merged: '#a371f7',
  closed: '#8b93a8', fail: '#eb6e64', day: 'rgba(120,132,168,.22)',
  gridText: '#5d6781',
};

// Lane geometry.
const LABEL_W = 138;   // left label gutter
const RIGHT_PAD = 16;
const TOP_PAD = 8;
const AXIS_H = 18;     // bottom time axis
const SESSION_H = 56;
const ITEM_H = 24;
const MORE_H = 22;
const LANE_GAP = 2;

let sessionId = new URLSearchParams(location.search).get('session');
let sessionsMeta = [];         // /sessions list (for title/agent fallback)
let events = [];
let model = null;
let lanes = [];        // laid-out rows: {y, h, kind, item, label, marks}
let fullT0 = 0, fullT1 = 0;
let view = { t0: 0, t1: 0 };
let contentH = 0;

// ------------------------------------------------------------------ helpers
const pad = n => String(n).padStart(2, '0');
function clockTime(t) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function dayStamp(t) {
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function tickLabel(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function niceTickMs(span) {
  const opts = [60e3, 5 * 60e3, 10 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3,
    6 * 3600e3, 12 * 3600e3, 24 * 3600e3, 2 * 86400e3, 7 * 86400e3];
  for (const o of opts) if (span / o <= 8) return o;
  return opts[opts.length - 1];
}
function truncate(text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}
// first index in a sorted number array whose value is >= v (binary search)
function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}

const plotW = () => Math.max(1, canvas.clientWidth - LABEL_W - RIGHT_PAD);
const xOf = t => LABEL_W + ((t - view.t0) / (view.t1 - view.t0)) * plotW();
const tAt = px => view.t0 + ((px - LABEL_W) / plotW()) * (view.t1 - view.t0);

// --------------------------------------------------------------- data load
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

// (Re)build the whole timeline for a session: fetch its events, rebuild the lane
// model, and repaint. No SSE here — lanes is a one-shot read-only view — so
// switching sessions just re-runs this. No page reload.
async function loadSession(id) {
  sessionId = id;
  const q = sessionId ? '?session=' + encodeURIComponent(sessionId) : '';
  let text = '';
  try { text = await (await fetch('/events' + q)).text(); } catch { text = ''; }
  events = text.split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(ev => ev && typeof ev.t === 'number' && typeof ev.type === 'string')
    .sort((a, b) => a.t - b.t);

  const state = fold(events);
  const meta = sessionsMeta.find(s => s.id === sessionId) || null;
  const title = (state.session.title) || (meta && meta.title) || sessionId || 'session';
  document.title = `lanes — ${title}`;
  $('#session-title').textContent = title;
  const agent = state.session.agent || (meta && meta.agent);
  const b = $('#agent-badge');
  if (agent) { b.textContent = agent; b.hidden = false; } else { b.hidden = true; }

  if (!events.length) {
    model = null; lanes = [];
    $('#lanes-empty').hidden = false;
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    return;
  }
  $('#lanes-empty').hidden = true;

  model = buildModel(events);
  fullT0 = model.t0;
  fullT1 = Math.max(model.t1, model.t0 + 60000);
  view = { t0: fullT0, t1: fullT1 };
  layout();
  sizeCanvas();
}

// Lay the rows out top-to-bottom and precompute each row's mark list ONCE. Marks
// carry their t (mapped to x only at draw time) and a tooltip descriptor.
function layout() {
  lanes = [];
  let y = TOP_PAD;
  lanes.push({ y, h: SESSION_H, kind: 'session', label: 'session', marks: sessionMarks() });
  y += SESSION_H + LANE_GAP;
  for (const it of model.lanes) {
    lanes.push({ y, h: ITEM_H, kind: 'item', item: it, label: it.title || it.id, marks: itemMarks(it) });
    y += ITEM_H + LANE_GAP;
  }
  if (model.more.count > 0) {
    lanes.push({ y, h: MORE_H, kind: 'more', label: `…${model.more.count} more`, marks: [] });
    y += MORE_H + LANE_GAP;
  }
  contentH = y + AXIS_H + 4;
}

function sessionMarks() {
  return model.attention.map(a => ({ t: a.t, kind: 'attention', label: `! attention — ${a.text}` }));
}
function itemMarks(it) {
  const marks = [];
  for (const c of it.commitMarks) {
    const d = (c.add || c.del) ? `  +${c.add}/-${c.del}` : '';
    marks.push({ t: c.t, kind: 'commit', label: `commit ${(c.sha || '').slice(0, 7)}  ${c.message || ''}${d}` });
  }
  for (const p of it.prMarks) {
    const verb = p.kind === 'merged' ? 'PR merged' : p.kind === 'closed' ? 'PR closed' : 'PR opened';
    marks.push({ t: p.t, kind: 'pr:' + p.kind, label: `${verb} #${p.number}${p.title ? '  ' + p.title : ''}` });
  }
  for (const c of it.ciMarks) {
    if (c.status !== 'fail') continue; // only CI failures get a mark (the loud one)
    marks.push({ t: c.t, kind: 'ci:fail', label: `CI failed  #${c.pr}` });
  }
  return marks;
}

// --------------------------------------------------------------- canvas fit
function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = main.clientWidth;
  const cssH = Math.max(main.clientHeight, contentH);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scheduleDraw();
}

// --------------------------------------------------------------- draw loop
let rafPending = false;
function scheduleDraw() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; draw(); });
}

function draw() {
  if (!model) return;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  const x0 = LABEL_W, x1 = W - RIGHT_PAD;

  // lane backgrounds (alternating hairline rows)
  for (let i = 0; i < lanes.length; i++) {
    const ln = lanes[i];
    ctx.fillStyle = i % 2 ? C.laneB : C.laneA;
    ctx.fillRect(0, ln.y, W, ln.h);
  }

  drawGrid(x0, x1, H);
  for (const ln of lanes) {
    if (ln.kind === 'session') drawSessionLane(ln, x0, x1);
    else if (ln.kind === 'item') drawItemLane(ln, x0, x1);
    else drawMoreLane(ln, x0, x1);
    drawLabel(ln);
  }
  drawAxis(x0, x1);

  // label gutter divider
  ctx.fillStyle = C.line;
  ctx.fillRect(LABEL_W - 0.5, 0, 1, contentH - AXIS_H);
}

function drawGrid(x0, x1, H) {
  const span = view.t1 - view.t0;
  const iv = niceTickMs(span);
  ctx.font = '9px ' + monoFont();
  ctx.textBaseline = 'alphabetic';
  const gridBottom = contentH - AXIS_H;
  for (let tk = Math.ceil(view.t0 / iv) * iv; tk <= view.t1; tk += iv) {
    const xx = xOf(tk);
    if (xx < x0 || xx > x1) continue;
    ctx.fillStyle = C.lineSoft;
    ctx.fillRect(Math.round(xx), TOP_PAD, 1, gridBottom - TOP_PAD);
  }
  // day boundaries — brighter, labeled (only present when the span > 24h)
  for (const d of model.dayLines) {
    const xx = xOf(d);
    if (xx < x0 || xx > x1) continue;
    ctx.fillStyle = C.day;
    ctx.fillRect(Math.round(xx), TOP_PAD, 1, gridBottom - TOP_PAD);
    ctx.fillStyle = C.dim;
    ctx.fillText(dayStamp(d), Math.round(xx) + 3, TOP_PAD + 9);
  }
}

function drawSessionLane(ln, x0, x1) {
  const phaseTop = ln.y + 4, phaseH = 9;
  // phase strips
  for (const seg of model.phases) {
    const a = Math.max(xOf(seg.start), x0), b = Math.min(xOf(seg.end), x1);
    if (b <= a) continue;
    ctx.fillStyle = seg.phase === 'working' ? C.working
      : seg.phase === 'idle' ? C.idle
      : seg.phase === 'attention' ? C.attention : C.ended;
    ctx.fillRect(a, phaseTop, b - a, phaseH);
  }
  // say/tool density sparkline (faint), only over the visible window
  const dBase = ln.y + ln.h - 5, dTop = phaseTop + phaseH + 3;
  const maxH = dBase - dTop;
  const BW = 3;
  const cols = Math.max(1, Math.floor((x1 - x0) / BW));
  const counts = new Array(cols).fill(0);
  const dens = model.density;
  let peak = 1;
  for (let k = lowerBound(dens, view.t0); k < dens.length && dens[k] <= view.t1; k++) {
    const c = Math.min(cols - 1, Math.max(0, Math.floor((xOf(dens[k]) - x0) / BW)));
    counts[c]++; if (counts[c] > peak) peak = counts[c];
  }
  ctx.fillStyle = C.density;
  for (let c = 0; c < cols; c++) {
    if (!counts[c]) continue;
    const h = Math.max(1, (Math.sqrt(counts[c]) / Math.sqrt(peak)) * maxH);
    ctx.fillRect(x0 + c * BW, dBase - h, BW - 1, h);
  }
  // attention marks — loud red ticks with a "!" cap
  for (const m of ln.marks) {
    const xx = xOf(m.t);
    if (xx < x0 || xx > x1) continue;
    ctx.fillStyle = C.fail;
    ctx.fillRect(Math.round(xx) - 0.5, ln.y + 2, 1.4, ln.h - 4);
    ctx.font = 'bold 10px ' + monoFont();
    ctx.textBaseline = 'top';
    ctx.fillText('!', Math.round(xx) - 2, ln.y - 1);
  }
}

function episodeBar(ln, seg, x0, x1, fill, edge) {
  const a = Math.max(xOf(seg.start), x0), b = Math.min(xOf(seg.end), x1);
  if (b < x0 || a > x1) return;
  const left = Math.max(a, x0), w = Math.max(2, b - left);
  const top = ln.y + 6, h = ln.h - 12;
  ctx.fillStyle = fill;
  ctx.fillRect(left, top, w, h);
  if (edge) { ctx.fillStyle = edge; ctx.fillRect(left, top, 1, h); }
}

function drawItemLane(ln, x0, x1) {
  for (const seg of ln.item.episodes) episodeBar(ln, seg, x0, x1, C.episode, C.episodeEdge);
  const cy = ln.y + ln.h / 2;
  // commit diamonds
  for (const c of ln.item.commitMarks) {
    const xx = xOf(c.t);
    if (xx < x0 - 4 || xx > x1 + 4) continue;
    diamond(xx, cy, 3.4, C.commit);
  }
  // PR marks: open = ring, merged = filled, closed = hollow dim
  for (const p of ln.item.prMarks) {
    const xx = xOf(p.t);
    if (xx < x0 - 5 || xx > x1 + 5) continue;
    if (p.kind === 'merged') circle(xx, cy, 3.6, C.merged, true);
    else if (p.kind === 'closed') circle(xx, cy, 3.6, C.closed, false);
    else circle(xx, cy, 3.6, C.prOpen, false);
  }
  // CI failures: red X
  for (const c of ln.item.ciMarks) {
    if (c.status !== 'fail') continue;
    const xx = xOf(c.t);
    if (xx < x0 - 5 || xx > x1 + 5) continue;
    cross(xx, cy, 3.4, C.fail);
  }
}

function drawMoreLane(ln, x0, x1) {
  for (const seg of model.more.episodes) episodeBar(ln, seg, x0, x1, 'rgba(93,103,129,.22)', null);
  const cy = ln.y + ln.h / 2;
  for (const c of model.more.commitMarks) {
    const xx = xOf(c.t);
    if (xx < x0 - 4 || xx > x1 + 4) continue;
    diamond(xx, cy, 2.6, 'rgba(210,153,34,.55)');
  }
}

function drawLabel(ln) {
  ctx.textBaseline = 'middle';
  ctx.font = (ln.kind === 'session' ? '11px ' : '10px ') + monoFont();
  ctx.fillStyle = ln.kind === 'more' ? C.faint : ln.kind === 'session' ? C.dim : C.ink;
  const text = truncate(ln.label, LABEL_W - 16);
  ctx.fillText(text, 10, ln.y + ln.h / 2);
}

function drawAxis(x0, x1) {
  const y = contentH - AXIS_H;
  ctx.fillStyle = C.line;
  ctx.fillRect(0, y, x1, 1);
  const span = view.t1 - view.t0;
  const iv = niceTickMs(span);
  ctx.font = '9px ' + monoFont();
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.gridText;
  for (let tk = Math.ceil(view.t0 / iv) * iv; tk <= view.t1; tk += iv) {
    const xx = xOf(tk);
    if (xx < x0 || xx > x1) continue;
    ctx.fillText(tickLabel(tk - fullT0), Math.round(xx) + 3, y + 12);
  }
  // absolute wall-clock of the left edge, for orientation (T+ ticks are relative)
  ctx.fillStyle = C.faint;
  ctx.fillText(clockTime(view.t0), x0 + 2, y - 4);
}

function monoFont() { return "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace"; }

function diamond(x, y, r, fill) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
  ctx.closePath(); ctx.fill();
}
function circle(x, y, r, color, filled) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  if (filled) { ctx.fillStyle = color; ctx.fill(); }
  else { ctx.lineWidth = 1.4; ctx.strokeStyle = color; ctx.stroke(); }
}
function cross(x, y, r, color) {
  ctx.strokeStyle = color; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
  ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
  ctx.stroke();
}

// ---------------------------------------------------------- interactions
function laneAtY(py) {
  for (const ln of lanes) if (py >= ln.y && py <= ln.y + ln.h) return ln;
  return null;
}
// nearest mark on a lane within a pixel threshold of px
function markNear(ln, px) {
  let best = null, bestDx = 8;
  for (const m of ln.marks) {
    const dx = Math.abs(xOf(m.t) - px);
    if (dx < bestDx) { bestDx = dx; best = m; }
  }
  return best;
}

function localPos(e) {
  const r = canvas.getBoundingClientRect();
  return { px: e.clientX - r.left, py: e.clientY - r.top };
}

function showTip(e, ln, mark) {
  const { px } = localPos(e);
  const t = mark ? mark.t : tAt(px);
  const head = clockTime(t);
  let body;
  if (mark) body = mark.label;
  else if (ln && ln.kind === 'item') body = ln.item.title || ln.item.id;
  else if (ln && ln.kind === 'session') body = 'session';
  else if (ln && ln.kind === 'more') body = model.more.count + ' collapsed items';
  else body = '';
  tip.innerHTML = `<span class="tt-t">${head}</span>${body ? '<span class="tt-b">' + escapeHtml(body) + '</span>' : ''}`;
  tip.hidden = false;
  // position, keeping the box on-screen
  const r = main.getBoundingClientRect();
  let left = e.clientX - r.left + 12;
  let top = e.clientY - r.top + 14;
  if (left + tip.offsetWidth > r.width - 8) left = r.width - tip.offsetWidth - 8;
  if (top + tip.offsetHeight > r.height - 8) top = e.clientY - r.top - tip.offsetHeight - 10;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// wheel = horizontal zoom centered on the cursor; shift/deltaX = pan.
canvas.addEventListener('wheel', e => {
  if (!model) return;
  e.preventDefault();
  const { px } = localPos(e);
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    const span = view.t1 - view.t0;
    const dt = ((e.deltaX || e.deltaY) / plotW()) * span;
    panBy(dt);
  } else {
    const anchor = tAt(Math.min(Math.max(px, LABEL_W), canvas.clientWidth - RIGHT_PAD));
    zoomAround(anchor, e.deltaY < 0 ? 1 / 1.15 : 1.15);
  }
  scheduleDraw();
}, { passive: false });

function zoomAround(anchor, factor) {
  const span = view.t1 - view.t0;
  const full = fullT1 - fullT0;
  let newSpan = span * factor;
  newSpan = Math.max(5000, Math.min(newSpan, full));
  const frac = (anchor - view.t0) / span;
  view.t0 = anchor - frac * newSpan;
  view.t1 = view.t0 + newSpan;
  clampView();
}
function panBy(dt) {
  view.t0 += dt; view.t1 += dt; clampView();
}
function clampView() {
  const span = Math.min(view.t1 - view.t0, fullT1 - fullT0);
  if (view.t0 < fullT0) { view.t0 = fullT0; view.t1 = fullT0 + span; }
  if (view.t1 > fullT1) { view.t1 = fullT1; view.t0 = fullT1 - span; }
  if (view.t0 < fullT0) view.t0 = fullT0;
}

// drag = pan; a click that didn't drag navigates into replay at that time.
let dragging = false, dragX = 0, dragMoved = 0;
canvas.addEventListener('pointerdown', e => {
  dragging = true; dragMoved = 0; dragX = e.clientX;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
  if (dragging) {
    const dx = e.clientX - dragX;
    dragX = e.clientX;
    dragMoved += Math.abs(dx);
    const span = view.t1 - view.t0;
    panBy(-(dx / plotW()) * span);
    scheduleDraw();
    tip.hidden = true;
    return;
  }
  const { px, py } = localPos(e);
  const ln = laneAtY(py);
  if (!ln || px < LABEL_W) { tip.hidden = true; canvas.style.cursor = 'default'; return; }
  const mark = markNear(ln, px);
  canvas.style.cursor = mark ? 'pointer' : 'crosshair';
  showTip(e, ln, mark);
});
canvas.addEventListener('pointerup', e => {
  const wasDrag = dragMoved > 4;
  dragging = false;
  if (wasDrag) return;
  const { px, py } = localPos(e);
  if (px < LABEL_W) return;
  const ln = laneAtY(py);
  const mark = ln ? markNear(ln, px) : null;
  const t = Math.round(mark ? mark.t : tAt(px));
  replayAt(t);
});
canvas.addEventListener('pointerleave', () => { if (!dragging) tip.hidden = true; });

// The ?t= replay deep link is owned by a sibling branch (p2a); we only LINK to
// it. Navigating the board to this exact millisecond is that page's job.
function replayAt(t) {
  const q = new URLSearchParams();
  if (sessionId) q.set('session', sessionId);
  q.set('t', String(t));
  location.href = '/?' + q.toString();
}

window.addEventListener('resize', () => { if (model) sizeCanvas(); });

load();
