// nightshift engine: SSE in, pure fold to state, animated render out.
// Two clocks exist — wall time (live) and virtual time `vt` (replay). Every
// render path goes through renderAll(); animation only happens on forward,
// incremental application of events, never on rebuilds (scrub/refresh).

import { initialState, reduce, fold, activeItemId, hotFiles, prList, liveness, STATUSES } from './reducer.js';
import { initSessionPicker } from './session-picker.js';
import { turnLabel } from './turn-id.js';

const $ = sel => document.querySelector(sel);

// Mirror of the reducer's per-gap accrual cap, so the live in-flight timer on the
// active card can't tick past one capped gap while a recorder is fresh.
const ACTIVE_GAP_CAP = 30 * 60e3;

const log = [];
let state = initialState();
let cursor = 0;        // events from `log` applied into `state`
let ready = false;
let live = true;
let playing = false;
let speed = 10;
let vt = 0;            // virtual time when not live

// ---------------------------------------------------------------- helpers

const esc = s => String(s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const pad = n => String(n).padStart(2, '0');

function clockTime(t) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// HH:MM — for the honest "data ends HH:MM" on a stale badge.
function hhmm(t) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Is the live view showing a session whose recorder has gone stale? Pure derived
// honesty (see reducer.liveness); only meaningful while live.
function staleNow() {
  return live && liveness(state, vtNow()).state === 'stale';
}

function durText(ms) {
  if (ms < 0 || !isFinite(ms)) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function ageText(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const vtNow = () => (live ? Date.now() : vt);

function domain() {
  const t0 = log.length ? log[0].t : Date.now() - 60e3;
  let t1 = log.length ? log[log.length - 1].t : Date.now();
  if (live) t1 = Math.max(t1, Date.now());
  return [t0, Math.max(t1, t0 + 60e3)];
}

function upperBound(t) {
  let n = 0;
  while (n < log.length && log[n].t <= t) n++;
  return n;
}

// Insert a late-arriving event into the sorted log at its position by t (binary
// search for the first entry with a strictly greater t, so equal t keeps arrival
// order). Used only on the rare out-of-order live arrival.
function insertByT(arr, ev) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= ev.t) lo = mid + 1; else hi = mid;
  }
  arr.splice(lo, 0, ev);
}

// number ticker — tweens displayed value toward target
function setNum(el, val, animate, fmt = n => n.toLocaleString('en-US')) {
  const from = el._v ?? 0;
  el._v = val;
  if (!animate || from === val) {
    cancelAnimationFrame(el._raf);
    el.textContent = fmt(val);
    return;
  }
  cancelAnimationFrame(el._raf);
  const t0 = performance.now(), dur = 550;
  const step = now => {
    const p = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(Math.round(from + (val - from) * e));
    if (p < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

// -------------------------------------------------------------- transport

let es = null;
let sessionId = null;
let firstConnect = true;
let lastBeat = 0;       // last time the stream showed life (any message or ping)
let retry = 0;          // backoff counter for explicit reconnects

// Switch to a session: wipe the view, then open the stream. State reset lives
// here so a bare reconnect (openStream) can re-sync without clearing the board.
function connect(id) {
  sessionId = id;
  const lanesLink = $('#lanes-link');
  if (lanesLink) lanesLink.href = '/lanes?session=' + encodeURIComponent(id);
  const graphLink = $('#graph-link');
  if (graphLink) graphLink.href = '/graph?session=' + encodeURIComponent(id);
  log.length = 0;
  state = initialState();
  cursor = 0;
  ready = false;
  live = true; playing = false;
  for (const el of cardEls.values()) el.remove();
  cardEls.clear();
  feedEl.innerHTML = '';
  openStream(id);
}

// Open (or re-open) the SSE stream for the current session. The server replays
// full history then emits `ready`, so every connection is self-contained: we
// buffer this connection's replay and swap it in wholesale on `ready`. That
// makes reconnects idempotent — a native auto-reconnect that re-streams history
// can't double-count, and a forced reconnect re-syncs from a clean slate.
function openStream(id) {
  if (es) { es.onerror = null; es.close(); }
  let buf = [];           // this connection's replay, applied atomically on ready
  let connReady = false;
  lastBeat = Date.now();
  es = new EventSource('/sse?session=' + encodeURIComponent(id));

  es.onopen = () => { retry = 0; lastBeat = Date.now(); };

  es.addEventListener('ping', () => { lastBeat = Date.now(); });

  es.onmessage = e => {
    lastBeat = Date.now();
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (typeof ev.t !== 'number' || typeof ev.type !== 'string') return;
    if (!connReady) { buf.push(ev); return; }  // history replay → buffer
    // Keep `log` ordered by t. The common case is the newest event (t >= last),
    // which just appends and folds incrementally as before. A late arrival (an
    // OLDER t — a backfill, or an n154-style re-append seam) is inserted at its
    // sorted position, and a `retract` is meta (it applies at ALL replay times),
    // so both take the rare correctness-over-speed path: re-fold from scratch.
    const lastT = log.length ? log[log.length - 1].t : -Infinity;
    const older = ev.t < lastT;
    const meta = ev.type === 'retract';
    if (older) insertByT(log, ev); else log.push(ev);
    if (!ready) return;
    if (!live) {
      // A late/meta event can change the already-replayed state; re-fold at vt.
      if (older || meta) { state = fold(log, vt); cursor = upperBound(vt); renderAll(false); }
      else drawTimeline(); // tape just grows under the paused/replaying view
      return;
    }
    if (older || meta) {
      state = fold(log);
      cursor = log.length;
      vt = log.length ? log[log.length - 1].t : Date.now();
      renderAll(false);
    } else {
      reduce(state, ev);
      cursor++;
      renderAll(true, [ev]);
    }
  };

  es.addEventListener('ready', () => {
    // Authoritative full history for this connection. Replace the log wholesale
    // so a reconnect heals instead of appending duplicates.
    connReady = true;
    const wasLive = live;
    log.length = 0;
    for (const ev of buf) log.push(ev);
    buf = [];
    // Consume the log time-ordered even if it was recorded out of order (Array
    // .sort is stable, so equal t keeps file order). fold() has a belt-and-
    // suspenders guard too, but sorting here is what makes scrub == live.
    log.sort((a, b) => a.t - b.t);
    ready = true;
    lastBeat = Date.now();
    renderStatus();
    if (wasLive) {
      state = fold(log);
      cursor = log.length;
      vt = log.length ? log[log.length - 1].t : Date.now();
    } else {
      state = fold(log, vt);  // a reconnect mid-replay keeps your scrub position
      cursor = upperBound(vt);
    }
    renderAll(false);
    // deep link into the tape: ?at=0.45 (fraction) or ?at=620 (seconds from
    // start), or ?t=<epoch-ms> (absolute — how the Shift Report links a moment).
    // Only on the initial load — switching sessions starts live.
    if (firstConnect) {
      firstConnect = false;
      const params = new URLSearchParams(location.search);
      const t = params.get('t');
      const at = params.get('at');
      if (t != null && log.length) {
        // Absolute timestamp from a /report deep link. Enter replay scrubbed to
        // that moment when it falls within the tape; scrubTo clamps to the domain.
        const tMs = parseInt(t, 10);
        const t0 = log[0].t, t1 = log[log.length - 1].t;
        if (!Number.isNaN(tMs) && tMs >= t0 && tMs <= t1) scrubTo(tMs);
      } else if (at != null && log.length) {
        const t0 = log[0].t, t1 = log[log.length - 1].t;
        const v = parseFloat(at);
        if (!Number.isNaN(v)) scrubTo(v <= 1 ? t0 + v * (t1 - t0) : t0 + v * 1000);
      }
    }
  });

  es.onerror = () => {
    $('#status-text').textContent = 'RECONNECTING';
    // Native EventSource retries on its own while CONNECTING; only step in when
    // it has given up (CLOSED), with backoff, so a downed server is handled too.
    if (es.readyState === EventSource.CLOSED) {
      const delay = Math.min(1000 * 2 ** retry++, 15000);
      setTimeout(() => { if (sessionId === id) openStream(id); }, delay);
    }
  };
}

// Liveness watchdog: a socket can wedge open (laptop sleep) without ever firing
// `onerror`, so the stream looks alive but is dead. The server pings every 25s;
// if no message or ping has landed in 60s while the tab is visible, force a
// clean reconnect. Hidden tabs are left alone — visibilitychange catches wake.
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (sessionId && Date.now() - lastBeat > 60000) openStream(sessionId);
}, 10000);

// Returning to a stale tab (woke from sleep, switched back) — resync at once
// rather than waiting out the watchdog.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && sessionId && Date.now() - lastBeat > 30000) {
    openStream(sessionId);
  }
});

// Session switcher. A fleet board can serve dozens of tapes, so it's a filterable
// popover (type to narrow), not a native <select> wall — now the shared
// initSessionPicker (public/session-picker.js), reused verbatim by /graph and
// /lanes. onSelect does what the old click handler did: point the URL at the new
// tape (no reload) and reconnect the data stream.
async function initSessions() {
  const picker = await initSessionPicker({
    mount: $('#session-picker'),
    currentId: new URLSearchParams(location.search).get('session'),
    onSelect: id => {
      const p = new URLSearchParams(location.search);
      p.set('session', id); p.delete('at');
      history.replaceState(null, '', `?${p}`);
      connect(id);
    },
  });
  if (picker.multi) $('#session-title').hidden = true;
  connect(picker.current);
}

function goLive() {
  live = true; playing = false;
  state = fold(log);
  cursor = log.length;
  vt = log.length ? log[log.length - 1].t : Date.now();
  renderAll(false);
}

function scrubTo(t) {
  const [t0, t1] = domain();
  vt = Math.max(t0, Math.min(t, t1));
  live = false; playing = false;
  state = fold(log, vt);
  cursor = upperBound(vt);
  renderAll(false);
}

let lastFrame = 0;
function playLoop(now) {
  if (!playing) return;
  const dt = lastFrame ? now - lastFrame : 0;
  lastFrame = now;
  vt += dt * speed;
  const fresh = [];
  while (cursor < log.length && log[cursor].t <= vt) {
    reduce(state, log[cursor]);
    fresh.push(log[cursor]);
    cursor++;
  }
  if (fresh.length) renderAll(true, fresh);
  else { drawTimeline(); renderReadout(); tickActiveCards(); }
  if (cursor >= log.length && log.length) {
    const tapeEnd = log[log.length - 1].t;
    if (Date.now() - tapeEnd < 5000) return goLive();   // caught up with reality
    if (vt >= tapeEnd) { playing = false; renderStatus(); return; }
  }
  requestAnimationFrame(playLoop);
}

function startPlay(fromT = null) {
  if (fromT != null) scrubTo(fromT);
  live = false; playing = true; lastFrame = 0;
  renderStatus();
  requestAnimationFrame(playLoop);
}

$('#btn-play').addEventListener('click', () => {
  if (playing) { playing = false; renderStatus(); return; }
  const [t0] = domain();
  const atEnd = cursor >= log.length && log.length && vt >= log[log.length - 1].t;
  if (live || atEnd) startPlay(t0);
  else startPlay();
});

$('#btn-live').addEventListener('click', goLive);

$('#speeds').addEventListener('click', e => {
  const btn = e.target.closest('.speed');
  if (!btn) return;
  speed = Number(btn.dataset.speed);
  document.querySelectorAll('.speed').forEach(b => b.classList.toggle('sel', b === btn));
});

// -------------------------------------------------------------- timeline

const canvas = $('#timeline');
const ctx = canvas.getContext('2d');

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawTimeline();
}

// Pick a round tick interval so the axis shows ~5–8 marks, scaling from
// minutes (short session) up to days (a multi-day run).
function niceTickMs(span) {
  const opts = [60e3, 5 * 60e3, 10 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3,
    6 * 3600e3, 12 * 3600e3, 24 * 3600e3, 2 * 86400e3];
  for (const o of opts) if (span / o <= 8) return o;
  return opts[opts.length - 1];
}
function tickLabel(ms) {
  const m = Math.round(ms / 60e3);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function drawTimeline() {
  const r = canvas.getBoundingClientRect();
  const W = r.width, H = r.height;
  if (!W) return;
  ctx.clearRect(0, 0, W, H);
  const [t0, t1] = domain();
  const span = t1 - t0;
  const x = t => ((t - t0) / span) * W;

  const prTop = 2, prH = 8;          // PR open→merge band, up top
  const axisH = 11;                   // elapsed labels, at the bottom
  const base = H - axisH;             // density baseline sits above the axis
  const barTop = prTop + prH + 2;

  // --- time axis: faint gridlines + elapsed labels (T+ from start) ---
  const iv = niceTickMs(span);
  ctx.font = '9px ui-monospace, SFMono-Regular, monospace';
  ctx.textBaseline = 'alphabetic';
  for (let tk = Math.ceil(t0 / iv) * iv; tk <= t1; tk += iv) {
    const xx = x(tk);
    ctx.fillStyle = '#161d2e';
    ctx.fillRect(xx, barTop, 1, base - barTop);
    ctx.fillStyle = '#5d6781';
    ctx.fillText(tickLabel(tk - t0), xx + 3, H - 2);
  }

  // --- day boundaries: a multi-day tape (a project-keyed board can glue ~10
  // calendar days into one run) gets a faint vertical line + a date label at each
  // local midnight, so the days are legible. Dates sit up top, clear of the T+
  // elapsed axis at the bottom. Only drawn when the span actually exceeds a day. ---
  if (span > 24 * 3600e3) {
    const first = new Date(t0); first.setHours(24, 0, 0, 0); // first local midnight after t0
    for (let m = first.getTime(); m <= t1; m += 24 * 3600e3) {
      const xx = x(m);
      ctx.fillStyle = '#2b3556';
      ctx.fillRect(xx, prTop, 1, base - prTop);
      const d = new Date(m);
      ctx.fillStyle = '#7c88b0';
      ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, xx + 3, prTop + 9);
    }
  }

  // --- event density bars (between the PR band and the axis) ---
  const BW = 4;
  const buckets = new Array(Math.ceil(W / BW)).fill(null);
  for (const ev of log) {
    const i = Math.min(buckets.length - 1, Math.max(0, Math.floor(x(ev.t) / BW)));
    const b = buckets[i] || (buckets[i] = { n: 0, commit: false });
    b.n++;
    if (ev.type === 'commit') b.commit = true;
  }
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (!b) continue;
    const h = Math.min(base - barTop, 2 + Math.sqrt(b.n) * 6);
    ctx.fillStyle = b.commit ? '#d29922' : '#232c47';
    ctx.fillRect(i * BW + 1, base - h, BW - 2, h);
  }
  ctx.fillStyle = '#1b2338';
  ctx.fillRect(0, base, W, 1);

  // --- PR lifecycles: a line from open (green) to merge (purple) ---
  const nowX = x(Math.min(vtNow(), t1));
  for (const pr of prList(state)) {
    if (pr.openedAt == null) continue;
    const open = pr.state !== 'merged';
    const xo = x(pr.openedAt);
    const xe = open ? nowX : x(pr.mergedAt || pr.t);
    const y = prTop + prH / 2;
    ctx.strokeStyle = open ? 'rgba(76,183,130,.45)' : 'rgba(163,113,247,.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xo, y); ctx.lineTo(Math.max(xe, xo + 1), y); ctx.stroke();
    ctx.fillStyle = '#4cb782';
    ctx.fillRect(xo - 0.5, prTop, 1.4, prH);          // opened
    if (!open) { ctx.fillStyle = '#a371f7'; ctx.fillRect(xe - 0.5, prTop, 1.4, prH); } // merged
  }

  // unplayed tape dimmed while in replay
  if (!live) {
    ctx.fillStyle = 'rgba(7,10,19,.62)';
    ctx.fillRect(nowX, 0, W - nowX, H);
  }

  // playhead
  ctx.fillStyle = live ? '#eb6e64' : '#4ea7fc';
  ctx.fillRect(nowX - 0.5, 0, 1, H - axisH);
  ctx.beginPath();
  ctx.moveTo(nowX - 4, 0); ctx.lineTo(nowX + 4, 0); ctx.lineTo(nowX, 6);
  ctx.fill();
}

let scrubbing = false;
canvas.addEventListener('pointerdown', e => {
  scrubbing = true;
  canvas.setPointerCapture(e.pointerId);
  seek(e);
});
canvas.addEventListener('pointermove', e => { if (scrubbing) seek(e); });
canvas.addEventListener('pointerup', () => { scrubbing = false; });

function seek(e) {
  const r = canvas.getBoundingClientRect();
  const [t0, t1] = domain();
  scrubTo(t0 + ((e.clientX - r.left) / r.width) * (t1 - t0));
}

window.addEventListener('resize', sizeCanvas);

// ----------------------------------------------------------------- board

// Every card gets a mark in the corner — explicit `emoji` on the item event
// wins, otherwise inferred from the title. Inference is a pure function of
// state, so replay shows the same marks as live. First matching rule wins.
const EMOJI_RULES = [
  [/\b(hi|hello|hey|wave)\b/i, '👋'],
  [/emoji/i, '😀'],
  [/\b(bug|fix|crash|broken|flaky)\b/i, '🐛'],
  [/\b(import|transcript|tape|replay)\b/i, '📼'],
  [/\b(churn|heatmap)\b/i, '🔥'],
  [/\b(night|moon|sky|star)\b/i, '🌙'],
  [/\b(attach|wire|wiring|setup|install)\b/i, '🔌'],
  [/\b(hooks?|dogfood)\b/i, '🪝'],
  [/\b(codex|agents?|model)\b/i, '🤖'],
  [/\b(input|attention|alert|notify)\b/i, '🔔'],
  [/\b(board|kanban|cards?)\b/i, '📋'],
  [/\b(ui|design|theme|style|visual|logo|redesign)\b/i, '🎨'],
  [/\b(docs?|readme|spec)\b/i, '📝'],
  [/\b(server|sse|stream|api|poller)\b/i, '📡'],
  [/\b(tests?|qa)\b/i, '🧪'],
  [/\b(perf|performance|fast|slow)\b/i, '⚡'],
  [/\b(ship|release|deploy|launch)\b/i, '🚀'],
  [/\b(pr|ci|checks|merge)\b/i, '🔁'],
  [/\b(schema|reducer|fold|events?)\b/i, '🧩'],
  [/\b(rename|naming)\b/i, '🏷️'],
];

function cardEmoji(it) {
  if (it.emoji) return it.emoji;
  const title = it.title || it.id;
  for (const [re, em] of EMOJI_RULES) if (re.test(title)) return em;
  return '🗂️';
}

const cardEls = new Map();
const cols = Object.fromEntries(STATUSES.map(s => [s, $(`#cards-${s}`)]));
const counts = Object.fromEntries(STATUSES.map(s => [s, $(`#count-${s}`)]));
const colWraps = Object.fromEntries(STATUSES.map(s => [s, document.querySelector(`.col[data-status="${s}"]`)]));
const pinnedCols = new Set();   // empty columns the user clicked open (session-only)

// The corner timing on a card. Done: how long the work took. In progress: how
// long it's been running, plus an "idle Xm" flag if nothing's updated it lately
// (so a stalled card is visible at a glance).
function cardTiming(el) {
  if (el._status === 'done') return el._activeMs > 0 ? `took ${ageText(el._activeMs)}` : '';
  // The in-flight gap accrues to the active card ONLY while a recorder is fresh
  // and keyed on PRODUCER activity (lastProducerAt), never any event — so a dead
  // recorder's card freezes at its real worked time instead of ticking phantom
  // hours (F3). Capped like the reducer's per-gap accrual.
  const base = state.session.lastProducerAt ?? state.session.lastAt;
  const gap = el._activeLive && !staleNow() && base != null
    ? Math.min(ACTIVE_GAP_CAP, Math.max(0, vtNow() - base)) : 0;
  const dur = el._activeMs + gap;
  if (dur <= 0) return '';
  const idle = Math.max(0, vtNow() - (el._touchedAt || vtNow()));
  return ageText(dur) + (idle > 90e3 ? ` <span class="stale">· idle ${ageText(idle)}</span>` : '');
}

// Per-plan-step timing: a done step shows how long it took; the running step
// shows how long it's been in progress; a superseded step shows its FROZEN run
// time ("ran 39m") — the plan moved on, so it never ticks.
function stepTime(t, isNow) {
  if (t.status === 'superseded') {
    const d = t.supersededAt && t.startedAt ? Math.max(0, t.supersededAt - t.startedAt) : 0;
    return d >= 1000 ? `ran ${ageText(d)}` : '';
  }
  if (t.done) {
    // Prefer the producer's real duration; fall back to the snapshot-delta estimate.
    const d = t.elapsedMs != null
      ? t.elapsedMs
      : (t.doneAt && (t.startedAt || t.firstSeenAt) ? Math.max(0, t.doneAt - (t.startedAt || t.firstSeenAt)) : 0);
    return d >= 1000 ? ageText(d) : '';   // hide 0s — a backfilled step we have no real timing for
  }
  if (isNow && t.startedAt) {
    const d = Math.max(0, vtNow() - t.startedAt);
    return d >= 1000 ? ageText(d) : '';
  }
  return '';
}

// The card's live "now" line with a TTL: a fresh line (< 10 min old) reads as
// present tense; an older one is honestly re-tensed to "last seen 47m ago: …" so
// a dead recorder's 1am narration stops masquerading as current at 9am. Stored
// on the element (el._now) so the 1s tick can re-age it with no new event.
const NOW_TTL = 10 * 60e3;
function renderNowLine(el) {
  const R = el._refs, now = el._now;
  if (!now || !now.text) { R.nowDoing.style.display = 'none'; return; }
  const age = Math.max(0, vtNow() - (now.t || vtNow()));
  const past = age > NOW_TTL;
  R.nowDoing.className = `now-doing ${now.kind}${past ? ' past' : ''}`;
  R.nowDoing.style.display = 'flex'; // override the stylesheet's default `none`
  R.ndText.textContent = past ? `last seen ${ageText(age)} ago: ${now.text}` : now.text;
  R.ndText.title = now.text;
}

function makeCard() {
  const el = document.createElement('article');
  el.className = 'card';
  el.innerHTML = `
    <div class="card-head"><span class="head-l"><span class="emoji"></span><span class="cid"></span></span><span class="age"></span></div>
    <h3 class="title"></h3>
    <div class="pills">
      <span class="pill diff"><b class="a"></b><b class="d"></b></span>
      <span class="pill commits"><b class="c"></b></span>
      <span class="pill progress"><i class="ring"></i><b class="frac"></b></span>
      <a class="pill pr" target="_blank" rel="noopener"><i class="ci"></i><b class="prtxt"></b></a>
    </div>
    <ul class="todo-list"></ul>
    <div class="now-doing"><i class="nd-pulse"></i><span class="nd-text"></span></div>
    <div class="ab-flag" hidden></div>`;
  el._refs = {
    emoji: el.querySelector('.emoji'),
    cid: el.querySelector('.cid'),
    age: Object.assign(el.querySelector('.age'), { title: 'time worked (idle excluded)' }),
    title: el.querySelector('.title'),
    pills: el.querySelector('.pills'),
    diff: el.querySelector('.pill.diff'),
    a: el.querySelector('.a'), d: el.querySelector('.d'),
    commitsPill: el.querySelector('.pill.commits'),
    c: el.querySelector('.c'),
    progress: el.querySelector('.pill.progress'),
    ring: el.querySelector('.ring'),
    frac: el.querySelector('.frac'),
    pr: el.querySelector('.pill.pr'),
    ci: el.querySelector('.pill.pr .ci'),
    prtxt: el.querySelector('.prtxt'),
    tlist: el.querySelector('.todo-list'),
    nowDoing: el.querySelector('.now-doing'),
    ndText: el.querySelector('.nd-text'),
    abFlag: el.querySelector('.ab-flag'),
  };
  // Click a card with a plan to expand/collapse its steps (collapsed shows only
  // the recent tail — see updateCard). Re-render so the expand takes effect at
  // once, not on the next event. Don't hijack clicks on the PR link.
  el.addEventListener('click', e => {
    if (e.target.closest('a')) return;
    if (!el.classList.contains('has-todos')) return;
    el.classList.toggle('expanded');
    if (el._it) updateCard(el, el._it, false, el._activeId);
  });
  return el;
}

function updateCard(el, it, animate, activeId) {
  const R = el._refs;
  el._it = it; el._activeId = activeId; // remembered so a click can re-render in place
  R.emoji.textContent = cardEmoji(it);
  // Namespaced turn ids (turn-<sid8>-<n>) show SHORT as "turn <n>" — the sid8 is
  // collision-avoidance plumbing, noise to a reader. Legacy/real ids pass through.
  R.cid.textContent = turnLabel(it.id);
  R.title.textContent = it.title || it.id;

  // Time worked, not time since touched. The active `doing` card keeps
  // accruing the in-flight gap between events (see the age ticker).
  el._activeMs = it.activeMs || 0;
  el._activeLive = it.id === activeId && state.session.phase === 'working';
  el._touchedAt = it.touchedAt;
  el._status = it.status;
  R.age.innerHTML = cardTiming(el);

  const hasDiff = !!(it.add || it.del);
  R.diff.style.display = hasDiff ? '' : 'none';
  setNum(R.a, it.add, animate, n => `+${n.toLocaleString('en-US')}`);
  setNum(R.d, it.del, animate, n => `−${n.toLocaleString('en-US')}`);

  R.commitsPill.style.display = it.commits ? '' : 'none';
  R.c.textContent = it.commits ? `${it.commits} commit${it.commits > 1 ? 's' : ''}` : '';

  // Each card shows only the steps it advanced this turn (its delta); the whole
  // plan lives in the sidebar Plan panel. Keeps a turn from showing a stale,
  // cumulative checklist that isn't really "its" work.
  const steps = it.delta ? [...it.delta.values()] : [];
  const hasDelta = steps.length > 0;
  R.progress.style.display = 'none';
  el.classList.toggle('has-todos', hasDelta);
  if (!hasDelta) el.classList.remove('expanded');
  if (hasDelta) {
    // A card's delta is a changelog of what this turn advanced — ordered by when
    // each step reached its CURRENT state: completed steps by completion time,
    // superseded (dropped-mid-flight) steps by when the plan moved past them, and
    // running steps last (they haven't arrived anywhere yet — their time is "now"),
    // so the live edge always sits at the bottom, above the now-line. Pure start-
    // time chronology buried a long-running umbrella step mid-list whenever later
    // steps finished after it started.
    const when = t => t.doneAt || t.supersededAt || Infinity;
    const began = t => t.startedAt || t.firstSeenAt || 0;
    steps.sort((x, y) => (when(x) - when(y)) || (began(x) - began(y)));
    el._todos = steps;
    // A long autonomous turn (one Codex card can span dozens of plan steps) would
    // otherwise render a wall of checklist items taller than the screen. Collapsed,
    // show only the tail — recent history plus the in-progress step; a "+N earlier"
    // line leads, and clicking the card expands to the full list.
    const CAP = 6;
    const collapsed = !el.classList.contains('expanded');
    const hidden = collapsed && steps.length > CAP ? steps.length - CAP : 0;
    const shown = hidden ? steps.slice(hidden) : steps;
    const li = t => {
      const now = t.status === 'in_progress';
      const superseded = t.status === 'superseded';
      const cls = t.status === 'completed' ? 'done' : superseded ? 'superseded' : now ? 'now' : 'unfinished';
      const tm = stepTime(t, now);
      // A superseded step (the plan dropped it mid-flight) reads as history, not a
      // live claim: a faint "· superseded" tag, never a ticking timer.
      const tag = superseded ? '<span class="suptag">· superseded</span>' : '';
      return `<li class="${cls}">${esc(t.text)}${tm ? `<span class="steptime">${tm}</span>` : ''}${tag}</li>`;
    };
    R.tlist.innerHTML =
      (hidden ? `<li class="more">+${hidden} earlier step${hidden > 1 ? 's' : ''}</li>` : '') +
      shown.map(li).join('');
  }

  if (it.pr) {
    R.pr.style.display = '';
    R.pr.classList.toggle('merged', it.pr.state === 'merged');
    R.ci.className = `ci ${it.ci || ''}`;
    R.prtxt.textContent = `#${it.pr.number} ${it.pr.state}`;
    if (it.pr.url) R.pr.href = it.pr.url; else R.pr.removeAttribute('href');
  } else {
    R.pr.style.display = 'none';
  }

  R.pills.classList.toggle('has-pills', hasDiff || !!it.commits || hasDelta || !!it.pr);

  // Live "now" line — the agent's latest narration (or, lacking any, its latest
  // command) shown only on the active in-progress card. Stored on the element so
  // the 1s tick can re-age it past its TTL without a full re-render.
  el._now = it.id === activeId && it.status === 'doing' ? it.now : null;
  renderNowLine(el);

  // Abandoned: a card still in `doing` at a session `end` (reducer-set, definite)
  // OR — for a tape that just STOPS with no end — a doing card untouched for 6h
  // (display-only inference, state is never mutated). Both dim the card and show a
  // chip; the "?" distinguishes the inference from the recorded fact.
  const ABANDON_TTL = 6 * 3600e3;
  const staleDoing = it.status === 'doing' && (vtNow() - (it.touchedAt || vtNow())) > ABANDON_TTL;
  const abandoned = it.abandoned && it.status === 'doing';
  if (abandoned || staleDoing) {
    R.abFlag.hidden = false;
    R.abFlag.textContent = abandoned ? 'abandoned' : 'abandoned?';
    R.abFlag.className = `ab-flag${abandoned ? '' : ' inferred'}`;
  } else {
    R.abFlag.hidden = true;
  }
  el.classList.toggle('is-abandoned', abandoned || staleDoing);

  el.classList.toggle('is-done', it.status === 'done');
  el.classList.toggle('is-active', it.id === activeId);

  if (animate && el._seenTouch !== undefined && el._seenTouch !== it.touchedAt) {
    el.classList.remove('touched');
    void el.offsetWidth; // restart the pulse animation
    el.classList.add('touched');
  }
  el._seenTouch = it.touchedAt;
}

function renderBoard(animate) {
  const activeId = activeItemId(state);
  const rects = new Map();
  if (animate) for (const [id, el] of cardEls) rects.set(id, el.getBoundingClientRect());

  for (const it of state.items.values()) {
    let el = cardEls.get(it.id);
    if (!el) { el = makeCard(it); cardEls.set(it.id, el); el._isNew = true; }
    updateCard(el, it, animate, activeId);
  }
  for (const [id, el] of cardEls) {
    if (!state.items.has(id)) { el.remove(); cardEls.delete(id); }
  }

  const byCol = Object.fromEntries(STATUSES.map(s => [s, []]));
  for (const it of state.items.values()) byCol[it.status]?.push(it);

  for (const s of STATUSES) {
    const colEl = cols[s];
    byCol[s].forEach((it, idx) => {
      const el = cardEls.get(it.id);
      if (colEl.children[idx] !== el) colEl.insertBefore(el, colEl.children[idx] || null);
    });
    counts[s].textContent = byCol[s].length || '';
    colWraps[s].classList.toggle('col-empty', byCol[s].length === 0 && !pinnedCols.has(s));
  }

  if (animate) {
    for (const [id, el] of cardEls) {
      if (el._isNew) {
        el._isNew = false;
        el.classList.add('enter');
        setTimeout(() => el.classList.remove('enter'), 420);
        continue;
      }
      const r0 = rects.get(id);
      if (!r0) continue;
      const r1 = el.getBoundingClientRect();
      const dx = r0.left - r1.left, dy = r0.top - r1.top;
      if (dx || dy) {
        el.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
          { duration: 380, easing: 'cubic-bezier(.2, .7, .2, 1)' }
        );
      }
    }
  } else {
    for (const el of cardEls.values()) el._isNew = false;
  }
}

// ------------------------------------------------------------------ feed

const feedEl = $('#feed');

function feedLine(ev) {
  let tag = ev.type, cls = ev.type, tx = '';
  switch (ev.type) {
    case 'session':
      tag = 'sess'; cls = 'session';
      if (ev.phase === 'attention') {
        tag = 'ask'; cls = 'ci-fail';
        tx = `needs input${ev.text ? ` — ${esc(ev.text)}` : ''}`;
      } else if (ev.phase === 'start') {
        tx = 'session started';
      } else if (ev.phase === 'resume') {
        tx = 'prompt received';
      } else if (ev.phase === 'idle') {
        tx = 'agent idle — turn finished';
      } else if (ev.phase === 'end' || ev.phase === 'ended') {
        tx = 'session ended';
      } else if (ev.title) {
        // A phase-less title update (the backfill naming the session) — don't
        // mislabel it as "session ended".
        tx = `renamed → ${esc(ev.title)}`;
      } else {
        tx = 'session ended';
      }
      break;
    case 'item':
      tx = ev.status && !ev.title ? `<b>${esc(ev.id)}</b> → ${esc(ev.status)}`
        : `+ <b>${esc(ev.title || ev.id)}</b>${ev.status && ev.status !== 'inbox' ? ` → ${esc(ev.status)}` : ''}`;
      break;
    case 'todos': {
      const done = (ev.todos || []).filter(t => t.done).length;
      tag = 'plan'; cls = 'todos';
      tx = `plan updated · ${done}/${(ev.todos || []).length} done`;
      break;
    }
    case 'edit': {
      const p = String(ev.path || '');
      const i = p.lastIndexOf('/');
      tx = i < 0 ? `<b>${esc(p)}</b>` : `${esc(p.slice(0, i + 1))}<b>${esc(p.slice(i + 1))}</b>`;
      break;
    }
    case 'commit':
      tx = `<b>${esc(ev.sha || '')}</b> ${esc(ev.message || '')} <span class="a">+${ev.add || 0}</span> <span class="d">−${ev.del || 0}</span>`;
      break;
    case 'pr':
      tx = `<b>#${ev.number}</b> ${esc(ev.state || 'open')}${ev.title ? ` — ${esc(ev.title)}` : ''}`;
      break;
    case 'ci':
      cls = ev.status === 'fail' ? 'ci-fail' : 'ci';
      tx = `checks ${esc(ev.status)}`;
      break;
    case 'tool': {
      tag = ev.tool || 'run'; cls = 'tool';
      tx = `<span class="cmd">${esc(ev.text || '')}</span>`;
      break;
    }
    case 'say':
      tag = 'says'; cls = 'say';
      tx = esc(ev.text || '');
      break;
    case 'note':
      tx = esc(ev.text || '');
      break;
    default:
      tx = esc(JSON.stringify(ev));
  }
  const li = document.createElement('li');
  li.innerHTML = `<span class="ts">${clockTime(ev.t)}</span><span class="tag ${cls}">${tag}</span><span class="tx">${tx}</span>`;
  return li;
}

function renderFeed(freshEvents) {
  if (freshEvents) {
    for (const ev of freshEvents) {
      const li = feedLine(ev);
      li.classList.add('fresh');
      feedEl.prepend(li);
    }
    while (feedEl.children.length > 150) feedEl.lastChild.remove();
  } else {
    feedEl.innerHTML = '';
    for (const ev of state.feed) feedEl.append(feedLine(ev));
  }
  $('#count-feed').textContent = state.totals.events || '';
}

// -------------------------------------------------------- pull requests

const RECENT_MERGES = 8;

function renderPRs() {
  const box = $('#prs');
  const all = prList(state);
  box.hidden = !all.length;
  if (!all.length) return;
  const open = all.filter(p => p.state === 'open').sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  const merged = all.filter(p => p.state === 'merged').sort((a, b) => (b.mergedAt || b.t || 0) - (a.mergedAt || a.t || 0));
  $('#prs-count').textContent = open.length ? `${open.length} open` : `${merged.length} merged`;

  const now = vtNow();
  const link = pr => (pr.url ? ` data-url="${esc(pr.url)}"` : ''); // whole row clickable
  const title = pr => pr.title ? `<span class="prtitle">${esc(pr.title)}</span>` : '';
  // Repo prefix ONLY when the session spans more than one repo — otherwise the lone
  // repo is obvious and a prefix is noise. This is what keeps two repos' #1 from
  // reading as the same PR (plan 1.4: state.prs is keyed by repo#number).
  const repos = new Set(all.map(p => p.repo).filter(Boolean));
  const repoTag = pr => (repos.size > 1 && pr.repo)
    ? `<span class="prrepo" style="color:var(--dim);font-family:var(--mono);font-size:11px;margin-right:4px">${esc(pr.repo.split('/').pop())}</span>` : '';
  // Toast / CI status, spelled out and always present so it leads each open row —
  // the colored chip is the one thing that means "status".
  const status = pr => {
    if (pr.ci === 'pass') return '<span class="prci pass" title="CI / Toast checks passed — ready to merge">✓ passed</span>';
    if (pr.ci === 'fail') return '<span class="prci fail" title="a check failed or the merge is blocked">✗ blocked</span>';
    if (pr.ci === 'pending') return '<span class="prci pending" title="CI / Toast checks are still running">⋯ running</span>';
    return '<span class="prci unknown" title="PR is open; no check result recorded yet">open</span>';
  };

  const openRows = open.map(pr =>
    `<li class="pr-open"${link(pr)} title="open PR #${pr.number} on GitHub">${status(pr)}${repoTag(pr)}<b class="prnum">#${pr.number}</b>${title(pr)}` +
    `<span class="prage">${pr.openedAt ? ageText(now - pr.openedAt) : ''}</span></li>`).join('');
  const mergedRows = merged.slice(0, RECENT_MERGES).map(pr =>
    `<li class="pr-merged"${link(pr)} title="open PR #${pr.number} on GitHub">${repoTag(pr)}<b class="prnum">#${pr.number}</b>${title(pr)}` +
    `<span class="prage">${pr.mergedAt ? ageText(now - pr.mergedAt) : ''}</span></li>`).join('');
  const more = merged.length > RECENT_MERGES
    ? `<li class="pr-more">+${merged.length - RECENT_MERGES} more merged</li>` : '';

  $('#prs-list').innerHTML =
    (open.length ? `<li class="pr-head">In flight</li>${openRows}` : '') +
    (merged.length ? `<li class="pr-head">Recently merged</li>${mergedRows}${more}` : '');
}

// Whole PR row opens the PR on GitHub (listener on the <ul> survives re-renders).
$('#prs-list').addEventListener('click', e => {
  const li = e.target.closest('li[data-url]');
  if (li) window.open(li.dataset.url, '_blank', 'noopener');
});

// ----------------------------------------------------------- PR gantt
// A dedicated, taller view: one row per PR, bar length = open→merge duration,
// readable per-PR, on a shared time axis. Opened from the PR panel header.
function renderGantt() {
  const prs = prList(state).filter(p => p.openedAt != null);
  $('#gantt-count').textContent = prs.length || '';
  const body = $('#gantt-body'), axis = $('#gantt-axis');
  if (!prs.length) { body.innerHTML = '<div class="gantt-empty">No PRs recorded yet.</div>'; axis.innerHTML = ''; return; }
  const now = vtNow();
  let t0 = Infinity, t1 = -Infinity;
  for (const p of prs) { t0 = Math.min(t0, p.openedAt); t1 = Math.max(t1, p.mergedAt || now); }
  if (t1 <= t0) t1 = t0 + 60e3;
  const span = t1 - t0;
  const pct = t => ((t - t0) / span) * 100;

  const iv = niceTickMs(span);
  let ax = '';
  for (let tk = Math.ceil(t0 / iv) * iv; tk <= t1; tk += iv) ax += `<span class="gantt-tick" style="left:${pct(tk)}%">${tickLabel(tk - t0)}</span>`;
  axis.innerHTML = ax;

  const sorted = prs.slice().sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  body.innerHTML = sorted.map(p => {
    const open = p.state !== 'merged';
    const end = open ? now : (p.mergedAt || p.t);
    const left = pct(p.openedAt), width = Math.max(0.4, pct(end) - left);
    const dur = ageText(Math.max(0, end - p.openedAt));
    const barCls = (open ? 'g-open' : 'g-merged') + (p.ci ? ` g-${p.ci}` : '');
    return `<div class="gantt-row ${open ? 'g-open' : 'g-merged'}${p.url ? ' has-url' : ''}"${p.url ? ` data-url="${esc(p.url)}"` : ''} title="${esc(p.title || ('#' + p.number))}">` +
      `<div class="g-label"><b>#${p.number}</b><span class="g-title">${esc(p.title || '')}</span><span class="g-dur">${dur}${open ? ' open' : ''}</span></div>` +
      `<div class="g-track"><span class="g-bar ${barCls}" style="left:${left}%;width:${width}%"></span></div></div>`;
  }).join('');
}

const ganttOpen = () => !$('#gantt-overlay').hidden;
$('#gantt-open').addEventListener('click', () => { $('#gantt-overlay').hidden = false; renderGantt(); });
$('#gantt-close').addEventListener('click', () => { $('#gantt-overlay').hidden = true; });
$('#gantt-overlay').addEventListener('click', e => { if (e.target.id === 'gantt-overlay') $('#gantt-overlay').hidden = true; });
$('#gantt-body').addEventListener('click', e => {
  const r = e.target.closest('.gantt-row[data-url]');
  if (r) window.open(r.dataset.url, '_blank', 'noopener');
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && ganttOpen()) $('#gantt-overlay').hidden = true; });

// ------------------------------------------------------------- hot files

function renderHotfiles() {
  const box = $('#hotfiles');
  const hot = hotFiles(state);
  box.hidden = !hot.length;
  if (!hot.length) return;
  // A session launched in one worktree often edits sibling worktrees (paths that
  // escape root with `../`); the filename's immediate folder hides which one. For
  // those, surface the worktree instead, trimmed of the repo-name prefix so it
  // reads `lock-gate › …` not `megablock-h1-lock-gate › …`. Key the prefix off the
  // cwd basename — title can be a first-prompt/custom label on imported tapes.
  const repo = ((state.session.cwd || '').split('/').filter(Boolean).pop() || (state.session.title || '').trim());
  $('#hotfiles-list').innerHTML = hot.map(f => {
    // Show the filename (+ its immediate folder) — the useful end of the path —
    // not a middle-truncated prefix. Full path on hover.
    const segs = String(f.path).split('/').filter(Boolean);
    const name = segs[segs.length - 1] || f.path;
    let dir = segs.length > 1 ? segs[segs.length - 2] + '/' : '';
    if (segs[0] === '..') {
      const wt = segs.find(s => s !== '..');           // sibling worktree dir
      if (wt) dir = (repo && wt.startsWith(repo + '-') ? wt.slice(repo.length + 1) : wt) + '/';
    }
    return `<li class="${f.tier}" title="${esc(f.path)}"><i class="heat"></i>` +
      `<span class="fpath"><span class="fdir">${esc(dir)}</span><b>${esc(name)}</b></span>` +
      `<span class="fcount">${f.edits}×</span></li>`;
  }).join('');
}

// ------------------------------------------------------------ instruments

// Who works this shift — glyph + name, colored per agent. Unknown agents get
// a neutral glyph so new producers show up without a UI change.
const AGENT_BADGES = { claude: ['✳', 'Claude'], codex: ['⬢', 'Codex'] };

function renderAgentBadge() {
  const el = $('#agent-badge');
  const agent = state.session.agent;
  el.hidden = !agent;
  if (!agent) return;
  const [glyph, name] = AGENT_BADGES[agent] || ['◇', agent];
  el.textContent = `${glyph} ${name}`;
  el.className = `agent-badge agent-${agent}`;
}

// 12_345 → "12.3k", 2_100_000 → "2.1M"
function compactNum(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString('en-US');
}

function renderInstruments(animate) {
  setNum($('#stat-add'), state.totals.add, animate);
  setNum($('#stat-del'), state.totals.del, animate);
  setNum($('#stat-commits'), state.totals.commits, animate);
  setNum($('#stat-events'), state.totals.events, animate);

  const tok = state.totals.tokIn + state.totals.tokOut + state.totals.cacheTok;
  $('#stat-tokens-wrap').hidden = !tok;
  $('#stat-cost-wrap').hidden = !tok;
  if (tok) {
    setNum($('#stat-tokens'), tok, animate, compactNum);
    $('#stat-tokens').title = `${state.totals.tokIn.toLocaleString('en-US')} in · ` +
      `${state.totals.tokOut.toLocaleString('en-US')} out · ` +
      `${state.totals.cacheTok.toLocaleString('en-US')} cached`;
    const cost = state.totals.cost;
    $('#stat-cost').textContent = cost >= 1 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(3)}`;
    $('#stat-cost').title = 'approximate — local price table, not a billing source';
  }
  const t0 = state.session.startedAt ?? (log.length ? log[0].t : null);
  $('#stat-elapsed').textContent = t0 ? durText(vtNow() - t0) : '00:00';
  if (state.session.title) $('#session-title').textContent = state.session.title;
  else if (state.session.cwd) $('#session-title').textContent = state.session.cwd.split('/').pop();
  renderAgentBadge();
}

function renderStatus() {
  const badge = $('#status-badge'), text = $('#status-text');
  badge.className = 'badge';
  if (!live) {
    badge.classList.add('is-replay');
    text.textContent = playing ? `REPLAY ${speed}×` : 'PAUSED';
  } else {
    // Honest badge: derive from (phase, freshest producer age), so a `working`
    // phase whose recorder has gone silent past its TTL reads STALE with the real
    // "data ends HH:MM" — not a latched, lying LIVE (F3).
    const L = liveness(state, vtNow());
    if (L.state === 'attention') {
      badge.classList.add('is-attn');
      text.textContent = 'NEEDS INPUT';
    } else if (L.state === 'stale') {
      badge.classList.add('is-stale');
      text.textContent = `STALE · data ends ${hhmm(L.dataEndsAt)}`;
    } else if (L.state === 'live') {
      badge.classList.add('is-live');
      text.textContent = 'LIVE';
    } else if (L.state === 'idle') {
      badge.classList.add('is-idle');
      text.textContent = 'IDLE';
    } else {
      text.textContent = L.state === 'ended' ? 'ENDED' : 'WAITING';
    }
  }
  $('#btn-live').classList.toggle('on', live);
  $('#btn-play').textContent = playing ? '❚❚' : '▶';
  renderAttention();
}

// The one state the human must act on gets the loud treatment: a banner
// over the board and a tab title you can spot from another screen.
function renderAttention() {
  const banner = $('#attention');
  const phase = state.session.phase;
  // "quiet/waiting" is time since the agent last DID something (lastProducerAt),
  // not since any event — else a reconcile append every 30s reset the readout to
  // "quiet 0m" all night (F3). Falls back to lastAt for a producer-less tape.
  const quietFrom = state.session.lastProducerAt ?? state.session.lastAt;
  const waiting = ageText(Math.max(0, vtNow() - (quietFrom || vtNow())));
  if (live && phase === 'attention') {
    banner.hidden = false;
    banner.classList.add('urgent');
    $('#attention-text').textContent =
      `Agent needs you — ${state.session.attentionText || 'permission or input requested'}`;
    $('#attention-age').textContent = `waiting ${waiting}`;
    document.title = '🔴 needs input · nightshift';
  } else if (live && phase === 'idle') {
    banner.hidden = false;
    banner.classList.remove('urgent');
    // "Idle" only means the log went quiet — for an autonomous agent that's
    // usually a pause or a slow command, NOT "finished, waiting for you".
    const autonomous = state.session.agent === 'codex';
    $('#attention-text').textContent = autonomous
      ? 'No activity on the log — the agent may be thinking, running a long command, or done'
      : 'Turn finished — agent is waiting for your next prompt';
    $('#attention-age').textContent = `quiet ${waiting}`;
    document.title = '◌ idle · nightshift';
  } else {
    banner.hidden = true;
    document.title = 'nightshift';
  }
}

function renderReadout() {
  const [t0] = domain();
  $('#readout').textContent = `T+${durText(vtNow() - t0).padStart(8, '0')}`;
  $('#stat-elapsed').textContent = durText(vtNow() - (state.session.startedAt ?? t0));
}

// The full session plan, shown once in the sidebar — cards show only their
// own delta. Progress bar + the live (in-progress, else next-open) step lit.
function renderPlan() {
  const box = $('#plan');
  const todos = state.todos || [];
  box.hidden = !todos.length;
  if (!todos.length) return;
  const done = todos.filter(t => t.done).length;
  $('#plan-frac').textContent = `${done}/${todos.length}`;
  $('#plan-bar').style.width = `${(done / todos.length) * 100}%`;
  const hasIP = todos.some(t => t.status === 'in_progress');
  const firstOpen = todos.findIndex(t => !t.done);
  $('#plan-list').innerHTML = todos.map((t, i) => {
    const now = hasIP ? t.status === 'in_progress' : i === firstOpen;
    const cls = t.done ? 'done' : now ? 'now' : '';
    return `<li class="${cls}">${esc(t.text)}</li>`;
  }).join('');
}

function renderAll(animate, freshEvents = null) {
  renderInstruments(animate);
  renderBoard(animate);
  renderPlan();
  renderPRs();
  if (!$('#gantt-overlay').hidden) renderGantt();
  renderHotfiles();
  renderFeed(animate ? freshEvents : null);
  renderStatus();
  renderReadout();
  drawTimeline();
}

// ------------------------------------------------------------------ tape

const TAPE_KEY = 'tb-tape-collapsed';

function setTape(collapsed) {
  document.body.classList.toggle('tape-collapsed', collapsed);
  $('#tape-toggle').classList.toggle('active', !collapsed);
  try { localStorage.setItem(TAPE_KEY, collapsed ? '1' : '0'); } catch { /* private mode */ }
  setTimeout(sizeCanvas, 240); // after the grid transition settles
}

$('#tape-toggle').addEventListener('click', () =>
  setTape(!document.body.classList.contains('tape-collapsed')));
$('#tape-close').addEventListener('click', () => setTape(true));

// Hot files / Activity are secondary — collapsed by default, click to expand.
const subToggle = (btn, panel, key) => {
  $(btn).addEventListener('click', () => {
    const collapsed = $(panel).classList.toggle('collapsed');
    try { localStorage.setItem(key, collapsed ? '1' : '0'); } catch { /* private */ }
  });
  try { if (localStorage.getItem(key) === '0') $(panel).classList.remove('collapsed'); } catch { /* private */ }
};
subToggle('#hotfiles-toggle', '#hotfiles', 'ns-hotfiles');
subToggle('#activity-toggle', '#activity', 'ns-activity');

let tapeCollapsed = false;
try { tapeCollapsed = localStorage.getItem(TAPE_KEY) === '1'; } catch { /* private mode */ }
setTape(tapeCollapsed);

// Collapse empty columns to a rail; click the rail to expand (pin), click a
// pinned-empty column's header to re-collapse. Only empty columns toggle —
// a column with cards is always shown, and re-renders auto-expand it.
$('#board').addEventListener('click', e => {
  const col = e.target.closest('.col');
  if (!col) return;
  const s = col.dataset.status;
  if (cols[s].children.length) return;            // has cards → not collapsible
  if (col.classList.contains('col-empty')) {       // rail → expand + pin
    pinnedCols.add(s);
    col.classList.remove('col-empty');
    if (s === 'inbox') $('#add-card-input').focus();
  } else if (e.target.closest('.col-head')) {      // header → re-collapse
    pinnedCols.delete(s);
    col.classList.add('col-empty');
  }
});

// ---------------------------------------------------------------- inbox →

$('#add-card-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#add-card-input');
  const title = input.value.trim();
  if (!title) return;
  input.value = '';
  await fetch('/event?session=' + encodeURIComponent(sessionId || ''), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      // Envelope v2, source 'ui'. This is an item event, so `id` is the work-item
      // id (its identity); the server won't overwrite it with a UUID.
      type: 'item',
      id: 'wi-' + Date.now().toString(36),
      title,
      status: 'inbox',
      source: 'ui',
      v: 2,
    }),
  }).catch(() => {});
  // no local apply — the SSE echo renders it, same path as every other event
});

// ----------------------------------------------------------------- clock

// Keep the corner timing fresh between events — the active card's worked time
// ticks up, and any in-progress card's "idle Xm" flag grows while it's quiet.
function tickActiveCards() {
  for (const el of cardEls.values()) {
    if (el._status === 'done') continue;
    el._refs.age.innerHTML = cardTiming(el);
    renderNowLine(el); // re-tense the now-line as it crosses its TTL
    // live-tick the running step's elapsed time on the active card
    if (el._activeLive && el._todos) {
      const nowEl = el._refs.tlist.querySelector('li.now .steptime');
      const t = el._todos.find(td => td.status === 'in_progress') || el._todos.find(td => !td.done);
      if (nowEl && t && t.startedAt) nowEl.textContent = ageText(Math.max(0, vtNow() - t.startedAt));
    }
  }
}

setInterval(() => {
  if (!ready) return;
  if (live) {
    renderReadout();
    drawTimeline();
    renderStatus(); // re-derive the badge so it flips to STALE on time even with
                    // zero incoming events (a dead recorder appends nothing)
    tickActiveCards();
  }
}, 1000);

// Drag the left edge of the sidebar to resize it (persisted).
(() => {
  const handle = $('#tape-resize');
  if (!handle) return;
  const TKEY = 'ns-tape-w';
  try { const w = localStorage.getItem(TKEY); if (w) document.documentElement.style.setProperty('--tape-w', w); } catch { /* private */ }
  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
  });
  handle.addEventListener('pointermove', e => {
    if (!document.body.classList.contains('resizing')) return;
    const w = Math.max(240, Math.min(820, window.innerWidth - e.clientX));
    document.documentElement.style.setProperty('--tape-w', `${w}px`);
  });
  const end = () => {
    if (!document.body.classList.contains('resizing')) return;
    document.body.classList.remove('resizing');
    try { localStorage.setItem(TKEY, getComputedStyle(document.documentElement).getPropertyValue('--tape-w').trim() || '304px'); } catch { /* private */ }
    sizeCanvas();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('lostpointercapture', end);
})();

sizeCanvas();
initSessions();
