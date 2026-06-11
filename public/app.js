// nightshift engine: SSE in, pure fold to state, animated render out.
// Two clocks exist — wall time (live) and virtual time `vt` (replay). Every
// render path goes through renderAll(); animation only happens on forward,
// incremental application of events, never on rebuilds (scrub/refresh).

import { initialState, reduce, fold, activeItemId, STATUSES } from './reducer.js';

const $ = sel => document.querySelector(sel);

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

const es = new EventSource('/sse');

es.onmessage = e => {
  let ev;
  try { ev = JSON.parse(e.data); } catch { return; }
  if (typeof ev.t !== 'number' || typeof ev.type !== 'string') return;
  log.push(ev);
  if (!ready) return;
  if (live) {
    reduce(state, ev);
    cursor++;
    renderAll(true, [ev]);
  } else {
    drawTimeline(); // tape grows under the paused/replaying view
  }
};

es.addEventListener('ready', () => {
  ready = true;
  state = fold(log);
  cursor = log.length;
  vt = log.length ? log[log.length - 1].t : Date.now();
  renderAll(false);
  // deep link into the tape: ?at=0.45 (fraction) or ?at=620 (seconds from start)
  // Fractions map over the recorded event span, not the live domain — an old
  // tape's idle gap shouldn't dilute them.
  const at = new URLSearchParams(location.search).get('at');
  if (at != null && log.length) {
    const t0 = log[0].t, t1 = log[log.length - 1].t;
    const v = parseFloat(at);
    if (!Number.isNaN(v)) scrubTo(v <= 1 ? t0 + v * (t1 - t0) : t0 + v * 1000);
  }
});

es.onerror = () => { $('#status-text').textContent = 'RECONNECTING'; };

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
  else { drawTimeline(); renderReadout(); }
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

function drawTimeline() {
  const r = canvas.getBoundingClientRect();
  const W = r.width, H = r.height;
  if (!W) return;
  ctx.clearRect(0, 0, W, H);
  const [t0, t1] = domain();
  const span = t1 - t0;
  const x = t => ((t - t0) / span) * W;

  // event density buckets
  const BW = 4;
  const buckets = new Array(Math.ceil(W / BW)).fill(null);
  for (const ev of log) {
    const i = Math.min(buckets.length - 1, Math.max(0, Math.floor(x(ev.t) / BW)));
    const b = buckets[i] || (buckets[i] = { n: 0, commit: false, pr: false });
    b.n++;
    if (ev.type === 'commit') b.commit = true;
    if (ev.type === 'pr' || ev.type === 'ci') b.pr = true;
  }
  const base = H - 12;
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (!b) continue;
    const h = Math.min(base - 8, 3 + Math.sqrt(b.n) * 7);
    ctx.fillStyle = b.commit ? '#d29922' : b.pr ? '#4ea7fc' : '#232c47';
    ctx.fillRect(i * BW + 1, base - h, BW - 2, h);
  }

  // baseline
  ctx.fillStyle = '#1b2338';
  ctx.fillRect(0, base, W, 1);

  // unplayed tape dimmed while in replay
  const px = x(Math.min(vtNow(), t1));
  if (!live) {
    ctx.fillStyle = 'rgba(7,10,19,.62)';
    ctx.fillRect(px, 0, W - px, H);
  }

  // playhead
  ctx.fillStyle = live ? '#eb6e64' : '#4ea7fc';
  ctx.fillRect(px - 0.5, 4, 1, H - 8);
  ctx.beginPath();
  ctx.moveTo(px - 4, 4); ctx.lineTo(px + 4, 4); ctx.lineTo(px, 10);
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
    <ul class="todo-list"></ul>`;
  el._refs = {
    emoji: el.querySelector('.emoji'),
    cid: el.querySelector('.cid'),
    age: el.querySelector('.age'),
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
  };
  return el;
}

function updateCard(el, it, animate, activeId) {
  const R = el._refs;
  R.emoji.textContent = cardEmoji(it);
  R.cid.textContent = it.id;
  R.title.textContent = it.title || it.id;
  R.age.textContent = ageText(vtNow() - it.touchedAt);

  const hasDiff = !!(it.add || it.del);
  R.diff.style.display = hasDiff ? '' : 'none';
  setNum(R.a, it.add, animate, n => `+${n.toLocaleString('en-US')}`);
  setNum(R.d, it.del, animate, n => `−${n.toLocaleString('en-US')}`);

  R.commitsPill.style.display = it.commits ? '' : 'none';
  R.c.textContent = it.commits ? `${it.commits} commit${it.commits > 1 ? 's' : ''}` : '';

  const hasTodos = !!(it.todos && it.todos.length);
  R.progress.style.display = hasTodos ? '' : 'none';
  if (hasTodos) {
    const done = it.todos.filter(t => t.done).length;
    const pct = (done / it.todos.length) * 100;
    R.ring.style.setProperty('--p', `${pct}%`);
    R.ring.style.setProperty('--ring-c', pct >= 100 ? 'var(--green)' : 'var(--yellow)');
    R.frac.textContent = `${done}/${it.todos.length}`;
    const firstOpen = it.todos.findIndex(t => !t.done);
    R.tlist.innerHTML = it.todos.map((t, i) =>
      `<li class="${t.done ? 'done' : i === firstOpen ? 'now' : ''}">${esc(t.text)}</li>`
    ).join('');
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

  R.pills.classList.toggle('has-pills', hasDiff || !!it.commits || hasTodos || !!it.pr);

  el._touchedAt = it.touchedAt;
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
      } else {
        tx = ev.phase === 'start' ? 'session started'
          : ev.phase === 'resume' ? 'prompt received'
          : ev.phase === 'idle' ? 'agent idle — turn finished'
          : 'session ended';
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

function renderInstruments(animate) {
  setNum($('#stat-add'), state.totals.add, animate);
  setNum($('#stat-del'), state.totals.del, animate);
  setNum($('#stat-commits'), state.totals.commits, animate);
  setNum($('#stat-events'), state.totals.events, animate);
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
  } else if (state.session.phase === 'attention') {
    badge.classList.add('is-attn');
    text.textContent = 'NEEDS INPUT';
  } else if (state.session.phase === 'working') {
    badge.classList.add('is-live');
    text.textContent = 'LIVE';
  } else if (state.session.phase === 'idle') {
    badge.classList.add('is-idle');
    text.textContent = 'IDLE';
  } else {
    text.textContent = state.session.phase === 'ended' ? 'ENDED' : 'WAITING';
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
  const waiting = ageText(Math.max(0, vtNow() - (state.session.lastAt || vtNow())));
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
    $('#attention-text').textContent = 'Turn finished — agent is waiting for your next prompt';
    $('#attention-age').textContent = `idle ${waiting}`;
    document.title = '◌ waiting · nightshift';
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

function renderAll(animate, freshEvents = null) {
  renderInstruments(animate);
  renderBoard(animate);
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

let tapeCollapsed = false;
try { tapeCollapsed = localStorage.getItem(TAPE_KEY) === '1'; } catch { /* private mode */ }
setTape(tapeCollapsed);

// ---------------------------------------------------------------- inbox →

$('#add-card-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#add-card-input');
  const title = input.value.trim();
  if (!title) return;
  input.value = '';
  await fetch('/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'item',
      id: 'wi-' + Date.now().toString(36),
      title,
      status: 'inbox',
    }),
  }).catch(() => {});
  // no local apply — the SSE echo renders it, same path as every other event
});

// ----------------------------------------------------------------- clock

setInterval(() => {
  if (!ready) return;
  if (live) {
    renderReadout();
    drawTimeline();
    renderAttention();
    for (const el of cardEls.values()) {
      if (el._touchedAt) el._refs.age.textContent = ageText(Date.now() - el._touchedAt);
    }
  }
}, 1000);

sizeCanvas();
