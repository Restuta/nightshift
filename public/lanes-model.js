// Pure model for the lane timeline (the "shape of the night"). Zero deps, no DOM,
// no fetches — a deterministic function of the event array, exactly like the
// reducer. Extracted from public/lanes.js so the load-bearing derivations —
// episode splitting, item ranking, and mark extraction — are unit-testable on
// golden tapes (see test/lanes-model.test.mjs).
//
// Semantic truth comes from session-insights-model. The lightweight second pass
// below remains only for the optional item-attribution overlay; it never owns the
// primary timeline, clocks, PR truth, blockers, or confidence.

import { buildSessionInsights } from './session-insights-model.js';
import { viewHref } from './session-view-context.js';

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

const PRODUCER_ACTIVITY_TYPES = new Set([
  'say', 'tool', 'tool_call', 'edit', 'commit', 'todos', 'item', 'work_phase',
]);
const RECONCILE_SOURCES = new Set(['poll-github', 'server']);

function eventActivityTimes(events, t0, t1) {
  return byT(events)
    .filter(event => PRODUCER_ACTIVITY_TYPES.has(event.type)
      && !RECONCILE_SOURCES.has(event.source)
      && event.t >= t0
      && event.t <= t1)
    .map(event => event.t);
}

function titleCase(value) {
  return String(value ?? 'unknown')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, character => character.toUpperCase());
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function eventDetail(event) {
  const detail = [
    event.input?.command,
    event.input?.text,
    event.command,
    event.text,
    event.message,
    event.title,
    event.path,
  ].find(value => typeof value === 'string' && value.trim());
  if (detail) return detail.trim();
  if (event.type === 'pr') return `PR #${event.number} ${event.state ?? 'observed'}`;
  if (event.type === 'ci') return `PR #${event.pr} validation ${event.status ?? 'observed'}`;
  if (event.type === 'work_phase') {
    return `${titleCase(event.phase)}${event.stage ? ` / ${titleCase(event.stage)}` : ''} ${event.state ?? 'observed'}`;
  }
  if (event.type === 'tool_call') return `${event.tool ?? 'Tool'} ${event.state ?? 'observed'}`;
  return titleCase(event.type);
}

function eventProvenance(event) {
  return [
    event.source ?? 'recorded tape',
    event.recovery ? `recovery: ${event.recovery}` : null,
    event.evidenceRef ? `evidence: ${event.evidenceRef}` : null,
  ].filter(Boolean).join(' · ');
}

function evidenceFor(ids, evidenceEvents) {
  return [...new Set(ids ?? [])]
    .map(id => evidenceEvents.get(id))
    .filter(Boolean)
    .map(event => ({
      id: event.id,
      t: event.t,
      type: event.type,
      source: event.source ?? 'recorded tape',
      detail: eventDetail(event),
      provenance: eventProvenance(event),
      tool: event.tool ?? null,
      toolUseId: event.toolUseId ?? null,
      agentId: event.agentId ?? null,
      state: event.state ?? event.status ?? null,
      outcome: event.outcome ?? null,
      evidenceRef: event.evidenceRef ?? null,
    }));
}

function replayHref(startT, context) {
  return viewHref('/', {
    ...(context ?? {}),
    cursorT: Math.round(startT),
    mode: 'replay',
  });
}

function descriptor(values, evidenceEvents, context, recordedMs) {
  const startT = Number.isFinite(values.startT) ? values.startT : 0;
  const endT = Number.isFinite(values.endT) ? values.endT : startT;
  const replayT = Number.isFinite(values.replayT) ? values.replayT : startT;
  const evidenceEventIds = [...new Set(values.evidenceEventIds ?? [])];
  const durationMs = Math.max(0, endT - startT);
  return {
    ...values,
    startT,
    endT,
    durationMs,
    percent: values.percent === null
      ? null
      : (recordedMs > 0 ? durationMs / recordedMs * 100 : 0),
    confidence: values.confidence ?? 'heuristic',
    evidenceEventIds,
    evidence: evidenceFor(evidenceEventIds, evidenceEvents),
    replayHref: replayHref(replayT, context),
  };
}

function semanticDescriptors(insights, evidenceEvents, context, recordedMs) {
  return insights.phases.map((phase, index) => {
    const evidence = evidenceFor(phase.evidenceEventIds, evidenceEvents);
    const terminal = evidence.find(item => item.type === 'work_phase' && item.state === 'end');
    return descriptor({
      id: `semantic-primary-${index}`,
      kind: 'phase',
      label: titleCase(phase.wallCategory),
      phase: phase.phase,
      stage: phase.stage,
      disposition: phase.disposition,
      wallCategory: phase.wallCategory,
      source: phase.source,
      outcome: terminal?.outcome ?? null,
      startT: phase.startT,
      endT: phase.endT,
      confidence: phase.confidence,
      evidenceEventIds: phase.evidenceEventIds,
    }, evidenceEvents, context, recordedMs);
  });
}

function preflightDescriptors(insights, evidenceEvents, context, recordedMs) {
  return insights.phases
    .filter(phase => phase.phase === 'preflight')
    .map((phase, index) => {
      const evidence = evidenceFor(phase.evidenceEventIds, evidenceEvents);
      const terminal = evidence.find(item => item.type === 'work_phase' && item.state === 'end');
      return descriptor({
        id: `preflight-${index}`,
        kind: 'preflight',
        label: titleCase(phase.stage ?? 'prepare'),
        phase: phase.phase,
        stage: phase.stage ?? 'prepare',
        disposition: phase.disposition,
        wallCategory: phase.wallCategory,
        source: phase.source,
        outcome: terminal?.outcome ?? null,
        startT: phase.startT,
        endT: phase.endT,
        confidence: phase.confidence,
        evidenceEventIds: phase.evidenceEventIds,
      }, evidenceEvents, context, recordedMs);
    });
}

function snapshotTruth(prefix, snapshot) {
  if (!snapshot) return `${prefix}: unavailable`;
  const advisory = snapshot.advisoryRunning ? ` · ${snapshot.advisoryRunning} advisory running` : '';
  return `${prefix}: ${snapshot.state ?? 'unknown'} · validation ${snapshot.validation ?? 'unknown'}${advisory}`;
}

function snapshotTransitions(pr, evidenceEvents, context, recordedMs, t0, t1) {
  const transitions = [];
  const push = ({ kind, label, occurredAt, observedAt, source, evidenceEventIds }) => {
    const axisT = Number.isFinite(occurredAt) ? occurredAt : observedAt;
    if (!Number.isFinite(axisT)) return;
    transitions.push(descriptor({
      id: `pr-transition-${pr.repo}-${pr.number}-${kind}`,
      kind,
      transitionKind: kind,
      label,
      repo: pr.repo,
      number: pr.number,
      githubHref: pr.url,
      occurredAt: Number.isFinite(occurredAt) ? occurredAt : null,
      observedAt: Number.isFinite(observedAt) ? observedAt : null,
      replayT: Number.isFinite(observedAt) ? observedAt : axisT,
      startT: clamp(axisT, t0, t1),
      endT: clamp(axisT, t0, t1),
      confidence: 'explicit',
      source: source ?? 'recorded tape',
      evidenceEventIds,
    }, evidenceEvents, context, recordedMs));
  };
  const createdAt = pr.recorded?.createdAt ?? pr.current?.createdAt ?? null;
  push({
    kind: 'discovered',
    label: pr.discovery.kind === 'recovered' ? 'Discovered retrospectively' : 'PR created',
    occurredAt: createdAt,
    observedAt: pr.discovery.observedAt,
    source: pr.discovery.source,
    evidenceEventIds: pr.discovery.evidenceEventIds,
  });
  push({
    kind: 'recorded_state',
    label: `Recorded ${pr.recorded?.state ?? 'state unavailable'}`,
    occurredAt: pr.recorded?.occurredAt,
    observedAt: pr.recorded?.prAt,
    source: pr.recorded?.source,
    evidenceEventIds: pr.recorded?.evidenceEventIds,
  });
  push({
    kind: 'recorded_validation',
    label: `Recorded validation ${pr.recorded?.validation ?? 'unavailable'}`,
    occurredAt: null,
    observedAt: pr.recorded?.ciAt,
    source: pr.recorded?.source,
    evidenceEventIds: pr.recorded?.evidenceEventIds,
  });
  push({
    kind: 'current_state',
    label: `Current ${pr.current?.state ?? 'state unavailable'}`,
    occurredAt: pr.current?.occurredAt,
    observedAt: pr.current?.prAt,
    source: pr.current?.source,
    evidenceEventIds: pr.current?.evidenceEventIds,
  });
  push({
    kind: 'current_validation',
    label: `Current validation ${pr.current?.validation ?? 'unavailable'}`,
    occurredAt: null,
    observedAt: pr.current?.ciAt,
    source: pr.current?.source,
    evidenceEventIds: pr.current?.evidenceEventIds,
  });
  return transitions;
}

function prDescriptors(insights, evidenceEvents, context, recordedMs, t0, t1) {
  return (insights.prStack?.prs ?? []).map(pr => {
    const recorded = pr.recorded;
    const current = pr.current;
    const effective = current ?? recorded;
    const createdAt = recorded?.createdAt ?? current?.createdAt ?? null;
    const occurredAt = recorded?.occurredAt ?? current?.occurredAt ?? null;
    const observedAt = pr.discovery.observedAt ?? recorded?.prAt ?? current?.prAt ?? null;
    const startT = clamp(createdAt ?? occurredAt ?? observedAt, t0, t1);
    const terminalT = ['merged', 'closed'].includes(recorded?.state)
      ? (recorded.occurredAt ?? recorded.prAt)
      : t1;
    const base = current?.base ?? recorded?.base ?? null;
    const disagreement = Boolean(recorded && current && (
      recorded.state !== current.state
      || recorded.validation !== current.validation
      || recorded.base !== current.base
    ));
    return descriptor({
      id: `pr-${pr.repo}-${pr.number}`,
      kind: 'pr',
      label: `#${pr.number} · ${pr.title || 'Untitled pull request'}`,
      milestone: pr.title || `PR #${pr.number}`,
      repo: pr.repo,
      number: pr.number,
      githubHref: pr.url,
      recorded,
      current,
      discovery: pr.discovery,
      recordedTruth: snapshotTruth('Recorded', recorded),
      currentTruth: snapshotTruth('Current', current),
      stackTruth: base == null ? 'Base: stack root' : `Base: #${base}`,
      createdAt,
      occurredAt,
      observedAt,
      replayT: observedAt,
      state: effective?.state ?? 'unknown',
      validation: effective?.validation ?? 'unknown',
      attention: disagreement || Boolean(current?.advisoryRunning)
        || pr.discovery.kind === 'recovered',
      transitions: snapshotTransitions(pr, evidenceEvents, context, recordedMs, t0, t1),
      startT,
      endT: clamp(terminalT, startT, t1),
      confidence: pr.discovery.kind === 'recovered' ? 'strong' : 'explicit',
      source: effective?.source ?? pr.discovery.source,
      evidenceEventIds: pr.evidenceEventIds,
    }, evidenceEvents, context, recordedMs);
  });
}

function agentRows(prefix, insights, evidenceEvents, context, recordedMs, t1) {
  const starts = new Map();
  const rows = new Map();
  const ensure = agentId => {
    if (!rows.has(agentId)) rows.set(agentId, { agentId, label: `Agent · ${agentId}`, segments: [] });
    return rows.get(agentId);
  };
  const owningPhase = start => insights.phases.find(candidate => candidate.source === 'work_phase'
    && candidate.evidenceEventIds.includes(start.id)
    && candidate.startT <= start.t
    && candidate.endT > start.t);
  const canonicalValues = start => {
    const waiting = start.disposition === 'waiting' || start.stage === 'readiness_wait';
    return {
      phase: start.phase ?? 'other',
      stage: start.stage ?? null,
      disposition: waiting ? 'waiting' : 'active',
      wallCategory: waiting ? 'waiting' : (start.phase ?? 'other'),
    };
  };
  const canonicalEnd = (start, terminalT) => {
    const owner = owningPhase(start);
    if (owner) return Math.min(terminalT, owner.endT);
    const disposition = start.disposition === 'waiting' || start.stage === 'readiness_wait'
      ? 'waiting'
      : 'active';
    for (const phase of insights.phases) {
      if (phase.endT <= start.t || phase.startT >= terminalT) continue;
      if (phase.disposition !== disposition) return Math.max(start.t, phase.startT);
    }
    return terminalT;
  };
  const append = (start, endT, outcome, evidenceEventIds) => {
    const canonical = canonicalValues(start);
    const closedAt = canonicalEnd(start, endT);
    if (closedAt <= start.t) return;
    ensure(start.agentId).segments.push(descriptor({
      id: `agent-${start.agentId}-${start.runId}`,
      kind: 'agent_phase',
      label: `${titleCase(canonical.phase)}${canonical.stage ? ` · ${titleCase(canonical.stage)}` : ''}`,
      agentId: start.agentId,
      phase: canonical.phase,
      stage: canonical.stage,
      disposition: canonical.disposition,
      wallCategory: canonical.wallCategory,
      outcome,
      startT: start.t,
      endT: closedAt,
      confidence: 'explicit',
      source: 'work_phase',
      evidenceEventIds,
    }, evidenceEvents, context, recordedMs));
  };
  for (const event of prefix) {
    if (event.type !== 'work_phase' || !event.agentId || !event.runId) continue;
    const key = `${event.agentId}\u0000${event.runId}`;
    if (event.state === 'start') {
      starts.set(key, event);
      continue;
    }
    if (event.state !== 'end' || !starts.has(key)) continue;
    const start = starts.get(key);
    starts.delete(key);
    append(start, event.t, event.outcome ?? null, [start.id, event.id].filter(Boolean));
  }
  for (const start of starts.values()) {
    append(start, t1, 'not observed', [start.id].filter(Boolean));
  }
  return [...rows.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
}

const MARK_LABELS = {
  human_input: 'Human input requested',
  permission_block: 'Permission blocked',
  ci_review_wait: 'CI or review wait',
  unknown_silence: 'Unknown silence',
  recorder_gap: 'Recorder stale / gap',
};

function forensicMarks(insights, evidenceEvents, context, recordedMs, t1) {
  const marks = (insights.blockers ?? []).map((blocker, index) => descriptor({
    id: `blocker-${blocker.kind}-${index}`,
    kind: blocker.kind,
    label: MARK_LABELS[blocker.kind] ?? titleCase(blocker.kind),
    startT: blocker.startT,
    endT: blocker.endT,
    confidence: blocker.confidence,
    source: 'session insights',
    evidenceEventIds: blocker.evidenceEventIds,
  }, evidenceEvents, context, recordedMs));

  for (const [index, tool] of (insights.toolCalls?.lifecycles ?? []).entries()) {
    marks.push(descriptor({
      id: `tool-${index}`,
      kind: tool.endT == null ? 'tool_outcome_unknown' : 'tool_execution',
      label: `${tool.tool ?? 'Tool'} · ${tool.outcome ?? 'unknown'}`,
      tool: tool.tool ?? null,
      toolKey: tool.key,
      outcome: tool.outcome,
      startT: tool.startT,
      endT: tool.endT ?? insights.bounds?.displayNow ?? t1,
      percent: tool.endT == null ? null : undefined,
      confidence: 'explicit',
      source: 'tool_call',
      evidenceEventIds: tool.evidenceEventIds,
    }, evidenceEvents, context, recordedMs));
  }
  for (const [index, tool] of (insights.toolCalls?.pointObservations ?? []).entries()) {
    marks.push(descriptor({
      id: `tool-point-${index}`,
      kind: 'tool_observation',
      label: `${tool.tool ?? 'Tool'} · point observation`,
      tool: tool.tool ?? null,
      startT: tool.t,
      endT: tool.t,
      confidence: 'explicit',
      source: tool.source ?? 'recorded tape',
      evidenceEventIds: [tool.id].filter(Boolean),
    }, evidenceEvents, context, recordedMs));
  }
  for (const [index, diagnostic] of (insights.diagnostics ?? []).entries()) {
    if (diagnostic.kind !== 'stale_poller') continue;
    marks.push(descriptor({
      id: `source-stale-${index}`,
      kind: 'source_stale',
      label: 'GitHub source stale',
      startT: diagnostic.lastSignalT ?? insights.bounds.recordedEnd,
      endT: diagnostic.lastSignalT ?? insights.bounds.recordedEnd,
      confidence: 'explicit',
      source: 'session diagnostics',
      evidenceEventIds: diagnostic.evidenceEventIds,
    }, evidenceEvents, context, recordedMs));
  }
  return marks;
}

function itemOverlays(lanes, evidenceEvents, context, recordedMs) {
  return lanes.map(item => ({
    id: item.id,
    label: item.title || item.id,
    segments: item.episodes.map((episode, index) => descriptor({
      id: `item-${item.id}-${index}`,
      kind: 'item_episode',
      label: item.title || item.id,
      itemId: item.id,
      startT: episode.start,
      endT: episode.end,
      confidence: 'heuristic',
      source: 'item attribution overlay',
      evidenceEventIds: [],
    }, evidenceEvents, context, recordedMs)),
  }));
}

// Compose the whole model the page renders. Pure over the event array and the
// canonical insights prefix. `insights` is optional only for backwards-compatible
// callers; production builds it once and passes it in.
export function buildModel(events, insights = null, context = null) {
  // Honor retracts before anything else folds: a retracted card must leave no
  // lane, mark, or count — the same META-level rule the reducer applies in fold().
  const canonical = insights ?? buildSessionInsights(events);
  const evs = canonical.visiblePrefix ?? byT(applyRetractions(events));
  const t0 = canonical.bounds?.recordedStart ?? (evs.length ? evs[0].t : 0);
  const t1 = canonical.bounds?.recordedEnd ?? (evs.length ? evs[evs.length - 1].t : t0 + 60000);
  const recordedMs = Math.max(0, t1 - t0);
  const evidenceEvents = new Map(
    [...evs, ...(canonical.factPrefix ?? [])]
      .filter(event => event.id != null)
      .map(event => [event.id, event]),
  );
  const itemsMap = buildItems(evs);
  const { lanes, more } = selectLanes(itemsMap);
  const moreActivity = [];
  const moreCommits = [];
  for (const it of more) { moreActivity.push(...it.activityTs); moreCommits.push(...it.commitMarks); }
  const primary = semanticDescriptors(canonical, evidenceEvents, context, recordedMs);
  const preflight = preflightDescriptors(canonical, evidenceEvents, context, recordedMs);
  const prs = prDescriptors(canonical, evidenceEvents, context, recordedMs, t0, t1);
  const agents = agentRows(evs, canonical, evidenceEvents, context, recordedMs, t1);
  const marks = forensicMarks(canonical, evidenceEvents, context, recordedMs, t1);
  const overlays = {
    items: itemOverlays(lanes, evidenceEvents, context, recordedMs),
    eventActivity: eventActivityTimes(evs, t0, t1),
  };
  const descriptors = [
    ...primary,
    ...preflight,
    ...prs,
    ...prs.flatMap(pr => pr.transitions),
    ...agents.flatMap(row => row.segments),
    ...marks,
    ...overlays.items.flatMap(row => row.segments),
  ];
  return {
    t0, t1,
    phases: sessionPhases(evs, t0, t1),
    attention: attentionMarks(evs),
    dayLines: dayBoundaries(t0, t1),
    density: densityTimes(evs),
    lanes,
    more: { count: more.length, episodes: splitEpisodes(moreActivity), commitMarks: moreCommits },
    semanticRows: { primary, preflight, prs, agents },
    marks,
    overlays,
    descriptors,
  };
}
