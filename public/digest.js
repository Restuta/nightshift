// Pure narrative projection for the session digest. This is a THIRD pure pass
// over the same tape folded by the reducer and lanes model: a ledger + prompt
// chapters for /story and the /lanes timeline.

import { applyRetractions, splitEpisodes } from './lanes-model.js';
import { isTurnId, turnLabel } from './turn-id.js';

export const GAP_MS = 10 * 60 * 1000;      // producer silence that counts as idle
export const EPISODE_MIN_EDITS = 5;        // edits that promote a beat to episode

const PRODUCERS = new Set(['say', 'tool', 'edit', 'commit', 'pr', 'todos', 'item', 'ci']);

const ZERO_TOTALS = {
  prompts: 0,
  episodes: 0,
  beats: 0,
  prsOpened: 0,
  prsMerged: 0,
  commits: 0,
  says: 0,
  edits: 0,
  tools: 0,
};

function zeroDigest() {
  return {
    startT: null,
    endT: null,
    wallMs: 0,
    activeMs: 0,
    idleMs: 0,
    gaps: [],
    totals: { ...ZERO_TOTALS },
    chapters: [],
  };
}

function byT(events) {
  // JS sort is stable in modern Node. Because applyRetractions preserves the
  // input order, equal timestamps keep original tape order for deterministic
  // replay and scrubber parity.
  return [...events].sort((a, b) => (a.t || 0) - (b.t || 0));
}

function producerEvents(evs) {
  return evs.filter(ev => PRODUCERS.has(ev.type));
}

function gapsBetween(evs, gapMs = GAP_MS) {
  const gaps = [];
  for (let i = 1; i < evs.length; i++) {
    const fromT = evs[i - 1].t;
    const toT = evs[i].t;
    if (toT - fromT > gapMs) gaps.push({ fromT, toT, ms: toT - fromT });
  }
  return gaps;
}

function activeMsFor(evs) {
  return splitEpisodes(evs.map(ev => ev.t), GAP_MS)
    .reduce((sum, ep) => sum + (ep.end - ep.start), 0);
}

function turnList(evs) {
  const byId = new Map();
  for (const ev of evs) {
    if (ev.type !== 'item' || !isTurnId(ev.id)) continue;
    let turn = byId.get(ev.id);
    if (!turn) {
      turn = { id: ev.id, firstT: ev.t, title: '' };
      byId.set(ev.id, turn);
    }
    if (!turn.title && typeof ev.title === 'string' && ev.title.trim()) turn.title = ev.title;
  }
  return [...byId.values()].sort((a, b) => a.firstT - b.firstT);
}

function prSummary(evs) {
  const byNumber = new Map();
  for (const ev of evs) {
    if (ev.type !== 'pr' || ev.number == null) continue;
    const eventT = ev.occurredAt != null ? ev.occurredAt : ev.t;
    let pr = byNumber.get(ev.number);
    if (!pr) {
      pr = {
        number: ev.number,
        title: '',
        openedT: null,
        mergedT: null,
        closedT: null,
        state: ev.state || null,
        firstT: ev.t,
      };
      byNumber.set(ev.number, pr);
    }
    if (typeof ev.title === 'string' && ev.title.trim()) pr.title = ev.title;
    if (ev.state === 'open' && pr.openedT == null) pr.openedT = eventT;
    if (ev.state === 'merged' && pr.mergedT == null) pr.mergedT = eventT;
    if (ev.state === 'closed' && pr.closedT == null) pr.closedT = eventT;
    pr.state = ev.state || pr.state;
  }
  return byNumber;
}

function firstPrEventByNumber(evs) {
  const out = new Map();
  for (const ev of evs) {
    if (ev.type === 'pr' && ev.number != null && !out.has(ev.number)) out.set(ev.number, ev);
  }
  return out;
}

function chapterForTime(chapters, t) {
  return chapters.find(ch =>
    t >= ch.windowStartT &&
    (ch.windowInclusiveEnd ? t <= ch.windowEndT : t < ch.windowEndT));
}

function publicPr(pr) {
  return {
    number: pr.number,
    title: pr.title,
    openedT: pr.openedT,
    mergedT: pr.mergedT,
    closedT: pr.closedT,
    state: pr.state,
  };
}

function buildChapter(seed, windowStartT, windowEndT, windowEvents) {
  const gaps = gapsBetween(windowEvents);
  const commits = windowEvents
    .filter(ev => ev.type === 'commit')
    .map(ev => ({ t: ev.t, sha: ev.sha, message: ev.message, add: ev.add, del: ev.del }));
  const closerEvent = [...windowEvents].reverse()
    .find(ev => ev.type === 'say' && typeof ev.text === 'string' && ev.text.trim());
  const counts = {
    commits: commits.length,
    edits: windowEvents.filter(ev => ev.type === 'edit').length,
    says: windowEvents.filter(ev => ev.type === 'say').length,
    tools: windowEvents.filter(ev => ev.type === 'tool').length,
  };
  const startT = windowEvents[0].t;
  const endT = windowEvents[windowEvents.length - 1].t;

  return {
    id: seed.id,
    label: seed.id == null ? '' : turnLabel(seed.id),
    title: seed.title,
    kind: commits.length || counts.edits >= EPISODE_MIN_EDITS
      ? 'episode'
      : 'beat',
    startT,
    endT,
    wallMs: endT - startT,
    activeMs: activeMsFor(windowEvents),
    gaps,
    counts,
    prs: [],
    commits,
    closer: closerEvent ? { t: closerEvent.t, text: closerEvent.text } : null,
    windowStartT,
    windowEndT,
    windowInclusiveEnd: seed.inclusiveEnd,
  };
}

export function buildDigest(events, untilT = Infinity) {
  const evs = byT(applyRetractions(events)).filter(ev => ev.t <= untilT);
  const producers = producerEvents(evs);
  if (!producers.length) return zeroDigest();

  const startT = producers[0].t;
  const endT = producers[producers.length - 1].t;
  const gaps = gapsBetween(producers);
  const idleMs = gaps.reduce((sum, gap) => sum + gap.ms, 0);
  const wallMs = endT - startT;
  const turns = turnList(evs);
  const prByNumber = prSummary(evs);
  const firstPrByNumber = firstPrEventByNumber(evs);

  const chapterSpecs = [];
  if (!turns.length) {
    chapterSpecs.push({
      id: null,
      title: '(before first prompt)',
      windowStartT: startT,
      windowEndT: endT,
      inclusiveEnd: true,
    });
  } else if (producers.some(ev => ev.t < turns[0].firstT)) {
    chapterSpecs.push({
      id: null,
      title: '(before first prompt)',
      windowStartT: -Infinity,
      windowEndT: turns[0].firstT,
      inclusiveEnd: false,
    });
  }
  for (let i = 0; i < turns.length; i++) {
    chapterSpecs.push({
      id: turns[i].id,
      title: turns[i].title,
      windowStartT: turns[i].firstT,
      windowEndT: i + 1 < turns.length ? turns[i + 1].firstT : endT,
      inclusiveEnd: i + 1 === turns.length,
    });
  }

  const chapters = [];
  for (const spec of chapterSpecs) {
    const windowEvents = producers.filter(ev =>
      ev.t >= spec.windowStartT &&
      (spec.inclusiveEnd ? ev.t <= spec.windowEndT : ev.t < spec.windowEndT));
    if (!windowEvents.length) continue;
    chapters.push(buildChapter(spec, spec.windowStartT, spec.windowEndT, windowEvents));
  }

  // Attribute a PR to its first appearance, but use the whole scrubbed prefix to
  // summarize its lifecycle. This preserves per-PR cycle time without duplicating
  // the same PR in the later merge chapter.
  for (const pr of prByNumber.values()) {
    const first = firstPrByNumber.get(pr.number);
    const chapter = first ? chapterForTime(chapters, first.t) : null;
    if (chapter) {
      chapter.prs.push(publicPr(pr));
      chapter.kind = 'episode';
    }
  }

  for (const chapter of chapters) {
    delete chapter.windowStartT;
    delete chapter.windowEndT;
    delete chapter.windowInclusiveEnd;
  }

  const totals = {
    prompts: turns.length,
    episodes: chapters.filter(ch => ch.kind === 'episode').length,
    beats: chapters.filter(ch => ch.kind === 'beat').length,
    prsOpened: [...prByNumber.values()].filter(pr => pr.openedT != null).length,
    prsMerged: [...prByNumber.values()].filter(pr => pr.mergedT != null).length,
    commits: producers.filter(ev => ev.type === 'commit').length,
    says: producers.filter(ev => ev.type === 'say').length,
    edits: producers.filter(ev => ev.type === 'edit').length,
    tools: producers.filter(ev => ev.type === 'tool').length,
  };

  return {
    startT,
    endT,
    wallMs,
    activeMs: wallMs - idleMs,
    idleMs,
    gaps,
    totals,
    chapters,
  };
}
