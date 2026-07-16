import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, '..', 'hooks', 'agent-hook.js');
const EVENTS_DOC = path.join(here, '..', 'docs', 'EVENTS.md');
const SID = 'tool-lifecycle-session';

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-lifecycle-'));
  return {
    root,
    ns: path.join(root, 'nightshift'),
    log: path.join(root, 'events.jsonl'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function fire(sb, payload, envOverrides = {}) {
  const env = {
    ...process.env,
    HOME: sb.root,
    NIGHTSHIFT_HOME: sb.ns,
    NIGHTSHIFT_LOG: sb.log,
    ...envOverrides,
  };
  delete env.CLAUDE_PROJECT_DIR;
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: '/tmp/project', ...payload }),
    encoding: 'utf8',
    env,
  });
}

function events(sb, type) {
  const all = fs.existsSync(sb.log)
    ? fs.readFileSync(sb.log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  return type ? all.filter(event => event.type === type) : all;
}

const pre = (extra = {}) => ({
  hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Bash',
  tool_input: { command: 'pwd' }, tool_use_id: 'tool-1', ...extra,
});
const post = (extra = {}) => ({
  hook_event_name: 'PostToolUse', session_id: SID, tool_name: 'Bash',
  tool_input: { command: 'pwd' }, tool_response: '/tmp/project', tool_use_id: 'tool-1', ...extra,
});

test('matching PreToolUse and PostToolUse emit one start/success lifecycle', () => {
  const sb = sandbox();
  try {
    assert.equal(fire(sb, pre({ agent_id: 'agent-a' })).status, 0);
    assert.equal(fire(sb, post({ agent_id: 'agent-a' })).status, 0);
    const lifecycle = events(sb, 'tool_call');
    assert.deepEqual(lifecycle.map(({ state, sessionId, agentId, toolUseId, tool }) => ({ state, sessionId, agentId, toolUseId, tool })), [
      { state: 'start', sessionId: SID, agentId: 'agent-a', toolUseId: 'tool-1', tool: 'Bash' },
      { state: 'success', sessionId: SID, agentId: 'agent-a', toolUseId: 'tool-1', tool: 'Bash' },
    ]);
  } finally {
    sb.cleanup();
  }
});

test('same tool id stays isolated by agent and Stop closes only the remaining start as unknown', () => {
  const sb = sandbox();
  try {
    assert.equal(fire(sb, pre({ agent_id: 'agent-a', tool_use_id: 'shared' })).status, 0);
    assert.equal(fire(sb, pre({ agent_id: 'agent-b', tool_use_id: 'shared' })).status, 0);
    assert.equal(fire(sb, post({ agent_id: 'agent-a', tool_use_id: 'shared' })).status, 0);
    assert.equal(fire(sb, { hook_event_name: 'Stop', session_id: SID }).status, 0);

    const lifecycle = events(sb, 'tool_call');
    const states = agent => lifecycle.filter(event => event.agentId === agent).map(event => event.state);
    assert.deepEqual(states('agent-a'), ['start', 'success']);
    assert.deepEqual(states('agent-b'), ['start', 'unknown']);
  } finally {
    sb.cleanup();
  }
});

test('punctuation-distinct sessions cannot collide on the same agent and tool id', () => {
  const sb = sandbox();
  try {
    const sessionIds = ['a/b', 'a?b'];
    for (const session_id of sessionIds) {
      assert.equal(fire(sb, pre({ session_id, agent_id: 'shared-agent', tool_use_id: 'shared-tool' })).status, 0);
    }
    const stateDirs = fs.readdirSync(path.join(sb.ns, 'tool-calls'));
    for (const session_id of sessionIds) {
      assert.equal(fire(sb, post({ session_id, agent_id: 'shared-agent', tool_use_id: 'shared-tool' })).status, 0);
    }

    assert.equal(stateDirs.length, 2, 'each exact session gets a distinct state directory');
    const lifecycle = events(sb, 'tool_call');
    for (const sessionId of sessionIds) {
      assert.deepEqual(
        lifecycle.filter(event => event.sessionId === sessionId).map(event => event.state),
        ['start', 'success'],
        sessionId,
      );
    }
  } finally {
    sb.cleanup();
  }
});

test('PostToolUse rejects a claimed state record whose compound identity was corrupted', () => {
  const sb = sandbox();
  try {
    assert.equal(fire(sb, pre({ session_id: 'expected-session', agent_id: 'expected-agent', tool_use_id: 'expected-tool' })).status, 0);
    const calls = path.join(sb.ns, 'tool-calls');
    const [sessionDir] = fs.readdirSync(calls);
    const [identityFile] = fs.readdirSync(path.join(calls, sessionDir)).filter(file => file.endsWith('.json'));
    fs.writeFileSync(path.join(calls, sessionDir, identityFile), JSON.stringify({
      sessionId: 'different-session', agentId: 'different-agent', toolUseId: 'different-tool', tool: 'Bash',
    }));

    assert.equal(fire(sb, post({ session_id: 'expected-session', agent_id: 'expected-agent', tool_use_id: 'expected-tool' })).status, 0);
    assert.equal(events(sb, 'tool_call').filter(event => event.state === 'success').length, 0);
  } finally {
    sb.cleanup();
  }
});

test('SessionEnd closes every open tool as unknown and clears persisted opens', () => {
  const sb = sandbox();
  try {
    assert.equal(fire(sb, pre({ tool_use_id: 'one' })).status, 0);
    assert.equal(fire(sb, pre({ tool_use_id: 'two' })).status, 0);
    assert.equal(fire(sb, { hook_event_name: 'SessionEnd', session_id: SID, reason: 'other' }).status, 0);
    assert.deepEqual(
      events(sb, 'tool_call').filter(event => event.state === 'unknown').map(event => event.toolUseId).sort(),
      ['one', 'two'],
    );

    assert.equal(fire(sb, { hook_event_name: 'Stop', session_id: SID }).status, 0);
    assert.equal(events(sb, 'tool_call').filter(event => event.state === 'unknown').length, 2, 'closed identities are not closed twice');
  } finally {
    sb.cleanup();
  }
});

test('camelCase ids and environment session fallback use main agent identity', () => {
  const sb = sandbox();
  try {
    const base = { tool_name: 'Bash', tool_input: { command: 'pwd' }, toolUseId: 'camel' };
    assert.equal(fire(sb, { hook_event_name: 'PreToolUse', ...base }, { CODEX_THREAD_ID: 'env-session' }).status, 0);
    assert.equal(fire(sb, { hook_event_name: 'PostToolUse', tool_response: 'ok', ...base }, { CODEX_THREAD_ID: 'env-session' }).status, 0);
    assert.deepEqual(events(sb, 'tool_call').map(event => [event.sessionId, event.agentId, event.toolUseId, event.state]), [
      ['env-session', 'main', 'camel', 'start'],
      ['env-session', 'main', 'camel', 'success'],
    ]);
  } finally {
    sb.cleanup();
  }
});

test('environment session fallback also passes the central recording gate', () => {
  const sb = sandbox();
  try {
    const sid = 'central-env-session';
    fs.mkdirSync(path.join(sb.ns, 'active'), { recursive: true });
    fs.writeFileSync(path.join(sb.ns, 'active', sid), '');
    fs.writeFileSync(path.join(sb.ns, 'install.json'), JSON.stringify({ repo: '/different/nightshift/repo' }));
    const env = {
      ...process.env,
      HOME: sb.root,
      NIGHTSHIFT_HOME: sb.ns,
      CODEX_THREAD_ID: sid,
    };
    delete env.NIGHTSHIFT_LOG;
    delete env.NIGHTSHIFT;
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CLAUDE_CODE_SESSION_ID;
    const payload = { cwd: '/tmp/project', tool_name: 'Bash', tool_input: { command: 'pwd' }, tool_use_id: 'central-tool' };
    for (const hook_event_name of ['PreToolUse', 'PostToolUse']) {
      const result = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ hook_event_name, ...payload }), encoding: 'utf8', env,
      });
      assert.equal(result.status, 0, result.stderr);
    }
    const log = path.join(sb.ns, 'sessions', 'tmp-project.jsonl');
    assert.equal(fs.existsSync(log), true, 'the opted-in central session was recorded');
    assert.deepEqual(
      fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
        .filter(event => event.type === 'tool_call').map(event => event.state),
      ['start', 'success'],
    );
  } finally {
    sb.cleanup();
  }
});

test('mid-turn activation keeps the enabling command as a point and starts exact lifecycles on the next tool', () => {
  const sb = sandbox();
  try {
    const sid = 'activation-session';
    fs.mkdirSync(path.join(sb.ns, 'active'), { recursive: true });
    fs.writeFileSync(path.join(sb.ns, 'install.json'), JSON.stringify({ repo: '/different/nightshift/repo' }));
    const env = {
      ...process.env,
      HOME: sb.root,
      NIGHTSHIFT_HOME: sb.ns,
      CLAUDE_CODE_SESSION_ID: sid,
    };
    delete env.NIGHTSHIFT_LOG;
    delete env.NIGHTSHIFT;
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CODEX_THREAD_ID;
    const invoke = payload => spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ cwd: '/tmp/project', session_id: sid, tool_name: 'Bash', tool_input: { command: 'pwd' }, ...payload }),
      encoding: 'utf8', env,
    });

    assert.equal(invoke({ hook_event_name: 'PreToolUse', tool_use_id: 'enable-nightshift' }).status, 0);
    fs.writeFileSync(path.join(sb.ns, 'active', sid), '');
    assert.equal(invoke({ hook_event_name: 'PostToolUse', tool_use_id: 'enable-nightshift', tool_response: 'enabled' }).status, 0);
    assert.equal(invoke({ hook_event_name: 'PreToolUse', tool_use_id: 'next-tool' }).status, 0);
    assert.equal(invoke({ hook_event_name: 'PostToolUse', tool_use_id: 'next-tool', tool_response: 'ok' }).status, 0);

    const log = path.join(sb.ns, 'sessions', 'tmp-project.jsonl');
    const recorded = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.deepEqual(recorded.filter(event => event.type === 'tool_call').map(event => [event.toolUseId, event.state]), [
      ['next-tool', 'start'],
      ['next-tool', 'success'],
    ]);
    assert.equal(recorded.filter(event => event.type === 'tool' && event.text === 'pwd').length, 2, 'both PostToolUse deliveries retain point activity');
    const contract = fs.readFileSync(EVENTS_DOC, 'utf8');
    assert.match(contract, /Mid-turn activation boundary/);
    assert.match(contract, /PreToolUse[\s\S]{0,80}before the active[\s\S]{0,20}marker/i);
    assert.match(contract, /PostToolUse[\s\S]{0,80}legacy point/i);
    assert.match(contract, /begins with the next[\s\S]{0,30}PreToolUse/i);
  } finally {
    sb.cleanup();
  }
});

test('PostToolUse without an id retains legacy point behavior only', () => {
  const sb = sandbox();
  try {
    assert.equal(fire(sb, post({ tool_use_id: undefined })).status, 0);
    assert.equal(events(sb, 'tool_call').length, 0);
    assert.equal(events(sb, 'tool').length, 1);
  } finally {
    sb.cleanup();
  }
});
