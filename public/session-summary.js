import { buildSessionDisposition } from './session-disposition.js';

function durationText(ms) {
  if (!(ms > 0)) return '0m';
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return `${Math.round(ms / 1_000)}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function timestampText(t) {
  return Number.isFinite(t) ? new Date(t).toISOString() : 'unavailable';
}

function effectivePrState(pr) {
  return pr.current?.state ?? pr.recorded?.state ?? null;
}

function provenanceText(insights) {
  const sources = ['recorded tape'];
  if (insights.prStack?.prs?.some(pr => pr.current != null)) {
    sources.push('current GitHub reconciliation');
  }
  if (insights.phases?.some(phase => phase.confidence !== 'explicit')) {
    sources.push('retrospective inference');
  }
  return `Provenance: ${sources.join(' · ')}`;
}

function freshnessText(insights) {
  const prs = insights.prStack?.prs ?? [];
  const currentRefreshTimes = prs
    .flatMap(pr => [pr.current?.fetchedAt, pr.current?.at])
    .filter(Number.isFinite);
  const knownRefreshTimes = [
    ...currentRefreshTimes,
    ...prs.flatMap(pr => [pr.recorded?.fetchedAt, pr.recorded?.at]),
    ...(insights.diagnostics ?? []).map(diagnostic => diagnostic.lastSignalT),
  ].filter(Number.isFinite);
  const latestCurrentRefresh = currentRefreshTimes.length ? Math.max(...currentRefreshTimes) : null;
  const latestKnownRefresh = knownRefreshTimes.length ? Math.max(...knownRefreshTimes) : null;
  const stale = insights.diagnostics?.some(diagnostic => diagnostic.kind === 'stale_poller');
  if (stale) {
    return latestKnownRefresh == null
      ? 'Source freshness: current GitHub stale'
      : `Source freshness: current GitHub stale; last successful refresh ${timestampText(latestKnownRefresh)}`;
  }
  if (latestCurrentRefresh != null) {
    return `Source freshness: current GitHub fetched ${timestampText(latestCurrentRefresh)}`;
  }
  return latestKnownRefresh == null
    ? 'Source freshness: current GitHub unavailable'
    : `Source freshness: current GitHub unavailable; last successful refresh ${timestampText(latestKnownRefresh)}`;
}

export function buildSummaryViewModel(insights) {
  const prs = insights.prStack?.prs ?? [];
  const open = prs.filter(pr => effectivePrState(pr) === 'open').length;
  const merged = prs.filter(pr => effectivePrState(pr) === 'merged').length;
  const roadmap = insights.roadmap ?? {};
  const remaining = (roadmap.todos ?? [])
    .filter(todo => todo.done !== true && todo.status !== 'completed')
    .map(todo => todo.text)
    .filter(Boolean);
  const inferredWork = insights.phases?.some(
    phase => phase.disposition === 'active' && phase.confidence !== 'explicit',
  );
  const sessionDisposition = buildSessionDisposition(insights);

  return {
    asOf: `As of: ${timestampText(insights.asOfT)}`,
    prs: `${open} ${open === 1 ? 'PR' : 'PRs'} open · ${merged} merged`,
    checklist: `Session checklist: ${roadmap.completed ?? 0}/${roadmap.total ?? 0}`,
    remaining: `Remaining checklist: ${remaining.length ? remaining.join(', ') : 'none'}`,
    roadmap: `Product roadmap: ${roadmap.assessment?.value ?? 'not assessed'}`,
    disposition: sessionDisposition.detail,
    sessionDisposition,
    recordedSpan: `${durationText(insights.clocks?.recordedSessionMs)} recorded session`,
    producerWindow: `${durationText(insights.clocks?.producerWindowMs)} producer window`,
    observedWork: `${durationText(insights.clocks?.observedActiveMs)} observed work · ${inferredWork ? 'Estimated' : 'Recorded'}`,
    provenance: provenanceText(insights),
    sourceFreshness: freshnessText(insights),
  };
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function item(label, value) {
  return `<div class="session-summary-item"><dt>${label}</dt><dd>${escapeHTML(value)}</dd></div>`;
}

export function summaryHTML(summary) {
  const confidence = String(summary.observedWork ?? '').split(' · ').at(-1) || 'Unspecified';
  return '<section class="session-summary" aria-labelledby="session-summary-title">'
    + '<h2 id="session-summary-title" class="sr-only">Session summary</h2>'
    + '<dl>'
    + item('As of', summary.asOf)
    + item('Pull requests', summary.prs)
    + item('Session checklist', summary.checklist)
    + item('Remaining checklist', summary.remaining)
    + item('Product roadmap', summary.roadmap)
    + item('Disposition', summary.disposition)
    + item('Clocks', `${summary.recordedSpan} · ${summary.producerWindow}`)
    + item('Observed work', summary.observedWork)
    + item('Confidence', confidence)
    + item('Provenance', summary.provenance)
    + item('Source freshness', summary.sourceFreshness)
    + '</dl>'
    + '</section>';
}
