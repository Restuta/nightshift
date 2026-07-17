import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as boardRuntime from '../public/board-runtime.js';
import { buildBoardViewModel } from '../public/board-model.js';
import { buildSummaryViewModel } from '../public/session-summary.js';
import { parseViewContext } from '../public/session-view-context.js';

const { loadReplaySession, shouldOpenLiveStream } = boardRuntime;

test('replay loads one sorted event snapshot and never enables live streaming', async () => {
  const context = parseViewContext('?session=reference&t=120&at=200');
  const calls = [];
  const events = await loadReplaySession({
    context,
    sessionId: 'reference',
    fetchImpl: async url => {
      calls.push(url);
      return {
        ok: true,
        text: async () => [
          JSON.stringify({ t: 20, type: 'say', text: 'later' }),
          'not-json',
          JSON.stringify({ t: 10, type: 'session', phase: 'start' }),
          JSON.stringify({ t: 'bad', type: 'say' }),
        ].join('\n'),
      };
    },
  });

  assert.deepEqual(calls, ['/events?session=reference']);
  assert.deepEqual(events.map(event => event.t), [10, 20]);
  assert.equal(shouldOpenLiveStream(context), false);
  assert.equal(shouldOpenLiveStream(parseViewContext('?session=reference')), true);
});

test('replay surfaces request failures instead of retaining stale session content', async () => {
  await assert.rejects(
    loadReplaySession({
      context: parseViewContext('?session=reference&t=120'),
      sessionId: 'reference',
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    /events request failed \(503\)/,
  );
});

test('playback advances one canonical prefix and stops at the immutable as-of ceiling', () => {
  assert.equal(typeof boardRuntime.buildReplayFrame, 'function', 'replay frame builder is required');
  assert.equal(typeof boardRuntime.advanceReplayFrame, 'function', 'replay playback advance is required');
  const { advanceReplayFrame, buildReplayFrame } = boardRuntime;
  const events = [
    { t: 0, id: 'session', type: 'session', phase: 'start' },
    { t: 10, id: 'task', type: 'item', title: 'Replay task', status: 'doing' },
    { t: 20, id: 'tool-start', type: 'tool_call', state: 'start', sessionId: 's', agentId: 'a', toolUseId: 'run', tool: 'Bash' },
    { t: 30, id: 'pr-7', source: 'poll-github', type: 'pr', repo: 'acme/replay', number: 7, title: 'Replay truth', state: 'open', createdAt: 30, occurredAt: 30 },
    { t: 35, id: 'edit', type: 'edit', item: 'task', path: 'src/replay.js' },
    { t: 45, id: 'tool-end', type: 'tool_call', state: 'success', sessionId: 's', agentId: 'a', toolUseId: 'run', tool: 'Bash' },
    { t: 60, id: 'future-attention', type: 'notification', reason: 'next_prompt' },
  ];

  const scrubbed = buildReplayFrame({ events, cursorT: 15, asOfT: 55 });
  const advanced = advanceReplayFrame({
    events,
    cursorT: scrubbed.cursorT,
    elapsedMs: 25,
    speed: 1,
    asOfT: 55,
  });
  const capped = advanceReplayFrame({
    events,
    cursorT: advanced.cursorT,
    elapsedMs: 100,
    speed: 1,
    asOfT: 55,
  });
  const scrubbedBoard = buildBoardViewModel(scrubbed.insights);
  const advancedBoard = buildBoardViewModel(advanced.insights);
  const cappedBoard = buildBoardViewModel(capped.insights);
  const scrubbedSummary = buildSummaryViewModel(scrubbed.insights);
  const advancedSummary = buildSummaryViewModel(advanced.insights);

  assert.deepEqual(scrubbed.insights.visiblePrefix.map(event => event.id), ['session', 'task']);
  assert.deepEqual(advanced.insights.visiblePrefix.map(event => event.id), ['session', 'task', 'tool-start', 'pr-7', 'edit']);
  assert.equal(advanced.state.items.get('task').status, 'doing');
  assert.equal(advanced.cursor, 5);
  assert.equal(scrubbedBoard.prs.length, 1);
  assert.match(scrubbedBoard.prs[0].currentTruth, /^Current: open/);
  assert.equal(advancedBoard.prs.length, 1);
  assert.equal(advancedBoard.prs[0].provenance, 'Recorded tape · authoritative GitHub fact');
  assert.equal(advancedBoard.tools.lifecycles[0].status, 'Outcome unknown');
  assert.equal(cappedBoard.tools.lifecycles[0].status, 'Completed · success');
  assert.ok(advanced.insights.phases.at(-1).endT > scrubbed.insights.phases.at(-1).endT);
  assert.equal(scrubbedSummary.prs, '1 PR open · 0 merged');
  assert.equal(advancedSummary.prs, '1 PR open · 0 merged');
  assert.equal(capped.cursorT, 55);
  assert.equal(capped.cutoffT, 55);
  assert.equal(capped.ceilingT, 55);
  assert.ok(!capped.insights.visiblePrefix.some(event => event.id === 'future-attention'));
});

test('replay frame keeps the semantic cursor while projecting facts through the as-of horizon', () => {
  const events = [
    { t: 0, id: 'session', type: 'session', phase: 'start' },
    { t: 10, id: 'recorded-pr', source: 'poll-github', type: 'pr', repo: 'acme/replay', number: 7, state: 'open' },
    { t: 20, id: 'attention', type: 'session', phase: 'attention' },
    { t: 40, id: 'later-work', type: 'edit', path: 'later.js' },
    { t: 50, id: 'current-pr', source: 'poll-github', type: 'pr', repo: 'acme/replay', number: 7, state: 'open' },
    { t: 55, id: 'current-ci', source: 'poll-github', type: 'ci', repo: 'acme/replay', pr: 7, status: 'pass', fetchedAt: 55 },
  ];

  const frame = boardRuntime.buildReplayFrame({ events, cursorT: 20, asOfT: 55 });
  assert.equal(frame.insights.asOfT, 55);
  assert.equal(frame.insights.bounds.recordedEnd, 20);
  assert.deepEqual(frame.insights.visiblePrefix.map(event => event.id), ['session', 'recorded-pr', 'attention']);
  assert.equal(frame.insights.prStack.prs[0].current.validation, 'pass');
  assert.equal(buildSummaryViewModel(frame.insights).asOf, 'As of: 1970-01-01T00:00:00.055Z');
});

test('replay Board state excludes semantic events that were not known by the as-of horizon', () => {
  const events = [
    { t: 0, id: 'session', type: 'session', phase: 'start' },
    { t: 10, id: 'task', type: 'item', title: 'Visible task', status: 'doing' },
    { t: 10, recordedAt: 90, id: 'late-recovery', type: 'item', title: 'Recovered later', status: 'done' },
    { t: 20, id: 'visible-say', type: 'say', text: 'Known by the cutoff' },
  ];

  const frame = boardRuntime.buildReplayFrame({ events, cursorT: 20, asOfT: 50 });

  assert.deepEqual(frame.insights.visiblePrefix.map(event => event.id), [
    'session',
    'task',
    'visible-say',
  ]);
  assert.equal(frame.state.items.get('task').status, 'doing');
  assert.equal(frame.state.items.has('late-recovery'), false);
  assert.ok(!frame.state.feed.some(event => event.id === 'late-recovery'));
  assert.deepEqual(
    boardRuntime.visibleReplayDelta(
      frame.insights.visiblePrefix.slice(0, 2),
      frame.insights.visiblePrefix,
    ).map(event => event.id),
    ['visible-say'],
  );
});

test('Gantt reset closes the overlay and removes every stale PR surface', () => {
  assert.equal(typeof boardRuntime.resetGanttView, 'function', 'Gantt reset helper is required');
  const overlay = { hidden: false };
  const body = {
    children: ['stale PR'],
    replaceChildren() { this.children = []; },
  };
  const axis = {
    children: ['stale tick'],
    replaceChildren() { this.children = []; },
  };
  const count = { textContent: '7' };

  boardRuntime.resetGanttView({ overlay, body, axis, count });

  assert.equal(overlay.hidden, true);
  assert.deepEqual(body.children, []);
  assert.deepEqual(axis.children, []);
  assert.equal(count.textContent, '');
});

test('PR reconciliation keeps disclosure, focus, and scroll stable across live renders', () => {
  assert.equal(typeof boardRuntime.reconcileDisclosureList, 'function');
  const { reconcileDisclosureList } = boardRuntime;
  const oldDetails = { dataset: { prKey: 'acme/replay#7' }, open: true };
  const nextDetails = { dataset: { prKey: 'acme/replay#7' }, open: false };
  const nextSummary = {
    focused: false,
    focus(options) {
      this.focused = options?.preventScroll === true;
    },
  };
  const nextRow = {
    dataset: { prKey: 'acme/replay#7' },
    querySelector(selector) {
      return selector === '.pr-details > summary' ? nextSummary : null;
    },
  };
  const list = {
    _markup: '<li>stable</li>',
    _details: [oldDetails],
    _rows: [],
    replacements: 0,
    scrollTop: 41,
    get innerHTML() { return this._markup; },
    set innerHTML(value) {
      this._markup = value;
      this._details = [nextDetails];
      this._rows = [nextRow];
      this.replacements++;
      this.scrollTop = 0;
    },
    querySelectorAll(selector) {
      if (selector === '.pr-details[open]') return this._details.filter(details => details.open);
      if (selector === '.pr-details[data-pr-key]') return this._details;
      if (selector === '.pr-row[data-pr-key]') return this._rows;
      return [];
    },
  };
  const activeElement = {
    closest: selector => selector === '.pr-row[data-pr-key]'
      ? { dataset: { prKey: 'acme/replay#7' } }
      : null,
    matches: selector => selector === 'summary',
  };

  const unchanged = reconcileDisclosureList({
    list,
    markup: '<li>stable</li>',
    previousMarkup: '<li>stable</li>',
    activeElement,
  });
  assert.deepEqual(unchanged, { markup: '<li>stable</li>', changed: false });
  assert.equal(list.replacements, 0);
  assert.equal(oldDetails.open, true);

  const changed = reconcileDisclosureList({
    list,
    markup: '<li>updated age</li>',
    previousMarkup: unchanged.markup,
    activeElement,
  });
  assert.deepEqual(changed, { markup: '<li>updated age</li>', changed: true });
  assert.equal(list.replacements, 1);
  assert.equal(nextDetails.open, true);
  assert.equal(nextSummary.focused, true);
  assert.equal(list.scrollTop, 41);
});
