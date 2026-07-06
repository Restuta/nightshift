// /story — the chaptered recap of a whole session: open it in the morning and
// understand the night in a minute. A one-shot read-only view (like /lanes):
// fetch the tape once, fold it twice — the pure reducer for the header, the pure
// digest for the narrative — lay the chapters out with story-model, and render.
// This file stays thin: fetch, fold, render, format. Every derivation with
// judgment in it lives in digest.js / story-model.js where it is tested.
//
// ?t=<ms> renders "the story so far" at that moment (untilT into buildDigest) —
// the page never fabricates facts from wall-clock now; Date is used only to
// FORMAT recorded timestamps.

import { fold } from './reducer.js';
import { buildDigest } from './digest.js';
import { buildStoryBlocks, activeSegments } from './story-model.js';
import { dayBoundaries } from './lanes-model.js';
import { initSessionPicker } from './session-picker.js';

const $ = sel => document.querySelector(sel);

let sessionId = new URLSearchParams(location.search).get('session');
let untilT = (() => {
  const raw = new URLSearchParams(location.search).get('t');
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : Infinity;
})();
let sessionsMeta = [];
let loadSeq = 0;        // stale async guard — only the newest load may render

// ------------------------------------------------------------------ format
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const clockT = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayLabel = t => { const d = new Date(t); return `${DOW[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}`; };
const dateTime = t => { const d = new Date(t); return `${MON[d.getMonth()]} ${d.getDate()} ${clockT(t)}`; };

// Decimal hours everywhere ("9.1h"), minutes under an hour — the ledger, gap
// separators, and chapter durations all speak the same unit.
function fmtSpan(ms) {
  if (!(ms > 0)) return '0m';
  const h = ms / 3600e3;
  if (h >= 1) return `${h.toFixed(1)}h`;
  const m = Math.floor(ms / 60e3);
  return m >= 1 ? `${m}m` : `${Math.floor(ms / 1000)}s`;
}
const fmtCount = n => n >= 10000 ? `${Math.round(n / 1000)}k`
  : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0);
const truncate = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// Deep link into board replay at an exact recorded moment — the through-line
// shared with /report: every claim on this page is one click from the evidence.
const replayHref = t => `/?session=${encodeURIComponent(sessionId)}&t=${Math.round(t)}`;

// --------------------------------------------------------------- data load
async function load() {
  const picker = await initSessionPicker({
    mount: $('#session-picker'),
    currentId: sessionId,
    onSelect: id => {
      const p = new URLSearchParams(location.search);
      p.set('session', id);
      p.delete('t');            // a scrub time is meaningless on another tape
      untilT = Infinity;
      history.replaceState(null, '', '?' + p.toString());
      loadSession(id);
    },
  });
  sessionsMeta = picker.sessions;
  if (picker.multi) $('#session-title').hidden = true;
  await loadSession(picker.current);
}

async function loadSession(id) {
  sessionId = id;
  const seq = ++loadSeq;
  const q = sessionId ? '?session=' + encodeURIComponent(sessionId) : '';
  let text = '';
  try { text = await (await fetch('/events' + q)).text(); } catch { text = ''; }
  if (seq !== loadSeq) return;   // a newer load superseded this one
  const events = text.split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(ev => ev && typeof ev.t === 'number' && typeof ev.type === 'string');

  const state = fold(events);
  const meta = sessionsMeta.find(s => s.id === sessionId) || null;
  const title = state.session.title || (meta && meta.title) || sessionId || 'session';
  document.title = `story — ${title}`;
  $('#session-title').textContent = title;
  const agent = state.session.agent || (meta && meta.agent);
  const badge = $('#agent-badge');
  badge.hidden = !agent;
  if (agent) { badge.textContent = agent; badge.className = 'agent-badge agent-' + agent; }
  updateNav();

  const digest = buildDigest(events, untilT);
  render(digest);
}

function updateNav() {
  const q = '?session=' + encodeURIComponent(sessionId || '');
  $('#home-link').href = '/' + q;
  $('#nav-board').href = '/' + q;
  $('#nav-lanes').href = '/lanes' + q;
  $('#nav-graph').href = '/graph' + q;
  $('#nav-report').href = '/report' + q;
  const pill = $('#asof-pill');
  pill.hidden = !Number.isFinite(untilT);
  if (!pill.hidden) {
    pill.textContent = `as of ${dateTime(untilT)}`;
    pill.href = '/story' + q;
  }
}

// ------------------------------------------------------------------ render
function render(digest) {
  const empty = !digest.chapters.length;
  $('#story-empty').hidden = !empty;
  $('#ledger').hidden = empty;
  $('#chapters').hidden = empty;
  if (empty) return;
  $('#ledger').innerHTML = ledgerHTML(digest);
  const ep = digest.totals.episodes, bt = digest.totals.beats;
  $('#chapters-head').innerHTML =
    `chapters <span class="chn">${digest.chapters.length}</span>` +
    `<span class="chapters-mix">${ep} episode${ep === 1 ? '' : 's'} · ${bt} beat${bt === 1 ? '' : 's'}</span>`;
  $('#blocks').innerHTML = buildStoryBlocks(digest.chapters, digest.gaps)
    .map(blockHTML).join('');
}

// The ledger: wall vs active as the hero (active is the honest number — wall
// includes every hour the human slept), a wall-clock strip of activity bursts,
// then the countable facts.
function ledgerHTML(d) {
  const t = d.totals;
  const stats = [
    [String(t.prompts), 'prompts'],
    [String(t.prsMerged), 'PRs merged'],
    [String(t.commits), 'commits'],
    [fmtCount(t.edits), 'edits'],
  ];
  let add = 0, del = 0;
  for (const ch of d.chapters) for (const c of ch.commits) { add += c.add || 0; del += c.del || 0; }
  const lines = (add || del)
    ? `<span class="lstat"><b><em class="add">+${fmtCount(add)}</em> <em class="del">−${fmtCount(del)}</em></b><i>lines</i></span>`
    : '';
  return `<div class="ledger-hero">
      <div class="lh-time">
        <b class="lh-num">${fmtSpan(d.wallMs)}</b><span class="lh-lab">wall</span>
        <span class="lh-dot">·</span>
        <b class="lh-num lh-active">${fmtSpan(d.activeMs)}</b><span class="lh-lab">active</span>
      </div>
      <div class="lh-range">${esc(dateTime(d.startT))} → ${esc(dateTime(d.endT))}</div>
    </div>
    ${stripHTML(d)}
    <div class="ledger-stats">
      ${stats.map(([v, l]) => `<span class="lstat"><b>${v}</b><i>${l}</i></span>`).join('')}
      ${lines}
    </div>`;
}

// Thin activity strip: amber bursts on a quiet track — the same working/idle
// palette as the /lanes session lane, so the two views read as one instrument.
// Pure DOM; x is a percentage of the recorded wall span.
function stripHTML(d) {
  const span = Math.max(1, d.endT - d.startT);
  const px = t => ((t - d.startT) / span * 100).toFixed(3) + '%';
  const segs = activeSegments(d.startT, d.endT, d.gaps).map(s =>
    `<i class="strip-seg" style="left:${px(s.fromT)};width:${(Math.max(0.15, (s.toT - s.fromT) / span * 100)).toFixed(3)}%"></i>`).join('');
  const days = dayBoundaries(d.startT, d.endT);
  const ticks = days.map(m => `<i class="strip-tick" style="left:${px(m)}"></i>`).join('');
  const labels = days.map(m =>
    `<span class="strip-daylab" style="left:${px(m)}">${esc(`${MON[new Date(m).getMonth()]} ${new Date(m).getDate()}`)}</span>`).join('');
  return `<div class="strip" title="active bursts vs idle, over the wall clock">
      <div class="strip-track">${segs}${ticks}</div>
      ${days.length ? `<div class="strip-days">${labels}</div>` : ''}
    </div>`;
}

function blockHTML(b) {
  if (b.kind === 'gap') {
    return `<div class="story-gap"><i></i><span>⏸ ${fmtSpan(b.ms)} idle</span><i></i></div>`;
  }
  if (b.kind === 'day') {
    return `<div class="story-day"><span>${esc(dayLabel(b.t))}</span><i></i></div>`;
  }
  if (b.kind === 'beats') return beatsHTML(b.chapters);
  return episodeHTML(b.chapter);
}

// Episode card — the unit of real work. The prompt is the title, VERBATIM: what
// the human asked for is the only honest name for what happened next.
function episodeHTML(ch) {
  const chips = ch.prs.map(prChipHTML).join('');
  const meta = [];
  if (ch.counts.commits) {
    let add = 0, del = 0;
    for (const c of ch.commits) { add += c.add || 0; del += c.del || 0; }
    meta.push(`${ch.counts.commits} commit${ch.counts.commits === 1 ? '' : 's'}`);
    if (add || del) meta.push(`<em class="add">+${fmtCount(add)}</em> <em class="del">−${fmtCount(del)}</em>`);
  }
  if (ch.counts.edits) meta.push(`${fmtCount(ch.counts.edits)} edits`);
  const closer = ch.closer && ch.closer.text.trim()
    ? `<blockquote class="ep-closer" title="the agent's last word in this chapter">${esc(ch.closer.text.trim())}</blockquote>`
    : '';
  return `<article class="ep" data-t="${ch.startT}">
    <header class="ep-head">
      <a class="t-link" href="${esc(replayHref(ch.startT))}">${clockT(ch.startT)}</a>
      ${ch.label ? `<span class="ep-turn">${esc(ch.label)}</span>` : ''}
      <span class="ep-durs">${durText(ch)}</span>
    </header>
    <h4 class="ep-title">${esc(ch.title)}</h4>
    ${chips ? `<div class="ep-chips">${chips}</div>` : ''}
    ${meta.length ? `<div class="ep-meta">${meta.join(' · ')}</div>` : ''}
    ${closer}
  </article>`;
}

// Active is the meaningful duration; wall appears only when idle inflated the
// window enough to mislead (> 5min difference).
function durText(ch) {
  if (ch.wallMs - ch.activeMs < 5 * 60e3) return fmtSpan(ch.wallMs);
  return `<b>${fmtSpan(ch.activeMs)} active</b> · ${fmtSpan(ch.wallMs)} wall`;
}

// Digest PRs carry no url (the tape may not have recorded one), so the chip is a
// replay link to the PR's decisive moment — merge if it merged, else open.
function prChipHTML(pr) {
  const state = pr.state || 'open';
  const at = pr.mergedT != null ? pr.mergedT : (pr.openedT != null ? pr.openedT : null);
  const cycle = pr.mergedT != null && pr.openedT != null
    ? `<i>${fmtSpan(pr.mergedT - pr.openedT)}</i>` : '';
  const label = `#${pr.number} — ${state}${pr.title ? ' — ' + pr.title : ''}`;
  const body = `<b>#${pr.number}</b><span>${esc(truncate(pr.title, 36))}</span>${cycle}`;
  if (at == null) return `<span class="prchip pr-${esc(state)}" title="${esc(label)}">${body}</span>`;
  return `<a class="prchip pr-${esc(state)}" href="${esc(replayHref(at))}" title="${esc(label + ' — click to replay')}">${body}</a>`;
}

// Beat run — conversation, not work. One quiet line per prompt with the agent's
// reply riding along; the single-line ellipsis keeps the run tight, and the
// recorder caps say-text anyway, so the visible head of the reply is its gist.
function beatsHTML(chapters) {
  const rows = chapters.map(b => {
    const replyText = b.closer ? b.closer.text.trim() : '';
    const reply = replyText
      ? `<span class="beat-reply"> — ${esc(truncate(replyText, 200))}</span>` : '';
    return `<div class="beat" data-t="${b.startT}">
      <a class="t-link" href="${esc(replayHref(b.startT))}">${clockT(b.startT)}</a>
      <p class="beat-line"><span class="beat-prompt">${esc(b.title)}</span>${reply}</p>
    </div>`;
  }).join('');
  return `<div class="beats">${rows}</div>`;
}

// ------------------------------------------------------------ interactions
// A chapter is a link into replay at its opening moment; inner anchors (time
// stamps, PR chips) keep their own more precise targets.
$('#blocks').addEventListener('click', e => {
  if (e.target.closest('a')) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;   // copying a prompt is not a navigation
  const el = e.target.closest('[data-t]');
  if (el) location.href = replayHref(Number(el.dataset.t));
});

// v1 live-follow: one-shot render, refreshed when the tab becomes visible again
// — the "open in the morning" moment. No SSE here.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && sessionId) loadSession(sessionId);
});

load();
