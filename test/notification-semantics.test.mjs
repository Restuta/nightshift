import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fold } from '../public/reducer.js';
import { summarizeBase } from '../public/fleet-summary.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, '..', 'hooks', 'agent-hook.js');
const SID = 'notification-session';

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-semantics-'));
  return {
    root,
    ns: path.join(root, 'nightshift'),
    log: path.join(root, 'events.jsonl'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function fire(sb, payload) {
  const env = {
    ...process.env,
    HOME: sb.root,
    NIGHTSHIFT_HOME: sb.ns,
    NIGHTSHIFT_LOG: sb.log,
  };
  delete env.CLAUDE_PROJECT_DIR;
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: SID, cwd: '/tmp/project', ...payload }),
    encoding: 'utf8',
    env,
  });
}

function recorded(sb) {
  if (!fs.existsSync(sb.log)) return [];
  return fs.readFileSync(sb.log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('Notification records semantic reasons from structured fields only', () => {
  const sb = sandbox();
  try {
    const cases = [
      [{ notification_type: 'idle_prompt', message: 'ready' }, 'next_prompt'],
      [{ subtype: 'permission', message: 'approve?' }, 'permission'],
      [{ reason: 'question', message: 'choose one' }, 'question'],
      [{ type: 'background_complete', message: 'worker done' }, 'background_complete'],
      [{ notificationType: 'auth_success', message: 'permission needed now' }, 'system_notice'],
    ];
    for (const [fields] of cases) {
      const result = fire(sb, { hook_event_name: 'Notification', ...fields });
      assert.equal(result.status, 0, result.stderr);
    }

    const notifications = recorded(sb).filter(event => event.type === 'notification');
    assert.deepEqual(notifications.map(event => event.reason), cases.map(([, reason]) => reason));
    assert.deepEqual(notifications.map(event => event.text), cases.map(([fields]) => fields.message));
    assert.equal(recorded(sb).some(event => event.type === 'session' && event.phase === 'attention'), false);
  } finally {
    sb.cleanup();
  }
});

test('next_prompt after Stop preserves idle and does not request input', () => {
  const sb = sandbox();
  try {
    assert.equal(fire(sb, { hook_event_name: 'Stop' }).status, 0);
    assert.equal(fire(sb, {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
    }).status, 0);

    const events = recorded(sb);
    const state = fold(events);
    const summary = summarizeBase(events, { id: SID });
    assert.equal(state.session.phase, 'idle');
    assert.equal(state.session.unresolvedInputReason, null);
    assert.equal(summary.needsInput, false);
    assert.equal(summary.needsInputText, null);
  } finally {
    sb.cleanup();
  }
});

test('permission and question are actionable while informational notices preserve phase', () => {
  for (const reason of ['permission', 'question']) {
    const events = [
      { t: 1, type: 'session', phase: 'start' },
      { t: 2, type: 'notification', reason, text: `${reason}?` },
      { t: 3, type: 'notification', reason: 'system_notice', text: 'FYI only' },
    ];
    const state = fold(events);
    const summary = summarizeBase(events, { id: reason });
    assert.equal(state.session.phase, 'attention');
    assert.equal(state.session.unresolvedInputReason, reason);
    assert.equal(state.session.attentionText, `${reason}?`);
    assert.equal(summary.needsInput, true);
    assert.equal(summary.needsInputText, `${reason}?`);
  }
});

test('later work, resume, idle, and end clear actionable notification state', () => {
  const clearers = [
    { t: 3, type: 'tool', tool: 'run', text: 'pwd' },
    { t: 3, type: 'tool_call', state: 'success', sessionId: 's', agentId: 'main', toolUseId: 'u', tool: 'Bash' },
    { t: 3, type: 'session', phase: 'resume' },
    { t: 3, type: 'session', phase: 'idle' },
    { t: 3, type: 'session', phase: 'end' },
  ];
  for (const clearer of clearers) {
    const events = [
      { t: 1, type: 'session', phase: 'start' },
      { t: 2, type: 'notification', reason: 'permission', text: 'approve?' },
      clearer,
    ];
    const state = fold(events);
    const summary = summarizeBase(events, { id: clearer.type + (clearer.phase || clearer.state || '') });
    assert.equal(state.session.unresolvedInputReason, null, JSON.stringify(clearer));
    assert.equal(summary.needsInput, false, JSON.stringify(clearer));
  }
});

test('legacy session attention remains actionable and clears on later work', () => {
  const blocked = [
    { t: 1, type: 'session', phase: 'start' },
    { t: 2, type: 'session', phase: 'attention', text: 'legacy question' },
  ];
  const state = fold(blocked);
  assert.equal(state.session.unresolvedInputReason, 'question');
  assert.equal(summarizeBase(blocked, { id: 'legacy' }).needsInput, true);

  const resumed = [...blocked, { t: 3, type: 'edit', path: 'a.js' }];
  assert.equal(summarizeBase(resumed, { id: 'legacy-resumed' }).needsInput, false);
});
