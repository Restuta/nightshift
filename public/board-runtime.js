// Replay transport is deliberately tiny and dependency-injected so its one-shot
// contract can be tested without a browser. Live streaming remains in app.js.

import { fold } from './reducer.js';
import { buildSessionInsights } from './session-insights-model.js';

export function shouldOpenLiveStream(context) {
  return context?.mode === 'live';
}

export async function loadReplaySession({ context, sessionId, fetchImpl = fetch }) {
  if (context?.mode !== 'replay') throw new Error('replay context required');
  const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
  const response = await fetchImpl(`/events${query}`);
  if (!response.ok) throw new Error(`events request failed (${response.status})`);
  const text = await response.text();
  return text.split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(event => event && Number.isFinite(event.t) && typeof event.type === 'string')
    .sort((a, b) => a.t - b.t);
}

function rawCursor(events, cutoffT) {
  let cursor = 0;
  while (cursor < events.length && events[cursor].t <= cutoffT) cursor++;
  return cursor;
}

export function buildReplayFrame({ events, cursorT, asOfT = null }) {
  const tapeStartT = events[0]?.t ?? 0;
  const tapeEndT = events.at(-1)?.t ?? tapeStartT;
  const ceilingT = Number.isFinite(asOfT) ? Math.min(asOfT, tapeEndT) : tapeEndT;
  const floorT = Math.min(tapeStartT, ceilingT);
  const requestedT = Number.isFinite(cursorT) ? cursorT : ceilingT;
  const boundedCursorT = Math.max(floorT, Math.min(requestedT, ceilingT));
  const insights = buildSessionInsights(events, {
    untilT: boundedCursorT,
    asOfT,
    displayNow: boundedCursorT,
  });

  return {
    cursorT: boundedCursorT,
    cutoffT: boundedCursorT,
    ceilingT,
    cursor: rawCursor(events, boundedCursorT),
    state: fold(insights.visiblePrefix),
    insights,
  };
}

export function visibleReplayDelta(previousPrefix = [], nextPrefix = []) {
  const previouslyVisible = new Set(previousPrefix);
  return nextPrefix.filter(event => !previouslyVisible.has(event));
}

export function advanceReplayFrame({ events, cursorT, elapsedMs, speed = 1, asOfT = null }) {
  const delta = Math.max(0, Number(elapsedMs) || 0) * Math.max(0, Number(speed) || 0);
  return buildReplayFrame({ events, cursorT: cursorT + delta, asOfT });
}

export function resetGanttView({ overlay, body, axis, count }) {
  overlay.hidden = true;
  body.replaceChildren();
  axis.replaceChildren();
  count.textContent = '';
}

export function reconcileDisclosureList({
  list,
  markup,
  previousMarkup = '',
  activeElement = null,
}) {
  if (markup === previousMarkup) return { markup, changed: false };

  const scrollTop = list.scrollTop;
  const expandedKeys = new Set(
    [...list.querySelectorAll('.pr-details[open]')].map(details => details.dataset.prKey),
  );
  const focusedRow = activeElement?.closest?.('.pr-row[data-pr-key]') ?? null;
  const focusedKey = focusedRow?.dataset.prKey ?? null;
  const focusedTarget = activeElement?.matches?.('summary')
    ? '.pr-details > summary'
    : activeElement?.matches?.('a.pr-primary') ? 'a.pr-primary' : null;

  list.innerHTML = markup;
  for (const details of list.querySelectorAll('.pr-details[data-pr-key]')) {
    if (expandedKeys.has(details.dataset.prKey)) details.open = true;
  }
  if (focusedKey && focusedTarget) {
    const nextRow = [...list.querySelectorAll('.pr-row[data-pr-key]')]
      .find(row => row.dataset.prKey === focusedKey);
    nextRow?.querySelector(focusedTarget)?.focus({ preventScroll: true });
  }
  list.scrollTop = scrollTop;
  return { markup, changed: true };
}
