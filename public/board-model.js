// Pure Board projection over the canonical session-insights model. The Board
// specializes live-operational copy, but does not derive independent truth.

import { buildSessionDisposition } from './session-disposition.js';

const WALL_LABELS = {
  coding: 'Coding',
  testing: 'Testing',
  preflight: 'Preflight',
  other: 'Other',
  waiting: 'Waiting',
  idle: 'Idle',
  unknown: 'Unknown',
};

function durationText(ms) {
  if (!(ms > 0)) return '0s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function titleCase(value) {
  return String(value ?? 'unknown')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, character => character.toUpperCase());
}

function effectivePrState(pr) {
  return pr.current?.state ?? pr.recorded?.state ?? 'unknown';
}

function validationText(snapshot) {
  const validation = snapshot?.validation ?? 'unknown';
  return validation === 'pass' ? 'gates pass'
    : validation === 'fail' ? 'gates fail'
      : validation === 'pending' ? 'gates pending'
        : 'gates unavailable';
}

function truthText(axis, snapshot) {
  const label = axis === 'recorded' ? 'Recorded' : 'Current';
  if (!snapshot) return `${label}: ${axis === 'recorded' ? 'not observed in the tape' : 'unavailable'}`;
  const advisory = snapshot.advisoryRunning > 0
    ? ` · ${snapshot.advisoryRunning} advisory running`
    : '';
  return `${label}: ${snapshot.state ?? 'state unavailable'} · ${validationText(snapshot)}${advisory}`;
}

function parentText(axis, snapshot) {
  const label = axis === 'recorded' ? 'Recorded parent' : 'Current parent';
  return `${label}: ${Number.isFinite(snapshot?.base) ? `#${snapshot.base}` : 'unavailable'}`;
}

function prProvenance(pr) {
  if (pr.discovery?.kind === 'recovered') {
    const source = pr.discovery.recovery === 'transcript' ? 'transcript evidence' : 'recovery evidence';
    return `Discovered retrospectively · ${source}`;
  }
  if (pr.recorded) return 'Recorded tape · authoritative GitHub fact';
  return 'Observed reference · authoritative state unavailable';
}

function prChanged(pr) {
  if (!pr.recorded || !pr.current) return pr.recorded !== pr.current;
  return pr.recorded.state !== pr.current.state
    || pr.recorded.validation !== pr.current.validation
    || pr.recorded.base !== pr.current.base
    || pr.recorded.advisoryRunning !== pr.current.advisoryRunning;
}

function toolsOf(insights) {
  const toolCalls = insights.toolCalls ?? {};
  const displayNow = insights.bounds?.displayNow ?? insights.asOfT ?? 0;
  const lifecycles = (toolCalls.lifecycles ?? []).map(tool => {
    const complete = Number.isFinite(tool.endT);
    const endT = complete ? tool.endT : displayNow;
    return {
      key: tool.key?.join(':') ?? `${tool.tool ?? 'tool'}:${tool.startT}`,
      tool: tool.tool ?? 'Tool',
      startT: tool.startT,
      endT: tool.endT,
      outcome: tool.outcome,
      status: complete ? `Completed · ${tool.outcome}` : 'Outcome unknown',
      state: complete ? 'completed' : 'outcome-unknown',
      duration: complete
        ? `${durationText(Math.max(0, endT - tool.startT))} measured tool execution`
        : `${durationText(Math.max(0, endT - tool.startT))} elapsed since recorded start`,
      blocked: false,
      evidenceEventIds: tool.evidenceEventIds ?? [],
    };
  });
  const observations = (toolCalls.pointObservations ?? []).map(event => ({
    id: event.id ?? `${event.t}:${event.tool ?? 'tool'}`,
    tool: event.tool ?? 'Tool',
    text: event.text ?? '',
    t: event.t,
    status: 'Historical point observation · runtime not measured',
  }));
  return {
    lifecycles,
    observations,
    metrics: `${Number(toolCalls.matchedTranscriptPairs) || 0} transcript tool pairs · ${Number(toolCalls.tapeObservations) || 0} tape tool observations`,
    legend: ['Running requires an explicit live signal', 'Completed', 'Outcome unknown'],
  };
}

function prsOf(insights) {
  const displayNow = insights.bounds?.displayNow ?? insights.asOfT ?? 0;
  return (insights.prStack?.prs ?? []).map(pr => {
    const createdAt = pr.current?.createdAt
      ?? pr.recorded?.createdAt
      ?? null;
    const state = effectivePrState(pr);
    return {
      key: pr.key,
      repo: pr.repo,
      number: pr.number,
      title: pr.current?.title ?? pr.recorded?.title ?? pr.title ?? `PR #${pr.number}`,
      url: pr.current?.url ?? pr.recorded?.url ?? pr.url,
      state,
      createdAt,
      openFor: state === 'open'
        ? (Number.isFinite(createdAt)
            ? `Open for ${durationText(Math.max(0, displayNow - createdAt))}`
            : 'Open duration unavailable')
        : (Number.isFinite(createdAt)
            ? `Opened at ${new Date(createdAt).toISOString()}`
            : 'Opened time unavailable'),
      recordedTruth: truthText('recorded', pr.recorded),
      currentTruth: truthText('current', pr.current),
      recordedParent: parentText('recorded', pr.recorded),
      currentParent: parentText('current', pr.current),
      provenance: prProvenance(pr),
      attribution: pr.items?.length ? `Work items: ${pr.items.join(', ')}` : 'Unattached to a recorded work item',
      changedSinceRecording: prChanged(pr),
      discoveryT: pr.discovery?.observedAt ?? null,
      recordedAt: pr.discovery?.recordedAt ?? null,
      currentFetchedAt: pr.current?.fetchedAt ?? pr.current?.at ?? null,
      evidenceEventIds: pr.evidenceEventIds ?? [],
    };
  });
}

export function buildBoardViewModel(insights) {
  const prs = prsOf(insights);
  const open = prs.filter(pr => pr.state === 'open').length;
  const merged = prs.filter(pr => pr.state === 'merged').length;
  const visible = insights.visiblePrefix ?? [];
  const heartbeatExcluded = visible.filter(event => event.type === 'alive').length;
  const activity = visible.filter(event => event.type !== 'alive');
  const recordedMs = insights.clocks?.recordedSessionMs ?? 0;
  const timeline = (insights.phases ?? []).map(span => ({
    ...span,
    label: WALL_LABELS[span.wallCategory] ?? titleCase(span.wallCategory),
    duration: `${durationText(span.endT - span.startT)} of recorded session`,
    percent: recordedMs > 0 ? (span.endT - span.startT) / recordedMs * 100 : 0,
  }));

  return {
    clocks: {
      recordedSession: {
        value: durationText(recordedMs),
        label: 'recorded session',
      },
    },
    disposition: buildSessionDisposition(insights),
    prs,
    prTotals: `${open} ${open === 1 ? 'PR' : 'PRs'} open · ${merged} merged`,
    tools: toolsOf(insights),
    timeline,
    timelineLegend: Object.values(WALL_LABELS),
    events: {
      activity,
      heartbeatExcluded,
      nonHeartbeat: activity.length,
      label: `${activity.length} non-heartbeat events · ${heartbeatExcluded} heartbeats excluded`,
    },
  };
}
