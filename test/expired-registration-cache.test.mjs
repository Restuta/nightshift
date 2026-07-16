// Expired PR registrations stay resumable without making the always-on board
// reopen and parse an unchanged historical tape on every supervisor tick.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const serverFile = path.join(repo, 'server.js');
const registrationFile = path.join(repo, 'tools', 'poller-registration.js');
const pollerFile = path.join(repo, 'tools', 'poll-github.js');
const node = process.execPath;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function freePort() {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function get(port, pathname) {
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 500 }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', () => resolve(null));
    request.on('timeout', () => { request.destroy(); resolve(null); });
  });
}

async function waitFor(fn, { tries = 150, gap = 20 } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const value = await fn();
    if (value) return value;
    await sleep(gap);
  }
  return null;
}

function readCount(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; }
  catch { return 0; }
}

async function waitUntilStable(file) {
  let previous = readCount(file);
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(40);
    const current = readCount(file);
    if (current === previous) return current;
    previous = current;
  }
  return previous;
}

function register(home, log, cwd, sessionId) {
  const result = spawnSync(node, [registrationFile, 'register', '--log', log, '--session', sessionId, '--cwd', cwd], {
    env: { ...process.env, NIGHTSHIFT_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('expired registration scans stay cached until tape or registration identity changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-expired-cache-'));
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'repo');
  const log = path.join(cwd, 'session.jsonl');
  const clock = path.join(dir, 'clock');
  const probeCalls = path.join(dir, 'probe-calls');
  const preload = path.join(dir, 'read-probe.cjs');
  const sessionId = 'expired-session';
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(log, [
    { t: 1, source: 'hook', type: 'session', phase: 'end', cwd },
    { t: 2, recordedAt: 100, source: 'recovery', type: 'pr_ref', repo: 'sample/repo', number: 1 },
  ].map(event => JSON.stringify(event)).join('\n') + '\n');
  fs.writeFileSync(clock, String(200_000_000));
  fs.writeFileSync(preload, `
const fs = require('node:fs');
const path = require('node:path');
const original = fs.readFileSync;
const target = fs.realpathSync.native(process.env.NIGHTSHIFT_TEST_PROBE_LOG);
fs.readFileSync = function (file, ...args) {
  const resolved = path.resolve(String(file));
  if (resolved === target) fs.appendFileSync(process.env.NIGHTSHIFT_TEST_PROBE_CALLS, 'read\\n');
  return original.call(this, file, ...args);
};
`);
  const registration = register(home, log, cwd, sessionId);
  const port = await freePort();
  const child = spawn(node, [serverFile, '--port', String(port), '--log', log], {
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preload}`.trim(),
      NIGHTSHIFT_HOME: home,
      NIGHTSHIFT_PR_POLLER: pollerFile,
      NIGHTSHIFT_PR_NOW_FILE: clock,
      NIGHTSHIFT_PR_SUPERVISOR_TICK_MS: '15',
      NIGHTSHIFT_TEST_PROBE_LOG: log,
      NIGHTSHIFT_TEST_PROBE_CALLS: probeCalls,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });

  try {
    assert.ok(await waitFor(async () => (await get(port, '/whoami')) === 200), `server starts: ${stderr}`);
    const statusFile = path.join(home, 'poller-status', `${registration.logKey}.json`);
    assert.ok(await waitFor(() => {
      try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')).status === 'expired'; }
      catch { return false; }
    }), 'retention still records one durable expired status');

    const cachedReads = await waitUntilStable(probeCalls);
    await sleep(120);
    assert.equal(readCount(probeCalls), cachedReads,
      'an unchanged expired tape is not reopened on later supervisor ticks');

    fs.appendFileSync(log, `${JSON.stringify({ t: 2, source: 'hook', type: 'note', text: 'late append' })}\n`);
    assert.ok(await waitFor(() => readCount(probeCalls) > cachedReads),
      `a tape size/mtime change reactivates one full scan (before=${cachedReads}, after=${readCount(probeCalls)}, exit=${child.exitCode}, signal=${child.signalCode}, stderr=${stderr})`);
    const readsAfterAppend = await waitUntilStable(probeCalls);

    await sleep(5);
    register(home, log, cwd, sessionId);
    assert.ok(await waitFor(() => readCount(probeCalls) > readsAfterAppend),
      'refreshing a registration reactivates one full scan even when the tape is unchanged');
    const readsAfterRefresh = await waitUntilStable(probeCalls);
    await sleep(120);
    assert.equal(readCount(probeCalls), readsAfterRefresh,
      'the refreshed expired registration becomes cached again after revalidation');
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM');
    await waitFor(() => child.exitCode != null || child.signalCode != null, { tries: 100, gap: 20 });
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unchanged empty registered tape also enters the expired scan cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-empty-cache-'));
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'repo');
  const log = path.join(cwd, 'empty.jsonl');
  const clock = path.join(dir, 'clock');
  const probeCalls = path.join(dir, 'probe-calls');
  const preload = path.join(dir, 'read-probe.cjs');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(log, '');
  fs.writeFileSync(clock, String(200_000_000));
  fs.writeFileSync(preload, `
const fs = require('node:fs');
const path = require('node:path');
const original = fs.readFileSync;
const target = fs.realpathSync.native(process.env.NIGHTSHIFT_TEST_PROBE_LOG);
fs.readFileSync = function (file, ...args) {
  const resolved = path.resolve(String(file));
  if (resolved === target) fs.appendFileSync(process.env.NIGHTSHIFT_TEST_PROBE_CALLS, 'read\\n');
  return original.call(this, file, ...args);
};
`);
  const registration = register(home, log, cwd, 'empty-session');
  const port = await freePort();
  const child = spawn(node, [serverFile, '--port', String(port), '--log', log], {
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preload}`.trim(),
      NIGHTSHIFT_HOME: home,
      NIGHTSHIFT_PR_POLLER: pollerFile,
      NIGHTSHIFT_PR_NOW_FILE: clock,
      NIGHTSHIFT_PR_SUPERVISOR_TICK_MS: '15',
      NIGHTSHIFT_TEST_PROBE_LOG: log,
      NIGHTSHIFT_TEST_PROBE_CALLS: probeCalls,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });

  try {
    assert.ok(await waitFor(async () => (await get(port, '/whoami')) === 200), `server starts: ${stderr}`);
    const statusFile = path.join(home, 'poller-status', `${registration.logKey}.json`);
    assert.ok(await waitFor(() => {
      try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')).reason === 'empty_log'; }
      catch { return false; }
    }), 'empty tape records one durable expiry status');
    const cachedReads = await waitUntilStable(probeCalls);
    await sleep(120);
    assert.equal(readCount(probeCalls), cachedReads,
      'an unchanged empty tape is not reopened on later supervisor ticks');
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM');
    await waitFor(() => child.exitCode != null || child.signalCode != null, { tries: 100, gap: 20 });
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
