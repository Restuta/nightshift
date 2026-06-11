// Pure fold over the event log. UI state is `fold(events, t)` — live mode is
// t = now, replay is any earlier t. No fetches, no Date.now(): purity over the
// log is what makes time travel work (see docs/EVENTS.md).

export const STATUSES = ['inbox', 'doing', 'pr', 'done'];

const FEED_CAP = 150;

export function initialState() {
  return {
    session: { title: null, startedAt: null, lastAt: null, phase: null, cwd: null, agent: null, attentionText: null },
    items: new Map(),
    todos: [],
    feed: [],
    totals: { add: 0, del: 0, commits: 0, edits: 0, events: 0 },
  };
}

// Events usually arrive unattributed (hooks don't know which card they belong
// to). Explicit `ev.item` wins; PR/CI events match by PR number; otherwise the
// most recently touched item in `doing` takes them.
function targetItem(state, ev) {
  if (ev.item && state.items.has(ev.item)) return state.items.get(ev.item);
  const prNum = ev.type === 'ci' ? ev.pr : ev.type === 'pr' ? ev.number : null;
  if (prNum != null) {
    for (const it of state.items.values()) {
      if (it.pr && it.pr.number === prNum) return it;
    }
  }
  let best = null;
  for (const it of state.items.values()) {
    if (it.status !== 'doing') continue;
    if (!best || (it.touchedAt || 0) > (best.touchedAt || 0)) best = it;
  }
  return best;
}

export function reduce(state, ev) {
  state.totals.events++;
  state.session.lastAt = ev.t;

  switch (ev.type) {
    case 'session': {
      if (ev.title != null) state.session.title = ev.title;
      if (ev.cwd != null) state.session.cwd = ev.cwd;
      if (ev.agent != null) state.session.agent = ev.agent;
      if (ev.phase === 'start' || ev.phase === 'resume') {
        if (state.session.startedAt == null) state.session.startedAt = ev.t;
        state.session.phase = 'working';
        state.session.attentionText = null;
      } else if (ev.phase === 'attention') {
        state.session.phase = 'attention';
        state.session.attentionText = ev.text || null;
      } else if (ev.phase === 'idle') {
        state.session.phase = 'idle';
        state.session.attentionText = null;
      } else if (ev.phase === 'end') {
        state.session.phase = 'ended';
        state.session.attentionText = null;
      }
      break;
    }

    case 'item': {
      if (!ev.id) break;
      let it = state.items.get(ev.id);
      if (!it) {
        it = {
          id: ev.id, title: '', status: 'inbox', note: null, emoji: null,
          add: 0, del: 0, commits: 0, edits: 0,
          todos: null, pr: null, ci: null,
          createdAt: ev.t, touchedAt: ev.t,
        };
        state.items.set(ev.id, it);
      }
      if (ev.title != null) it.title = ev.title;
      if (ev.status != null && STATUSES.includes(ev.status)) it.status = ev.status;
      if (ev.note != null) it.note = ev.note;
      if (ev.emoji != null) it.emoji = ev.emoji;
      it.touchedAt = ev.t;
      break;
    }

    case 'todos': {
      const todos = (ev.todos || []).map(td => ({ text: td.text, done: !!td.done }));
      state.todos = todos;
      const it = targetItem(state, ev);
      if (it) { it.todos = todos; it.touchedAt = ev.t; }
      break;
    }

    case 'edit': {
      state.totals.edits++;
      const it = targetItem(state, ev);
      if (it) { it.edits++; it.touchedAt = ev.t; }
      // Tool activity means the request was answered — clear the alarm.
      if (state.session.phase === 'attention') {
        state.session.phase = 'working';
        state.session.attentionText = null;
      }
      break;
    }

    case 'commit': {
      state.totals.commits++;
      state.totals.add += ev.add || 0;
      state.totals.del += ev.del || 0;
      const it = targetItem(state, ev);
      if (it) {
        it.commits++;
        it.add += ev.add || 0;
        it.del += ev.del || 0;
        it.touchedAt = ev.t;
      }
      if (state.session.phase === 'attention') {
        state.session.phase = 'working';
        state.session.attentionText = null;
      }
      break;
    }

    case 'pr': {
      const it = targetItem(state, ev);
      if (it) {
        it.pr = {
          number: ev.number, state: ev.state || 'open',
          url: ev.url || null, title: ev.title || null,
        };
        // PR lifecycle advances the card on its own — hooks-only sessions
        // still get column movement without the agent emitting item events.
        if (ev.state === 'open' && (it.status === 'inbox' || it.status === 'doing')) it.status = 'pr';
        if (ev.state === 'merged') it.status = 'done';
        it.touchedAt = ev.t;
      }
      break;
    }

    case 'ci': {
      const it = targetItem(state, ev);
      if (it) { it.ci = ev.status; it.touchedAt = ev.t; }
      break;
    }

    // 'note' and unknown types land in the feed only (forward compatibility).
  }

  state.feed.unshift(ev);
  if (state.feed.length > FEED_CAP) state.feed.length = FEED_CAP;
  return state;
}

export function fold(events, untilT = Infinity) {
  const state = initialState();
  for (const ev of events) {
    if (ev.t > untilT) break;
    reduce(state, ev);
  }
  return state;
}

// The card whose todo drill-in is expanded: most recently touched `doing` item.
export function activeItemId(state) {
  let best = null;
  for (const it of state.items.values()) {
    if (it.status !== 'doing') continue;
    if (!best || (it.touchedAt || 0) > (best.touchedAt || 0)) best = it;
  }
  return best ? best.id : null;
}
