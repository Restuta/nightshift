import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSessionInsights } from '../public/session-insights-model.js';
import { buildBoardViewModel } from '../public/board-model.js';

function referenceEvents() {
  return readFileSync(new URL('./tapes/semantic-reference.jsonl', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
}

test('Board projects the seven-PR reference truth without collapsing recorded and current state', () => {
  const events = referenceEvents();
  const insights = buildSessionInsights(events, { untilT: Infinity, displayNow: events.at(-1).t });
  const board = buildBoardViewModel(insights);

  assert.equal(board.disposition.label, 'Waiting for your next instruction');
  assert.equal(board.disposition.currentBlocker, 'No execution blocker');
  assert.equal(board.disposition.nextActor, 'human');
  assert.equal(board.disposition.nextActorLabel, 'Human');
  assert.deepEqual(board.clocks.recordedSession, {
    value: '11h 32m',
    label: 'recorded session',
  });
  assert.equal(board.prs.length, 7);

  const pr104 = board.prs.find(pr => pr.number === 104);
  assert.equal(pr104.recordedTruth, 'Recorded: not observed in the tape');
  assert.equal(pr104.currentTruth, 'Current: open · gates pass');
  assert.equal(pr104.recordedParent, 'Recorded parent: unavailable');
  assert.equal(pr104.currentParent, 'Current parent: #102');
  assert.equal(pr104.provenance, 'Discovered retrospectively · transcript evidence');
  assert.equal(pr104.openFor, 'Open duration unavailable');

  const pr102 = board.prs.find(pr => pr.number === 102);
  assert.match(pr102.openFor, /^Open for /);

  const pr106 = board.prs.find(pr => pr.number === 106);
  assert.equal(pr106.recordedTruth, 'Recorded: open · gates pending');
  assert.equal(pr106.currentTruth, 'Current: open · gates pass · 1 advisory running');
  assert.equal(pr106.changedSinceRecording, true);
  assert.equal(board.prTotals, '7 PRs open · 0 merged');
});

test('Board keeps tool lifecycles, observations, and transcript metrics semantically separate', () => {
  const insights = buildSessionInsights([
    { t: 0, id: 'session', type: 'session', phase: 'start' },
    { t: 1_000, id: 'point', type: 'tool', tool: 'Read', text: 'historical point only' },
    { t: 2_000, id: 'run-start', type: 'tool_call', state: 'start', sessionId: 's', agentId: 'a', toolUseId: 'run', tool: 'Bash' },
    { t: 4_000, id: 'run-end', type: 'tool_call', state: 'success', sessionId: 's', agentId: 'a', toolUseId: 'run', tool: 'Bash' },
    { t: 5_000, id: 'lost-start', type: 'tool_call', state: 'start', sessionId: 's', agentId: 'a', toolUseId: 'lost', tool: 'WebFetch' },
    { t: 6_000, id: 'metrics', type: 'transcript_metrics', matchedToolPairs: 345, tapeToolObservations: 587 },
    { t: 7_000, id: 'permission', type: 'notification', reason: 'permission' },
  ], { untilT: 7_000, displayNow: 10_000 });
  const board = buildBoardViewModel(insights);

  assert.deepEqual(board.tools.lifecycles.map(tool => tool.status), [
    'Completed · success',
    'Outcome unknown',
  ]);
  assert.equal(board.tools.lifecycles[0].duration, '2s measured tool execution');
  assert.equal(board.tools.lifecycles[1].duration, '5s elapsed since recorded start');
  assert.equal(board.tools.lifecycles[1].blocked, false);
  assert.equal(board.tools.observations[0].status, 'Historical point observation · runtime not measured');
  assert.equal(board.tools.metrics, '345 transcript tool pairs · 587 tape tool observations');
  assert.equal(board.disposition.label, 'Permission blocked');
  assert.equal(board.disposition.currentBlocker, 'Permission decision required');
  assert.equal(board.disposition.nextActor, 'human');
  assert.equal(board.disposition.nextActorLabel, 'Human');
});

test('Board keeps question, permission, and next-prompt requests distinct', () => {
  const project = reason => buildBoardViewModel(buildSessionInsights([
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 10, id: reason, type: 'notification', reason },
  ], { untilT: 10, displayNow: 10 })).disposition;

  assert.deepEqual(
    [project('question'), project('permission'), project('next_prompt')].map(disposition => ({
      state: disposition.state,
      inputRequest: disposition.inputRequest,
      currentBlocker: disposition.currentBlocker,
      nextAction: disposition.nextAction,
    })),
    [
      { state: 'attention', inputRequest: 'question', currentBlocker: 'Human answer required', nextAction: 'Human: answer the recorded question' },
      { state: 'blocked', inputRequest: 'permission', currentBlocker: 'Permission decision required', nextAction: 'Human: approve or decline the permission request' },
      { state: 'attention', inputRequest: 'none', currentBlocker: 'No execution blocker', nextAction: 'Human: provide the next instruction' },
    ],
  );
});

test('Board phase ribbon and event footer exclude heartbeats without calling density work', () => {
  const insights = buildSessionInsights([
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 1_000, id: 'edit', type: 'edit', path: 'board.js' },
    { t: 2_000, id: 'beat-1', type: 'alive' },
    { t: 3_000, id: 'beat-2', type: 'alive' },
    { t: 4_000, id: 'done', type: 'notification', reason: 'next_prompt' },
  ], { untilT: 4_000, displayNow: 4_000 });
  const board = buildBoardViewModel(insights);

  assert.equal(board.events.label, '3 non-heartbeat events · 2 heartbeats excluded');
  assert.equal(board.events.activity.length, 3);
  assert.ok(board.events.activity.every(event => event.type !== 'alive'));
  assert.ok(board.timeline.length > 0);
  assert.ok(board.timeline.every(span => / of recorded session$/.test(span.duration)));
  assert.deepEqual(board.timelineLegend, ['Coding', 'Testing', 'Preflight', 'Other', 'Waiting', 'Idle', 'Unknown']);
});
