// Fleet home — the aggregate view over every recorded session. Plain fetch of
// /api/fleet (folded server-side, cached by mtime), sorted needs-input-first,
// diff-rendered into a dense Linear-like table, and re-polled every ~15s. No SSE
// and no fold on the client: the server already did the fold, so this page only
// sorts and paints. Zero deps.

import { sessionLabel } from './session-label.js';

const $ = sel => document.querySelector(sel);

const POLL_MS = 15000;

const esc = s => String(s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Same age wording as the board (app.js ageText): compact s / m / h m.
function ageText(ms) {
  if (ms < 0 || !isFinite(ms)) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function costText(c) {
  if (!c) return '$0';
  return c >= 1 ? `$${c.toFixed(2)}` : `$${c.toFixed(3)}`;
}

const AGENT_GLYPH = { claude: '✳', codex: '⬢' };
const FRESH_TITLE = {
  live: 'live — an event landed in the last 90s',
  recent: 'recent — quiet for under 30m',
  stale: 'stale — no events in over 30m',
};

// Sort: needs-input first, then live by recency, then the rest by recency.
// A stable numeric rank (0/1/2) keyed off needsInput + freshness, ties broken by
// most-recent event, gives exactly that ordering.
function rank(r) {
  if (r.needsInput) return 0;
  if (r.freshness === 'live') return 1;
  return 2;
}
function sortRows(rows) {
  return rows.slice().sort((a, b) =>
    rank(a) - rank(b) || (b.lastEventAt || 0) - (a.lastEventAt || 0));
}

// ---------------------------------------------------------------- aggregate

function renderAgg(rows, now) {
  let live = 0, stale = 0, merged24 = 0, failing = 0, cost = 0;
  for (const r of rows) {
    if (r.freshness === 'live') live++;
    else if (r.freshness === 'stale') stale++;
    merged24 += r.mergedRecent || 0;
    failing += r.failingCI || 0;
    cost += r.cost || 0;
  }
  const stat = (val, label, cls = '') =>
    `<span class="fa-stat"><b class="${cls}">${val}</b><span>${label}</span></span>`;
  $('#fleet-agg').innerHTML =
    stat(rows.length, rows.length === 1 ? 'session' : 'sessions') +
    stat(live, 'live', 'fa-live') +
    (stale ? stat(stale, 'stale', 'fa-stale') : '') +
    stat(merged24, 'merged 24h', 'fa-merged') +
    (failing ? stat(failing, 'CI failing', 'fa-fail') : '') +
    stat(costText(cost), 'est. cost', 'fa-cost');
}

// ------------------------------------------------------------------- rows

const rowEls = new Map();     // id → row element
const rowsBox = $('#fleet-rows');

function prChips(r) {
  const chips = [];
  if (r.openPRs) chips.push(`<span class="chip chip-open" title="${r.openPRs} open PR${r.openPRs > 1 ? 's' : ''}">${r.openPRs} open</span>`);
  if (r.mergedPRs) chips.push(`<span class="chip chip-merged" title="${r.mergedPRs} merged PR${r.mergedPRs > 1 ? 's' : ''}">${r.mergedPRs} merged</span>`);
  if (r.failingCI) chips.push(`<span class="chip chip-fail" title="${r.failingCI} PR${r.failingCI > 1 ? 's' : ''} with failing CI">${r.failingCI} ci-fail</span>`);
  return chips.join('');
}

function makeRow(r) {
  const el = document.createElement('div');
  el.className = 'fleet-row';
  el.dataset.id = r.id;
  el.innerHTML =
    '<span class="fr-dot"></span>' +
    '<div class="fr-id"><span class="fr-name"></span><span class="fr-agent"></span><span class="fr-flare"></span></div>' +
    '<div class="fr-say"></div>' +
    '<div class="fr-prs"></div>' +
    '<div class="fr-cost"></div>' +
    '<div class="fr-age"></div>' +
    '<a class="fr-graph" title="open the work-structure graph for this session">graph</a>' +
    '<a class="fr-report" title="open the shift report for this session">report</a>';
  // The whole row is a link to that session on the board; the graph + report links
  // are the exceptions (they open other views), so they stop the row's navigation.
  el.addEventListener('click', () => {
    location.href = '/?session=' + encodeURIComponent(el.dataset.id);
  });
  el.querySelector('.fr-report').addEventListener('click', e => e.stopPropagation());
  el.querySelector('.fr-graph').addEventListener('click', e => e.stopPropagation());
  el._refs = {
    dot: el.querySelector('.fr-dot'),
    name: el.querySelector('.fr-name'),
    agent: el.querySelector('.fr-agent'),
    flare: el.querySelector('.fr-flare'),
    say: el.querySelector('.fr-say'),
    prs: el.querySelector('.fr-prs'),
    cost: el.querySelector('.fr-cost'),
    age: el.querySelector('.fr-age'),
    graph: el.querySelector('.fr-graph'),
    report: el.querySelector('.fr-report'),
  };
  return el;
}

function updateRow(el, r, now) {
  const R = el._refs;
  el.classList.toggle('needs-input', !!r.needsInput);
  el.classList.toggle('is-stale', r.freshness === 'stale');

  R.dot.className = `fr-dot fr-${r.freshness}`;
  R.dot.title = FRESH_TITLE[r.freshness] || r.freshness;

  const label = r.label || sessionLabel({ id: r.id, cwd: r.cwd, title: r.title });
  R.name.textContent = label;
  R.name.title = label + (r.cwd ? ` · ${r.cwd}` : '');

  if (r.agent) {
    R.agent.hidden = false;
    R.agent.textContent = `${AGENT_GLYPH[r.agent] || '◇'} ${r.agent}`;
    R.agent.className = `fr-agent agent-${r.agent}`;
  } else {
    R.agent.hidden = true;
  }

  // The needs-input flare: a loud pill next to the label when the agent is
  // blocked on the human, so a session that needs you can't be scrolled past.
  if (r.needsInput) {
    R.flare.hidden = false;
    R.flare.textContent = 'needs input';
  } else {
    R.flare.hidden = true;
  }

  // The narrative cell: the question it's blocked on if it needs you, else the
  // latest narration line.
  if (r.needsInput && r.needsInputText) {
    R.say.textContent = r.needsInputText;
    R.say.className = 'fr-say fr-say-ask';
    R.say.title = r.needsInputText;
  } else if (r.lastSay) {
    R.say.textContent = r.lastSay;
    R.say.className = 'fr-say';
    R.say.title = r.lastSay;
  } else {
    R.say.textContent = '';
    R.say.className = 'fr-say';
    R.say.removeAttribute('title');
  }

  R.prs.innerHTML = prChips(r);
  R.cost.textContent = costText(r.cost);
  R.age.textContent = r.lastEventAt ? ageText(now - r.lastEventAt) : '';
  R.age.title = r.span ? `ran ${ageText(r.span)}` : '';
  R.graph.href = '/graph?session=' + encodeURIComponent(r.id);
  R.report.href = '/report?session=' + encodeURIComponent(r.id);
}

function render(rows) {
  const now = Date.now();
  const sorted = sortRows(rows);
  renderAgg(rows, now);

  $('#fleet-head').hidden = sorted.length === 0;
  $('#fleet-empty').hidden = sorted.length !== 0;

  const seen = new Set();
  sorted.forEach((r, idx) => {
    seen.add(r.id);
    let el = rowEls.get(r.id);
    if (!el) { el = makeRow(r); rowEls.set(r.id, el); }
    updateRow(el, r, now);
    // Reorder in place so unchanged rows don't flash — only move a node that's
    // not already at its slot.
    if (rowsBox.children[idx] !== el) rowsBox.insertBefore(el, rowsBox.children[idx] || null);
  });
  for (const [id, el] of rowEls) {
    if (!seen.has(id)) { el.remove(); rowEls.delete(id); }
  }
}

// --------------------------------------------------------------- transport

async function poll() {
  try {
    const rows = await (await fetch('/api/fleet')).json();
    if (Array.isArray(rows)) render(rows);
  } catch { /* keep the last paint; try again next tick */ }
}

poll();
setInterval(poll, POLL_MS);
// A tab returning from the background repaints at once rather than waiting out
// the interval (freshness ages while you were away).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') poll();
});
