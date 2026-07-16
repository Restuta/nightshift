import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSessionInsights } from '../public/session-insights-model.js';
import { buildSummaryViewModel, summaryHTML } from '../public/session-summary.js';

function referenceInsights() {
  const events = readFileSync(new URL('./tapes/semantic-reference.jsonl', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  return buildSessionInsights(events, { untilT: Infinity, displayNow: events.at(-1).t });
}

test('summary gives exact, labeled shared copy', () => {
  const summary = buildSummaryViewModel(referenceInsights());

  assert.equal(summary.prs, '7 PRs open · 0 merged');
  assert.equal(summary.checklist, 'Session checklist: 8/10');
  assert.equal(summary.remaining, 'Remaining checklist: Roadmap, Final handoff');
  assert.equal(summary.roadmap, 'Product roadmap: roughly one-third');
  assert.equal(
    summary.disposition,
    'Turn complete · session open · human is next actor · no tool outcome is missing',
  );
  assert.match(summary.asOf, /^As of: /);
  assert.match(summary.recordedSpan, /^\d+h \d+m recorded session$/);
  assert.match(summary.producerWindow, /^\d+h \d+m producer window$/);
  assert.match(summary.observedWork, / observed work · Estimated$/);
  assert.match(summary.provenance, /^Provenance: .*recorded tape.*current GitHub.*retrospective inference/);
  assert.match(summary.sourceFreshness, /^Source freshness: current GitHub fetched /);
});

test('summary exposes unavailable current truth and explicit confidence in text', () => {
  const insights = buildSessionInsights([
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 1_000, id: 'edit', type: 'edit', path: 'a.js' },
    { t: 61_000, id: 'end', type: 'session', phase: 'end' },
  ], { untilT: 61_000, displayNow: 61_000 });

  const summary = buildSummaryViewModel(insights);

  assert.equal(summary.sourceFreshness, 'Source freshness: current GitHub unavailable');
  assert.equal(summary.observedWork, '1m observed work · Estimated');
  assert.match(summary.provenance, /retrospective inference/);
});

test('summary retains the last successful recorded GitHub refresh when current truth is unavailable', () => {
  const summary = buildSummaryViewModel({
    asOfT: 2_000,
    prStack: {
      prs: [{ recorded: { state: 'open', at: 1_000, fetchedAt: 900 }, current: null }],
    },
    diagnostics: [],
  });

  assert.equal(
    summary.sourceFreshness,
    'Source freshness: current GitHub unavailable; last successful refresh 1970-01-01T00:00:01.000Z',
  );
});

test('stale poller diagnostics retain their known last successful GitHub refresh', () => {
  const summary = buildSummaryViewModel({
    asOfT: 3_000,
    prStack: { prs: [] },
    diagnostics: [{ kind: 'stale_poller', lastSignalT: 2_000 }],
  });

  assert.equal(
    summary.sourceFreshness,
    'Source freshness: current GitHub stale; last successful refresh 1970-01-01T00:00:02.000Z',
  );
});

test('summary uses singular PR copy for one open pull request', () => {
  const summary = buildSummaryViewModel({
    asOfT: 1,
    prStack: { prs: [{ recorded: { state: 'open', at: 1 }, current: null }] },
  });

  assert.equal(summary.prs, '1 PR open · 0 merged');
});

test('summary HTML uses labeled definition-list semantics without inline behavior', () => {
  const summary = buildSummaryViewModel(referenceInsights());
  const html = summaryHTML(summary);

  assert.match(html, /^<section class="session-summary" aria-labelledby="session-summary-title">/);
  assert.match(html, /<h2 id="session-summary-title" class="sr-only">Session summary<\/h2>/);
  assert.match(html, /<dl>/);
  assert.equal((html.match(/<dt>/g) ?? []).length, 11);
  assert.equal((html.match(/<dd>/g) ?? []).length, 11);
  assert.match(html, />Confidence<\/dt><dd>Estimated<\/dd>/);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
});

test('summary HTML escapes copy derived from recorded content', () => {
  const summary = Object.fromEntries([
    'asOf',
    'prs',
    'checklist',
    'remaining',
    'roadmap',
    'disposition',
    'recordedSpan',
    'producerWindow',
    'observedWork',
    'provenance',
    'sourceFreshness',
  ].map(key => [key, `<script data-key="${key}">&</script>`]));

  const html = summaryHTML(summary);

  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;script data-key=&quot;roadmap&quot;&gt;&amp;&lt;\/script&gt;/);
});
