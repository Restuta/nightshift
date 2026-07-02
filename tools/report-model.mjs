// Shift Report — the morning answer, as a pure deterministic model + a thin HTML
// renderer. `buildReportModel(events, since)` folds the tape with the SAME pure
// reducer the board uses (public/reducer.js) and derives: what shipped, what
// needs you, what's still open, the night's story (chapters), and cost — with no
// LLM and no fetch. Determinism over the log is the whole point: the report is a
// fold, so it can never disagree with replay (see docs/PLAN-morning-truth.md 2.1).
//
// The server is CJS and loads this via dynamic import() (this is ESM so it can
// pull the ESM reducer). Tests import buildReportModel directly and assert the
// MODEL — shipped list, needs-you detection, chapter count — never HTML strings.

import { fold, prList } from '../public/reducer.js';

const CHAPTER_GAP = 30 * 60e3;    // a silent gap longer than this starts a chapter
const ACTIVE_GAP_CAP = 30 * 60e3; // cap one working gap (matches reducer.js)
const DAY = 24 * 3600e3;

// The REAL merge time: gh's mergedAt lands as `occurredAt` (Phase 1.4); until a
// producer sets it, fall back to the recorded `t`. Reading it here means the
// report shows true history the moment producers start stamping it — no change.
const mergeTime = ev => (ev && ev.occurredAt != null ? ev.occurredAt : ev.t);

function sortByT(events) {
  // Array.sort is stable, so equal-t events keep file order (consumers sort by t;
  // see docs/EVENTS.md "Ordering").
  return (events || []).slice().sort((a, b) => (a.t || 0) - (b.t || 0));
}

// Mirror reducer.js's retraction semantics WITHOUT importing internals (it's a
// shared file): a retract is meta — it applies at all times — so drop retract
// events, any event whose envelope id is retracted, and any retracted item (its
// own upserts AND everything attributed to it).
function dropRetracted(sorted) {
  const rEvents = new Set(), rItems = new Set();
  for (const ev of sorted) {
    if (ev && ev.type === 'retract' && ev.target) {
      if (ev.target.event != null) rEvents.add(ev.target.event);
      if (ev.target.item != null) rItems.add(ev.target.item);
    }
  }
  if (!rEvents.size && !rItems.size) return sorted.filter(ev => ev && ev.type !== 'retract');
  return sorted.filter(ev => {
    if (!ev || ev.type === 'retract') return false;
    if (ev.id != null && rEvents.has(ev.id)) return false;
    if (ev.type === 'item' && ev.id != null && rItems.has(ev.id)) return false;
    if (ev.item != null && rItems.has(ev.item)) return false;
    return true;
  });
}

// Wall-clock active vs idle inside the window. Each inter-event gap is charged to
// the phase in effect at its start; a working gap is capped at 30min (matching
// the reducer, so one stuck window can't inflate "active"), idle gaps aren't
// capped. Activity (edit/commit/todos/tool/say) wakes an idle/attention phase,
// same as reducer.awake(). Intervals are clamped to [since, end] first.
function activeIdle(live, since, end) {
  let phase = null, prevT = null, activeMs = 0, idleMs = 0;
  const account = t => {
    if (prevT == null) return;
    const lo = Math.max(prevT, since), hi = Math.min(t, end);
    if (hi <= lo) return;
    const dt = hi - lo;
    if (phase === 'working') activeMs += Math.min(dt, ACTIVE_GAP_CAP);
    else idleMs += dt;
  };
  for (const ev of live) {
    account(ev.t);
    if (ev.type === 'session') {
      if (ev.phase === 'start' || ev.phase === 'resume') phase = 'working';
      else if (ev.phase === 'attention') phase = 'attention';
      else if (ev.phase === 'idle') phase = 'idle';
      else if (ev.phase === 'end') phase = 'ended';
    } else if (ev.type === 'edit' || ev.type === 'commit' || ev.type === 'todos' ||
               ev.type === 'tool' || ev.type === 'say') {
      if (phase === 'idle' || phase === 'attention') phase = 'working';
    }
    prevT = ev.t;
  }
  account(end); // trailing gap to the window end (idle/working up to "now")
  return { activeMs, idleMs };
}

// The pure model. `since` is an absolute epoch-ms lower bound; `opts.now` is the
// window's upper bound (defaults to the last event's t, which keeps tests
// deterministic — the server passes Date.now()).
export function buildReportModel(events, since, opts = {}) {
  const all = sortByT(events);
  const live = dropRetracted(all);
  const firstT = live.length ? live[0].t : null;
  const lastT = live.length ? live[live.length - 1].t : null;
  const now = opts.now != null ? opts.now : (lastT != null ? lastT : Date.now());
  const sinceT = since != null ? since : now - DAY;
  const winStart = firstT != null ? Math.max(sinceT, firstT) : sinceT;
  const winEnd = Math.max(now, sinceT);

  // Windowed aggregates come from differencing two folds of the SAME reducer, so
  // cost/commits/lines use the reducer's exact accounting (incl. its price table)
  // rather than a duplicated copy. Totals are monotonic, so full − before ≥ 0.
  const full = fold(all);
  const before = fold(all, sinceT - 1);
  const win = {
    commits: full.totals.commits - before.totals.commits,
    add: full.totals.add - before.totals.add,
    del: full.totals.del - before.totals.del,
    edits: full.totals.edits - before.totals.edits,
    cost: full.totals.cost - before.totals.cost,
    tokIn: full.totals.tokIn - before.totals.tokIn,
    tokOut: full.totals.tokOut - before.totals.tokOut,
    cacheTok: full.totals.cacheTok - before.totals.cacheTok,
  };

  const { activeMs, idleMs } = activeIdle(live, sinceT, winEnd);

  let lastSay = null, lastSayT = null, lastAttentionT = null;
  for (const ev of live) {
    if (ev.type === 'say' && ev.text) { lastSay = ev.text; lastSayT = ev.t; }
    if (ev.type === 'session' && ev.phase === 'attention') lastAttentionT = ev.t;
  }

  const header = {
    title: full.session.title || (full.session.cwd ? full.session.cwd.split('/').filter(Boolean).pop() : null),
    agent: full.session.agent,
    cwd: full.session.cwd,
    phase: full.session.phase,
    since: sinceT, windowStart: winStart, windowEnd: winEnd,
    durationMs: Math.max(0, winEnd - winStart),
    activeMs, idleMs,
    commits: win.commits, add: win.add, del: win.del,
    cost: win.cost,
    events: live.length,
  };

  const inWin = ev => ev.t >= sinceT && ev.t <= winEnd;

  // SHIPPED — PRs whose REAL merge time falls in the window. First merge per
  // number wins (a re-recorded merge doesn't double-list).
  const shipped = [];
  const shippedSeen = new Set();
  for (const ev of live) {
    if (ev.type !== 'pr' || ev.state !== 'merged' || ev.number == null) continue;
    const mt = mergeTime(ev);
    if (mt < sinceT || mt > winEnd || shippedSeen.has(ev.number)) continue;
    shippedSeen.add(ev.number);
    const pr = full.prs.get(ev.number);
    shipped.push({
      number: ev.number,
      title: (pr && pr.title) || ev.title || null,
      url: (pr && pr.url) || ev.url || null,
      mergedAt: mt,
    });
  }
  shipped.sort((a, b) => b.mergedAt - a.mergedAt);

  // NEEDS YOU — the things that block the human, most-actionable first.
  const needsYou = [];
  if (full.session.phase === 'attention') {
    needsYou.push({ kind: 'attention', text: full.session.attentionText || 'permission or input requested', t: lastAttentionT });
  }
  for (const pr of prList(full)) {
    if (pr.state === 'open' && pr.ci === 'fail') {
      needsYou.push({ kind: 'blocked-pr', number: pr.number, title: pr.title, url: pr.url, ci: pr.ci, t: pr.t });
    }
  }
  // A card left in `doing` while the session isn't actively working was abandoned
  // mid-flight (Phase 1.6 will sweep these; until then the report surfaces them).
  const working = full.session.phase === 'working';
  for (const it of full.items.values()) {
    if (it.status === 'doing' && !working) {
      needsYou.push({ kind: 'abandoned', id: it.id, title: it.title || it.id, t: it.touchedAt });
    }
  }
  // The last thing it said, if it never came back to working — often an unanswered
  // question ("should I force-merge?") left hanging at the end of the shift.
  const stalled = full.session.phase === 'idle' || full.session.phase === 'attention' || full.session.phase === 'ended';
  if (stalled && lastSay) needsYou.push({ kind: 'lastword', text: lastSay, t: lastSayT });

  // STILL OPEN — open PRs (with CI + age) and unfinished plan items.
  const stillOpen = {
    prs: prList(full).filter(p => p.state === 'open').map(p => ({
      number: p.number, title: p.title, url: p.url, ci: p.ci || null,
      openedAt: p.openedAt, ageMs: Math.max(0, winEnd - (p.openedAt || winEnd)), t: p.t,
    })),
    todos: (full.todos || []).filter(t => !t.done).map(t => ({ text: t.text })),
  };

  // THE STORY — chapters split on silent gaps > 30min, within the window.
  const story = [];
  let chap = null, prevT = null;
  for (const ev of live) {
    if (!inWin(ev)) continue;
    if (chap == null || (prevT != null && ev.t - prevT > CHAPTER_GAP)) {
      chap = {
        start: ev.t, end: ev.t, _cards: new Set(), commits: 0, add: 0, del: 0,
        prsOpened: new Set(), prsMerged: new Set(), firstSay: null, lastSay: null, _files: new Set(),
      };
      story.push(chap);
    }
    if (ev.item != null) chap._cards.add(ev.item);
    if (ev.type === 'item' && ev.id != null) chap._cards.add(ev.id);
    if (ev.type === 'commit') { chap.commits++; chap.add += ev.add || 0; chap.del += ev.del || 0; }
    if (ev.type === 'edit' && ev.path) chap._files.add(ev.path);
    if (ev.type === 'pr' && ev.number != null) {
      if (ev.state === 'merged') chap.prsMerged.add(ev.number);
      else chap.prsOpened.add(ev.number);
    }
    if (ev.type === 'say' && ev.text) { if (chap.firstSay == null) chap.firstSay = ev.text; chap.lastSay = ev.text; }
    chap.end = ev.t;
    prevT = ev.t;
  }
  for (const c of story) {
    c.durationMs = Math.max(0, c.end - c.start);
    c.cards = [...c._cards].map(id => { const it = full.items.get(id); return it ? (it.title || it.id) : id; });
    c.files = [...c._files].map(p => p.split('/').filter(Boolean).pop() || p);
    c.prsOpened = [...c.prsOpened];
    c.prsMerged = [...c.prsMerged];
    delete c._cards; delete c._files;
  }

  const usage = (win.tokIn || win.tokOut || win.cacheTok)
    ? { tokIn: win.tokIn, tokOut: win.tokOut, cacheTok: win.cacheTok, cost: win.cost }
    : null;

  return { header, needsYou, shipped, stillOpen, story, usage };
}

// ------------------------------------------------------------------- rendering
// HTML is kept deliberately thin: string helpers + one function per section, all
// pure. The report links the board's own style.css (report styles live there too)
// so it reads as the same product. No client JS — deep links are plain anchors.

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const pad = n => String(n).padStart(2, '0');

function fmtClock(t) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDateTime(t) {
  const d = new Date(t);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${mon} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDur(ms) {
  if (!(ms > 0)) return '0m';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h >= 1) return m ? `${h}h ${m}m` : `${h}h`;
  if (m >= 1) return `${m}m`;
  return `${s}s`;
}

const num = n => (n || 0).toLocaleString('en-US');

function fmtCost(c) {
  if (!c) return '$0';
  return c >= 1 ? `$${c.toFixed(2)}` : `$${c.toFixed(3)}`;
}

// Deep link into replay at an exact moment: /?session=<id>&t=<ms>. app.js reads
// ?t= on load and scrubs there.
const deep = (sid, t) => `/?session=${encodeURIComponent(sid)}${t != null ? `&t=${t}` : ''}`;
const tstamp = (sid, t, label) => `<a class="rpt-t" href="${esc(deep(sid, t))}">${esc(label != null ? label : fmtClock(t))}</a>`;

function headerBlock(sid, m) {
  const h = m.header;
  const agent = h.agent ? `<span class="rpt-agent">${esc(h.agent)}</span>` : '';
  const win = `${fmtDateTime(h.windowStart)} → ${fmtDateTime(h.windowEnd)}`;
  const stats = [
    ['active', fmtDur(h.activeMs)],
    ['idle', fmtDur(h.idleMs)],
    ['commits', num(h.commits)],
    ['+lines', num(h.add)],
    ['−lines', num(h.del)],
    ['est. cost', fmtCost(h.cost)],
  ];
  return `<header class="rpt-shead">
    <h2 class="rpt-title">${esc(h.title || sid)}${agent}</h2>
    <div class="rpt-window">${esc(win)} · ${fmtDur(h.durationMs)}</div>
    <div class="rpt-stats">${stats.map(([l, v]) =>
      `<span class="rpt-stat"><b>${esc(v)}</b><i>${esc(l)}</i></span>`).join('')}</div>
  </header>`;
}

function needsYouBlock(sid, m) {
  const rows = m.needsYou.map(n => {
    if (n.kind === 'attention') {
      return `<li class="ny-attention"><span class="ny-tag">attention</span>` +
        `<span class="ny-body">${esc(n.text)}</span>${n.t != null ? tstamp(sid, n.t) : ''}</li>`;
    }
    if (n.kind === 'blocked-pr') {
      const link = n.url ? `<a href="${esc(n.url)}" class="ny-pr">#${n.number}</a>` : `<b class="ny-pr">#${n.number}</b>`;
      return `<li class="ny-blocked"><span class="ny-tag">CI blocked</span>` +
        `<span class="ny-body">${link} ${esc(n.title || '')}</span>${tstamp(sid, n.t)}</li>`;
    }
    if (n.kind === 'abandoned') {
      return `<li class="ny-abandoned"><span class="ny-tag">left in progress</span>` +
        `<span class="ny-body">${esc(n.title)}</span>${tstamp(sid, n.t)}</li>`;
    }
    if (n.kind === 'lastword') {
      return `<li class="ny-lastword"><span class="ny-tag">last word</span>` +
        `<span class="ny-body">“${esc(n.text)}”</span>${n.t != null ? tstamp(sid, n.t) : ''}</li>`;
    }
    return '';
  }).join('');
  const body = rows
    ? `<ul class="rpt-list ny-list">${rows}</ul>`
    : `<p class="rpt-empty">Nothing needs you.</p>`;
  return section('Needs you', m.needsYou.length, body, m.needsYou.length ? 'has-needs' : '');
}

function shippedBlock(sid, m) {
  if (!m.shipped.length) return section('Shipped', 0, `<p class="rpt-empty">Nothing merged in this window.</p>`);
  const rows = m.shipped.map(p => {
    const numHtml = p.url ? `<a href="${esc(p.url)}" class="sh-num">#${p.number}</a>` : `<b class="sh-num">#${p.number}</b>`;
    return `<li>${numHtml}<span class="sh-title">${esc(p.title || '')}</span>` +
      `<span class="sh-when">merged ${tstamp(sid, p.mergedAt, fmtDateTime(p.mergedAt))}</span></li>`;
  }).join('');
  const foot = `<p class="rpt-subtle">${num(m.header.commits)} commits · ` +
    `<span class="add">+${num(m.header.add)}</span> <span class="del">−${num(m.header.del)}</span> in window</p>`;
  return section('Shipped', m.shipped.length, `<ul class="rpt-list sh-list">${rows}</ul>${foot}`, 'has-shipped');
}

function stillOpenBlock(sid, m) {
  const o = m.stillOpen;
  if (!o.prs.length && !o.todos.length) return section('Still open', 0, `<p class="rpt-empty">Nothing open.</p>`);
  const ciChip = ci => ci
    ? `<span class="so-ci so-${esc(ci)}">${ci === 'pass' ? '✓' : ci === 'fail' ? '✗' : '⋯'} ${esc(ci)}</span>`
    : `<span class="so-ci so-unknown">open</span>`;
  const prRows = o.prs.map(p => {
    const numHtml = p.url ? `<a href="${esc(p.url)}" class="so-num">#${p.number}</a>` : `<b class="so-num">#${p.number}</b>`;
    return `<li>${ciChip(p.ci)}${numHtml}<span class="so-title">${esc(p.title || '')}</span>` +
      `<span class="so-age">${p.openedAt != null ? `${fmtDur(p.ageMs)} old ${tstamp(sid, p.openedAt)}` : ''}</span></li>`;
  }).join('');
  const todoRows = o.todos.map(t => `<li class="so-todo">${esc(t.text)}</li>`).join('');
  const body =
    (prRows ? `<ul class="rpt-list so-list">${prRows}</ul>` : '') +
    (todoRows ? `<h4 class="rpt-sub">Unfinished plan</h4><ul class="rpt-list so-todos">${todoRows}</ul>` : '');
  return section('Still open', o.prs.length + o.todos.length, body);
}

function storyBlock(sid, m) {
  if (!m.story.length) return section('The story', 0, `<p class="rpt-empty">No activity in this window.</p>`);
  const chapters = m.story.map((c, i) => {
    const meta = [];
    if (c.commits) meta.push(`${c.commits} commit${c.commits > 1 ? 's' : ''}`);
    if (c.add || c.del) meta.push(`<span class="add">+${num(c.add)}</span> <span class="del">−${num(c.del)}</span>`);
    if (c.prsMerged.length) meta.push(`merged ${c.prsMerged.map(n => '#' + n).join(', ')}`);
    if (c.prsOpened.length) meta.push(`opened ${c.prsOpened.map(n => '#' + n).join(', ')}`);
    const cards = c.cards.length
      ? `<div class="ch-cards">${c.cards.map(t => `<span class="ch-card">${esc(t)}</span>`).join('')}</div>` : '';
    const files = c.files.length
      ? `<div class="ch-files">${c.files.slice(0, 8).map(f => `<code>${esc(f)}</code>`).join(' ')}` +
        `${c.files.length > 8 ? ` <span class="rpt-subtle">+${c.files.length - 8} more</span>` : ''}</div>` : '';
    const says = [];
    if (c.firstSay) says.push(`<span class="ch-say">“${esc(c.firstSay)}”</span>`);
    if (c.lastSay && c.lastSay !== c.firstSay) says.push(`<span class="ch-say">“${esc(c.lastSay)}”</span>`);
    return `<div class="ch">
      <div class="ch-head"><span class="ch-n">${i + 1}</span>` +
      `<span class="ch-range">${tstamp(sid, c.start, fmtClock(c.start))} – ${tstamp(sid, c.end, fmtClock(c.end))}</span>` +
      `<span class="ch-dur">${fmtDur(c.durationMs)}</span></div>` +
      `${cards}${meta.length ? `<div class="ch-meta">${meta.join(' · ')}</div>` : ''}` +
      `${says.length ? `<div class="ch-says">${says.join('')}</div>` : ''}${files}</div>`;
  }).join('');
  return section('The story', m.story.length, `<div class="rpt-story">${chapters}</div>`);
}

function usageBlock(m) {
  const u = m.usage;
  if (!u) return '';
  const tok = (u.tokIn || 0) + (u.tokOut || 0) + (u.cacheTok || 0);
  return `<footer class="rpt-usage">${num(tok)} tokens · ` +
    `${num(u.tokIn)} in · ${num(u.tokOut)} out · ${num(u.cacheTok)} cached · ` +
    `<b>${fmtCost(u.cost)}</b> est. — <span class="rpt-subtle">approximate, local price table</span></footer>`;
}

function section(title, count, body, cls = '') {
  return `<section class="rpt-sec ${cls}">
    <h3 class="rpt-h">${esc(title)}${count ? `<span class="rpt-count">${count}</span>` : ''}</h3>
    ${body}
  </section>`;
}

function sessionBlock(sid, m) {
  return `<article class="rpt-session">
    ${headerBlock(sid, m)}
    ${needsYouBlock(sid, m)}
    ${shippedBlock(sid, m)}
    ${stillOpenBlock(sid, m)}
    ${storyBlock(sid, m)}
    ${usageBlock(m)}
  </article>`;
}

// sinceLinks: quick-window switcher (plain anchors — no JS). `q` carries the
// session param (empty for the fleet view).
function sinceLinks(q, active) {
  const opts = [['8h', '8h'], ['24h', '24h'], ['3d', '3d'], ['all', '0']];
  return `<nav class="rpt-since">${opts.map(([label, val]) =>
    `<a class="${active === val ? 'sel' : ''}" href="/report?${q}since=${val}">${label}</a>`).join('')}</nav>`;
}

// payload: { sessions: [{id, model}], sinceParam, single }.
export function renderReportHTML(payload) {
  const { sessions, sinceParam } = payload;
  const aggregate = sessions.length !== 1;
  const q = aggregate ? '' : `session=${encodeURIComponent(sessions[0].id)}&`;

  // Combined masthead numbers (across sessions in the fleet view).
  let commits = 0, add = 0, del = 0, cost = 0, shipped = 0, needs = 0, winStart = Infinity, winEnd = -Infinity;
  for (const { model } of sessions) {
    commits += model.header.commits; add += model.header.add; del += model.header.del;
    cost += model.header.cost; shipped += model.shipped.length; needs += model.needsYou.length;
    winStart = Math.min(winStart, model.header.windowStart);
    winEnd = Math.max(winEnd, model.header.windowEnd);
  }
  if (!isFinite(winStart)) { winStart = Date.now(); winEnd = Date.now(); }

  const summary = aggregate
    ? `<div class="rpt-fleet-sum">${sessions.length} sessions · ${shipped} shipped · ` +
      `${needs} need you · ${num(commits)} commits · <span class="add">+${num(add)}</span> ` +
      `<span class="del">−${num(del)}</span> · <b>${fmtCost(cost)}</b></div>`
    : '';

  const body = aggregate && !sessions.length
    ? `<p class="rpt-empty">No sessions served.</p>`
    : sessions.map(s => sessionBlock(s.id, s.model)).join('');

  const heading = aggregate ? 'Fleet Shift Report' : (sessions[0] ? esc(sessions[0].model.header.title || sessions[0].id) : 'Shift Report');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>shift report · nightshift</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M10 1.8 A6.6 6.6 0 1 0 14.6 8.4 A5.4 5.4 0 0 1 10 1.8 Z' fill='%23F0E2C0'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
</head>
<body class="report">
<header class="rpt-masthead">
  <a class="brand" href="${esc(aggregate ? '/' : deep(sessions[0].id))}" title="back to the board">
    <svg class="logo" width="16" height="16" viewBox="0 0 16 16"><path d="M10 1.8 A6.6 6.6 0 1 0 14.6 8.4 A5.4 5.4 0 0 1 10 1.8 Z" fill="#F0E2C0"/></svg>
    <span class="wordmark">nightshift</span>
  </a>
  <span class="crumb-sep">/</span>
  <span class="rpt-crumb">${heading}</span>
  <div class="rpt-mast-right">
    <span class="rpt-mast-window">${esc(fmtDateTime(winStart))} → ${esc(fmtDateTime(winEnd))}</span>
    ${sinceLinks(q, sinceParam)}
  </div>
</header>
<main class="rpt">
  ${summary}
  ${body}
</main>
</body>
</html>`;
}
