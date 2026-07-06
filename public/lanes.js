// Lane timeline — the visual "shape of the night". An additive, read-only view:
// fetch the whole tape once (GET /events), fold it with the pure reducer for the
// session header, build the lane model (public/lanes-model.js, a second pure pass
// that does NOT touch the reducer), and paint it on a canvas. x = time over the
// whole tape; lanes (rows) = the session on top, then one row per work item.
//
// The x-axis goes through ONE mapping — the pure scale (public/lanes-scale.js).
// By default it COMPRESSES idle: active spans keep real proportions, long silences
// collapse to a fixed sliver, so the ~11 real hours of a 64h session fill the axis.
// "compress idle" off rebuilds the same scale with zero gaps → the old linear axis,
// pixel-for-pixel. Every consumer (paint, hit-test, tooltips, deep-links, pan/zoom)
// works in the scale's unit space, so there's exactly one code path. Chapter bands
// (from the digest's prompt episodes) tint the background so the timeline answers
// "which ask produced this burst".
//
// Perf: the model + digest + per-lane mark arrays are computed ONCE on load. Pan/
// zoom only remaps unit→x and redraws (rAF-throttled) — never a refold — so a
// 29k-event tape stays interactive. Toggling the axis rebuilds only the scale.

import { fold } from './reducer.js';
import { buildModel } from './lanes-model.js';
import { buildDigest } from './digest.js';
import { buildScale } from './lanes-scale.js';
import { initSessionPicker } from './session-picker.js';

const $ = sel => document.querySelector(sel);
const canvas = $('#lanes-canvas');
const ctx = canvas.getContext('2d');
const tip = $('#lanes-tooltip');
const main = $('#lanes-main');
const compressBtn = $('#compress-toggle');

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
  // Chapter bands — a very faint indigo wash, alternating per episode so adjacent
  // asks read apart without shouting. Hairline edge + quiet prompt label on top.
  bandA: 'rgba(94,106,210,.055)', bandB: 'rgba(94,106,210,.11)',
  bandEdge: 'rgba(94,106,210,.28)', bandLabel: '#7d88a6',
  // Collapsed idle slot — dimmer than a lane, with a ⏸ label when it's wide enough.
  gapFill: 'rgba(6,9,17,.55)', gapEdge: 'rgba(93,103,129,.16)', gapText: '#4b5570',
};

// Lane geometry.
const LABEL_W = 138;   // left label gutter
const RIGHT_PAD = 16;
const TOP_PAD = 8;
const CHAPTER_H = 15;  // top strip reserved for chapter-band prompt labels
const AXIS_H = 18;     // bottom time axis
const SESSION_H = 56;
const ITEM_H = 24;
const MORE_H = 22;
const LANE_GAP = 2;

const params = new URLSearchParams(location.search);
let sessionId = params.get('session');
// Axis mode lives in the URL so a shared link preserves it (no localStorage).
// Compression is ON by default; &linear=1 opts into the old linear axis.
let compress = params.get('linear') !== '1';

let sessionsMeta = [];         // /sessions list (for title/agent fallback)
let events = [];
let model = null;
let digest = null;
let scale = null;              // pure time↔unit mapping (see lanes-scale.js)
let chapters = [];             // episode chapters that get a background band
let lanes = [];        // laid-out rows: {y, h, kind, item, label, marks}
let fullT0 = 0, fullT1 = 0;    // axis TIME bounds (same in both modes)
let fullU1 = 0;                // scale.compressedSpan — the axis extent in units
let bandTop = TOP_PAD;         // y where lane rows + bands start (below the label strip)
// The pan/zoom window lives in the scale's UNIT space, so both modes share one
// path: u0/u1 are positions from scale.x(), not raw timestamps.
let view = { u0: 0, u1: 0 };
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
const uSpan = () => Math.max(1, view.u1 - view.u0);
// time → px and px → time, BOTH through the scale. In linear mode the scale is an
// identity shift, so these collapse to the original linear mapping pixel-for-pixel.
const xAtU = u => LABEL_W + ((u - view.u0) / uSpan()) * plotW();
const uAtX = px => view.u0 + ((px - LABEL_W) / plotW()) * uSpan();
const xOf = t => xAtU(scale.x(t));
const tAt = px => scale.t(uAtX(px));
// Visible TIME window — used for time-labeled grid ticks and to bound the density
// scan. Derived from the unit window so it tracks compressed gaps correctly.
const visT0 = () => scale.t(view.u0);
const visT1 = () => scale.t(view.u1);

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
  digest = buildDigest(events);
  fullT0 = model.t0;
  fullT1 = Math.max(model.t1, model.t0 + 60000);
  // Episode chapters get a background band; beats (conversation, no work) don't.
  chapters = (digest.chapters || []).filter(c => c.kind === 'episode' && c.endT > c.startT);
  buildScaleForMode();          // sets scale + fullU1
  view = { u0: 0, u1: fullU1 }; // full-fit
  layout();
  sizeCanvas();
}

// Build the time↔unit scale for the current mode. Compressed mode feeds the digest
// gaps (plus any tape-edge idle the digest doesn't span — leading pre-work and the
// trailing heartbeat tail) so those collapse. Linear mode feeds ZERO gaps, so the
// scale is an identity shift and the axis is exactly today's linear one.
function buildScaleForMode() {
  let gaps = [];
  if (compress && digest) {
    gaps = digest.gaps.slice();
    // The digest spans only producer events; the axis spans the whole tape. Fold
    // the leading/trailing idle into gaps too, or they'd waste linear pixels.
    if (digest.startT != null && digest.startT > fullT0) gaps.push({ fromT: fullT0, toT: digest.startT });
    if (digest.endT != null && digest.endT < fullT1) gaps.push({ fromT: digest.endT, toT: fullT1 });
  }
  scale = buildScale(gaps, fullT0, fullT1);
  fullU1 = Math.max(1, scale.compressedSpan);
}

// Lay the rows out top-to-bottom and precompute each row's mark list ONCE. Marks
// carry their t (mapped to x only at draw time) and a tooltip descriptor.
function layout() {
  lanes = [];
  // Reserve a thin strip at the top for chapter-band prompt labels (only when
  // there are bands to label), so labels never collide with the session lane.
  bandTop = TOP_PAD + (chapters.length ? CHAPTER_H : 0);
  let y = bandTop;
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

  // BEHIND lane content: chapter bands (which ask), then collapsed-gap slots.
  drawChapterBands(x0, x1);
  drawGapSlots(x0, x1);
  drawGrid(x0, x1);
  for (const ln of lanes) {
    if (ln.kind === 'session') drawSessionLane(ln, x0, x1);
    else if (ln.kind === 'item') drawItemLane(ln, x0, x1);
    else drawMoreLane(ln, x0, x1);
    drawLabel(ln);
  }
  // ON TOP: the quiet prompt labels + ⏸ gap labels, so nothing overwrites them.
  drawChapterLabels(x0, x1);
  drawGapLabels(x0, x1);
  drawAxis(x0, x1);

  // label gutter divider
  ctx.fillStyle = C.line;
  ctx.fillRect(LABEL_W - 0.5, 0, 1, contentH - AXIS_H);
}

// Chapter bands — a faint alternating wash spanning each work episode's real time,
// mapped through the scale so they compress with the axis. Beats get no band.
function drawChapterBands(x0, x1) {
  const top = bandTop, bottom = contentH - AXIS_H;
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const a = Math.max(xOf(ch.startT), x0), b = Math.min(xOf(ch.endT), x1);
    if (b <= a) continue;
    ctx.fillStyle = i % 2 ? C.bandB : C.bandA;
    ctx.fillRect(a, top, b - a, bottom - top);
    ctx.fillStyle = C.bandEdge; // hairline at the band start (and end) up into the label strip
    ctx.fillRect(Math.round(a), TOP_PAD, 1, bottom - TOP_PAD);
    ctx.fillRect(Math.round(b), TOP_PAD, 1, bottom - TOP_PAD);
  }
}

// The user's prompt, quietly, at the top of each band — "which ask produced this".
function drawChapterLabels(x0, x1) {
  if (!chapters.length) return;
  ctx.textBaseline = 'alphabetic';
  ctx.font = '10px ' + sansFont();
  for (const ch of chapters) {
    const a = Math.max(xOf(ch.startT), x0), b = Math.min(xOf(ch.endT), x1);
    const w = b - a;
    if (w < 34) continue; // too narrow to label legibly
    const prompt = (ch.title || ch.label || '').replace(/\s+/g, ' ').trim();
    if (!prompt) continue;
    ctx.fillStyle = C.bandLabel;
    ctx.fillText(truncate(prompt, w - 8), a + 4, TOP_PAD + 11);
  }
}

// Collapsed idle: a dim slot where a long silence used to sprawl. Only present in
// compressed mode (linear mode has no gaps in the scale, so this loop is empty).
function drawGapSlots(x0, x1) {
  const top = bandTop, bottom = contentH - AXIS_H;
  for (const g of scale.gaps) {
    const a = Math.max(xAtU(g.u0), x0), b = Math.min(xAtU(g.u1), x1);
    if (b <= a) continue;
    ctx.fillStyle = C.gapFill;
    ctx.fillRect(a, top, b - a, bottom - top);
    ctx.fillStyle = C.gapEdge;
    ctx.fillRect(Math.round(a), top, 1, bottom - top);
    ctx.fillRect(Math.round(b), top, 1, bottom - top);
  }
}

// A quiet "pause" marker in each collapsed gap: two hairline bars (drawn, not an
// emoji — a color ⏸ would clash with the flat Linear language and not render in
// every font) plus "9.1h" when the slot is wide enough; bars-only when tight;
// nothing when it's a sliver. Sits in the session lane so it reads as a pause.
function drawGapLabels(x0, x1) {
  const cy = bandTop + Math.min(SESSION_H, 40) / 2 + 4;
  ctx.textBaseline = 'middle';
  ctx.font = '9px ' + monoFont();
  for (const g of scale.gaps) {
    const a = Math.max(xAtU(g.u0), x0), b = Math.min(xAtU(g.u1), x1);
    const w = b - a;
    if (w < 11) continue;
    const dur = w >= 34 ? gapDur(g.ms) : '';
    const durW = dur ? ctx.measureText(dur).width : 0;
    const glyphW = 5;                          // two 1.4px bars, ~2px apart
    const totalW = glyphW + (dur ? 3 + durW : 0);
    let cx = (a + b) / 2 - totalW / 2;
    ctx.fillStyle = C.gapText;
    ctx.fillRect(Math.round(cx), cy - 4, 1.4, 8);
    ctx.fillRect(Math.round(cx) + 3.6, cy - 4, 1.4, 8);
    if (dur) {
      ctx.textAlign = 'left';
      ctx.fillText(dur, cx + glyphW + 3, cy);
    }
  }
  ctx.textAlign = 'left';
}

// Compact idle duration for the ⏸ label: "9.1h", "44m".
function gapDur(ms) {
  const m = ms / 60000;
  if (m < 90) return Math.round(m) + 'm';
  return (m / 60).toFixed(1) + 'h';
}

function drawGrid(x0, x1) {
  // Interval is chosen from the visible UNIT span (active-dominated), so ticks stay
  // dense enough over the compressed axis; they're still stepped at round wall-clock
  // times and skipped inside collapsed gaps so they never pile up in a sliver.
  const iv = niceTickMs(uSpan());
  ctx.font = '9px ' + monoFont();
  ctx.textBaseline = 'alphabetic';
  const gridBottom = contentH - AXIS_H;
  const t0 = visT0(), t1 = visT1();
  for (let tk = Math.ceil(t0 / iv) * iv; tk <= t1; tk += iv) {
    if (scale.gapAt(tk)) continue;
    const xx = xOf(tk);
    if (xx < x0 || xx > x1) continue;
    ctx.fillStyle = C.lineSoft;
    ctx.fillRect(Math.round(xx), TOP_PAD, 1, gridBottom - TOP_PAD);
  }
  // day boundaries — brighter vertical lines (only present when the span > 24h).
  // Labeled down on the axis (drawAxis) so they never collide with the chapter
  // prompt labels that now live in the top strip.
  for (const d of model.dayLines) {
    const xx = xOf(d);
    if (xx < x0 || xx > x1) continue;
    ctx.fillStyle = C.day;
    ctx.fillRect(Math.round(xx), TOP_PAD, 1, gridBottom - TOP_PAD);
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
  for (let k = lowerBound(dens, visT0()); k < dens.length && dens[k] <= visT1(); k++) {
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
  const iv = niceTickMs(uSpan());
  ctx.font = '9px ' + monoFont();
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.gridText;
  const t0 = visT0(), t1 = visT1();
  for (let tk = Math.ceil(t0 / iv) * iv; tk <= t1; tk += iv) {
    if (scale.gapAt(tk)) continue; // no elapsed-time label inside a collapsed gap
    const xx = xOf(tk);
    if (xx < x0 || xx > x1) continue;
    ctx.fillText(tickLabel(tk - fullT0), Math.round(xx) + 3, y + 12);
  }
  // day boundaries get their wall-clock date here (moved off the top strip).
  ctx.fillStyle = C.dim;
  for (const d of model.dayLines) {
    const xx = xOf(d);
    if (xx < x0 || xx > x1) continue;
    ctx.fillText(dayStamp(d), Math.round(xx) + 3, y + 12);
  }
  // absolute wall-clock of the left edge, for orientation (T+ ticks are relative)
  ctx.fillStyle = C.faint;
  ctx.fillText(clockTime(visT0()), x0 + 2, y - 4);
}

function monoFont() { return "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace"; }
function sansFont() { return "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"; }

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
  // Over a collapsed idle slot, name the pause (and its real length) so the reader
  // sees WHY the axis jumps here. The head time stays exact (tAt inverts the scale).
  const gap = mark ? null : scale.gapAt(t);
  let body;
  if (mark) body = mark.label;
  else if (gap) body = 'idle ' + gapDur(gap.ms);
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

// wheel = horizontal zoom centered on the cursor; shift/deltaX = pan. All in the
// scale's UNIT space, so a gap never eats the pan/zoom the way it eats linear time.
canvas.addEventListener('wheel', e => {
  if (!model) return;
  e.preventDefault();
  const { px } = localPos(e);
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    const du = ((e.deltaX || e.deltaY) / plotW()) * uSpan();
    panBy(du);
  } else {
    const anchor = uAtX(Math.min(Math.max(px, LABEL_W), canvas.clientWidth - RIGHT_PAD));
    zoomAround(anchor, e.deltaY < 0 ? 1 / 1.15 : 1.15);
  }
  scheduleDraw();
}, { passive: false });

function zoomAround(anchorU, factor) {
  const span = uSpan();
  let newSpan = span * factor;
  newSpan = Math.max(5000, Math.min(newSpan, fullU1));
  const frac = (anchorU - view.u0) / span;
  view.u0 = anchorU - frac * newSpan;
  view.u1 = view.u0 + newSpan;
  clampView();
}
function panBy(du) {
  view.u0 += du; view.u1 += du; clampView();
}
function clampView() {
  const span = Math.min(view.u1 - view.u0, fullU1);
  if (view.u0 < 0) { view.u0 = 0; view.u1 = span; }
  if (view.u1 > fullU1) { view.u1 = fullU1; view.u0 = fullU1 - span; }
  if (view.u0 < 0) view.u0 = 0;
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
    panBy(-(dx / plotW()) * uSpan());
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

// ------------------------------------------------------------ axis toggle
// Flip between the compressed and linear axis. Rebuild only the scale (cheap) and
// re-fit the window so the same wall-clock center + zoom level carries across, then
// mirror the mode into the URL so a shared link preserves it.
function setCompress(on) {
  compress = on;
  const p = new URLSearchParams(location.search);
  if (compress) p.delete('linear'); else p.set('linear', '1');
  history.replaceState(null, '', '?' + p.toString());
  syncToggle();
  if (!model) return;
  // Preserve center time + zoom fraction across the remap.
  const centerT = scale.t((view.u0 + view.u1) / 2);
  const frac = uSpan() / fullU1;
  buildScaleForMode();
  const newSpan = Math.max(5000, Math.min(frac * fullU1, fullU1));
  const centerU = scale.x(centerT);
  view = { u0: centerU - newSpan / 2, u1: centerU + newSpan / 2 };
  clampView();
  scheduleDraw();
}
function syncToggle() {
  if (!compressBtn) return;
  compressBtn.classList.toggle('on', compress);
  compressBtn.setAttribute('aria-pressed', String(compress));
  compressBtn.title = compress
    ? 'idle gaps compressed — click for the linear axis'
    : 'linear axis — click to compress idle gaps';
}
if (compressBtn) {
  syncToggle();
  compressBtn.addEventListener('click', () => setCompress(!compress));
}

load();
