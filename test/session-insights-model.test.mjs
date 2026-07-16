import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTIVE_GAP_MS, buildSessionInsights } from '../public/session-insights-model.js';

test('explicit work and tool lifecycle events retain their compound identity', () => {
  const events = [
    { t: 0, id: 's', source: 'hook', v: 2, type: 'session', phase: 'start', sessionId: 's1' },
    { t: 10, id: 'w1', source: 'hook', v: 2, type: 'work_phase', state: 'start', phase: 'preflight', stage: 'local_validation', runId: 'r1', agentId: 'a1' },
    { t: 20, id: 'tc1', source: 'hook', v: 2, type: 'tool_call', state: 'start', sessionId: 's1', agentId: 'a1', toolUseId: 'u1', tool: 'Bash', parentRunId: 'r1' },
    { t: 40, id: 'tc2', source: 'hook', v: 2, type: 'tool_call', state: 'success', sessionId: 's1', agentId: 'a1', toolUseId: 'u1', tool: 'Bash', parentRunId: 'r1' },
    { t: 50, id: 'w2', source: 'hook', v: 2, type: 'work_phase', state: 'end', phase: 'preflight', stage: 'local_validation', runId: 'r1', agentId: 'a1', outcome: 'pass' },
    { t: 60, id: 'e', source: 'hook', v: 2, type: 'session', phase: 'end' },
  ];
  const x = buildSessionInsights(events, { untilT: 60, displayNow: 60 });
  assert.equal(x.phases.find(p => p.source === 'work_phase').confidence, 'explicit');
  assert.deepEqual(x.toolCalls.lifecycles[0].key, ['s1', 'a1', 'u1']);
  assert.equal(x.toolCalls.lifecycles[0].outcome, 'success');
});

test('wall categories exactly partition recorded time without heartbeat work', () => {
  const H = 60 * 60 * 1000;
  const events = [
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 1000, id: 'turn-1', type: 'item', status: 'doing' },
    { t: 2 * H, id: 'edit', type: 'edit', path: 'src/a.js' },
    { t: 2 * H + 60_000, id: 'alive', type: 'alive' },
    { t: 4 * H, id: 'idle', type: 'session', phase: 'idle' },
    { t: 5 * H, id: 'attention', type: 'notification', reason: 'next_prompt' },
  ];
  const x = buildSessionInsights(events, { untilT: 5 * H, displayNow: 7 * H });
  const total = Object.values(x.phaseTotals.byWallCategory).reduce((a, b) => a + b, 0);
  assert.equal(total, x.clocks.recordedSessionMs);
  assert.equal(Math.round(Object.values(x.phaseTotals.percentages).reduce((a, b) => a + b, 0)), 100);
  assert.equal(x.bounds.recordedEnd, 5 * H);
  assert.equal(x.clocks.liveHumanWaitMs, 2 * H);
  assert.equal(x.lifecycle.turn, 'complete');
  assert.equal(x.lifecycle.nextActor, 'human');
});

test('retracted evidence and events after replay cutoff are invisible', () => {
  const events = [
    { t: 0, type: 'session', phase: 'start' },
    { t: 10, id: 'bad', type: 'edit', path: 'bad.js' },
    { t: 20, type: 'retract', target: { event: 'bad' } },
    { t: 30, id: 'future', type: 'edit', path: 'future.js' },
  ];
  const x = buildSessionInsights(events, { untilT: 25, displayNow: 25 });
  assert.ok(x.phases.every(p => !p.evidenceEventIds.includes('bad') && !p.evidenceEventIds.includes('future')));
});

test('visible replay events are stably sorted after global item retractions', () => {
  const events = [
    { t: 20, id: 'second', type: 'say', text: 'second at the same instant' },
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 20, id: 'first', type: 'say', text: 'first at the same instant' },
    { t: 10, id: 'gone', type: 'item', status: 'doing' },
    { t: 15, id: 'gone-edit', type: 'edit', item: 'gone', path: 'gone.js' },
    { t: 50, type: 'retract', target: { item: 'gone' } },
  ];
  const x = buildSessionInsights(events, { untilT: 25, displayNow: 25 });
  assert.deepEqual(x.visiblePrefix.map(e => e.id), ['start', 'second', 'first']);
});

test('explicit closures cap inferred activity and passive events extend no bounds', () => {
  const events = [
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 100, id: 'edit', type: 'edit', path: 'a.js' },
    { t: ACTIVE_GAP_MS + 500, id: 'idle', type: 'session', phase: 'idle' },
    { t: ACTIVE_GAP_MS + 1000, id: 'heartbeat', type: 'alive' },
    { t: ACTIVE_GAP_MS + 2000, id: 'reconcile', type: 'ci', status: 'pending' },
  ];
  const x = buildSessionInsights(events, { untilT: Infinity, displayNow: ACTIVE_GAP_MS + 3000 });
  assert.equal(x.bounds.recordedEnd, ACTIVE_GAP_MS + 500);
  assert.equal(x.bounds.producerStart, 100);
  assert.equal(x.bounds.producerEnd, 100);
  assert.equal(x.clocks.observedActiveMs, ACTIVE_GAP_MS);
  assert.equal(x.lifecycle.turn, 'complete');
});

test('same-timestamp closures honor stable producer ordering', () => {
  const producerThenIdle = buildSessionInsights([
    { t: 0, id: 'start-a', type: 'session', phase: 'start' },
    { t: 10, id: 'edit-a', type: 'edit', path: 'a.js' },
    { t: 10, id: 'idle-a', type: 'session', phase: 'idle' },
    { t: 20, id: 'next-a', type: 'notification', reason: 'next_prompt' },
  ], { untilT: 20, displayNow: 20 });
  assert.equal(producerThenIdle.clocks.observedActiveMs, 0);
  assert.equal(producerThenIdle.phaseTotals.byWallCategory.idle, 10);

  const idleThenProducer = buildSessionInsights([
    { t: 0, id: 'start-b', type: 'session', phase: 'start' },
    { t: 10, id: 'idle-b', type: 'session', phase: 'idle' },
    { t: 10, id: 'edit-b', type: 'edit', path: 'b.js' },
    { t: 20, id: 'idle-b2', type: 'session', phase: 'idle' },
  ], { untilT: 20, displayNow: 20 });
  assert.equal(idleThenProducer.clocks.observedActiveMs, 10);
  assert.equal(idleThenProducer.phaseTotals.byWallCategory.coding, 10);
});

test('reading a preflight skill remains other work', () => {
  const x = buildSessionInsights([
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 10, id: 'read', type: 'tool', tool: 'Read', text: 'Read /preflight SKILL.md' },
    { t: 20, id: 'idle', type: 'session', phase: 'idle' },
  ], { untilT: 20, displayNow: 20 });
  const span = x.phases.find(p => p.evidenceEventIds.includes('read'));
  assert.equal(span.phase, 'other');
  assert.equal(span.wallCategory, 'other');
});

test('declared preflight substages retain phase while disposition owns wall category', () => {
  const x = buildSessionInsights([
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 10, id: 'local-start', type: 'work_phase', state: 'start', phase: 'preflight', stage: 'local_validation', runId: 'local' },
    { t: 20, id: 'local-end', type: 'work_phase', state: 'end', phase: 'preflight', stage: 'local_validation', runId: 'local' },
    { t: 20, id: 'wait-start', type: 'work_phase', state: 'start', phase: 'preflight', stage: 'readiness_wait', runId: 'wait' },
    { t: 40, id: 'wait-end', type: 'work_phase', state: 'end', phase: 'preflight', stage: 'readiness_wait', runId: 'wait' },
    { t: 50, id: 'end', type: 'session', phase: 'end' },
  ], { untilT: 50, displayNow: 50 });
  const local = x.phases.find(p => p.evidenceEventIds.includes('local-start'));
  const wait = x.phases.find(p => p.evidenceEventIds.includes('wait-start'));
  assert.equal(local.phase, 'preflight');
  assert.equal(local.stage, 'local_validation');
  assert.equal(local.wallCategory, 'preflight');
  assert.equal(wait.phase, 'preflight');
  assert.equal(wait.stage, 'readiness_wait');
  assert.equal(wait.disposition, 'waiting');
  assert.equal(wait.wallCategory, 'waiting');
  assert.ok(x.blockers.some(b => b.kind === 'ci_review_wait' && b.evidenceEventIds.includes('wait-start')));
});

test('declared historical preflight assigns strong validation and review substages', () => {
  const x = buildSessionInsights([
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 10, id: 'declare', type: 'say', text: 'Starting /orba-preflight' },
    { t: 20, id: 'validate', type: 'tool', tool: 'Bash', text: 'npm run build' },
    { t: 30, id: 'review', type: 'tool', tool: 'Skill', text: 'Run Toast review' },
    { t: 40, id: 'idle', type: 'session', phase: 'idle' },
  ], { untilT: 40, displayNow: 40 });
  const validation = x.phases.find(p => p.evidenceEventIds.includes('validate'));
  const review = x.phases.find(p => p.evidenceEventIds.includes('review'));
  assert.equal(validation.stage, 'local_validation');
  assert.equal(validation.confidence, 'strong');
  assert.equal(review.stage, 'cross_ai_review');
  assert.equal(review.confidence, 'strong');
});

test('legacy tool points cannot prove a readiness-wait blocker', () => {
  const x = buildSessionInsights([
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 10, id: 'declare', type: 'say', text: 'Starting preflight' },
    { t: 20, id: 'point', type: 'tool', tool: 'Bash', text: 'waiting on CI checks' },
    { t: 30, id: 'idle', type: 'session', phase: 'idle' },
  ], { untilT: 30, displayNow: 30 });
  assert.equal(x.phases.find(p => p.evidenceEventIds.includes('point')).stage, 'readiness_wait');
  assert.ok(x.blockers.every(b => b.kind !== 'ci_review_wait'));
});

test('session idle closes an explicit readiness wait before its late terminal event', () => {
  const events = [
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 10, id: 'wait-start', type: 'work_phase', state: 'start', phase: 'preflight', stage: 'readiness_wait', runId: 'wait' },
    { t: 20, id: 'idle', type: 'session', phase: 'idle' },
    { t: 30, id: 'wait-end', type: 'work_phase', state: 'end', phase: 'preflight', stage: 'readiness_wait', runId: 'wait' },
    { t: 40, id: 'next', type: 'notification', reason: 'next_prompt' },
  ];
  const x = buildSessionInsights(events, { untilT: 40, displayNow: 40 });
  assert.equal(x.phaseTotals.byWallCategory.waiting, 10);
  assert.equal(x.phaseTotals.byWallCategory.idle, 20);
  const beforePrompt = buildSessionInsights(events, { untilT: 30, displayNow: 30 });
  assert.equal(beforePrompt.lifecycle.turn, 'complete');
  assert.equal(beforePrompt.lifecycle.nextActor, 'none');
});

test('delayed tool terminals after idle do not wake lifecycle or disposition', () => {
  for (const state of ['success', 'failure', 'cancelled', 'unknown']) {
    const x = buildSessionInsights([
      { t: 0, id: `start-${state}`, type: 'session', phase: 'start' },
      { t: 10, id: `tool-start-${state}`, type: 'tool_call', state: 'start', sessionId: 's', agentId: 'a', toolUseId: state, tool: 'Bash' },
      { t: 20, id: `idle-${state}`, type: 'session', phase: 'idle' },
      { t: 30, id: `tool-end-${state}`, type: 'tool_call', state, sessionId: 's', agentId: 'a', toolUseId: state, tool: 'Bash' },
    ], { untilT: 30, displayNow: 30 });
    assert.equal(x.lifecycle.turn, 'complete', state);
    assert.equal(x.lifecycle.nextActor, 'none', state);
    assert.equal(x.phaseTotals.byWallCategory.idle, 10, state);
  }
});

test('delayed tool terminals after session end keep the ended lifecycle closed', () => {
  const x = buildSessionInsights([
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 10, id: 'tool-start', type: 'tool_call', state: 'start', sessionId: 's', agentId: 'a', toolUseId: 'u', tool: 'Bash' },
    { t: 20, id: 'end', type: 'session', phase: 'end' },
    { t: 30, id: 'tool-end', type: 'tool_call', state: 'success', sessionId: 's', agentId: 'a', toolUseId: 'u', tool: 'Bash' },
  ], { untilT: 30, displayNow: 30 });
  assert.equal(x.lifecycle.session, 'ended');
  assert.equal(x.lifecycle.turn, 'complete');
  assert.equal(x.lifecycle.nextActor, 'none');
  assert.equal(x.phaseTotals.byWallCategory.idle, 10);
});

test('test and build commands outside preflight classify as testing', () => {
  const x = buildSessionInsights([
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 10, id: 'test', type: 'tool', tool: 'Bash', text: 'npm test' },
    { t: 20, id: 'idle', type: 'session', phase: 'idle' },
  ], { untilT: 20, displayNow: 20 });
  const span = x.phases.find(p => p.evidenceEventIds.includes('test'));
  assert.equal(span.phase, 'testing');
  assert.equal(span.confidence, 'strong');
});

test('PR publishing is preflight only inside a declared run', () => {
  const x = buildSessionInsights([
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 10, id: 'plain-pr', type: 'tool', tool: 'Bash', text: 'gh pr create --fill' },
    { t: 20, id: 'idle-1', type: 'session', phase: 'idle' },
    { t: 30, id: 'resume', type: 'session', phase: 'resume' },
    { t: 40, id: 'declare', type: 'say', text: 'Starting preflight' },
    { t: 50, id: 'preflight-pr', type: 'tool', tool: 'Bash', text: 'gh pr create --fill' },
    { t: 60, id: 'idle-2', type: 'session', phase: 'idle' },
  ], { untilT: 60, displayNow: 60 });
  assert.equal(x.phases.find(p => p.evidenceEventIds.includes('plain-pr')).phase, 'other');
  const publishing = x.phases.find(p => p.evidenceEventIds.includes('preflight-pr'));
  assert.equal(publishing.phase, 'preflight');
  assert.equal(publishing.stage, 'publish_pr');
});

test('concurrent explicit agent spans contribute union wall time', () => {
  const x = buildSessionInsights([
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 10, id: 'a-start', type: 'work_phase', state: 'start', phase: 'testing', runId: 'a', agentId: 'a' },
    { t: 20, id: 'b-start', type: 'work_phase', state: 'start', phase: 'coding', runId: 'b', agentId: 'b' },
    { t: 40, id: 'b-end', type: 'work_phase', state: 'end', phase: 'coding', runId: 'b', agentId: 'b' },
    { t: 50, id: 'a-end', type: 'work_phase', state: 'end', phase: 'testing', runId: 'a', agentId: 'a' },
    { t: 60, id: 'end', type: 'session', phase: 'end' },
  ], { untilT: 60, displayNow: 60 });
  assert.equal(x.clocks.observedActiveMs, 40);
  assert.equal(x.phases.filter(p => p.disposition === 'active').reduce((sum, p) => sum + p.endT - p.startT, 0), 40);
});

test('permission and question notifications request human input', () => {
  for (const reason of ['permission', 'question']) {
    const x = buildSessionInsights([
      { t: 0, id: `start-${reason}`, type: 'session', phase: 'start' },
      { t: 10, id: reason, type: 'notification', reason },
    ], { untilT: 10, displayNow: 30 });
    assert.equal(x.lifecycle.turn, 'complete');
    assert.equal(x.lifecycle.nextActor, 'human');
    assert.equal(x.lifecycle.inputRequest, reason);
    assert.equal(x.clocks.liveHumanWaitMs, 20);
  }
});

test('generic next_prompt after idle is human wait but not recorded waiting', () => {
  const x = buildSessionInsights([
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 10, id: 'idle', type: 'session', phase: 'idle' },
    { t: 20, id: 'next', type: 'notification', reason: 'next_prompt' },
  ], { untilT: 20, displayNow: 30 });
  assert.equal(x.lifecycle.turn, 'complete');
  assert.equal(x.lifecycle.nextActor, 'human');
  assert.equal(x.lifecycle.inputRequest, 'none');
  assert.equal(x.clocks.liveHumanWaitMs, 10);
  assert.equal(x.phaseTotals.byWallCategory.waiting, 0);
  assert.equal(x.phaseTotals.byWallCategory.idle, 10);
});

test('blockers are zero-duration overlays over the exact recorded partition', () => {
  const x = buildSessionInsights([
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 10, id: 'edit', type: 'edit', path: 'a.js' },
    { t: 20, id: 'permission', type: 'notification', reason: 'permission' },
  ], { untilT: 20, displayNow: 30 });
  const wall = x.phases.reduce((sum, p) => sum + p.endT - p.startT, 0);
  assert.equal(wall, x.clocks.recordedSessionMs);
  assert.ok(x.blockers.length > 0);
  assert.ok(x.blockers.every(b => b.durationMs === 0));
});

test('deterministic generated tapes always produce a non-overlapping 100 percent partition', () => {
  const producerTypes = ['edit', 'say', 'tool', 'commit'];
  for (let seed = 0; seed < 100; seed += 1) {
    const events = [{ t: 0, id: `start-${seed}`, type: 'session', phase: 'start' }];
    let t = 1 + seed;
    const count = 1 + seed % 6;
    for (let i = 0; i < count; i += 1) {
      const type = producerTypes[(seed + i) % producerTypes.length];
      const event = { t, id: `${seed}-${i}`, type };
      if (type === 'edit') event.path = `${seed}.js`;
      if (type === 'say') event.text = 'working through the task';
      if (type === 'tool') event.text = i % 2 ? 'npm test' : 'inspect output';
      if (type === 'commit') event.message = 'checkpoint';
      events.push(event);
      if (i % 2 === 0) events.push({ t: t + 1, id: `alive-${seed}-${i}`, type: 'alive' });
      t += 1 + ((seed * 17 + i * 31) % (ACTIVE_GAP_MS + 5));
    }
    events.push({ t: t + 1, id: `idle-${seed}`, type: 'session', phase: 'idle' });
    const x = buildSessionInsights(events, { untilT: Infinity, displayNow: t + 1 });
    assert.equal(x.phases[0].startT, x.bounds.recordedStart);
    assert.equal(x.phases.at(-1).endT, x.bounds.recordedEnd);
    for (let i = 0; i < x.phases.length; i += 1) {
      assert.ok(x.phases[i].endT > x.phases[i].startT);
      if (i > 0) assert.equal(x.phases[i - 1].endT, x.phases[i].startT);
    }
    assert.equal(x.phases.reduce((sum, p) => sum + p.endT - p.startT, 0), x.clocks.recordedSessionMs);
    assert.equal(Object.values(x.phaseTotals.byWallCategory).reduce((sum, value) => sum + value, 0), x.clocks.recordedSessionMs);
    assert.equal(Math.round(Object.values(x.phaseTotals.percentages).reduce((sum, value) => sum + value, 0)), 100);
  }
});

test('recorded and post-session current PR truth remain separate', () => {
  const events = [
    { t: 0, type: 'session', phase: 'start' },
    { t: 10, id: 'p1', source: 'poll-github', type: 'pr', repo: 'o/r', number: 1, state: 'open', base: null },
    { t: 20, id: 'c1', source: 'poll-github', type: 'ci', repo: 'o/r', pr: 1, status: 'pending' },
    { t: 30, type: 'notification', reason: 'next_prompt' },
    { t: 40, id: 'c2', source: 'poll-github', type: 'ci', repo: 'o/r', pr: 1, status: 'pass', checks: [{ name: 'required', status: 'pass', required: true }, { name: 'bot', status: 'pending', required: false }], fetchedAt: 40 },
  ];
  const x = buildSessionInsights(events, { untilT: 40, displayNow: 40 });
  const pr = x.prStack.prs[0];
  assert.equal(pr.recorded.validation, 'pending');
  assert.equal(pr.current.validation, 'pass');
  assert.equal(pr.current.advisoryRunning, 1);
  assert.deepEqual(x.prStack.currentRoots, []);
  assert.equal(x.lifecycle.nextActor, 'human');
  assert.equal(buildSessionInsights(events, { untilT: 30, displayNow: 30 }).prStack.prs[0].current, null);
});

test('advisory-only checks do not make gating validation pending', () => {
  const x = buildSessionInsights([
    { t: 0, type: 'session', phase: 'start' },
    { t: 5, id: 'pr', source: 'poll-github', type: 'pr', repo: 'o/r', number: 1, state: 'open' },
    { t: 10, id: 'ci', source: 'poll-github', type: 'ci', repo: 'o/r', pr: 1, status: 'pending', checks: [
      { name: 'optional-bot', status: 'pending', required: false },
    ] },
    { t: 20, type: 'notification', reason: 'next_prompt' },
  ], { untilT: 20, displayNow: 20 });
  const recorded = x.prStack.prs[0].recorded;
  assert.equal(recorded.validation, 'pass');
  assert.equal(recorded.advisoryRunning, 1);
});

test('recovered references retain observation time but join only once the knowledge horizon reaches recordedAt', () => {
  const events = [
    { t: 0, type: 'session', phase: 'start' },
    { t: 20, id: 'r', source: 'recovery', type: 'pr_ref', repo: 'o/r', number: 104, url: 'https://github.com/o/r/pull/104', recordedAt: 1000, recovery: 'transcript', evidenceRef: 'subagent-result' },
  ];
  assert.equal(buildSessionInsights(events, { untilT: 19, asOfT: 999 }).prStack.prs.length, 0);
  assert.equal(buildSessionInsights(events, { untilT: 20, asOfT: 999 }).prStack.prs.length, 0);
  const recovered = buildSessionInsights(events, { untilT: 20, asOfT: 1000 }).prStack.prs[0];
  assert.equal(recovered.discovery.kind, 'recovered');
  assert.equal(recovered.discovery.observedAt, 20);
  assert.equal(recovered.discovery.recordedAt, 1000);
  assert.equal(recovered.discovery.evidenceRef, 'subagent-result');
});

test('knowledge horizon adds current PR facts without extending semantic session truth', () => {
  const events = [
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 10, id: 'recorded-pr', source: 'poll-github', type: 'pr', repo: 'o/r', number: 1, state: 'open', base: null },
    { t: 20, id: 'attention', type: 'session', phase: 'attention' },
    { t: 15, id: 'recovered-pr', source: 'recovery', type: 'pr_ref', repo: 'o/r', number: 2, recordedAt: 80, recovery: 'transcript' },
    { t: 40, id: 'later-edit', type: 'edit', path: 'must-not-leak.js' },
    { t: 50, id: 'later-resume', type: 'session', phase: 'resume' },
    { t: 60, id: 'current-pr', source: 'poll-github', type: 'pr', repo: 'o/r', number: 1, state: 'open', base: null },
    { t: 61, id: 'current-ci', source: 'poll-github', type: 'ci', repo: 'o/r', pr: 1, status: 'pass', fetchedAt: 61 },
  ];

  const beforeCurrent = buildSessionInsights(events, { untilT: 20, asOfT: 59, displayNow: 20 });
  const early = buildSessionInsights(events, { untilT: 20, asOfT: 79, displayNow: 20 });
  const later = buildSessionInsights(events, { untilT: 20, asOfT: 80, displayNow: 20 });

  assert.equal(beforeCurrent.prStack.prs.find(pr => pr.number === 1).current, null);
  assert.deepEqual(early.visiblePrefix.map(event => event.id), ['start', 'recorded-pr', 'attention']);
  assert.deepEqual(later.visiblePrefix.map(event => event.id), ['start', 'recorded-pr', 'recovered-pr', 'attention']);
  assert.deepEqual(early.factPrefix.map(event => event.id), ['recorded-pr', 'current-pr', 'current-ci']);
  assert.deepEqual(later.factPrefix.map(event => event.id), ['recorded-pr', 'recovered-pr', 'current-pr', 'current-ci']);
  assert.equal(early.prStack.prs.some(pr => pr.number === 2), false);
  assert.equal(later.prStack.prs.some(pr => pr.number === 2), true);
  assert.equal(later.prStack.prs.find(pr => pr.number === 1).current.validation, 'pass');
  assert.equal(later.asOfT, 80);
  assert.equal(later.bounds.recordedEnd, 20);
  assert.equal(later.clocks.recordedSessionMs, 20);
  assert.equal(later.clocks.liveHumanWaitMs, 0);
  assert.deepEqual(later.lifecycle, { session: 'open', turn: 'complete', nextActor: 'human', inputRequest: 'question' });
  assert.ok(later.phases.every(phase => !phase.evidenceEventIds.includes('later-edit')));
  assert.ok(later.toolCalls.pointObservations.every(event => event.id !== 'later-edit'));
});

test('an unmatched tool start is unknown outcome, never blocked or running', () => {
  const x = buildSessionInsights([
    { t: 0, type: 'session', phase: 'start', sessionId: 's' },
    { t: 10, type: 'tool_call', state: 'start', sessionId: 's', agentId: 'a', toolUseId: 'u', tool: 'Bash' },
  ], { untilT: 10, displayNow: 20 });
  assert.equal(x.toolCalls.missingOutcomeCount, 1);
  assert.equal(x.toolCalls.lifecycles[0].outcome, 'unknown');
  assert.equal(x.toolCalls.lifecycles[0].endT, null);
  assert.ok(x.blockers.every(b => b.kind !== 'permission_block'));
});

test('PR registry is repo-qualified and topology uses only authoritative numeric bases', () => {
  const x = buildSessionInsights([
    { t: 0, type: 'session', phase: 'start' },
    { t: 5, id: 'ref-a', type: 'pr_ref', number: 1, url: 'https://github.com/org/alpha/pull/1', item: 'a' },
    { t: 6, id: 'ref-b', type: 'pr_ref', number: 1, url: 'https://github.com/org/beta/pull/1' },
    { t: 10, id: 'a1', source: 'poll-github', v: 2, type: 'pr', number: 1, url: 'https://github.com/org/alpha/pull/1', state: 'open', title: 'root' },
    { t: 11, id: 'a2', source: 'poll-github', v: 2, type: 'pr', number: 2, url: 'https://github.com/org/alpha/pull/2', state: 'open', base: 1 },
    { t: 12, id: 'a3', source: 'hook', v: 2, type: 'pr', repo: 'org/alpha', number: 3, state: 'open', base: 2 },
    { t: 13, id: 'a4', source: 'poll-github', v: 2, type: 'pr', repo: 'org/alpha', number: 4, state: 'open', base: '3', title: 'stacked on #3' },
    { t: 20, type: 'notification', reason: 'next_prompt' },
  ], { untilT: 20, displayNow: 20 });

  assert.deepEqual(x.prStack.prs.map(pr => pr.key).sort(), [
    'org/alpha#1', 'org/alpha#2', 'org/alpha#3', 'org/alpha#4', 'org/beta#1',
  ]);
  assert.equal(x.prStack.prs.find(pr => pr.key === 'org/alpha#2').recorded.base, 1);
  assert.equal(x.prStack.prs.find(pr => pr.key === 'org/alpha#3').recorded, null);
  assert.equal(x.prStack.prs.find(pr => pr.key === 'org/alpha#4').recorded.base, null);
  assert.deepEqual(x.prStack.recordedEdges, [{ from: 'org/alpha#1', to: 'org/alpha#2' }]);
  assert.ok(x.prStack.recordedRoots.includes('org/alpha#1'));
  assert.ok(x.prStack.recordedRoots.includes('org/alpha#4'));
});

test('later repo facts never retroactively re-key unknown PR observations', () => {
  const x = buildSessionInsights([
    { t: 0, type: 'session', phase: 'start' },
    { t: 5, id: 'unknown-ref', type: 'pr_ref', number: 7 },
    { t: 6, id: 'scoped-seven', source: 'poll-github', type: 'pr', repo: 'o/r', number: 7, state: 'open' },
    { t: 7, id: 'unknown-state', type: 'pr', number: 8, state: 'open' },
    { t: 8, id: 'scoped-eight', source: 'poll-github', type: 'pr', repo: 'o/r', number: 8, state: 'merged' },
    { t: 20, type: 'notification', reason: 'next_prompt' },
  ], { untilT: 20, displayNow: 20 });

  assert.deepEqual(x.prStack.prs.map(pr => pr.key).sort(), [
    'o/r#7', 'o/r#8', 'unknown#7', 'unknown#8',
  ]);
  assert.equal(x.prStack.prs.find(pr => pr.key === 'unknown#7').discovery.observedAt, 5);
  assert.equal(x.prStack.prs.find(pr => pr.key === 'unknown#8').recorded.state, 'open');
  assert.equal(x.prStack.prs.find(pr => pr.key === 'o/r#8').recorded.state, 'merged');
});

test('tool points and transcript aggregate metrics retain separate provenance', () => {
  const x = buildSessionInsights([
    { t: 0, type: 'session', phase: 'start' },
    { t: 5, id: 'point', type: 'tool', tool: 'Bash', text: 'legacy observation' },
    { t: 6, id: 'metrics-1', type: 'transcript_metrics', matchedToolPairs: 345, tapeToolObservations: 587 },
    { t: 10, id: 'start', type: 'tool_call', state: 'start', sessionId: 's', agentId: 'a', toolUseId: 'u', tool: 'Bash' },
    { t: 11, id: 'duplicate', type: 'tool_call', state: 'start', sessionId: 's', agentId: 'a', toolUseId: 'u', tool: 'Bash' },
    { t: 12, id: 'end', type: 'tool_call', state: 'success', sessionId: 's', agentId: 'a', toolUseId: 'u', tool: 'Bash' },
    { t: 13, id: 'orphan', type: 'tool_call', state: 'failure', sessionId: 's', agentId: 'a', toolUseId: 'missing', tool: 'Bash' },
  ], { untilT: 13, displayNow: 13 });

  assert.deepEqual(x.toolCalls.pointObservations.map(e => e.id), ['point']);
  assert.equal(x.toolCalls.matchedTranscriptPairs, 345);
  assert.equal(x.toolCalls.tapeObservations, 587);
  assert.equal(x.toolCalls.lifecycles.length, 1);
  assert.equal(x.toolCalls.lifecycles[0].startT, 10);
  assert.equal(x.toolCalls.lifecycles[0].outcome, 'success');
  assert.ok(x.diagnostics.some(d => d.kind === 'conflicting_lifecycle'));
});

test('later roadmap evidence flags but never rewrites the latest todo snapshot', () => {
  const x = buildSessionInsights([
    { t: 0, type: 'session', phase: 'start' },
    { t: 10, id: 'todos', type: 'todos', todos: [
      { text: 'Milestone 1', status: 'completed' },
      { text: 'Roadmap', status: 'in_progress' },
      { text: 'Final handoff', status: 'pending' },
    ] },
    { t: 20, id: 'assessment', type: 'assessment', subject: 'roadmap', value: 'roughly one-third', text: 'Milestone 1 complete', evidenceRef: 'final-message' },
    { t: 30, id: 'handoff', type: 'handoff', subject: 'roadmap', text: 'Stopped for human direction' },
  ], { untilT: 30, displayNow: 30 });

  assert.equal(x.roadmap.completed, 1);
  assert.equal(x.roadmap.total, 3);
  assert.deepEqual(x.roadmap.todos, [
    { text: 'Milestone 1', status: 'completed' },
    { text: 'Roadmap', status: 'in_progress' },
    { text: 'Final handoff', status: 'pending' },
  ]);
  assert.equal(x.roadmap.assessment.value, 'roughly one-third');
  assert.equal(x.roadmap.staleSnapshot, true);
  assert.deepEqual(x.roadmap.staleEvidenceEventIds, ['assessment', 'handoff']);
});

test('attribution gaps and diagnostics expose unattached artifacts and provenance gaps', () => {
  const x = buildSessionInsights([
    { t: 0, id: 'session', type: 'session', phase: 'start' },
    { t: 1, id: 'attached', type: 'edit', path: 'attached.js', item: 'card' },
    { t: 2, id: 'loose', type: 'edit', path: 'loose.js' },
    { t: 3, id: 'recovered', source: 'recovery', type: 'pr_ref', number: 9, url: 'https://github.com/o/r/pull/9', recovery: 'transcript', recordedAt: 30 },
    { t: 4, id: 'expired', type: 'poller_status', status: 'expired' },
    { t: ACTIVE_GAP_MS + 20, id: 'end', type: 'session', phase: 'end' },
  ], { untilT: ACTIVE_GAP_MS + 20, displayNow: ACTIVE_GAP_MS + 20 });

  assert.ok(x.attributionGaps.some(g => g.kind === 'producer' && g.eventId === 'loose'));
  assert.ok(x.attributionGaps.some(g => g.kind === 'pr' && g.key === 'o/r#9'));
  assert.ok(x.attributionGaps.every(g => g.eventId !== 'attached'));
  assert.ok(x.diagnostics.some(d => d.kind === 'recovery'));
  assert.ok(x.diagnostics.some(d => d.kind === 'missing_poller'));
  assert.ok(x.diagnostics.some(d => d.kind === 'stale_poller'));
  assert.ok(x.diagnostics.some(d => d.kind === 'unclassified_span'));
});

test('post-session poller signals age against display time without replay lookahead', () => {
  const futureT = 20 + ACTIVE_GAP_MS + 100;
  const events = [
    { t: 0, type: 'session', phase: 'start' },
    { t: 5, id: 'pr', source: 'poll-github', type: 'pr', repo: 'o/r', number: 1, state: 'open' },
    { t: 10, type: 'notification', reason: 'next_prompt' },
    { t: 20, id: 'post-session-alive', source: 'poll-github', type: 'alive' },
    { t: futureT, id: 'future-alive', source: 'poll-github', type: 'alive' },
  ];

  const fresh = buildSessionInsights(events, { untilT: 20, displayNow: 20 });
  assert.ok(fresh.diagnostics.every(d => d.kind !== 'stale_poller'));

  const stale = buildSessionInsights(events, { untilT: 20, displayNow: 20 + ACTIVE_GAP_MS + 1 });
  const stalePoller = stale.diagnostics.find(d => d.kind === 'stale_poller');
  assert.equal(stalePoller.lastSignalT, 20);
  assert.ok(stalePoller.evidenceEventIds.includes('post-session-alive'));
  assert.ok(!stalePoller.evidenceEventIds.includes('future-alive'));

  const refreshed = buildSessionInsights(events, { untilT: futureT, displayNow: futureT });
  assert.ok(refreshed.diagnostics.every(d => d.kind !== 'stale_poller'));
});

test('current facts age against the knowledge horizon without advancing semantic clocks', () => {
  const events = [
    { t: 0, id: 'start', type: 'session', phase: 'start' },
    { t: 10, id: 'attention', type: 'notification', reason: 'next_prompt' },
    { t: 20, id: 'current-pr', source: 'poll-github', type: 'pr', repo: 'o/r', number: 1, state: 'open', fetchedAt: 20 },
  ];
  const fresh = buildSessionInsights(events, { untilT: 10, asOfT: 20, displayNow: 10 });
  const stale = buildSessionInsights(events, {
    untilT: 10,
    asOfT: 20 + ACTIVE_GAP_MS + 1,
    displayNow: 10,
  });

  assert.ok(fresh.diagnostics.every(diagnostic => diagnostic.kind !== 'stale_poller'));
  assert.equal(stale.diagnostics.find(diagnostic => diagnostic.kind === 'stale_poller')?.lastSignalT, 20);
  assert.deepEqual(stale.bounds, fresh.bounds);
  assert.deepEqual(stale.clocks, fresh.clocks);
  assert.deepEqual(stale.phases, fresh.phases);
});

test('sanitized reference session preserves the retrospective acceptance truth', () => {
  const events = readFileSync(new URL('./tapes/semantic-reference.jsonl', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  const finalAttentionT = 1700041531012;
  const recoveryT = 1700004331705;
  const expectedRecordedBase = { 101: null, 102: 101, 103: 101, 105: 102, 106: 102, 107: 102 };
  const expectedCurrentBase = { 101: null, 102: 101, 103: 102, 104: 102, 105: 102, 106: 102, 107: 102 };
  const expectedRecordedCi = { 101: 'pass', 102: 'pending', 103: 'pending', 105: 'pass', 106: 'pending', 107: 'pending' };
  const expectedCurrentCi = { 101: 'pass', 102: 'pass', 103: 'pass', 104: 'pass', 105: 'pass', 106: 'pass', 107: 'pass' };
  const beforeRecovery = buildSessionInsights(events, {
    untilT: finalAttentionT,
    asOfT: 1700120426100,
    displayNow: finalAttentionT,
  });
  const recoveredKnowledge = buildSessionInsights(events, {
    untilT: finalAttentionT,
    asOfT: 1700120426802,
    displayNow: finalAttentionT,
  });
  const x = buildSessionInsights(events, { untilT: Infinity, displayNow: events.at(-1).t });
  const prsByNumber = new Map(x.prStack.prs.map(pr => [pr.number, pr]));
  const axisValues = (axis, field) => Object.fromEntries(x.prStack.prs
    .filter(pr => pr[axis] != null)
    .map(pr => [pr.number, pr[axis][field]]));

  assert.ok(!beforeRecovery.visiblePrefix.some(event => event.id === 'final-next-prompt'));
  assert.ok(!beforeRecovery.visiblePrefix.some(event => event.id === 'transcript-metrics'));
  assert.deepEqual(beforeRecovery.lifecycle, { session: 'open', turn: 'complete', nextActor: 'human', inputRequest: 'question' });
  assert.equal(beforeRecovery.toolCalls.matchedTranscriptPairs, 0);
  assert.equal(beforeRecovery.toolCalls.tapeObservations, 0);
  assert.ok(recoveredKnowledge.visiblePrefix.some(event => event.id === 'final-next-prompt'));
  assert.ok(recoveredKnowledge.visiblePrefix.some(event => event.id === 'transcript-metrics'));
  assert.ok(recoveredKnowledge.visiblePrefix.every(event => event.t <= finalAttentionT));
  assert.deepEqual(recoveredKnowledge.lifecycle, { session: 'open', turn: 'complete', nextActor: 'human', inputRequest: 'none' });
  assert.equal(recoveredKnowledge.toolCalls.matchedTranscriptPairs, 345);
  assert.equal(recoveredKnowledge.toolCalls.tapeObservations, 587);
  assert.deepEqual(recoveredKnowledge.bounds, beforeRecovery.bounds);
  assert.deepEqual(recoveredKnowledge.clocks, beforeRecovery.clocks);
  const edges = axis => x.prStack[`${axis}Edges`]
    .map(edge => `${edge.from}>${edge.to}`)
    .sort();

  assert.equal(x.bounds.recordedStart, 1700000000000);
  assert.equal(x.bounds.recordedEnd, finalAttentionT);
  assert.equal(x.bounds.producerStart, 1700000001363);
  assert.equal(x.bounds.producerEnd, 1700041373239);
  assert.ok(Math.abs(x.clocks.recordedSessionMs - (11 * 60 + 32) * 60_000) <= 60_000);
  assert.ok(Math.abs(x.clocks.producerWindowMs - (11 * 60 + 29) * 60_000) <= 60_000);
  const promptCards = events.filter(event => event.type === 'item' && event.status === 'doing');
  const activeSpans = x.phases.filter(span => span.disposition === 'active');
  const preflightSpans = activeSpans.filter(span => span.phase === 'preflight' && span.source === 'declared_preflight');
  assert.equal(promptCards.length, 2);
  assert.ok(activeSpans.length > 2);
  assert.ok(promptCards.every(card => activeSpans.some(span => span.evidenceEventIds.includes(card.id))));
  assert.ok(preflightSpans.length >= 2);
  assert.ok(preflightSpans.some(span => span.stage === 'local_validation'));
  assert.ok(preflightSpans.some(span => span.stage === 'cross_ai_review'));

  assert.equal(x.prStack.prs.filter(pr => (pr.current?.state ?? pr.recorded?.state) === 'open').length, 7);
  assert.equal(x.prStack.prs.filter(pr => (pr.current?.state ?? pr.recorded?.state) === 'merged').length, 0);
  assert.deepEqual(x.prStack.prs.filter(pr => pr.recorded?.prAt != null).map(pr => pr.number).sort((a, b) => a - b), [101, 102, 103, 105, 106, 107]);
  assert.equal(prsByNumber.get(104).recorded, null);
  assert.deepEqual(axisValues('recorded', 'base'), expectedRecordedBase);
  assert.deepEqual(axisValues('current', 'base'), expectedCurrentBase);
  assert.deepEqual(axisValues('recorded', 'validation'), expectedRecordedCi);
  assert.deepEqual(axisValues('current', 'validation'), expectedCurrentCi);
  assert.deepEqual(x.prStack.recordedRoots, ['sample-org/reference-app#101']);
  assert.deepEqual(x.prStack.currentRoots, ['sample-org/reference-app#101']);
  assert.deepEqual(edges('recorded'), [
    'sample-org/reference-app#101>sample-org/reference-app#102',
    'sample-org/reference-app#101>sample-org/reference-app#103',
    'sample-org/reference-app#102>sample-org/reference-app#105',
    'sample-org/reference-app#102>sample-org/reference-app#106',
    'sample-org/reference-app#102>sample-org/reference-app#107',
  ]);
  assert.deepEqual(edges('current'), [
    'sample-org/reference-app#101>sample-org/reference-app#102',
    'sample-org/reference-app#102>sample-org/reference-app#103',
    'sample-org/reference-app#102>sample-org/reference-app#104',
    'sample-org/reference-app#102>sample-org/reference-app#105',
    'sample-org/reference-app#102>sample-org/reference-app#106',
    'sample-org/reference-app#102>sample-org/reference-app#107',
  ]);
  assert.deepEqual(Object.fromEntries(x.prStack.prs.map(pr => [pr.number, pr.current?.advisoryRunning ?? 0])), {
    101: 0, 102: 0, 103: 0, 104: 0, 105: 0, 106: 1, 107: 0,
  });

  assert.equal(x.roadmap.completed, 8);
  assert.equal(x.roadmap.total, 10);
  assert.deepEqual(x.roadmap.todos.slice(-2).map(todo => [todo.text, todo.status]), [
    ['Roadmap', 'in_progress'],
    ['Final handoff', 'in_progress'],
  ]);
  assert.equal(x.roadmap.assessment.value, 'roughly one-third');
  assert.match(x.roadmap.assessment.text, /Milestone 1 complete/);
  assert.match(x.roadmap.assessment.text, /Milestones 4 through 7 not started/);
  assert.equal(x.roadmap.staleSnapshot, true);
  assert.deepEqual(x.roadmap.staleEvidenceEventIds, ['roadmap-assessment']);

  const finalNotification = events.find(event => event.id === 'final-next-prompt');
  assert.deepEqual({
    t: finalNotification?.t,
    source: finalNotification?.source,
    type: finalNotification?.type,
    reason: finalNotification?.reason,
    recovery: finalNotification?.recovery,
  }, {
    t: finalAttentionT,
    source: 'recovery',
    type: 'notification',
    reason: 'next_prompt',
    recovery: 'transcript',
  });
  assert.ok(finalNotification.recordedAt > finalAttentionT);
  assert.ok(finalNotification.evidenceRef);
  assert.deepEqual(x.lifecycle, { session: 'open', turn: 'complete', nextActor: 'human', inputRequest: 'none' });
  assert.equal(x.toolCalls.missingOutcomeCount, 0);
  assert.equal(x.toolCalls.matchedTranscriptPairs, 345);
  assert.equal(x.toolCalls.tapeObservations, 587);
  assert.deepEqual(x.toolCalls.metricsEvidenceEventIds, ['transcript-metrics']);
  const transcriptMetrics = events.find(event => event.id === 'transcript-metrics');
  assert.equal(transcriptMetrics.source, 'recovery');
  assert.equal(transcriptMetrics.sourceUntilT, finalAttentionT);
  assert.ok(transcriptMetrics.recordedAt > finalAttentionT);
  assert.ok(transcriptMetrics.evidenceRef);
  assert.equal(transcriptMetrics.sourceEventCount, 1938);

  const serializedFixture = JSON.stringify(events);
  assert.ok(events.every(event => event.repo == null || event.repo === 'sample-org/reference-app'));
  assert.ok(events.every(event => event.session == null || event.session === 'reference-session'));
  assert.doesNotMatch(serializedFixture, /github\.com\/(?!sample-org\/reference-app\/pull\/)/i);
  assert.doesNotMatch(serializedFixture, /\/(?:Users|private|home)\//i);
  assert.doesNotMatch(serializedFixture, /(?:~\/|\$HOME|%USERPROFILE%)/i);
  assert.doesNotMatch(serializedFixture, /"(?:command|cmd)"\s*:/i);
  assert.doesNotMatch(serializedFixture, /(?:client[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|bearer\s+|password|-----BEGIN|\b(?:sk|gh[opusr])_[A-Za-z0-9])/i);
  assert.doesNotMatch(serializedFixture, /(?:\$\(|&&|\b(?:cd|curl|sudo|ssh|git|gh|npm|pnpm|bun|yarn)\s+)/i);

  assert.equal(buildSessionInsights(events, { untilT: recoveryT - 1 }).prStack.prs.some(pr => pr.number === 104), false);
  const recoveryRecordedAt = events.find(event => event.id === 'recovered-pr-104').recordedAt;
  const recovered = buildSessionInsights(events, {
    untilT: recoveryT,
    asOfT: recoveryRecordedAt,
  }).prStack.prs.find(pr => pr.number === 104);
  assert.equal(recovered.discovery.kind, 'recovered');
  assert.equal(recovered.discovery.observedAt, recoveryT);
  assert.ok(recovered.discovery.recordedAt > finalAttentionT);
  assert.equal(recovered.discovery.recovery, 'transcript');
  assert.equal(recovered.discovery.evidenceRef, 'claude-transcript:pr-link');
  assert.equal(recovered.current, null);

  const atFinalAttention = buildSessionInsights(events, { untilT: finalAttentionT, displayNow: finalAttentionT });
  assert.ok(atFinalAttention.prStack.prs.every(pr => pr.current === null));
  assert.deepEqual(atFinalAttention.prStack.currentRoots, []);
  assert.deepEqual(atFinalAttention.prStack.currentEdges, []);
});
