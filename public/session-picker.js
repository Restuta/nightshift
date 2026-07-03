// Shared session switcher — the masthead popover that lets you change sessions
// without leaving a view. Extracted from app.js so the board, /graph and /lanes
// all get the SAME filterable picker (type to narrow, freshest first, live/
// recent/stale dot) instead of each reinventing it.
//
// initSessionPicker({ mount, currentId, onSelect }) fetches /sessions, renders
// the button + menu into `mount` (same class names + ids as the board, so
// style.css applies untouched), owns ALL popover behavior (open/close, filter,
// Esc, Enter-picks-first, click-outside), and calls onSelect(id) when the user
// picks a different tape. What "switch" means is the caller's concern: the board
// reconnects its SSE, /graph and /lanes tear down and rebuild their model. No
// page reload anywhere.

import { sessionLabel, freshness } from './session-label.js';

const esc = s => String(s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Compact age wording — matches app.js / fleet.js ageText (s / m / h m).
function ageText(ms) {
  if (ms < 0 || !isFinite(ms)) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// live (🟢 <90s) / recent (🟡 <30m) / stale (⚪) dot — keyed off the SAME
// freshness thresholds as the Fleet honesty dot (session-label.js), so the
// picker and Fleet never disagree about how fresh a tape is. Pure.
export function sessionMark(lastT, now) {
  const f = freshness(lastT, now);
  return f === 'live' ? '🟢' : f === 'recent' ? '🟡' : '⚪';
}

// Freshest first — the ordering every session list shares. Pure (returns a copy).
export function sortSessions(list) {
  return list.slice().sort((a, b) => (b.lastT || 0) - (a.lastT || 0));
}

// The current session id, read from the shared ?session= URL convention. Used to
// light the matching row in the menu (kept in sync by the caller's replaceState).
const urlSessionId = () => new URLSearchParams(location.search).get('session');

const MENU_MARKUP = `
  <button class="session-select" id="session-btn" type="button" aria-haspopup="listbox" aria-expanded="false">
    <span id="session-btn-label">no session</span>
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
  </button>
  <div class="session-menu" id="session-menu" hidden>
    <input type="text" id="session-filter" placeholder="Filter sessions…" autocomplete="off" spellcheck="false">
    <ul id="session-list" role="listbox"></ul>
  </div>`;

// Mount the picker. Returns { sessions, current, multi, setLabel } so the caller
// can resolve which tape to open (current) and whether to reveal the picker over
// the plain title (multi). `mount` must be a `.session-picker` element.
export async function initSessionPicker({ mount, currentId, onSelect }) {
  let sessions = [];
  try { sessions = await (await fetch('/sessions')).json(); } catch { sessions = []; }
  if (!Array.isArray(sessions)) sessions = [];
  sessions = sortSessions(sessions);

  // The tape the view should open: the requested one if it's served, else the
  // freshest, else the requested id (single-log server serves it without listing).
  const current = (sessions.find(s => s.id === currentId) || sessions[0] || {}).id
    || currentId || 'default';

  mount.innerHTML = MENU_MARKUP;
  mount.hidden = sessions.length <= 1;   // a lone tape needs no switcher

  const btn = mount.querySelector('#session-btn');
  const btnLabel = mount.querySelector('#session-btn-label');
  const menu = mount.querySelector('#session-menu');
  const input = mount.querySelector('#session-filter');
  const list = mount.querySelector('#session-list');

  const setLabel = id => {
    const s = sessions.find(x => x.id === id);
    btnLabel.textContent = s ? sessionLabel(s) : (id || 'no session');
  };

  function renderMenu(filter) {
    const now = Date.now();
    const q = (filter || '').trim().toLowerCase();
    const cur = urlSessionId();
    const rows = sessions.filter(s =>
      !q || sessionLabel(s).toLowerCase().includes(q) || (s.agent || '').toLowerCase().includes(q));
    list.innerHTML = rows.map(s =>
      `<li role="option" data-id="${esc(s.id)}" class="${s.id === cur ? 'sel' : ''}">` +
      `<span class="sm-dot">${sessionMark(s.lastT || 0, now)}</span>` +
      `<span class="sm-label">${esc(sessionLabel(s))}</span>` +
      `<span class="sm-meta">${s.agent ? esc(s.agent) + ' · ' : ''}${ageText(now - (s.lastT || now))} ago</span>` +
      `</li>`).join('') || '<li class="sm-empty">no matches</li>';
  }

  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const open = () => {
    renderMenu('');
    input.value = '';
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    input.focus();
  };

  btn.addEventListener('click', e => { e.stopPropagation(); menu.hidden ? open() : close(); });
  input.addEventListener('input', () => renderMenu(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { close(); btn.focus(); }
    if (e.key === 'Enter') { const first = list.querySelector('li[data-id]'); if (first) first.click(); }
  });
  list.addEventListener('click', e => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const id = li.dataset.id;
    setLabel(id);
    close();
    onSelect(id);
  });
  document.addEventListener('click', e => { if (!mount.contains(e.target)) close(); });

  setLabel(current);
  return { sessions, current, multi: sessions.length > 1, setLabel };
}
