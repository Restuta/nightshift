// Pure interaction rules for the React Graph. Keeping replay bounds, session
// transitions, and accessibility copy here makes the real browser behavior
// deterministic without coupling tests to React internals.

const finiteTimes = events => events
  .map(event => event?.t)
  .filter(Number.isFinite);

const clamp = (value, floor, ceiling) => Math.max(floor, Math.min(ceiling, value));

export function buildReplayWindow({ events, cursorT, asOfT = null }) {
  const times = finiteTimes(events ?? []);
  const tapeStartT = times.length ? Math.min(...times) : 0;
  const tapeEndT = times.length ? Math.max(...times) : tapeStartT;
  const ceilingT = Number.isFinite(asOfT) ? Math.min(asOfT, tapeEndT) : tapeEndT;
  const floorT = Math.min(tapeStartT, ceilingT);
  const requestedT = Number.isFinite(cursorT) ? cursorT : ceilingT;
  const boundedCursorT = clamp(requestedT, floorT, ceilingT);
  return {
    floorT,
    ceilingT,
    cursorT: boundedCursorT,
    cutoffT: boundedCursorT,
  };
}

export function timelineKeyTarget(key, { floorT, ceilingT, cursorT }) {
  const span = Math.max(0, ceilingT - floorT);
  let target;
  if (key === 'ArrowLeft') target = cursorT - span * 0.01;
  else if (key === 'ArrowRight') target = cursorT + span * 0.01;
  else if (key === 'PageDown') target = cursorT - span * 0.10;
  else if (key === 'PageUp') target = cursorT + span * 0.10;
  else if (key === 'Home') target = floorT;
  else if (key === 'End') target = ceilingT;
  else return null;
  return Math.round(clamp(target, floorT, ceilingT));
}

export function timelinePointerTarget(fraction, { floorT, ceilingT }) {
  const boundedFraction = Math.max(0, Math.min(1, Number(fraction) || 0));
  return Math.round(floorT + boundedFraction * Math.max(0, ceilingT - floorT));
}

export function contextForScrub(context, cursorT, ceilingT) {
  const asOfT = Number.isFinite(context?.asOfT)
    ? context.asOfT
    : (Number.isFinite(ceilingT) ? ceilingT : null);
  const boundedCursorT = Number.isFinite(asOfT) ? Math.min(cursorT, asOfT) : cursorT;
  return {
    ...context,
    cursorT: Math.round(boundedCursorT),
    cutoffT: Math.round(boundedCursorT),
    asOfT,
    mode: 'replay',
  };
}

export function selectGraphSession(contextRef, session) {
  const current = contextRef?.current ?? {};
  const context = { ...current, session };
  return {
    context,
    cursorT: context.cutoffT ?? null,
    scrubT: context.cutoffT ?? null,
  };
}

export function shouldOpenGraphStream(context) {
  return context?.mode === 'live';
}

function entityName(node) {
  if (node.kind === 'session') return node.title || 'Untitled session';
  if (node.kind === 'plan') return 'Plan';
  if (node.kind === 'intent') return node.title || 'Untitled work item';
  if (node.kind === 'step') return node.text || 'Untitled plan step';
  if (node.kind === 'now') return node.prompt || node.title || 'Current turn';
  if (node.kind === 'collapsed') return node.label || `${node.count ?? 0} more entities`;
  if (node.kind === 'step-more') return `${node.count ?? 0} more running`;
  if (node.kind === 'pr') return `Pull request ${node.number}. ${node.title || 'Untitled'}`;
  return node.title || node.text || node.kind || 'Graph entity';
}

function entityStatus(node) {
  if (node.kind === 'session') return node.activity?.phase || node.phase || 'unknown';
  if (node.kind === 'plan') return `${node.counts?.completed ?? 0} of ${node.total ?? 0} complete`;
  if (node.kind === 'intent') return node.status || 'unknown';
  if (node.kind === 'step') return node.paused ? 'paused' : 'active';
  if (node.kind === 'now') return node.phase || 'active';
  if (node.kind === 'collapsed') return 'collapsed';
  if (node.kind === 'step-more') return node.paused ? 'paused' : 'active';
  if (node.kind === 'pr') return node.semanticState || node.prState || 'unknown';
  return node.status || 'unknown';
}

export function graphNodeAriaLabel(node) {
  const base = `${entityName(node)}. Status ${entityStatus(node)}.`;
  if (node.kind !== 'pr') return `${base} Press Enter to replay evidence.`;
  const truth = node.currentTruth ?? node.recordedTruth ?? 'State unavailable';
  const evidence = [
    node.discoveryProvenance && `Discovery ${node.discoveryProvenance}`,
    node.snapshotProvenance && `Snapshot ${node.snapshotProvenance}`,
    node.confidence && `Confidence ${node.confidence}`,
  ].filter(Boolean).join('. ');
  return `${base} ${truth}.${evidence ? ` ${evidence}.` : ''} Press Enter to replay evidence.`;
}
