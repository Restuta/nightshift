import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const GLOBAL = path.join(root, 'tools', 'install-global.js');
const CODEX = path.join(root, 'tools', 'install-codex.js');
const ATTACH = path.join(root, 'tools', 'attach.js');

function temp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function run(script, args, home) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
}

function ours(group) {
  return (group.hooks || []).some(hook => (hook.command || '').includes('nightshift'));
}

function assertSymmetric(config, expectedMatcher) {
  const pre = (config.hooks.PreToolUse || []).filter(ours);
  const post = (config.hooks.PostToolUse || []).filter(ours);
  assert.equal(pre.length, 1, 'exactly one Nightshift PreToolUse group');
  assert.equal(post.length, 1, 'exactly one Nightshift PostToolUse group');
  assert.equal(pre[0].matcher, expectedMatcher);
  assert.equal(post[0].matcher, expectedMatcher);
  assert.equal('PostToolUseFailure' in config.hooks, false);
  assert.equal('ToolUseCancelled' in config.hooks, false);
}

test('global installer adds symmetric tool matchers idempotently and preserves foreign hooks', () => {
  const sb = temp('install-global-');
  try {
    const file = path.join(sb.dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const foreignBefore = { matcher: 'Bash', hooks: [{ type: 'command', command: 'foreign-before' }] };
    const foreignAfter = { matcher: 'Read', hooks: [{ type: 'command', command: 'foreign-after' }] };
    const oldNightshift = { matcher: 'OldMatcher', hooks: [{ type: 'command', command: 'node /old/nightshift/hooks/claude-hook.js' }] };
    fs.writeFileSync(file, JSON.stringify({
      hooks: {
        PreToolUse: [foreignBefore, oldNightshift, foreignAfter],
        PostToolUse: [foreignBefore, oldNightshift, foreignAfter],
      },
      keep: 1,
    }));

    for (let i = 0; i < 2; i++) {
      const result = run(GLOBAL, [], sb.dir);
      assert.equal(result.status, 0, result.stderr);
    }
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const event of ['PreToolUse', 'PostToolUse']) {
      assert.deepEqual(config.hooks[event][0], foreignBefore, `${event} foreign-before index`);
      assert.equal(ours(config.hooks[event][1]), true, `${event} Nightshift index`);
      assert.deepEqual(config.hooks[event][2], foreignAfter, `${event} foreign-after index`);
    }
    assert.equal(config.keep, 1);
    assertSymmetric(config, 'Edit|Write|MultiEdit|NotebookEdit|TodoWrite|Bash');
  } finally {
    sb.cleanup();
  }
});

test('Codex installer appends symmetric tool groups once without shifting foreign indices', () => {
  const sb = temp('install-codex-');
  try {
    const file = path.join(sb.dir, '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const foreignPre = { matcher: 'Bash', hooks: [{ type: 'command', command: 'security-pre' }] };
    const foreignPost = { matcher: 'Read', hooks: [{ type: 'command', command: 'audit-post' }] };
    fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [foreignPre], PostToolUse: [foreignPost] }, keep: 2 }));

    for (let i = 0; i < 2; i++) {
      const result = run(CODEX, [], sb.dir);
      assert.equal(result.status, 0, result.stderr);
    }
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(config.hooks.PreToolUse[0], foreignPre);
    assert.deepEqual(config.hooks.PostToolUse[0], foreignPost);
    assert.equal(config.keep, 2);
    assertSymmetric(config, undefined);
  } finally {
    sb.cleanup();
  }
});

test('attach installer adds symmetric local matchers idempotently and preserves project hooks', () => {
  const sb = temp('install-attach-');
  try {
    const project = path.join(sb.dir, 'project');
    const file = path.join(project, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const foreignPre = { matcher: 'Bash', hooks: [{ type: 'command', command: 'project-pre' }] };
    const foreignPost = { matcher: 'Read', hooks: [{ type: 'command', command: 'project-post' }] };
    fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [foreignPre], PostToolUse: [foreignPost] }, keep: 3 }));

    for (let i = 0; i < 2; i++) {
      const result = run(ATTACH, [project], sb.dir);
      assert.equal(result.status, 0, result.stderr);
    }
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(config.hooks.PreToolUse[0], foreignPre);
    assert.deepEqual(config.hooks.PostToolUse[0], foreignPost);
    assert.equal(config.keep, 3);
    assertSymmetric(config, 'Edit|Write|MultiEdit|NotebookEdit|TodoWrite');
  } finally {
    sb.cleanup();
  }
});
