import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { buildSessionInsights } from '../public/session-insights-model.js';
import { parseViewContext, viewHref } from '../public/session-view-context.js';

const runtimeUrl = new URL('../graph-app/src/runtime.js', import.meta.url);
const runtime = existsSync(runtimeUrl) ? await import(runtimeUrl) : {};

test('replay controls advance a selected prefix against one immutable full-tape ceiling', () => {
  assert.equal(typeof runtime.buildReplayWindow, 'function');
  assert.equal(typeof runtime.timelineKeyTarget, 'function');
  assert.equal(typeof runtime.timelinePointerTarget, 'function');

  const events = [
    { t: 0, id: 'session', type: 'session', phase: 'start' },
    { t: 20, id: 'early', type: 'item', title: 'Early work', status: 'doing' },
    { t: 45, id: 'middle', type: 'edit', item: 'early', path: 'src/middle.js' },
    { t: 80, id: 'late', type: 'say', text: 'Late evidence' },
    { t: 100, id: 'ceiling', type: 'notification', reason: 'next_prompt' },
    { t: 120, id: 'after-as-of', type: 'say', text: 'Must stay hidden' },
  ];
  const initial = runtime.buildReplayWindow({ events, cursorT: 20, asOfT: 100 });
  assert.deepEqual(initial, { floorT: 0, ceilingT: 100, cursorT: 20, cutoffT: 20 });

  const arrow = runtime.timelineKeyTarget('ArrowRight', initial);
  const page = runtime.timelineKeyTarget('PageUp', { ...initial, cursorT: arrow });
  const end = runtime.timelineKeyTarget('End', { ...initial, cursorT: page });
  const pointer = runtime.timelinePointerTarget(0.75, initial);
  assert.equal(arrow, 21, 'ArrowRight moves one percent of the immutable window');
  assert.equal(page, 31, 'PageUp moves ten percent without shrinking the window');
  assert.equal(end, 100, 'End reaches the immutable as-of ceiling');
  assert.equal(pointer, 75, 'pointer position maps against the immutable window');

  const at20 = buildSessionInsights(events, { untilT: initial.cursorT, displayNow: initial.cursorT });
  const at31 = buildSessionInsights(events, { untilT: page, displayNow: page });
  const at75 = buildSessionInsights(events, { untilT: pointer, displayNow: pointer });
  const atEnd = buildSessionInsights(events, { untilT: end, displayNow: end });
  assert.deepEqual(at20.visiblePrefix.map(event => event.id), ['session', 'early']);
  assert.deepEqual(at31.visiblePrefix.map(event => event.id), ['session', 'early']);
  assert.deepEqual(at75.visiblePrefix.map(event => event.id), ['session', 'early', 'middle']);
  assert.deepEqual(atEnd.visiblePrefix.map(event => event.id), ['session', 'early', 'middle', 'late', 'ceiling']);
  assert.ok(!atEnd.visiblePrefix.some(event => event.id === 'after-as-of'));
});

test('live scrub then session selection reads current replay context and never enables streaming', () => {
  assert.equal(typeof runtime.contextForScrub, 'function');
  assert.equal(typeof runtime.selectGraphSession, 'function');
  assert.equal(typeof runtime.shouldOpenGraphStream, 'function');

  const staleCapturedContext = parseViewContext('?session=alpha');
  const contextRef = { current: staleCapturedContext };
  contextRef.current = runtime.contextForScrub(contextRef.current, 40, 90);
  const selected = runtime.selectGraphSession(contextRef, 'beta');

  assert.deepEqual(selected.context, {
    session: 'beta', cursorT: 40, cutoffT: 40, asOfT: 90, mode: 'replay',
  });
  assert.equal(selected.cursorT, 40);
  assert.equal(selected.scrubT, 40);
  assert.equal(runtime.shouldOpenGraphStream(selected.context), false);
  assert.equal(viewHref('/graph', selected.context), '/graph?session=beta&t=40&at=90');
});

test('replay-to-replay session selection preserves the current t and at values', () => {
  const contextRef = { current: parseViewContext('?session=alpha&t=55&at=100') };
  const selected = runtime.selectGraphSession(contextRef, 'gamma');

  assert.equal(selected.context.mode, 'replay');
  assert.equal(selected.context.cursorT, 55);
  assert.equal(selected.context.cutoffT, 55);
  assert.equal(selected.context.asOfT, 100);
  assert.equal(selected.cursorT, 55);
  assert.equal(selected.scrubT, 55);
  assert.equal(runtime.shouldOpenGraphStream(selected.context), false);
});

test('every focusable Graph entity aria label names the entity, status, and replay action', () => {
  assert.equal(typeof runtime.graphNodeAriaLabel, 'function');
  const cases = [
    [{ kind: 'session', title: 'Night run', activity: { phase: 'attention' } }, /Night run.*status attention.*Press Enter to replay evidence/i],
    [{ kind: 'plan', total: 10, counts: { completed: 8 } }, /Plan.*status 8 of 10 complete.*Press Enter to replay evidence/i],
    [{ kind: 'intent', title: 'Ship parser', status: 'doing' }, /Ship parser.*status doing.*Press Enter to replay evidence/i],
    [{ kind: 'step', text: 'Run tests', paused: false }, /Run tests.*status active.*Press Enter to replay evidence/i],
    [{ kind: 'now', prompt: 'Review result', phase: 'working' }, /Review result.*status working.*Press Enter to replay evidence/i],
    [{ kind: 'collapsed', label: '4 more open' }, /4 more open.*status collapsed.*Press Enter to replay evidence/i],
    [{ kind: 'step-more', count: 3, paused: true }, /3 more running.*status paused.*Press Enter to replay evidence/i],
  ];

  for (const [node, expected] of cases) assert.match(runtime.graphNodeAriaLabel(node), expected);
});
