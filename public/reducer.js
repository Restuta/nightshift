// Pure fold over the event log. UI state is `fold(events, t)` — live mode is
// t = now, replay is any earlier t. No fetches, no Date.now(): purity over the
// log is what makes time travel work (see docs/EVENTS.md).

export const STATUSES = ['inbox', 'doing', 'pr', 'done'];

const FEED_CAP = 150;

// A single working gap longer than this is almost certainly the session
// sitting idle without an `idle` event (a missed Stop hook, say), not real
// work — cap each gap so one stuck window can't inflate a card's timer.
const ACTIVE_GAP_CAP = 30 * 60e3;

// Approximate USD per million tokens, matched by model-id substring. A local
// estimate, not a billing source of truth — update as prices move. Cache reads
// bill ~0.1× input; cache writes ~1.25×.
const PRICES = [
  [/opus/i, { in: 15, out: 75 }],
  [/sonnet/i, { in: 3, out: 15 }],
  [/haiku/i, { in: 0.8, out: 4 }],
  [/fable|mythos/i, { in: 5, out: 25 }],
  [/gpt-5|o[34]|codex/i, { in: 1.25, out: 10 }],
];
const DEFAULT_PRICE = { in: 3, out: 15 };

function priceFor(model) {
  if (model) for (const [re, p] of PRICES) if (re.test(model)) return p;
  return DEFAULT_PRICE;
}

function usageCost(ev) {
  const p = priceFor(ev.model);
  return (
    ((ev.in || 0) * p.in) +
    ((ev.out || 0) * p.out) +
    ((ev.cacheRead || 0) * p.in * 0.1) +
    ((ev.cacheWrite || 0) * p.in * 1.25)
  ) / 1e6;
}

export function initialState() {
  return {
    session: { title: null, startedAt: null, lastAt: null, phase: null, cwd: null, agent: null, attentionText: null },
    items: new Map(),
    todos: [],
    files: new Map(), // path → {edits, lastAt} — churn signal
    feed: [],
    totals: { add: 0, del: 0, commits: 0, edits: 0, events: 0, tokIn: 0, tokOut: 0, cacheTok: 0, cost: 0 },
  };
}

// Most recently touched item still in `doing` — the card the agent is on now.
function activeDoingItem(state) {
  let best = null;
  for (const it of state.items.values()) {
    if (it.status !== 'doing') continue;
    if (!best || (it.touchedAt || 0) > (best.touchedAt || 0)) best = it;
  }
  return best;
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
  // Accrue active work-time to the card in progress over the gap that just
  // elapsed — but only while the session was working. Idle/attention gaps
  // (waiting on the human) don't count, so a card's timer reflects time spent
  // on it, not wall-clock since it opened. Pure over the log, so the number is
  // the same live or in replay.
  if (state.session.lastAt != null && state.session.phase === 'working') {
    const dt = ev.t - state.session.lastAt;
    if (dt > 0) {
      const active = activeDoingItem(state);
      if (active) active.activeMs += Math.min(dt, ACTIVE_GAP_CAP);
    }
  }

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
          add: 0, del: 0, commits: 0, edits: 0, activeMs: 0,
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
      if (ev.path) {
        const f = state.files.get(ev.path) || { edits: 0, lastAt: 0 };
        f.edits++;
        f.lastAt = ev.t;
        state.files.set(ev.path, f);
      }
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

    case 'usage': {
      // Token accounting, emitted per model turn (mostly by the importer —
      // live hooks have no token visibility). Drives the masthead meters.
      state.totals.tokIn += ev.in || 0;
      state.totals.tokOut += ev.out || 0;
      state.totals.cacheTok += (ev.cacheRead || 0) + (ev.cacheWrite || 0);
      state.totals.cost += usageCost(ev);
      break;
    }

    // 'note' and unknown types land in the feed only (forward compatibility).
  }

  // Usage events are frequent and machine-ish — they feed the meters, not the
  // human-readable activity tape.
  if (ev.type !== 'usage') {
    state.feed.unshift(ev);
    if (state.feed.length > FEED_CAP) state.feed.length = FEED_CAP;
  }
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

// Files an agent keeps coming back to — the visual signature of flailing.
// Pure over state, so live and replay agree. Tiers: 3+ warm, 5+ hot, 8+ churn.
export function hotFiles(state, min = 3, cap = 5) {
  return [...state.files.entries()]
    .filter(([, f]) => f.edits >= min)
    .sort((a, b) => b[1].edits - a[1].edits || b[1].lastAt - a[1].lastAt)
    .slice(0, cap)
    .map(([path, f]) => ({ path, ...f, tier: f.edits >= 8 ? 'churn' : f.edits >= 5 ? 'hot' : 'warm' }));
}

// The card whose todo drill-in is expanded: most recently touched `doing` item.
export function activeItemId(state) {
  const it = activeDoingItem(state);
  return it ? it.id : null;
}
