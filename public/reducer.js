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
    todos: [],            // full current plan (session-scoped) → the sidebar Plan panel
    stepTimes: new Map(), // step text → {firstSeenAt, startedAt, doneAt}
    todoPrev: new Map(),  // step text → status at the previous snapshot (for per-turn deltas)
    files: new Map(), // path → {edits, lastAt} — churn signal
    prs: new Map(),   // pr number → {number, state, url, title, ci, openedAt} — the PR panel
    feed: [],
    totals: { add: 0, del: 0, commits: 0, edits: 0, events: 0, tokIn: 0, tokOut: 0, cacheTok: 0, cost: 0 },
  };
}

// Any agent activity means the session is live again. Codex fires task_complete
// at the end of every internal task, so in an autonomous run (no human prompts
// to "resume") the badge would otherwise stick on idle while the agent keeps
// working — this flips it back on the next edit/command/plan/commit.
function awake(state) {
  if (state.session.phase === 'idle' || state.session.phase === 'attention') {
    state.session.phase = 'working';
    state.session.attentionText = null;
  }
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

// True when a card has a linked PR that hasn't merged/closed yet. A turn
// boundary (Stop / next prompt) marks a card 'done', but if its PR is still
// open the work hasn't actually shipped — defer 'done' to the PR lifecycle.
function prStillOpen(state, it) {
  if (!it.pr || it.pr.number == null) return false;
  const pr = state.prs.get(it.pr.number);
  const prState = (pr && pr.state) || it.pr.state;
  return prState === 'open';
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
          delta: null, pr: null, ci: null,
          createdAt: ev.t, touchedAt: ev.t,
        };
        state.items.set(ev.id, it);
      }
      if (ev.title != null) it.title = ev.title;
      if (ev.status != null && STATUSES.includes(ev.status)) {
        // A card can't be 'done' while its PR is still open — its CI may still
        // be running. Park it in 'pr'; the PR's own merge/close (handled below,
        // matched by number) carries it to 'done'. Without this a turn jumps to
        // Done the instant the agent stops talking, mid-flight work and all.
        it.status = (ev.status === 'done' && prStillOpen(state, it)) ? 'pr' : ev.status;
      }
      if (ev.note != null) it.note = ev.note;
      if (ev.emoji != null) it.emoji = ev.emoji;
      it.touchedAt = ev.t;
      break;
    }

    case 'todos': {
      // The plan is SESSION state, not a turn's: the agent keeps one cumulative
      // list. The full plan lives at session level (state.todos -> the sidebar
      // Plan panel); each card carries only its DELTA -- the steps that advanced
      // while it was active. A card never shows the whole plan, which is what
      // stops the cumulative list smearing onto every turn.
      // Per-step timing (keyed by step text): startedAt when a step first goes
      // in_progress, doneAt when it completes — for the durations on the panel.
      const times = state.stepTimes, prev = state.todoPrev;
      const target = (ev.item && state.items.get(ev.item)) || activeDoingItem(state);
      const todos = (ev.todos || []).map(td => {
        const status = td.status || (td.done ? 'completed' : 'pending');
        let tm = times.get(td.text);
        if (!tm) { tm = { firstSeenAt: ev.t }; times.set(td.text, tm); }
        if (status === 'in_progress' && tm.startedAt == null) tm.startedAt = ev.t;
        if (status === 'completed' && tm.doneAt == null) {
          tm.doneAt = ev.t;
          if (tm.startedAt == null) tm.startedAt = tm.firstSeenAt;
        }
        // A step joins this turn's delta only if we WITNESS it advance here: it
        // was seen earlier not-yet-done and now moved forward. A step first seen
        // already completed/in_progress (a continued session, work from an earlier
        // turn, or a checklist written pre-checked) was not moved here — which is
        // what stops a long first turn absorbing the whole backlog.
        const was = prev.get(td.text);
        const advanced = was != null && was !== 'completed' && status !== was &&
          (status === 'completed' || status === 'in_progress');
        if (advanced && target) {
          const d = target.delta || (target.delta = new Map());
          d.set(td.text, { text: td.text, status, startedAt: tm.startedAt, doneAt: tm.doneAt, elapsedMs: td.elapsedMs });
          target.touchedAt = ev.t;
        }
        return {
          text: td.text, done: status === 'completed', status,
          startedAt: tm && tm.startedAt, doneAt: tm && tm.doneAt, firstSeenAt: tm && tm.firstSeenAt,
          // Real duration carried by the producer (task tools) wins over the
          // snapshot-delta estimate — a backfill folds the whole plan at once, so
          // the delta would read 0.
          elapsedMs: td.elapsedMs,
        };
      });
      state.todos = todos;
      // An unchanged re-emit refreshes the reference but isn't real activity on
      // the card, so it must not bump touchedAt (which drives ordering / "active
      // card") — only a genuine plan change counts as touching it.
      state.todoPrev = new Map(todos.map(t => [t.text, t.status]));
      awake(state);
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
      awake(state);
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
      awake(state);
      break;
    }

    case 'pr': {
      // A metadata-only event (title/url, no state) must not conjure a PR — an
      // unknown number would default to 'open' and flood the panel (e.g. a
      // `gh pr list` dump of merged PRs). Attach to a known PR or skip.
      if (ev.number != null && !(ev.meta && !state.prs.has(ev.number))) {
        // PRs are session-level entities (the PR panel), tracked by number.
        const pr = state.prs.get(ev.number) ||
          { number: ev.number, state: 'open', url: null, title: null, ci: null, openedAt: ev.t, mergedAt: null };
        if (ev.state) pr.state = ev.state;
        if (ev.state === 'merged' && pr.mergedAt == null) pr.mergedAt = ev.t;
        if (ev.state === 'open') pr.mergedAt = null; // reopened / corrected
        if (ev.url) pr.url = ev.url;
        if (ev.title) pr.title = ev.title;
        pr.t = ev.t;
        state.prs.set(ev.number, pr);
      }
      // Resolve the owning card: an explicit ev.item link (set when the PR is
      // opened), or any card that already claimed this number — so a later
      // poller event with no item (the merge/close) still reaches the card that
      // opened the PR and can finish it. Matching only cards that already own
      // the number means the attribution heuristic never hijacks an unrelated
      // card (the original ev.item-only concern).
      let it = ev.item ? state.items.get(ev.item) : null;
      if (!it && ev.number != null) {
        for (const c of state.items.values()) {
          if (c.pr && c.pr.number === ev.number) { it = c; break; }
        }
      }
      if (it) {
        it.pr = {
          number: ev.number,
          state: ev.state || (it.pr && it.pr.state) || 'open',
          url: ev.url || (it.pr && it.pr.url) || null,
          title: ev.title || (it.pr && it.pr.title) || null,
        };
        if (it.pr.state === 'open' && (it.status === 'inbox' || it.status === 'doing')) it.status = 'pr';
        if (it.pr.state === 'merged' || it.pr.state === 'closed') it.status = 'done';
        it.touchedAt = ev.t;
      }
      break;
    }

    case 'ci': {
      if (ev.pr != null && state.prs.has(ev.pr)) state.prs.get(ev.pr).ci = ev.status;
      // attach to a card only if one is explicitly carrying this PR
      for (const it of state.items.values()) {
        if (it.pr && it.pr.number === ev.pr) { it.ci = ev.status; it.touchedAt = ev.t; }
      }
      break;
    }

    case 'tool': {
      // The agent ran a command (read a file, ran tests). Activity, not a file
      // change — it warms the active card and scrolls the tape so a working
      // turn looks alive between edits.
      state.totals.tools = (state.totals.tools || 0) + 1;
      const it = targetItem(state, ev);
      if (it) { it.tools = (it.tools || 0) + 1; it.touchedAt = ev.t; }
      awake(state);
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
// PRs touched this session, most recent first — drives the PR panel.
export function prList(state) {
  return [...state.prs.values()].sort((a, b) => (b.t || 0) - (a.t || 0));
}

export function activeItemId(state) {
  const it = activeDoingItem(state);
  return it ? it.id : null;
}
