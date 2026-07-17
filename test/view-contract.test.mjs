import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSessionInsights } from '../public/session-insights-model.js';
import { buildSummaryViewModel, summaryHTML } from '../public/session-summary.js';
import { parseViewContext, viewHref } from '../public/session-view-context.js';
import { buildBoardViewModel } from '../public/board-model.js';
import { buildStoryReport } from '../public/story-model.js';
import { buildModel as buildLanesModel } from '../public/lanes-model.js';
import { buildGraphModel } from '../public/graph-model.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const REFERENCE_SESSION = 'semantic-reference';
const REFERENCE_CURSOR_T = 1_700_041_531_012;
const REFERENCE_AS_OF_T = 1_700_120_426_802;

function referenceEvents() {
  return read('test/tapes/semantic-reference.jsonl')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
}

function referenceReplayContext() {
  return parseViewContext(
    `?session=${REFERENCE_SESSION}&t=${REFERENCE_CURSOR_T}&at=${REFERENCE_AS_OF_T}`,
  );
}

function projectReferenceViews(events, context, { fullHorizon = false } = {}) {
  const insights = buildSessionInsights(events, {
    untilT: fullHorizon ? Infinity : (context.cutoffT ?? Infinity),
    asOfT: fullHorizon ? Infinity : context.asOfT,
    displayNow: fullHorizon
      ? (events.at(-1)?.t ?? 0)
      : (context.cursorT ?? context.cutoffT ?? events.at(-1)?.t ?? 0),
  });
  const summaries = Object.fromEntries(
    ['Board', 'Story', 'Lanes', 'Graph'].map(view => [view, buildSummaryViewModel(insights)]),
  );

  return {
    insights,
    summaries,
    renderedSummaries: Object.fromEntries(
      Object.entries(summaries).map(([view, summary]) => [view, summaryHTML(summary)]),
    ),
    board: buildBoardViewModel(insights),
    story: buildStoryReport(insights),
    lanes: buildLanesModel(events, insights, context),
    graph: buildGraphModel(insights.visiblePrefix, insights),
  };
}

function dispositionContract(disposition) {
  return Object.fromEntries([
    'state', 'inputRequest', 'currentBlocker', 'nextActor', 'nextAction',
  ].map(key => [key, disposition?.[key]]));
}

test('Board document exposes canonical summary, entity, freshness, timeline, and atomic page states', () => {
  const html = read('public/index.html');

  assert.match(html, /<body class="board-page">/);
  assert.match(html, /<details class="board-overview-details" id="board-overview-details">/);
  assert.match(html, /id="board-overview-label"/);
  assert.match(html, /id="board-overview-state-label"/);
  assert.match(html, /id="board-overview-meta"/);
  assert.match(html, /id="board-summary"[^>]*aria-label="Session summary"[^>]*hidden/);
  assert.match(html, /id="board-disposition"[^>]*aria-label="Session disposition"[^>]*hidden/);
  assert.match(html, /id="source-freshness"[^>]*role="status"/);
  assert.match(html, /id="tools"[^>]*aria-labelledby="tools-title"[^>]*hidden/);
  assert.match(html, /id="tools-title"[^>]*>Tool calls</);
  assert.match(html, /id="board-title"[^>]*>Work items</);
  assert.match(html, /Pull requests/);
  assert.match(html, /id="timeline-legend"[^>]*aria-label="Semantic timeline legend"/);
  assert.match(html, /id="event-activity-toggle"[^>]*aria-pressed="false"/);
  assert.match(html, /id="event-counts"[^>]*aria-live="polite"/);
  assert.match(html, /id="stat-recorded-session"[^>]*>0s<\/span><span class="stat-label">recorded session<\/span>/);
  assert.doesNotMatch(html, /id="stat-elapsed"|<span class="stat-label">elapsed<\/span>/);
  assert.match(html, /id="board-loading"[^>]*role="status"/);
  assert.match(html, /id="board-empty"[^>]*aria-hidden="true"[^>]*hidden/);
  assert.match(html, /id="board-error"[^>]*role="alert"[^>]*hidden/);
});

test('Board consumes one canonical insight projection and exact shared summary copy', () => {
  const source = read('public/app.js');

  assert.match(source, /from '\.\/session-insights-model\.js'/);
  assert.match(source, /from '\.\/session-summary\.js'/);
  assert.match(source, /from '\.\/session-view-context\.js'/);
  assert.match(source, /from '\.\/board-model\.js'/);
  assert.match(source, /from '\.\/board-runtime\.js'/);
  assert.match(source, /const viewContext = parseViewContext\(location\.search\)/);
  assert.match(source, /buildSessionInsights\(log,/);
  assert.match(source, /const boardView = buildBoardViewModel\(insights\)/);
  assert.match(source, /summaryHTML\(summary\)/);
  assert.match(source, /OVERVIEW_KEY = 'ns-board-overview-open'/);
  assert.match(source, /overviewDetails\.addEventListener\('toggle'/);
  assert.match(source, /\$\('#board-overview-meta'\)\.textContent/);
  assert.match(source, /\$\('#board-overview-state-label'\)\.textContent = boardView\.disposition\.label/);
  assert.match(source, /renderAll\([^)]*insights/);
  assert.match(source, /viewHref\('\/', viewContext\)/);
  assert.match(source, /viewHref\('\/story', viewContext\)/);
  assert.match(source, /viewHref\('\/lanes', viewContext\)/);
  assert.match(source, /viewHref\('\/graph', viewContext\)/);
});

test('Board replay is one-shot while live mode retains streaming reconciliation', () => {
  const source = read('public/app.js');
  const replayBranch = source.indexOf("viewContext.mode === 'replay'");
  const replayLoad = source.indexOf('await loadReplaySession', replayBranch);
  const replayReturn = source.indexOf('return;', replayLoad);
  const liveConnect = source.indexOf('connect(picker.current)', replayReturn);

  assert.ok(replayBranch >= 0 && replayLoad > replayBranch && replayReturn > replayLoad);
  assert.ok(liveConnect > replayReturn, 'live connection starts only after the replay branch returns');
  assert.match(source, /new EventSource\('\/sse\?session='/);
  assert.match(source, /let sessionId = viewContext\.session/);
  assert.match(source, /shouldOpenLiveStream\(viewContext\)/);
  assert.match(source, /buildReplayFrame\(\{/);
  assert.match(source, /advanceReplayFrame\(\{/);
  assert.match(source, /visibleReplayDelta\(previousPrefix, frame\.insights\.visiblePrefix\)/);
  assert.match(source, /viewContext\.cursorT = Math\.round\(frame\.cursorT\)/);
  assert.match(source, /viewContext\.cutoffT = frame\.cutoffT/);
  assert.match(source, /renderAll\([^)]*frame\.insights/);
  assert.doesNotMatch(source, /Math\.min\(vt, viewContext\.cutoffT \?\? Infinity\)/);
  assert.doesNotMatch(source, /for \(const event of events\) if \(event\.t <= cutoff\) log\.push\(event\)/);
  assert.match(source, /function scrubTo\(t\)[\s\S]*if \(es\) \{[\s\S]*es\.close\(\);[\s\S]*es = null/);
  assert.match(source, /if \(!shouldOpenLiveStream\(viewContext\)\) return;/);
  assert.doesNotMatch(source.slice(replayBranch, replayReturn), /openStream|EventSource|initSessionPicker/);

  const runtime = read('public/board-runtime.js');
  assert.match(runtime, /state: fold\(insights\.visiblePrefix\)/);
});

test('Board labels every duration, lifecycle, event count, and freshness state', () => {
  const source = `${read('public/app.js')}\n${read('public/board-model.js')}`;

  for (const label of [
    'Open for',
    'observed work',
    'elapsed',
    'recorded session',
    'Waiting for your next instruction',
    'Permission blocked',
    'Completed',
    'Outcome unknown',
    'measured tool execution',
    'non-heartbeat events',
    'heartbeats excluded',
    'last successful refresh',
  ]) assert.match(source, new RegExp(label));
  assert.doesNotMatch(source, /permission or input requested/);
  assert.match(source, /event\.type !== 'alive'/);
  assert.match(source, /insights\.phases/);
});

test('Board masthead and readout use the canonical recorded-session clock', () => {
  const source = read('public/app.js');

  assert.match(source, /\$\('#stat-recorded-session'\)\.textContent = currentBoardView\?\.clocks\.recordedSession\.value \?\? '0s'/);
  assert.match(source, /`Recorded session \$\{currentBoardView\?\.clocks\.recordedSession\.value \?\? '0s'\}/);
  assert.doesNotMatch(source, /\$\('#stat-elapsed'\)/);
  assert.doesNotMatch(source, /vtNow\(\) - \(state\.session\.startedAt/);
});

test('Board clears all prior-session semantic surfaces before loading and on error', () => {
  const source = read('public/app.js');
  const start = source.indexOf('function clearSessionView()');
  const end = source.indexOf('\n}\n', start) + 2;
  assert.ok(start >= 0, 'one atomic reset owns prior-session cleanup');
  const clear = source.slice(start, end);

  for (const contract of [
    /log\.length = 0/,
    /state = initialState\(\)/,
    /currentInsights = null/,
    /currentBoardView = null/,
    /\$\('#board-summary'\)\.replaceChildren\(\)/,
    /\$\('#board-disposition'\)\.replaceChildren\(\)/,
    /\$\('#tools-list'\)\.replaceChildren\(\)/,
    /\$\('#prs-list'\)\.replaceChildren\(\)/,
    /\$\('#plan-list'\)\.replaceChildren\(\)/,
    /feedEl\.replaceChildren\(\)/,
    /resetGanttView\(\{/,
    /overlay: \$\('#gantt-overlay'\)/,
    /body: \$\('#gantt-body'\)/,
    /axis: \$\('#gantt-axis'\)/,
    /count: \$\('#gantt-count'\)/,
  ]) assert.match(clear, contract);

  assert.match(source, /clearSessionView\(\);\s*setBoardState\('loading'\)/);
  assert.match(source, /catch \(error\) \{\s*clearSessionView\(\);\s*setBoardState\('error'/);
  assert.match(source, /setBoardState\('empty'\)/);
});

test('Board semantic styling is flat, calm, and exposes text-backed status and focus', () => {
  const css = read('public/style.css');
  const board = css.slice(css.indexOf('/* ------------------------------------------------ semantic board state */'), css.indexOf('/* ------------------------------------------------------------- recorder */'));

  assert.ok(board.length > 0, 'semantic Board style section exists');
  assert.doesNotMatch(board, /gradient\(/i);
  assert.doesNotMatch(board, /text-shadow|box-shadow/i);
  assert.match(board, /\.board-page::before/);
  assert.match(board, /\.board-disposition\[data-state="attention"\]/);
  assert.match(board, /\.board-overview-details > summary:focus-visible/);
  assert.match(board, /\.pr-details > summary:focus-visible/);
  assert.match(board, /\.tool-state\[data-state="outcome-unknown"\]/);
  assert.match(board, /#event-activity-toggle:focus-visible/);
});

test('Board PR rows keep forensic metadata behind native disclosure', () => {
  const source = read('public/app.js');
  const css = read('public/style.css');

  assert.match(source, /<details class="pr-details"[^>]*>/);
  assert.match(source, /class="pr-forensics"/);
  assert.match(source, /data-tone="\$\{esc\(pr\.summaryTone\)\}"/);
  assert.doesNotMatch(source, /<a class="pr-row"/);
  assert.match(source, /reconcileDisclosureList\(\{/);
  assert.match(css, /\.pr-details:not\(\[open\]\) \.pr-forensics/);
});

test('Board narrow masthead reflows without hiding navigation', () => {
  const html = read('public/index.html');
  const css = read('public/style.css');
  const narrowStart = css.indexOf('@media (max-width: 700px)', css.indexOf('/* ------------------------------------------------ semantic board state */'));
  const narrow = css.slice(narrowStart, css.indexOf('/* ------------------------------------------------------------- recorder */'));

  assert.ok(narrowStart >= 0, 'Board has an explicit narrow-width contract');
  assert.equal((html.match(/class="stat stat-secondary"/g) ?? []).length, 6);
  assert.match(html, /class="stat stat-secondary"[^>]*><span class="stat-value adds"/);
  assert.match(html, /class="stat stat-secondary"[^>]*><span class="stat-value dels"/);
  assert.match(narrow, /\.board-page \.masthead\s*{[^}]*height:\s*auto[^}]*flex-wrap:\s*wrap/s);
  assert.match(narrow, /\.board-page \.brand\s*{[^}]*width:\s*100%[^}]*min-width:\s*0/s);
  assert.match(narrow, /\.board-page \.instruments\s*{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*flex-wrap:\s*wrap/s);
  assert.match(narrow, /\.board-page \.stat-secondary\s*{[^}]*display:\s*none/s);
  assert.doesNotMatch(narrow, /(?:\.(?:icon-btn|board-nav)|#(?:report-link|story-link|lanes-link|graph-link))[^{]*{[^}]*display:\s*none/s);
});

test('Board narrow timeline keeps activity counts accessible without widening the document', () => {
  const html = read('public/index.html');
  const css = read('public/style.css');
  const narrowStart = css.indexOf('@media (max-width: 700px)', css.indexOf('/* ------------------------------------------------ semantic board state */'));
  const narrow = css.slice(narrowStart, css.indexOf('/* ------------------------------------------------------------- recorder */'));

  assert.match(html, /id="event-counts"[^>]*aria-live="polite"/);
  assert.match(narrow, /\.board-page \.timeline-meta\s*{[^}]*min-width:\s*0/s);
  assert.match(narrow, /\.board-page \.event-counts\s*{[^}]*position:\s*absolute[^}]*width:\s*1px[^}]*height:\s*1px[^}]*overflow:\s*hidden[^}]*clip:\s*rect\(0,\s*0,\s*0,\s*0\)/s);
  assert.doesNotMatch(narrow, /\.board-page \.event-counts\s*{[^}]*(?:display:\s*none|visibility:\s*hidden)/s);
});

test('Lanes document exposes semantic summary, controls, focus layer, and drawer states', () => {
  const html = read('public/lanes.html');

  assert.match(html, /id="lanes-summary"[^>]*aria-label="Session summary"/);
  assert.match(html, /id="phase-summary"[^>]*aria-label="Semantic phase totals"/);
  assert.match(html, /<canvas[^>]*id="lanes-canvas"[^>]*aria-hidden="true"/);
  assert.match(html, /id="segment-layer"[^>]*aria-label="Inspectable timeline segments"/);
  assert.match(html, /id="preflight-toggle"[^>]*aria-expanded="true"/);
  assert.match(html, /id="item-overlay-toggle"/);
  assert.match(html, /id="activity-overlay-toggle"/);
  assert.match(html, /id="evidence-drawer"[^>]*aria-labelledby="evidence-title"[^>]*aria-live="polite"[^>]*hidden/);
  assert.match(html, /id="evidence-close"[^>]*aria-label="Close evidence"/);

  assert.match(html, /id="lanes-loading"[^>]*role="status"/);
  assert.match(html, /id="lanes-empty"[^>]*aria-hidden="true"[^>]*hidden/);
  assert.match(html, /id="lanes-error"[^>]*role="alert"[^>]*hidden/);
});

test('Lanes legend names states, confidence textures, tool meanings, and every preflight substage', () => {
  const html = read('public/lanes.html');
  for (const label of ['Coding', 'Testing', 'Preflight', 'Other', 'Waiting', 'Idle', 'Unknown']) {
    assert.match(html, new RegExp(`>${label}<`));
  }
  for (const label of ['Explicit', 'Strong inference', 'Heuristic', 'Tool execution', 'Human input', 'Permission blocked', 'Tool outcome unknown']) {
    assert.match(html, new RegExp(label));
  }
  for (const label of ['Prepare', 'Local validation', 'Visual QA', 'Self review', 'Cross-AI review', 'Publish PR', 'Readiness wait', 'Readiness fix']) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /Unknown tool outcomes are not labeled blocked/);
  assert.match(html, /PR transition — recorded ring, current square/);
  assert.match(html, /Event activity — recorded producer events only; passive and reconcile traffic excluded/);
});

test('Lanes source consumes canonical insights, preserves replay context, and never opens live transport', () => {
  const source = read('public/lanes.js');
  assert.match(source, /from '\.\/session-insights-model\.js'/);
  assert.match(source, /from '\.\/session-summary\.js'/);
  assert.match(source, /from '\.\/session-view-context\.js'/);
  assert.match(source, /buildSessionInsights\(events,/);
  assert.match(source, /buildModel\(events, insights, viewContext\)/);
  assert.match(source, /summaryHTML\(buildSummaryViewModel\(insights\)\)/);
  assert.match(source, /viewHref\('\/', viewContext\)/);
  assert.doesNotMatch(source, /EventSource|\/sse/);
  assert.match(source, /viewContext\.mode === 'replay'/);
  assert.match(source, /initSessionPicker/);
});

test('Lanes evidence supports native keyboard activation, Escape close, and focus return', () => {
  const source = read('public/lanes.js');
  assert.match(source, /document\.createElement\('button'\)/);
  assert.match(source, /button\.addEventListener\('click', \(\) => openEvidence\(descriptor\.id, button\)\)/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /evidenceReturnFocus\?\.focus\(\)/);
  assert.match(source, /setAttribute\('aria-label', descriptorAriaLabel\(descriptor\)\)/);
  assert.match(source, /function prStateLabel\(pr\)/);
  assert.match(source, /prStateLabel\(row\.pr\)/);
  assert.match(source, /Outcome: \$\{descriptor\.outcome \?\? 'not recorded'\}/);
  assert.match(source, /descriptor\.recordedTruth, descriptor\.currentTruth, descriptor\.stackTruth/);
  assert.match(source, /for \(const transition of row\.pr\?\.transitions \?\? \[\]\)/);
  assert.match(source, /addSegmentButton\(row, transition,[\s\S]*'marker pr-transition'\)/);
  assert.match(source, /addFact\(facts, 'Occurred', Number\.isFinite\(descriptor\.occurredAt\)\s*\? timeText\(descriptor\.occurredAt\)\s*: null\)/);
  assert.match(source, /addFact\(facts, 'Observed', Number\.isFinite\(descriptor\.observedAt\)\s*\? timeText\(descriptor\.observedAt\)\s*: null\)/);
  assert.match(source, /descriptor\.occurredAt[\s\S]*`occurred \$\{timeText\(descriptor\.occurredAt\)\}`/);
  assert.match(source, /descriptor\.observedAt[\s\S]*`observed \$\{timeText\(descriptor\.observedAt\)\}`/);
  assert.match(source, /const recordedPercent = Number\.isFinite\(descriptor\.percent\)[\s\S]*percent of recorded session[\s\S]*: null;[\s\S]*recordedPercent \? `, \$\{recordedPercent\}` : ''/);
  assert.match(source, /addFact\(facts, 'Recorded session portion', Number\.isFinite\(descriptor\.percent\)[\s\S]*: null\)/);
});

test('Lanes clears every prior-session surface before loading and on error', () => {
  const source = read('public/lanes.js');
  const start = source.indexOf('function clearSessionView()');
  const end = source.indexOf('\n}\n', start) + 2;
  assert.ok(start >= 0, 'a single reset function owns prior-session cleanup');
  const clear = source.slice(start, end);

  for (const contract of [
    /events = \[\]/,
    /insights = null/,
    /model = null/,
    /rows = \[\]/,
    /descriptorById = new Map\(\)/,
    /document\.title = 'lanes'/,
    /\$\('#session-title'\)\.textContent = ''/,
    /badge\.textContent = ''/,
    /badge\.hidden = true/,
    /\$\('#lanes-summary'\)\.replaceChildren\(\)/,
    /\$\('#phase-summary'\)\.replaceChildren\(\)/,
    /segmentLayer\.replaceChildren\(\)/,
    /ctx\.clearRect\(0, 0, canvas\.width, canvas\.height\)/,
  ]) assert.match(clear, contract);

  assert.match(source, /syncNavigation\(\);\s*clearSessionView\(\);\s*setPageState\('loading'\)/);
  assert.match(source, /catch \(error\) \{\s*clearSessionView\(\);\s*setPageState\('error'/);
});

test('Lanes styling stays flat and exposes semantic textures and focus', () => {
  const css = read('public/style.css');
  const lanes = css.slice(css.indexOf('/* ------------------------------------------------------------ lane timeline */'), css.indexOf('/* ------------------------------------------------------------ graph view */'));
  assert.doesNotMatch(lanes, /gradient\(/i);
  assert.doesNotMatch(lanes, /text-shadow|box-shadow/i);
  assert.match(lanes, /\.semantic-segment\[data-confidence="strong"\]/);
  assert.match(lanes, /\.semantic-segment\[data-confidence="heuristic"\]/);
  assert.match(lanes, /\.semantic-segment:focus-visible/);
  assert.match(lanes, /\.evidence-drawer/);
  assert.match(lanes, /\.session-summary/);
});

test('Story document exposes the shared summary and semantic morning-report regions', () => {
  const html = read('public/story.html');

  assert.match(html, /id="story-summary"[^>]*aria-label="Session summary"/);
  assert.match(html, /id="morning-report"[^>]*aria-labelledby="morning-report-title"[^>]*hidden/);
  assert.match(html, /id="story-disposition"[^>]*aria-label="Current disposition"/);
  assert.match(html, /id="story-phase-totals"[^>]*aria-label="Semantic phase totals"/);
  assert.match(html, /id="story-pr-stack"[^>]*aria-label="Pull request stack"/);
  assert.match(html, /id="story-stale-warning"[^>]*role="status"[^>]*hidden/);
  assert.match(html, /id="story-loading"[^>]*role="status"[^>]*hidden/);
  assert.match(html, /id="story-error"[^>]*role="alert"[^>]*hidden/);
  assert.match(html, /Active · Attention · Blocked · Complete/);
  assert.match(html, /id="story-empty"[^>]*aria-hidden="true"[^>]*hidden/);
});

test('Story consumes one canonical insight model and keeps digest narrative-only', () => {
  const source = read('public/story.js');

  assert.match(source, /from '\.\/session-insights-model\.js'/);
  assert.match(source, /from '\.\/session-summary\.js'/);
  assert.match(source, /from '\.\/session-view-context\.js'/);
  assert.equal((source.match(/buildSessionInsights\(/g) ?? []).length, 1);
  assert.match(source, /buildDigest\(buildStoryNarrativeEvents\(insights\), Infinity\)/);
  assert.match(source, /render\(digest, insights\)/);
  assert.match(source, /summaryHTML\(buildSummaryViewModel\(insights\)\)/);
  assert.match(source, /buildStoryBlocks\(digest\.chapters, digest\.gaps, insights\)/);
  assert.doesNotMatch(source, /digest\.totals\.prsOpened|digest\.totals\.prsMerged/);
  assert.doesNotMatch(source, /chapter\.activeMs|digest\.activeMs|digest\.idleMs/);
  assert.match(source, /recorded-event gap/);
  assert.doesNotMatch(source, /\$\{durationText\(block\.ms\)\} idle/);
});

test('Story chapter PR chips render canonical truth and links instead of digest fallback data', () => {
  const source = read('public/story.js');
  assert.match(source, /const prsByNumber = new Map\(report\.prs\.map\(pr => \[pr\.number, pr\]\)\)/);
  assert.match(source, /\.map\(block => blockHTML\(block, prsByNumber\)\)\.join\(''\)/);
  assert.match(source, /function blockHTML\(block, prsByNumber\)/);
  assert.match(source, /return episodeHTML\(block\.chapter, prsByNumber\)/);
  assert.match(source, /function episodeHTML\(chapter, prsByNumber\)/);
  assert.match(source, /prChipHTML\(prsByNumber\.get\(pr\.number\) \?\? pr\)/);

  const declaration = (name, nextName) => {
    const start = source.indexOf(`function ${name}`);
    const end = source.indexOf(`\n\nfunction ${nextName}`, start);
    assert.ok(start >= 0 && end > start, `extract ${name}`);
    return source.slice(start, end);
  };
  const renderEpisode = Function(
    'escapeHTML', 'truncate', 'replayHref', 'clockT', 'durationText', 'countText',
    `${declaration('episodeHTML', 'chapterDurationText')}\n`
      + `${declaration('chapterDurationText', 'prChipHTML')}\n`
      + `${declaration('prChipHTML', 'unattachedHTML')}\nreturn episodeHTML;`,
  )(
    value => String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]),
    (value, length) => String(value ?? '').slice(0, length),
    t => `/replay?t=${t}`,
    t => `clock-${t}`,
    ms => `${ms}ms`,
    value => String(value),
  );

  const digestPr = { number: 102, title: 'Digest-only title', state: 'open', openedT: 10 };
  const canonicalPr = {
    number: 102,
    title: 'Canonical report title',
    state: 'merged',
    recordedTruth: 'Recorded: open · gates pass',
    currentTruth: 'Current: merged · gates pass',
    changedSinceRecording: true,
    provenance: 'Authoritative GitHub facts',
    replayT: 99,
    url: 'https://github.com/acme/widgets/pull/102',
  };
  const html = renderEpisode({
    startT: 1,
    wallMs: 10,
    title: 'Chapter',
    label: null,
    prs: [digestPr],
    counts: { commits: 0, edits: 0 },
    commits: [],
    closer: null,
  }, new Map([[102, canonicalPr]]));

  assert.match(html, /Canonical report title/);
  assert.doesNotMatch(html, /Digest-only title/);
  assert.match(html, /<b>Recorded<\/b> open · gates pass/);
  assert.match(html, /<b>Current<\/b> merged · gates pass/);
  assert.match(html, /href="https:\/\/github\.com\/acme\/widgets\/pull\/102"[^>]*>GitHub<\/a>/);
  assert.match(html, /href="\/replay\?t=99">replay<\/a>/);
});

test('Story preserves replay context and replay never opens live transport or refresh paths', () => {
  const source = read('public/story.js');

  assert.match(source, /const viewContext = parseViewContext\(location\.search\)/);
  assert.match(source, /viewHref\('\/', viewContext\)/);
  assert.match(source, /viewHref\('\/lanes', viewContext\)/);
  assert.match(source, /viewHref\('\/graph', viewContext\)/);
  assert.match(source, /viewContext\.mode === 'replay'/);
  assert.match(source, /viewContext\.cutoffT \?\? Infinity/);
  assert.match(source, /if \(viewContext\.mode === 'live' && !document\.hidden && sessionId\)/);
  assert.doesNotMatch(source, /EventSource|\/sse/);
});

test('Story exposes PR truth, topology, evidence, and accessible populated-empty state changes', () => {
  const source = read('public/story.js');

  assert.match(source, /Recorded truth/);
  assert.match(source, /Current truth/);
  assert.match(source, /Recorded stack/);
  assert.match(source, /Current stack/);
  assert.match(source, /Evidence and confidence/);
  assert.match(source, /Open PR #\$\{pr\.number\} on GitHub/);
  assert.match(source, /Replay PR #\$\{pr\.number\} evidence/);
  for (const label of ['Occurred', 'Observed', 'Recovery recorded', 'Recorded PR snapshot', 'Current PR snapshot', 'Current fetched']) {
    assert.match(source, new RegExp(`>${label}<`));
  }
  assert.match(source, /pr\.replayT/);
  assert.match(source, /disposition\.uncertainty/);
  assert.match(source, /emptyElement\.setAttribute\('aria-hidden', String\(!empty\)\)/);
});

test('Story clears every prior-session surface and keeps loading, error, and empty distinct', () => {
  const source = read('public/story.js');
  const start = source.indexOf('function clearSessionView()');
  const end = source.indexOf('\n}\n', start) + 2;
  assert.ok(start >= 0, 'one atomic reset owns prior-session cleanup');
  const clear = source.slice(start, end);

  for (const contract of [
    /document\.title = 'story'/,
    /\$\('#session-title'\)\.textContent = ''/,
    /badge\.textContent = ''/,
    /badge\.hidden = true/,
    /\$\('#story-stale-warning'\)\.textContent = ''/,
    /\$\('#story-stale-warning'\)\.hidden = true/,
    /\$\('#chapters-head'\)\.textContent = ''/,
    /\$\('#story-summary'\)\.replaceChildren\(\)/,
    /\$\('#story-pr-stack'\)\.replaceChildren\(\)/,
    /\$\('#blocks'\)\.replaceChildren\(\)/,
  ]) assert.match(clear, contract);

  assert.match(source, /syncNavigation\(\);\s*clearSessionView\(\);\s*setPageState\('loading'\)/);
  assert.match(source, /catch \(error\) \{\s*if \(sequence !== loadSeq\) return;\s*clearSessionView\(\);\s*setPageState\('error'/);
  assert.match(source, /setPageState\('empty'\)/);
  assert.doesNotMatch(source, /catch \{\s*text = ''/);
});

test('Story styling stays flat and uses restrained semantic status treatments', () => {
  const css = read('public/style.css');
  const story = css.slice(css.indexOf('/* ------------------------------------------------------------ story (/story)'));

  assert.doesNotMatch(story, /gradient\(/i);
  assert.doesNotMatch(story, /text-shadow|box-shadow/i);
  assert.match(story, /\.story-disposition\[data-state="attention"\]/);
  assert.match(story, /\.story-pr-truth/);
  assert.match(story, /\.story-evidence/);
  assert.match(story, /\.story-stale-warning/);
});

test('Story narrow masthead, navigation, and episode durations wrap within the viewport', () => {
  const css = read('public/style.css');
  const story = css.slice(css.indexOf('/* ------------------------------------------------------------ story (/story)'));
  const narrowStart = story.indexOf('@media (max-width: 700px)');
  const narrow = story.slice(narrowStart);

  assert.ok(narrowStart >= 0, 'Story has an explicit narrow-width contract');
  assert.match(narrow, /\.story-page \.masthead\s*{[^}]*height:\s*auto[^}]*flex-wrap:\s*wrap/s);
  assert.match(narrow, /\.story-page \.brand\s*{[^}]*width:\s*100%[^}]*min-width:\s*0/s);
  assert.match(narrow, /\.story-page \.instruments\s*{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*flex-wrap:\s*wrap/s);
  assert.match(narrow, /\.story-nav\s*{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*flex-wrap:\s*wrap/s);
  assert.match(narrow, /\.ep-head\s*{[^}]*min-width:\s*0[^}]*flex-wrap:\s*wrap/s);
  assert.match(narrow, /\.ep-durs\s*{[^}]*min-width:\s*0[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s);
});

test('Graph runtime imports the canonical insights, summary, and replay context modules', () => {
  const models = read('graph-app/src/models.js');
  const source = read('graph-app/src/App.jsx');

  assert.match(models, /import\(\/\* @vite-ignore \*\/ '\/session-insights-model\.js'\)/);
  assert.match(models, /import\(\/\* @vite-ignore \*\/ '\/session-summary\.js'\)/);
  assert.match(models, /import\(\/\* @vite-ignore \*\/ '\/session-view-context\.js'\)/);
  assert.equal((source.match(/buildSessionInsights\(/g) ?? []).length, 1);
  assert.match(source, /buildGraphModel\([^,]+, insights\)/);
  assert.match(source, /buildSummaryViewModel\(insights\)/);
  assert.match(source, /<Summary summary=\{derived\.summary\}/);
  assert.match(source, /viewHref\('\/', viewContext\)/);
  assert.match(source, /viewHref\('\/story', viewContext\)/);
  assert.match(source, /viewHref\('\/lanes', viewContext\)/);
  assert.match(source, /viewHref\('\/graph', viewContext\)/);
});

test('Graph replay performs one event load, opens no stream, and keeps page states atomic', () => {
  const source = read('graph-app/src/App.jsx');
  const replayBranch = source.indexOf("if (context.mode === 'replay')");
  const replayReturn = source.indexOf('return;', replayBranch);
  const stream = source.indexOf('openStream(id)', replayReturn);

  assert.ok(replayBranch >= 0 && replayReturn > replayBranch && stream > replayReturn);
  assert.match(source, /fetch\('\/events' \+ query\)/);
  assert.match(source, /new EventSource\('\/sse\?session='/);
  assert.doesNotMatch(source.slice(replayBranch, replayReturn), /EventSource|openStream|\/sse/);
  assert.match(source, /setPageState\('loading'\)/);
  assert.match(source, /setPageState\('empty'\)/);
  assert.match(source, /setPageState\('error'/);
  assert.match(source, /setPageState\('populated'\)/);
  assert.match(source, /eventsRef\.current = \[\]/);
  assert.match(source, /setNodes\(\[\]\)/);
  assert.match(source, /setEdges\(\[\]\)/);
});

test('Graph wires replay and session selection through current-context runtime behavior', () => {
  const source = read('graph-app/src/App.jsx');
  const timeline = read('graph-app/src/Timeline.jsx');

  assert.match(source, /viewContextRef\.current/);
  assert.match(source, /selectGraphSession\(viewContextRef,/);
  assert.match(source, /loadSession\(id, selection\.context\)/);
  assert.match(source, /shouldOpenGraphStream\(context\)/);
  assert.match(source, /buildReplayWindow\(\{/);
  assert.match(source, /ceilingT=\{derived\.replayWindow\.ceilingT\}/);
  assert.match(timeline, /timelineKeyTarget\(event\.key,/);
  assert.match(timeline, /timelinePointerTarget\(fraction,/);
});

test('Graph semantic timeline is keyboard operable and tool evidence is labeled rather than density bars', () => {
  const timeline = read('graph-app/src/Timeline.jsx');
  const runtime = read('graph-app/src/runtime.js');

  assert.match(timeline, /role="slider"/);
  assert.match(timeline, /tabIndex=\{0\}/);
  assert.match(timeline, /aria-valuemin=\{0\}/);
  assert.match(timeline, /aria-valuemax=\{100\}/);
  assert.match(timeline, /aria-valuenow=/);
  assert.match(timeline, /aria-valuetext=/);
  for (const key of ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Enter']) {
    assert.match(`${timeline}\n${runtime}`, new RegExp(`'${key}'`));
  }
  assert.match(timeline, /insights\.phases/);
  assert.match(timeline, /insights\.toolCalls\.lifecycles/);
  assert.match(timeline, /insights\.toolCalls\.pointObservations/);
  assert.match(timeline, /Tool evidence:/);
  assert.doesNotMatch(timeline, /activeSegments|gf-tl-seg/);
});

test('Graph exposes text-backed truth, accessible nodes, state legend, and flat forensic styling', () => {
  const source = `${read('graph-app/src/App.jsx')}\n${read('graph-app/src/nodes/index.jsx')}\n${read('graph-app/src/Summary.jsx')}`;
  const flow = read('graph-app/src/flow-build.js');
  const css = read('graph-app/src/app.css');

  for (const label of ['Active', 'Attention', 'Blocked', 'Complete', 'Current truth', 'Recorded truth', 'Provenance', 'Confidence', 'Current blocker', 'Next actor']) {
    assert.match(source, new RegExp(label));
  }
  assert.match(flow, /focusable: true/);
  assert.match(flow, /ariaLabel: graphNodeAriaLabel\(n\)/);
  assert.match(flow, /ariaLabel: graphNodeAriaLabel\(sessionNode\)/);
  assert.match(source, /Discovery provenance/);
  assert.match(source, /Snapshot provenance/);
  assert.match(source, /Uncertainty/);
  assert.match(source, /onNodeKeyDown/);
  assert.match(source, /event\.key === 'Enter' \|\| event\.key === ' '/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /gradient\(/i);
  assert.doesNotMatch(css, /text-shadow|box-shadow/i);
});

test('reference full horizon gives every view one exact shared semantic summary', () => {
  const views = projectReferenceViews(referenceEvents(), referenceReplayContext(), {
    fullHorizon: true,
  });
  const expectedDisposition = {
    state: 'attention',
    inputRequest: 'none',
    label: 'Waiting for your next instruction',
    detail: 'Turn complete · session open · human is next actor · no tool outcome is missing',
    currentBlocker: 'No execution blocker',
    nextActor: 'human',
    nextActorLabel: 'Human',
    nextAction: 'Human: provide the next instruction',
    confidence: 'Explicit lifecycle evidence',
    uncertainty: null,
    uncertaintyText: 'No unresolved tool outcomes',
  };
  const expectedSummary = {
    asOf: 'As of: 2023-11-16T07:40:26.802Z',
    prs: '7 PRs open · 0 merged',
    checklist: 'Session checklist: 8/10',
    remaining: 'Remaining checklist: Roadmap, Final handoff',
    roadmap: 'Product roadmap: roughly one-third',
    disposition: 'Turn complete · session open · human is next actor · no tool outcome is missing',
    sessionDisposition: expectedDisposition,
    recordedSpan: '11h 32m recorded session',
    producerWindow: '11h 30m producer window',
    observedWork: '48m observed work · Estimated',
    provenance: 'Provenance: recorded tape · current GitHub reconciliation · retrospective inference',
    sourceFreshness: 'Source freshness: current GitHub fetched 2023-11-16T07:40:26.802Z',
  };

  for (const [view, summary] of Object.entries(views.summaries)) {
    assert.deepEqual(summary, expectedSummary, `${view} uses the exact shared summary values`);
  }
  assert.equal(
    new Set(Object.values(views.renderedSummaries)).size,
    1,
    'the shared summary renderer produces identical markup for all four consumers',
  );

  assert.equal(views.board.prTotals, expectedSummary.prs);
  assert.equal(views.board.disposition.state, 'attention');
  assert.equal(views.board.disposition.nextActor, 'human');
  assert.equal(views.board.disposition.nextActorLabel, 'Human');
  assert.equal(views.board.clocks.recordedSession.value, '11h 32m');
  assert.equal(views.story.checklist.label, expectedSummary.checklist);
  assert.equal(views.story.roadmap.label, expectedSummary.roadmap);
  assert.equal(views.story.disposition.detail, expectedSummary.disposition);
  assert.equal(views.story.disposition.nextAction, 'Human: provide the next instruction');
  assert.equal(views.lanes.semanticRows.prs.length, 7);
  assert.equal(views.lanes.t1 - views.lanes.t0, views.insights.clocks.recordedSessionMs);
  assert.deepEqual(views.graph.semantic.phases, views.insights.phases);
  assert.equal(views.graph.semantic.state, 'attention');
  assert.equal(views.graph.semantic.nextActor, 'human');
  assert.equal(views.graph.nodes.filter(node => node.kind === 'pr').length, 7);
});

test('historical permission evidence does not keep the canonical disposition blocked after resolution', () => {
  const projection = events => {
    const insights = buildSessionInsights(events, { untilT: Infinity, displayNow: events.at(-1).t });
    return {
      insights,
      dispositions: [
        buildBoardViewModel(insights).disposition,
        buildStoryReport(insights).disposition,
        buildGraphModel(insights.visiblePrefix, insights).semantic,
        buildSummaryViewModel(insights).sessionDisposition,
      ],
    };
  };
  const permission = [
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 10, id: 'permission', type: 'notification', reason: 'permission' },
  ];
  const unresolved = projection(permission);
  const resolved = projection([
    ...permission,
    { t: 20, id: 'resume', type: 'session', phase: 'resume' },
    { t: 30, id: 'next-prompt', type: 'notification', reason: 'next_prompt' },
  ]);

  assert.ok(resolved.insights.blockers.some(blocker => blocker.kind === 'permission_block'));
  for (const disposition of unresolved.dispositions) {
    assert.deepEqual(dispositionContract(disposition), {
      state: 'blocked',
      inputRequest: 'permission',
      currentBlocker: 'Permission decision required',
      nextActor: 'human',
      nextAction: 'Human: approve or decline the permission request',
    });
  }
  for (const disposition of resolved.dispositions) {
    assert.deepEqual(dispositionContract(disposition), {
      state: 'attention',
      inputRequest: 'none',
      currentBlocker: 'No execution blocker',
      nextActor: 'human',
      nextAction: 'Human: provide the next instruction',
    });
  }
});

test('reference replay keeps semantic time at t while current truth remains visible through at', () => {
  const context = referenceReplayContext();
  const views = projectReferenceViews(referenceEvents(), context);
  const effectiveBoardOpen = views.board.prs.filter(pr => pr.state === 'open').length;
  const storyCurrentOpen = views.story.prs.filter(pr => pr.currentTruth.startsWith('Current: open')).length;
  const lanesCurrentOpen = views.lanes.semanticRows.prs.filter(pr => pr.current?.state === 'open').length;
  const graphPrs = views.graph.nodes.filter(node => node.kind === 'pr');
  const graphCurrentOpen = graphPrs.filter(node => node.currentTruth?.startsWith('Current: open')).length;
  const phaseEnd = Math.max(...views.insights.phases.map(phase => phase.endT));

  assert.deepEqual({
    summary: Object.fromEntries(Object.entries(views.summaries).map(([view, summary]) => [view, {
      asOf: summary.asOf,
      prs: summary.prs,
      checklist: summary.checklist,
      roadmap: summary.roadmap,
      disposition: summary.disposition,
      recordedSpan: summary.recordedSpan,
      producerWindow: summary.producerWindow,
      observedWork: summary.observedWork,
      provenance: summary.provenance,
    }])),
    semanticHorizon: {
      recordedEnd: views.insights.bounds.recordedEnd,
      phaseEnd,
      recordedSessionMs: views.insights.clocks.recordedSessionMs,
    },
    currentTruth: {
      board: { prs: views.board.prs.length, open: effectiveBoardOpen },
      story: { prs: views.story.prs.length, currentOpen: storyCurrentOpen },
      lanes: { prs: views.lanes.semanticRows.prs.length, currentOpen: lanesCurrentOpen },
      graph: { prs: graphPrs.length, currentOpen: graphCurrentOpen, axis: views.graph.topology.axis },
    },
  }, {
    summary: Object.fromEntries(['Board', 'Story', 'Lanes', 'Graph'].map(view => [view, {
      asOf: 'As of: 2023-11-16T07:40:26.802Z',
      prs: '7 PRs open · 0 merged',
      checklist: 'Session checklist: 8/10',
      roadmap: 'Product roadmap: roughly one-third',
      disposition: 'Turn complete · session open · human is next actor · no tool outcome is missing',
      recordedSpan: '11h 32m recorded session',
      producerWindow: '11h 30m producer window',
      observedWork: '48m observed work · Estimated',
      provenance: 'Provenance: recorded tape · current GitHub reconciliation · retrospective inference',
    }])),
    semanticHorizon: {
      recordedEnd: REFERENCE_CURSOR_T,
      phaseEnd: REFERENCE_CURSOR_T,
      recordedSessionMs: 41_531_012,
    },
    currentTruth: {
      board: { prs: 7, open: 7 },
      story: { prs: 7, currentOpen: 7 },
      lanes: { prs: 7, currentOpen: 7 },
      graph: { prs: 7, currentOpen: 7, axis: 'current' },
    },
  });

  const expectedDisposition = {
    state: 'attention',
    inputRequest: 'none',
    currentBlocker: 'No execution blocker',
    nextActor: 'human',
    nextAction: 'Human: provide the next instruction',
  };
  assert.deepEqual(dispositionContract(views.board.disposition), expectedDisposition);
  assert.deepEqual(dispositionContract(views.story.disposition), expectedDisposition);
  assert.deepEqual(dispositionContract(views.graph.semantic), expectedDisposition);
  assert.deepEqual(dispositionContract(views.summaries.Lanes.sessionDisposition), expectedDisposition);
});

test('cross-view navigation round-trips session, t, and at in stable order', () => {
  const context = referenceReplayContext();
  const expected = {
    '/': `/?session=${REFERENCE_SESSION}&t=${REFERENCE_CURSOR_T}&at=${REFERENCE_AS_OF_T}`,
    '/story': `/story?session=${REFERENCE_SESSION}&t=${REFERENCE_CURSOR_T}&at=${REFERENCE_AS_OF_T}`,
    '/lanes': `/lanes?session=${REFERENCE_SESSION}&t=${REFERENCE_CURSOR_T}&at=${REFERENCE_AS_OF_T}`,
    '/graph': `/graph?session=${REFERENCE_SESSION}&t=${REFERENCE_CURSOR_T}&at=${REFERENCE_AS_OF_T}`,
  };

  for (const [path, href] of Object.entries(expected)) {
    assert.equal(viewHref(path, context), href);
    assert.deepEqual(
      parseViewContext(new URL(href, 'https://nightshift.test').search),
      context,
      `${path} round-trips the complete replay context`,
    );
  }

  for (const [view, source] of Object.entries({
    Board: read('public/app.js'),
    Story: read('public/story.js'),
    Lanes: read('public/lanes.js'),
    Graph: read('graph-app/src/App.jsx'),
  })) {
    for (const path of ['/', '/story', '/lanes', '/graph']) {
      const escapedPath = path.replace('/', '\\/');
      assert.match(source, new RegExp(`viewHref\\('${escapedPath}'`), `${view} routes ${path} through viewHref`);
    }
    assert.match(
      source,
      /buildSessionInsights\([\s\S]*?asOfT:/,
      `${view} threads the independent knowledge horizon into its canonical insight call`,
    );
  }
});

test('every replay entry reads one tape snapshot before any live-only transport', () => {
  const board = read('public/app.js');
  const boardReplayStart = board.indexOf("if (viewContext.mode === 'replay')", board.indexOf('async function initSessions()'));
  const boardReplayEnd = board.indexOf('\n  const picker = await initSessionPicker', boardReplayStart);
  const boardReplay = board.slice(boardReplayStart, boardReplayEnd);
  assert.match(boardReplay, /await loadReplaySession/);
  assert.doesNotMatch(boardReplay, /new EventSource|openStream|connect\(|initSessionPicker|fetch\([^)]*(?:current|sessions|github|reconcile)/i);

  for (const [view, source] of [
    ['Story', read('public/story.js')],
    ['Lanes', read('public/lanes.js')],
  ]) {
    const loadStart = source.indexOf('async function loadSession');
    const loadEnd = source.indexOf('\nasync function load()', loadStart);
    const replayStart = source.indexOf("if (viewContext.mode === 'replay')", loadEnd);
    const replayEnd = source.indexOf('\n  const picker = await initSessionPicker', replayStart);
    const loadSession = source.slice(loadStart, loadEnd);
    const replayEntry = source.slice(replayStart, replayEnd);
    assert.equal((loadSession.match(/fetch\(/g) ?? []).length, 1, `${view} has one replay-capable fetch`);
    assert.match(loadSession, /fetch\(`\/events\$\{query\}`\)/);
    assert.doesNotMatch(loadSession, /new EventSource|\/sse|fetch\([^)]*(?:current|sessions|github|reconcile)/i);
    assert.match(replayEntry, /await loadSession\(sessionId\)/);
    assert.doesNotMatch(replayEntry, /new EventSource|openStream|initSessionPicker|\/sessions|github|reconcile/i);
  }

  const boardRuntime = read('public/board-runtime.js');
  const boardLoadStart = boardRuntime.indexOf('export async function loadReplaySession');
  const boardLoadEnd = boardRuntime.indexOf('\nfunction rawCursor', boardLoadStart);
  const boardLoad = boardRuntime.slice(boardLoadStart, boardLoadEnd);
  assert.equal((boardLoad.match(/fetchImpl\(/g) ?? []).length, 1);
  assert.match(boardLoad, /fetchImpl\(`\/events\$\{query\}`\)/);
  assert.doesNotMatch(boardLoad, /EventSource|\/sse|current|sessions|github|reconcile/i);

  const graph = read('graph-app/src/App.jsx');
  const graphLoadStart = graph.indexOf('const loadSession = useCallback');
  const graphLoadEnd = graph.indexOf('\n\n  useEffect(', graphLoadStart);
  const graphLoad = graph.slice(graphLoadStart, graphLoadEnd);
  const graphFetch = graphLoad.indexOf("fetch('/events' + query)");
  const graphReplayReturn = graphLoad.indexOf("if (context.mode === 'replay') return;");
  const graphLiveOpen = graphLoad.indexOf('openStream(id)', graphReplayReturn);
  assert.ok(graphFetch >= 0 && graphReplayReturn > graphFetch && graphLiveOpen > graphReplayReturn);
  assert.doesNotMatch(graphLoad, /new EventSource|\/sse|fetch\([^)]*(?:current|sessions|github|reconcile)/i);
});

test('duration-bearing view copy always supplies the exact semantic noun', () => {
  const views = projectReferenceViews(referenceEvents(), referenceReplayContext(), {
    fullHorizon: true,
  });
  const displayedDurations = [
    ...Object.values(views.summaries.Board).filter(value => typeof value === 'string'),
    `${views.board.clocks.recordedSession.value} ${views.board.clocks.recordedSession.label}`,
    views.board.disposition.detail,
    ...views.board.prs.map(pr => pr.openFor),
    ...views.board.tools.lifecycles.map(tool => tool.duration),
    ...views.board.timeline.map(phase => phase.duration),
  ].filter(value => /\b(?:\d+h(?: \d+m)?|\d+m|\d+s)\b/.test(value));
  const semanticNoun = /\b(?:recorded session|producer window|observed work|attention wait|open for|measured tool execution|elapsed since recorded start)\b/i;

  assert.ok(displayedDurations.length > 0);
  for (const duration of displayedDurations) {
    assert.match(duration, semanticNoun, `duration has an exact noun: ${duration}`);
  }

  const story = read('public/story.js');
  assert.match(story, /durationText\(phase\.durationMs\)[^\n]*% of recorded session/);
  assert.match(story, /interval\.label[\s\S]*durationText\(interval\.durationMs\)/);
  assert.match(story, /durationText\(chapter\.wallMs\)[^\n]*chapter span/);

  const lanes = read('public/lanes.js');
  assert.match(lanes, /\['Recorded session', insights\.clocks\.recordedSessionMs\]/);
  assert.match(lanes, /\['Observed work', insights\.clocks\.observedActiveMs\]/);
  for (const category of ['coding', 'testing', 'preflight', 'other', 'waiting', 'idle', 'unknown']) {
    assert.match(lanes, new RegExp(`'${category}'`));
  }

  const graph = `${read('graph-app/src/Summary.jsx')}\n${read('graph-app/src/Timeline.jsx')}`;
  assert.match(graph, /summary\.recordedSpan[^\n]*summary\.producerWindow/);
  assert.match(graph, /summary\.observedWork/);
  assert.match(graph, /duration unknown/);
});
