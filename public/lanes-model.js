// Pure model for the lane timeline (the "shape of the night"). Zero deps, no DOM,
// no fetches — a deterministic function of the event array, exactly like the
// reducer. Extracted from public/lanes.js so the load-bearing derivations —
// episode splitting, item ranking, and mark extraction — are unit-testable on
// golden tapes (see test/lanes-model.test.mjs).
//
// This is a SECOND pure pass over the same tape the reducer folds; it does NOT
// modify the reducer. It reconstructs a lightweight per-item attribution (a
// faithful-enough mirror of reducer.targetItem: explicit `item` wins, pr/ci
// match by PR number to the owning card, else the most-recently-touched card in
// `doing`) purely so activity can be laid out in time.

export const EPISODE_GAP_MS = 10 * 60 * 1000; // a >10min gap starts a new episode
export const TOP_ITEMS = 12;                  // lanes shown before "…n more"
export const DAY_MS = 24 * 60 * 60 * 1000;

// Event types that count as an item's own activity (drive episodes + warmth).
const ACTIVITY = new Set(['edit', 'commit', 'tool', 'todos', 'say']);

function byT(events) {
  return [...events].sort((a, b) => (a.t || 0) - (b.t || 0));
}

// A `retract` corrects the tape itself — "this event / this card was a recording
// bug, it was never real." Retraction is META-level: it applies at ALL times,
// exactly as the reducer's fold() does (docs/EVENTS.md: "vanishes from board,
// counts, and feed"). The /lanes page is a pure SECOND fold over the same tape,
// so it must honor retracts too — otherwise a retracted `<task-notification>`
// card resurrects as a lane and its events get counted, diverging from the board.
// Pre-scan the whole array for retracts, then drop the retracted events + items
// (and the retract meta-events) before any derivation runs. Mirrors reducer.js
// scanRetractions/isRetracted so the two stay in lock-step.
export function applyRetractions(events) {
  const retractedEvents = new Set(); // envelope ids ({target:{event}})
  const retractedItems = new Set();  // work-item ids ({target:{item}})
  for (const ev of events) {
    if (!ev || ev.type !== 'retract' || !ev.target) continue;
    if (ev.target.event != null) retractedEvents.add(ev.target.event);
    if (ev.target.item != null) retractedItems.add(ev.target.item);
  }
  return events.filter(ev => {
    if (!ev) return false;
    if (ev.type === 'retract') return false; // meta-event: applied in the pre-scan
    if (ev.id != null && retractedEvents.has(ev.id)) return false;
    // A retracted item vanishes completely: its own `item` upserts AND anything
    // attributed to it (edit/commit/todos/ci/... carrying ev.item) drop out.
    if (ev.type === 'item' && ev.id != null && retractedItems.has(ev.id)) return false;
    if (ev.item != null && retractedItems.has(ev.item)) return false;
    return true;
  });
}

// Consecutive timestamps become one episode until a gap wider than `gapMs`.
// Input need not be sorted. Returns [{start, end, count}] (start<=end).
export function splitEpisodes(ts, gapMs = EPISODE_GAP_MS) {
  const sorted = [...ts].sort((a, b) => a - b);
  const out = [];
  let cur = null;
  for (const t of sorted) {
    if (!cur || t - cur.end > gapMs) { cur = { start: t, end: t, count: 1 }; out.push(cur); }
    else { cur.end = t; cur.count++; }
  }
  return out;
}

// Reconstruct per-item lanes from the raw stream. Returns a Map id → model with
// activity counts, episode spans, and mark arrays (commits, PR events, CI).
// A faithful-enough mirror of the reducer's attribution — it deliberately omits
// the reducer's done→pr "parking" nuance (that only shifts attribution right at
// a PR-open boundary), which is acceptable for a spatial prototype.
export function buildItems(events) {
  const evs = byT(events);
  const items = new Map();
  const ensure = id => {
    let it = items.get(id);
    if (!it) {
      it = {
        id, title: '', status: 'inbox', createdAt: null, touchedAt: 0,
        edits: 0, commits: 0, tools: 0, add: 0, del: 0,
        firstAt: Infinity, lastAt: -Infinity,
        activityTs: [], commitMarks: [], prMarks: [], ciMarks: [],
        prNumbers: new Set(),
      };
      items.set(id, it);
    }
    return it;
  };
  const activeDoing = () => {
    let best = null;
    for (const it of items.values()) {
      if (it.status !== 'doing') continue;
      if (!best || it.touchedAt > best.touchedAt) best = it;
    }
    return best;
  };
  const itemByPr = num => {
    for (const it of items.values()) if (it.prNumbers.has(num)) return it;
    return null;
  };
  const target = ev => {
    if (ev.item && items.has(ev.item)) return items.get(ev.item);
    if (ev.type === 'ci' && ev.pr != null) return itemByPr(ev.pr);
    if (ev.type === 'pr' && ev.number != null) return itemByPr(ev.number);
    return activeDoing();
  };
  const touch = (it, t) => {
    it.touchedAt = t;
    if (t < it.firstAt) it.firstAt = t;
    if (t > it.lastAt) it.lastAt = t;
  };

  for (const ev of evs) {
    const t = ev.t;
    switch (ev.type) {
      case 'item': {
        if (!ev.id) break;
        const it = ensure(ev.id);
        if (it.createdAt == null) it.createdAt = t;
        if (ev.title != null) it.title = ev.title;
        if (ev.status != null) it.status = ev.status;
        it.touchedAt = t;
        break;
      }
      case 'edit': {
        const it = target(ev);
        if (it) { it.edits++; it.activityTs.push(t); touch(it, t); }
        break;
      }
      case 'commit': {
        const it = target(ev);
        if (it) {
          it.commits++; it.add += ev.add || 0; it.del += ev.del || 0;
          it.activityTs.push(t);
          it.commitMarks.push({ t, sha: ev.sha, message: ev.message, add: ev.add || 0, del: ev.del || 0 });
          touch(it, t);
        }
        break;
      }
      case 'tool': {
        const it = target(ev);
        if (it) { it.tools++; it.activityTs.push(t); touch(it, t); }
        break;
      }
      case 'todos': {
        const it = (ev.item && items.get(ev.item)) || activeDoing();
        if (it) { it.activityTs.push(t); touch(it, t); }
        break;
      }
      case 'say': {
        const it = target(ev);
        if (it) { it.activityTs.push(t); touch(it, t); }
        break;
      }
      case 'pr': {
        // Claim the number for a card the way the reducer does: an explicit item
        // link, or a card that already owns this number (so a later merge with no
        // item still lands on the opening card). Never hijack an unrelated card.
        let it = ev.item ? items.get(ev.item) : null;
        if (!it && ev.number != null) it = itemByPr(ev.number);
        if (it && ev.number != null) {
          it.prNumbers.add(ev.number);
          it.prMarks.push({ t, kind: ev.state || 'open', number: ev.number, title: ev.title, url: ev.url });
          if (ev.state === 'open' && (it.status === 'inbox' || it.status === 'doing')) it.status = 'pr';
          if (ev.state === 'merged' || ev.state === 'closed') it.status = 'done';
          touch(it, t);
        }
        break;
      }
      case 'ci': {
        const it = itemByPr(ev.pr);
        if (it) { it.ciMarks.push({ t, status: ev.status, pr: ev.pr }); if (ev.status === 'fail') touch(it, t); }
        break;
      }
    }
  }

  for (const it of items.values()) {
    it.episodes = splitEpisodes(it.activityTs);
    if (it.firstAt === Infinity) it.firstAt = it.createdAt == null ? 0 : it.createdAt;
    if (it.lastAt === -Infinity) it.lastAt = it.firstAt;
    // Activity score: raw event counts, plus a capped contribution from churn so a
    // single huge diff can't outrank a card that actually did many things.
    it.activity = it.edits + it.commits + it.tools + Math.min(20, (it.add + it.del) / 50);
  }
  return items;
}

// Rank items by activity, take the top N as their own lanes (ordered newest-
// active at top), and return the rest for the collapsed "…n more" lane. An item
// with no activity and no marks gets no lane at all.
export function selectLanes(itemsMap, topN = TOP_ITEMS) {
  const all = [...itemsMap.values()].filter(it =>
    it.activity > 0 || it.commitMarks.length || it.prMarks.length || it.ciMarks.length);
  const cmpId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // pick the top N by activity (stable, deterministic tie-breaks)
  all.sort((a, b) => b.activity - a.activity || b.lastAt - a.lastAt || cmpId(a, b));
  const lanes = all.slice(0, topN);
  const more = all.slice(topN);
  // ...then order the visible lanes newest-active first, so the freshest work is
  // at the top of the stack.
  lanes.sort((a, b) => b.lastAt - a.lastAt || b.activity - a.activity || cmpId(a, b));
  return { lanes, more };
}

// Session phase strips over [t0,t1]: working / idle / attention / ended, each
// persisting until the next session event. Mirrors the reducer's awake() — any
// item activity flips idle/attention back to working — so the strip agrees with
// the badge on the board.
export function sessionPhases(events, t0, t1) {
  const evs = byT(events);
  const segs = [];
  let phase = null, start = null;
  const flush = end => { if (phase && start != null && end > start) segs.push({ start, end, phase }); };
  const set = (p, t) => { if (p === phase) return; flush(t); phase = p; start = t; };
  for (const ev of evs) {
    if (ev.type === 'session') {
      if (ev.phase === 'start' || ev.phase === 'resume') set('working', ev.t);
      else if (ev.phase === 'idle') set('idle', ev.t);
      else if (ev.phase === 'attention') set('attention', ev.t);
      else if (ev.phase === 'end') set('ended', ev.t);
    } else if (ACTIVITY.has(ev.type) && (phase === 'idle' || phase === 'attention')) {
      set('working', ev.t);
    }
  }
  flush(t1);
  return segs;
}

// Attention marks (agent blocked on the human) — the loud "!" ticks.
export function attentionMarks(events) {
  return byT(events)
    .filter(ev => ev.type === 'session' && ev.phase === 'attention')
    .map(ev => ({ t: ev.t, text: ev.text || 'attention' }));
}

// Local-midnight boundaries strictly inside a multi-day span (empty when <=24h).
// Stepped via Date so DST shifts land on the real local midnight.
export function dayBoundaries(t0, t1) {
  if (!(t1 - t0 > DAY_MS)) return [];
  const out = [];
  const d = new Date(t0);
  d.setHours(24, 0, 0, 0); // first midnight after t0
  while (d.getTime() < t1) { out.push(d.getTime()); d.setDate(d.getDate() + 1); }
  return out;
}

// Sorted timestamps of the session-level density sparkline (say + tool chatter).
export function densityTimes(events) {
  return byT(events).filter(ev => ev.type === 'say' || ev.type === 'tool').map(ev => ev.t);
}

// Compose the whole model the page renders. Pure over the event array.
export function buildModel(events) {
  // Honor retracts before anything else folds: a retracted card must leave no
  // lane, mark, or count — the same META-level rule the reducer applies in fold().
  const evs = byT(applyRetractions(events));
  const t0 = evs.length ? evs[0].t : 0;
  const t1 = evs.length ? evs[evs.length - 1].t : t0 + 60000;
  const itemsMap = buildItems(evs);
  const { lanes, more } = selectLanes(itemsMap);
  const moreActivity = [];
  const moreCommits = [];
  for (const it of more) { moreActivity.push(...it.activityTs); moreCommits.push(...it.commitMarks); }
  return {
    t0, t1,
    phases: sessionPhases(evs, t0, t1),
    attention: attentionMarks(evs),
    dayLines: dayBoundaries(t0, t1),
    density: densityTimes(evs),
    lanes,
    more: { count: more.length, episodes: splitEpisodes(moreActivity), commitMarks: moreCommits },
  };
}
