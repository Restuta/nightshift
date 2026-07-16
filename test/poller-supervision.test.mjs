// Durable PR reconciliation supervisor tests. Hermetic: temp NIGHTSHIFT_HOME,
// fake poller, fake clock, no gh/network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const REGISTRATION = path.join(here, '..', 'tools', 'poller-registration.js');
const SERVER = path.join(here, '..', 'server.js');
const POLL_GITHUB = path.join(here, '..', 'tools', 'poll-github.js');
const NIGHTSHIFT_SKILL = path.join(here, '..', 'skills', 'nightshift', 'SKILL.md');
const node = process.execPath;

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ns-poller-'));
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
  for (let i = 0; i < tries; i++) {
    const value = await fn();
    if (value) return value;
    await sleep(gap);
  }
  return null;
}

function readJsonl(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

const leaseGeneration = record => record && (record.claimGeneration || record.generation);

function append(file, event) { fs.appendFileSync(file, JSON.stringify(event) + '\n'); }

function writeFakePoller(dir) {
  const file = path.join(dir, 'fake-poller.js');
  fs.writeFileSync(file, `
const fs = require('node:fs');
const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const now = () => { try { return Number(fs.readFileSync(process.env.NIGHTSHIFT_PR_NOW_FILE, 'utf8')); } catch { return Date.now(); } };
const record = phase => fs.appendFileSync(process.env.FAKE_POLLER_CALLS, JSON.stringify({ phase, at: now(), log: value('--log'), pid: process.pid }) + '\\n');
if (process.env.NIGHTSHIFT_PR_START_FD) {
  const gate = Buffer.alloc(1);
  if (fs.readSync(Number(process.env.NIGHTSHIFT_PR_START_FD), gate, 0, 1, null) !== 1 || gate[0] !== 103) process.exit(75);
}
record('start');
let fail = false;
try {
  const n = Number(fs.readFileSync(process.env.FAKE_POLLER_FAILURES, 'utf8'));
  if (n > 0) { fs.writeFileSync(process.env.FAKE_POLLER_FAILURES, String(n - 1)); fail = true; }
} catch {}
let timer = setTimeout(() => { record('end'); process.exit(fail ? 7 : 0); }, Number(process.env.FAKE_POLLER_DELAY_MS || 0));
process.on('SIGTERM', () => {
  clearTimeout(timer);
  record('term');
  timer = setTimeout(() => { record('end'); process.exit(143); }, Number(process.env.FAKE_POLLER_TERM_DELAY_MS || 25));
});
`);
  return file;
}

function writeGhStub(dir, modeFile, callsFile) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, 'gh');
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'repo' && args[1] === 'view') {
  const mode = fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim();
  if (mode === 'repo-failure') { process.stderr.write('authentication required for api.github.com\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ nameWithOwner: 'org/repo' }));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
  const mode = fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim();
  if (mode === 'failure') { process.stderr.write('failed to connect to api.github.com\\n'); process.exit(1); }
  if (mode === 'unavailable') { process.stderr.write('GraphQL: Could not resolve to a PullRequest with the number of 1.\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ number: 1, title: 'merged', url: 'https://github.com/org/repo/pull/1', state: 'MERGED', mergedAt: '2026-07-14T00:00:00Z', closedAt: null, createdAt: '2026-07-13T00:00:00Z', baseRefName: null, statusCheckRollup: [], additions: 1, deletions: 0 }));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'list') { process.stdout.write('[]'); process.exit(0); }
process.stderr.write('unexpected gh call: ' + args.join(' ') + '\\n'); process.exit(2);
`);
  fs.chmodSync(file, 0o755);
  const toast = path.join(bin, 'toast');
  fs.writeFileSync(toast, '#!/bin/sh\nexit 2\n');
  fs.chmodSync(toast, 0o755);
  return bin;
}

function starts(file, log = null) {
  return readJsonl(file).filter(event => event.phase === 'start' && (!log || event.log === log));
}

async function startServer({ home, poller, calls, clock, delay = 0, failures, extraEnv = {}, logs = [] }) {
  const port = await freePort();
  const child = spawn(node, [SERVER, '--port', String(port), ...logs.flatMap(log => ['--log', log])], {
    env: {
      ...process.env,
      NIGHTSHIFT_HOME: home,
      NIGHTSHIFT_PR_POLLER: poller,
      NIGHTSHIFT_PR_NOW_FILE: clock,
      NIGHTSHIFT_PR_SUPERVISOR_TICK_MS: '10',
      FAKE_POLLER_CALLS: calls,
      FAKE_POLLER_DELAY_MS: String(delay),
      ...(failures ? { FAKE_POLLER_FAILURES: failures } : {}),
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const up = await waitFor(async () => (await get(port, '/whoami')) === 200);
  if (!up) {
    stopServer(child);
    await exited(child);
    assert.fail(`test board server starts${stderr ? `: ${stderr.trim()}` : ''}`);
  }
  return { child, port };
}

function exited(child) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
}

function stopServer(child) {
  if (!child || child.exitCode != null) return;
  try { child.kill('SIGKILL'); } catch { /* gone */ }
}

async function stopServers(...children) {
  for (const child of children) stopServer(child);
  await Promise.all(children.map(exited));
}

function setupSession(dir, name, events) {
  const cwd = path.join(dir, `${name}-repo`);
  fs.mkdirSync(cwd, { recursive: true });
  const log = path.join(cwd, `${name}.jsonl`);
  fs.writeFileSync(log, events.map(event => JSON.stringify({ cwd, ...event })).join('\n') + '\n');
  return { cwd, log };
}

function register(home, session) {
  return withHome(home, () => require(REGISTRATION).registerSession({
    log: session.log, sessionId: session.sessionId, cwd: session.cwd,
  }));
}

function withHome(home, fn) {
  const before = process.env.NIGHTSHIFT_HOME;
  process.env.NIGHTSHIFT_HOME = home;
  try { return fn(); }
  finally {
    if (before == null) delete process.env.NIGHTSHIFT_HOME;
    else process.env.NIGHTSHIFT_HOME = before;
  }
}

test('registrations are atomic and keyed by canonical log plus session id', () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const repoA = path.join(dir, 'repo-a');
  const repoB = path.join(dir, 'repo-b');
  fs.mkdirSync(repoA); fs.mkdirSync(repoB);
  const logA = path.join(repoA, 'events.jsonl');
  const logB = path.join(repoB, 'events.jsonl');
  fs.writeFileSync(logA, ''); fs.writeFileSync(logB, '');
  const aliasA = path.join(dir, 'events-a.jsonl');
  fs.symlinkSync(logA, aliasA);

  withHome(home, () => {
    const api = require(REGISTRATION);
    const first = api.registerSession({ log: aliasA, sessionId: 'same-session', cwd: repoA });
    const duplicate = api.registerSession({ log: logA, sessionId: 'same-session', cwd: repoA });
    const otherRepo = api.registerSession({ log: logB, sessionId: 'same-session', cwd: repoB });

    assert.equal(first.key, duplicate.key, 'symlink and real path identify one tape/session');
    assert.notEqual(first.key, otherRepo.key, 'same host session id in another repo is distinct');
    assert.equal(first.log, fs.realpathSync(logA));
    assert.equal(api.listRegistrations().length, 2);
    assert.deepEqual(new Set(api.listRegistrations().map(r => r.cwd)),
      new Set([fs.realpathSync(repoA), fs.realpathSync(repoB)]));

    const files = fs.readdirSync(path.join(home, 'poller-sessions'));
    assert.equal(files.filter(f => f.endsWith('.json')).length, 2);
    assert.equal(files.some(f => f.includes('.tmp')), false, 'atomic rename leaves no temporary file');

    assert.equal(api.unregisterSession({ log: aliasA, sessionId: 'same-session' }), true);
    assert.deepEqual(api.listRegistrations().map(r => r.key), [otherRepo.key]);
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('same-log registrations stay session-qualified but share one canonical writer identity', () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const log = path.join(cwd, 'shared.jsonl');
  fs.writeFileSync(log, '');
  withHome(home, () => {
    const api = require(REGISTRATION);
    const first = api.registerSession({ log, sessionId: 'session-a', cwd });
    const second = api.registerSession({ log, sessionId: 'session-b', cwd });
    assert.notEqual(first.key, second.key, 'registrations retain session identity');
    assert.match(first.logKey, /^[a-f0-9]{64}$/);
    assert.equal(first.logKey, second.logKey, 'writer/lease identity is canonical-log scoped');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cancel-and-drain preserves registration when an active writer cannot drain in time', () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const log = path.join(cwd, 'events.jsonl');
  fs.writeFileSync(log, '');

  withHome(home, () => {
    const api = require(REGISTRATION);
    const registration = api.registerSession({ log, sessionId: 'still-running', cwd });
    const lease = api.acquireLease(registration.logKey, { ttlMs: 60_000 });
    assert.ok(lease);

    assert.equal(api.cancelAndDrain({ log, sessionId: 'still-running', timeoutMs: 20 }), false);
    assert.deepEqual(api.listRegistrations().map(value => value.key), [registration.key],
      'a failed drain remains registered so the checked operation can be retried safely');

    assert.equal(api.releaseLease(registration.logKey, lease), true);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('draining one same-log session clears cancellation for the surviving registration', () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const log = path.join(cwd, 'events.jsonl');
  fs.writeFileSync(log, '');

  withHome(home, () => {
    const api = require(REGISTRATION);
    const first = api.registerSession({ log, sessionId: 'session-a', cwd });
    const second = api.registerSession({ log, sessionId: 'session-b', cwd });

    assert.equal(api.cancelAndDrain({ log, sessionId: 'session-a', timeoutMs: 100 }), true);
    assert.deepEqual(api.listRegistrations().map(value => value.key), [second.key]);
    assert.equal(api.readCancellation(first.logKey), null,
      'the remaining session is allowed to resume the canonical-log supervisor');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('exclusive leases reject a live owner and recover dead or expired owners', () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const log = path.join(cwd, 'events.jsonl');
  fs.writeFileSync(log, '');

  withHome(home, () => {
    const api = require(REGISTRATION);
    const registration = api.registerSession({ log, sessionId: 'lease-session', cwd });
    const first = api.acquireLease(registration.key, { now: 1_000, ttlMs: 60_000 });
    assert.ok(first, 'first owner acquires with wx');
    assert.equal(api.acquireLease(registration.key, { now: 1_001, ttlMs: 60_000 }), null,
      'same or another live server cannot become a second writer');

    const leaseDir = path.join(home, 'poller-leases', `${registration.key}.lock`);
    const leaseFile = path.join(leaseDir, 'owner.json');
    const recorded = api.readLease(registration.key);
    assert.equal(recorded.ownerPid, process.pid);
    assert.equal(recorded.log, fs.realpathSync(log));
    assert.equal(recorded.sessionId, 'lease-session');
    assert.equal(recorded.expiresAt, 61_000);

    assert.equal(api.releaseLease(registration.key, first), true);
    fs.mkdirSync(leaseDir);
    fs.writeFileSync(leaseFile, JSON.stringify({
      ownerPid: 999_999_999, generation: 'dead', acquiredAt: 1_000, expiresAt: 999_999,
      log: registration.log, sessionId: registration.sessionId,
    }) + '\n');
    const recoveredDead = api.acquireLease(registration.key, { now: 2_000, ttlMs: 60_000 });
    assert.ok(recoveredDead, 'dead pid is recoverable before nominal expiry');
    api.releaseLease(registration.key, recoveredDead);

    fs.mkdirSync(leaseDir);
    fs.writeFileSync(leaseFile, JSON.stringify({
      ownerPid: process.pid, generation: 'expired', acquiredAt: 1, expiresAt: 2,
      log: registration.log, sessionId: registration.sessionId,
    }) + '\n');
    const recoveredExpired = api.acquireLease(registration.key, { now: 3, ttlMs: 60_000 });
    assert.ok(recoveredExpired, 'expired lease is recoverable even if its pid is live');
    api.releaseLease(registration.key, recoveredExpired);

    fs.mkdirSync(leaseDir);
    fs.writeFileSync(leaseFile, '');
    assert.equal(api.acquireLease(registration.key, { now: 4, ttlMs: 60_000 }), null,
      'a rival never unlinks a lease record while its wx owner may still be writing it');
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('an ownerless lease directory fails closed briefly, then is recoverable', () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const log = path.join(cwd, 'events.jsonl');
  fs.writeFileSync(log, '');

  withHome(home, () => {
    const api = require(REGISTRATION);
    const registration = api.registerSession({ log, sessionId: 'ownerless', cwd });
    const leaseDir = path.join(home, 'poller-leases', `${registration.logKey}.lock`);
    fs.mkdirSync(leaseDir, { recursive: true });
    const createdAt = fs.statSync(leaseDir).mtimeMs;

    assert.equal(api.acquireLease(registration.logKey, { now: createdAt + 500, ttlMs: 1_000 }), null,
      'a contender does not erase a mkdir winner that may still create owner.json');
    const realRename = fs.renameSync;
    let sawQuarantine = false;
    fs.renameSync = function inspectIncompleteQuarantine(source, destination) {
      if (source === leaseDir && String(destination).includes('.stale.')) {
        sawQuarantine = true;
        assert.equal(fs.existsSync(path.join(source, '.quarantined')), true,
          'the atomic rename cannot leave an empty destination vulnerable to a delayed contender');
      }
      return realRename.call(fs, source, destination);
    };
    let recovered;
    try {
      recovered = api.acquireLease(registration.logKey, { now: createdAt + 1_001, ttlMs: 1_000 });
    } finally {
      fs.renameSync = realRename;
    }
    assert.ok(recovered, 'an abandoned ownerless directory does not block supervision forever');
    assert.equal(sawQuarantine, true);
    assert.equal(api.releaseLease(registration.logKey, recovered), true);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('failed owner initialization never removes a successor that acquired the authoritative path', async () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const log = path.join(cwd, 'events.jsonl');
  fs.writeFileSync(log, '');
  const api = require(REGISTRATION);
  const registration = withHome(home, () => api.registerSession({ log, sessionId: 'owner-init-race', cwd }));
  const leaseDir = path.join(home, 'poller-leases', `${registration.logKey}.lock`);
  const ownerFile = path.join(leaseDir, 'owner.json');
  const displaced = `${leaseDir}.interrupted`;
  const ready = path.join(dir, 'successor.json');
  const realOpen = fs.openSync;
  let successorChild = null;
  let intercepted = false;

  fs.openSync = function interruptOwnerWrite(file, ...args) {
    if (!intercepted && file === ownerFile) {
      intercepted = true;
      fs.renameSync(leaseDir, displaced);
      const script = `
const fs = require('node:fs');
const api = require(${JSON.stringify(REGISTRATION)});
const lease = api.acquireLease(${JSON.stringify(registration.logKey)}, { ttlMs: 10_000 });
if (!lease) process.exit(3);
fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ generation: lease.generation }));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
`;
      successorChild = spawn(node, ['-e', script], {
        env: { ...process.env, NIGHTSHIFT_HOME: home }, stdio: 'ignore',
      });
      const deadline = Date.now() + 1_000;
      while (!fs.existsSync(ready) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      assert.ok(fs.existsSync(ready), 'successor acquires after the interrupted mkdir owner is displaced');
      const error = new Error('injected owner write interruption');
      error.code = 'ENOENT';
      throw error;
    }
    return realOpen.call(fs, file, ...args);
  };

  try {
    assert.throws(() => withHome(home, () => api.acquireLease(registration.logKey)), /injected owner write/);
    const expected = JSON.parse(fs.readFileSync(ready, 'utf8')).generation;
    assert.equal(leaseGeneration(withHome(home, () => api.readLease(registration.logKey))), expected,
      'cleanup for the interrupted creator cannot recursively delete a successor');
  } finally {
    fs.openSync = realOpen;
    if (successorChild) {
      try { successorChild.kill('SIGKILL'); } catch { /* gone */ }
      await exited(successorChild);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a lease generation binds and renews the actual writer before it can append', () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const log = path.join(cwd, 'events.jsonl');
  fs.writeFileSync(log, '');
  withHome(home, () => {
    const api = require(REGISTRATION);
    const registration = api.registerSession({ log, sessionId: 'lease-generation', cwd });
    const lease = api.acquireLease(registration.logKey, { now: 1_000, ttlMs: 100 });
    assert.match(lease.generation, /^[a-f0-9-]{20,}$/);
    assert.equal(api.bindLease(lease, { writerPid: process.pid, now: 1_010, ttlMs: 100 }), true);
    assert.equal(api.renewLease(lease, { now: 1_080, ttlMs: 100 }), true);
    assert.equal(api.isLeaseCurrent(lease, { now: 1_081 }), true);
    const record = api.readLease(registration.logKey);
    assert.equal(record.writerPid, process.pid);
    assert.equal(leaseGeneration(record), lease.generation);
    assert.equal(record.expiresAt, 1_180);
    assert.equal(api.releaseLease(registration.logKey, lease), true);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('concurrent stale recovery elects exactly one new lease generation', async () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const log = path.join(cwd, 'events.jsonl');
  fs.writeFileSync(log, '');
  const registration = withHome(home, () => require(REGISTRATION).registerSession({ log, sessionId: 'stale-race', cwd }));
  const stale = withHome(home, () => require(REGISTRATION).acquireLease(registration.logKey, { now: 1, ttlMs: 1 }));
  assert.ok(stale);
  const gate = path.join(dir, 'go');
  const out = path.join(dir, 'owners.jsonl');
  const script = `
const fs = require('node:fs');
const api = require(${JSON.stringify(REGISTRATION)});
while (!fs.existsSync(${JSON.stringify(gate)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
const lease = api.acquireLease(${JSON.stringify(registration.logKey)}, { now: 10, ttlMs: 1000 });
if (lease) { fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify({ pid: process.pid, generation: lease.generation }) + '\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
`;
  const children = [0, 1].map(() => spawn(node, ['-e', script], { env: { ...process.env, NIGHTSHIFT_HOME: home }, stdio: 'ignore' }));
  fs.writeFileSync(gate, 'go');
  await Promise.all(children.map(exited));
  const owners = readJsonl(out);
  assert.equal(owners.length, 1, 'rename-and-generation recovery admits one contender');
  assert.notEqual(owners[0].generation, stale.generation);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a delayed stale contender cannot displace the live successor generation (ABA)', async () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const log = path.join(cwd, 'events.jsonl');
  fs.writeFileSync(log, '');
  const api = require(REGISTRATION);
  const registration = withHome(home, () => api.registerSession({ log, sessionId: 'aba-race', cwd }));
  const stale = withHome(home, () => api.acquireLease(registration.logKey, { now: 1, ttlMs: 1 }));
  assert.ok(stale);

  const leaseDir = path.join(home, 'poller-leases', `${registration.logKey}.lock`);
  const ready = path.join(dir, 'successor.json');
  const realRename = fs.renameSync;
  let successorChild = null;
  let delayed = null;
  let intercepted = false;
  fs.renameSync = function interceptStaleRename(source, destination) {
    if (!intercepted && source === leaseDir && String(destination).includes('.stale.')) {
      intercepted = true;
      const script = `
const fs = require('node:fs');
const api = require(${JSON.stringify(REGISTRATION)});
const lease = api.acquireLease(${JSON.stringify(registration.logKey)}, { now: 10, ttlMs: 10_000 });
if (!lease) process.exit(3);
fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ generation: lease.generation }));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
`;
      successorChild = spawn(node, ['-e', script], {
        env: { ...process.env, NIGHTSHIFT_HOME: home }, stdio: 'ignore',
      });
      const deadline = Date.now() + 1_000;
      while (!fs.existsSync(ready) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      assert.ok(fs.existsSync(ready), 'successor acquires while the first contender is paused');
    }
    return realRename.call(fs, source, destination);
  };

  try {
    delayed = withHome(home, () => api.acquireLease(registration.logKey, { now: 10, ttlMs: 10_000 }));
    assert.equal(delayed, null, 'the contender that observed the old generation loses after a successor wins');
    const expected = JSON.parse(fs.readFileSync(ready, 'utf8')).generation;
    assert.equal(leaseGeneration(withHome(home, () => api.readLease(registration.logKey))), expected,
      'the live successor remains at the authoritative lease path');
  } finally {
    fs.renameSync = realRename;
    if (delayed) withHome(home, () => api.releaseLease(registration.logKey, delayed));
    if (successorChild) {
      try { successorChild.kill('SIGKILL'); } catch { /* gone */ }
      await exited(successorChild);
    }
    try { fs.closeSync(stale._fd); } catch { /* displaced descriptor */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a delayed release cannot rename and delete a successor acquired after validation', async () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const log = path.join(cwd, 'events.jsonl');
  fs.writeFileSync(log, '');
  const api = require(REGISTRATION);
  const registration = withHome(home, () => api.registerSession({ log, sessionId: 'release-aba', cwd }));
  const stale = withHome(home, () => api.acquireLease(registration.logKey, { now: 1, ttlMs: 1 }));
  assert.ok(stale);

  const ownerFile = path.join(home, 'poller-leases', `${registration.logKey}.lock`, 'owner.json');
  const ready = path.join(dir, 'successor.json');
  const check = path.join(dir, 'check');
  const resultFile = path.join(dir, 'successor-current.json');
  const realRead = fs.readFileSync;
  let successorChild = null;
  let intercepted = false;
  fs.readFileSync = function pauseAfterReleaseRead(file, ...args) {
    const value = realRead.call(fs, file, ...args);
    if (!intercepted && file === ownerFile) {
      intercepted = true;
      const script = `
const fs = require('node:fs');
const api = require(${JSON.stringify(REGISTRATION)});
const lease = api.acquireLease(${JSON.stringify(registration.logKey)}, { now: 10, ttlMs: 10_000 });
if (!lease) process.exit(3);
fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ generation: lease.generation }));
while (!fs.existsSync(${JSON.stringify(check)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ current: api.isLeaseCurrent(lease, { allowExpired: true }) }));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
`;
      successorChild = spawn(node, ['-e', script], {
        env: { ...process.env, NIGHTSHIFT_HOME: home }, stdio: 'ignore',
      });
      const deadline = Date.now() + 1_000;
      while (!fs.existsSync(ready) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      assert.ok(fs.existsSync(ready), 'successor acquires after release validation reads the old generation');
    }
    return value;
  };

  try {
    const released = withHome(home, () => api.releaseLease(registration.logKey, stale));
    fs.writeFileSync(check, 'check');
    assert.ok(await waitFor(() => fs.existsSync(resultFile)));
    const successor = JSON.parse(fs.readFileSync(ready, 'utf8'));
    const successorCurrent = JSON.parse(fs.readFileSync(resultFile, 'utf8')).current;
    const current = withHome(home, () => api.readLease(registration.logKey));
    assert.deepEqual({ released, current: leaseGeneration(current), successorCurrent }, {
      released: false,
      current: successor.generation,
      successorCurrent: true,
    });
  } finally {
    fs.readFileSync = realRead;
    if (successorChild) {
      try { successorChild.kill('SIGKILL'); } catch { /* gone */ }
      await exited(successorChild);
    }
    if (stale._fd != null) try { fs.closeSync(stale._fd); } catch { /* displaced */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a takeover validated before the release guard shares one generation retirement tombstone', () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const log = path.join(cwd, 'events.jsonl');
  fs.writeFileSync(log, '');
  const api = require(REGISTRATION);
  const registration = withHome(home, () => api.registerSession({ log, sessionId: 'inverse-release-aba', cwd }));
  const stale = withHome(home, () => api.acquireLease(registration.logKey, { now: 1, ttlMs: 1 }));
  assert.ok(stale);

  const leaseDir = path.join(home, 'poller-leases', `${registration.logKey}.lock`);
  const realRename = fs.renameSync;
  let takeoverDestination = null;
  let releaseResult = null;
  let successor = null;
  let contender = null;
  let inRelease = false;
  let intercepted = false;
  fs.renameSync = function interleaveTakeoverAndRelease(source, destination) {
    if (source === leaseDir && !inRelease && !intercepted && String(destination).includes('.stale.')) {
      // The contender has already validated the expired generation. Pause its
      // rename, let release install its guard, then resume takeover immediately
      // before release's own rename.
      intercepted = true;
      takeoverDestination = destination;
      inRelease = true;
      try { releaseResult = api.releaseLease(registration.logKey, stale); }
      finally { inRelease = false; }
      // The nested release interleaving performed this contender's rename.
      return;
    }
    if (source === leaseDir && inRelease) {
      realRename.call(fs, source, takeoverDestination);
      successor = api.acquireLease(registration.logKey, { now: 10, ttlMs: 10_000 });
      assert.ok(successor, 'takeover publishes its successor before delayed release resumes');
      return realRename.call(fs, source, destination);
    }
    return realRename.call(fs, source, destination);
  };

  try {
    contender = withHome(home, () => api.acquireLease(registration.logKey, { now: 10, ttlMs: 10_000 }));
    const current = withHome(home, () => api.readLease(registration.logKey));
    const valid = [successor, contender].filter(lease => lease &&
      withHome(home, () => api.isLeaseCurrent(lease, { allowExpired: true })));
    assert.equal(releaseResult, false, 'release loses once takeover retired their shared generation');
    assert.equal(contender, null, 'the paused contender observes the successor published by its own takeover');
    assert.equal(leaseGeneration(current), successor?.generation, 'release cannot remove the takeover successor');
    assert.deepEqual(valid.map(lease => lease.generation), [successor.generation],
      'exactly one generation remains a valid writer after the inverse ordering');
  } finally {
    fs.renameSync = realRename;
    if (contender) withHome(home, () => api.releaseLease(registration.logKey, contender));
    if (successor && withHome(home, () => api.isLeaseCurrent(successor, { allowExpired: true }))) {
      withHome(home, () => api.releaseLease(registration.logKey, successor));
    }
    if (stale._fd != null) try { fs.closeSync(stale._fd); } catch { /* retired */ }
    if (successor?._fd != null) try { fs.closeSync(successor._fd); } catch { /* retired */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two session registrations for one tape schedule exactly one child', async () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const calls = path.join(dir, 'calls.jsonl');
  const clock = path.join(dir, 'clock');
  fs.writeFileSync(clock, '1001');
  const poller = writeFakePoller(dir);
  const session = setupSession(dir, 'shared-log', [
    { t: 1000, source: 'hook', type: 'session', phase: 'start' },
    { t: 1001, source: 'hook', type: 'pr_ref', repo: 'org/shared', number: 1 },
  ]);
  register(home, { ...session, sessionId: 'session-one' });
  register(home, { ...session, sessionId: 'session-two' });
  const server = await startServer({ home, poller, calls, clock, delay: 100 });
  try {
    assert.ok(await waitFor(() => starts(calls, fs.realpathSync(session.log)).length >= 1));
    await sleep(180);
    assert.equal(starts(calls, fs.realpathSync(session.log)).length, 1);
  } finally {
    await stopServers(server.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startup reconciliation is durable without viewers and two servers still launch one writer', async () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const calls = path.join(dir, 'calls.jsonl');
  const clock = path.join(dir, 'clock');
  fs.writeFileSync(clock, '1001');
  const poller = writeFakePoller(dir);
  const session = setupSession(dir, 'owned', [
    { t: 1000, source: 'hook', type: 'session', phase: 'start' },
    { t: 1001, source: 'hook', type: 'pr_ref', repo: 'org/owned', number: 1,
      url: 'https://github.com/org/owned/pull/1' },
  ]);
  session.sessionId = 'owned-session';
  register(home, session);

  const first = await startServer({ home, poller, calls, clock, delay: 120 });
  const second = await startServer({ home, poller, calls, clock, delay: 120 });
  try {
    assert.ok(await waitFor(() => starts(calls, fs.realpathSync(session.log)).length === 1),
      'durable registration is reconciled at startup with zero SSE clients');
    await sleep(250);
    assert.equal(starts(calls, fs.realpathSync(session.log)).length, 1,
      'wx lease plus durable success prevents a rival server from polling again');
    const statuses = readJsonl(session.log).filter(event => event.type === 'poller_status');
    assert.equal(statuses.at(-1)?.status, 'success');
  } finally {
    await stopServers(first.child, second.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a long poll renews its log lease so another server cannot take over at nominal expiry', async () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const calls = path.join(dir, 'calls.jsonl');
  const clock = path.join(dir, 'clock');
  fs.writeFileSync(clock, '1001');
  const poller = writeFakePoller(dir);
  const session = setupSession(dir, 'long-poll', [
    { t: 1000, source: 'hook', type: 'session', phase: 'start' },
    { t: 1001, source: 'hook', type: 'pr_ref', repo: 'org/long', number: 1 },
  ]);
  session.sessionId = 'long-poll-session'; register(home, session);
  const env = { NIGHTSHIFT_PR_LEASE_MS: '60' };
  const first = await startServer({ home, poller, calls, clock, delay: 260, extraEnv: env });
  const second = await startServer({ home, poller, calls, clock, delay: 260, extraEnv: env });
  try {
    assert.ok(await waitFor(() => starts(calls).length === 1));
    fs.writeFileSync(clock, '1000000');
    await sleep(140);
    assert.equal(starts(calls).length, 1, 'renewal fences a live writer beyond the original expiry');
  } finally {
    await stopServers(first.child, second.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a superseded writer generation cannot append completion status', async () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const calls = path.join(dir, 'calls.jsonl');
  const clock = path.join(dir, 'clock');
  fs.writeFileSync(clock, '1001');
  const poller = writeFakePoller(dir);
  const session = setupSession(dir, 'fenced-status', [
    { t: 1000, source: 'hook', type: 'session', phase: 'start' },
    { t: 1001, source: 'hook', type: 'pr_ref', repo: 'org/fence', number: 1 },
  ]);
  session.sessionId = 'fenced-session';
  const registration = register(home, session);
  const server = await startServer({ home, poller, calls, clock, delay: 120,
    extraEnv: { NIGHTSHIFT_PR_LEASE_MS: '1000' } });
  let successor = null;
  let displaced = null;
  try {
    assert.ok(await waitFor(() => starts(calls).length === 1));
    // Simulate an externally installed successor generation. Normal recovery
    // deliberately refuses to replace a live bound writer, even after nominal
    // expiry; this test isolates the old writer's final revalidation behavior.
    const leaseDir = path.join(home, 'poller-leases', `${registration.logKey}.lock`);
    displaced = `${leaseDir}.displaced`;
    fs.renameSync(leaseDir, displaced);
    successor = withHome(home, () => require(REGISTRATION).acquireLease(registration.logKey,
      { ttlMs: 10_000 }));
    assert.ok(successor, 'test supersedes the in-flight generation');
    await sleep(180);
    assert.equal(readJsonl(session.log).filter(event => event.type === 'poller_status').length, 0,
      'lost generation is revalidated before any success/error append');
  } finally {
    if (successor) withHome(home, () => require(REGISTRATION).releaseLease(registration.logKey, successor));
    if (displaced) fs.rmSync(displaced, { recursive: true, force: true });
    await stopServers(server.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('after abrupt supervisor death, its bound writer fences replacement until the child exits', async () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const calls = path.join(dir, 'calls.jsonl');
  const clock = path.join(dir, 'clock');
  fs.writeFileSync(clock, '1001');
  const poller = writeFakePoller(dir);
  const session = setupSession(dir, 'orphan-writer', [
    { t: 1000, source: 'hook', type: 'session', phase: 'start' },
    { t: 1001, source: 'hook', type: 'pr_ref', repo: 'org/orphan', number: 1 },
  ]);
  session.sessionId = 'orphan-session'; register(home, session);
  const first = await startServer({ home, poller, calls, clock, delay: 260, extraEnv: { NIGHTSHIFT_PR_LEASE_MS: '60' } });
  assert.ok(await waitFor(() => starts(calls).length === 1));
  first.child.kill('SIGKILL'); await exited(first.child);
  const second = await startServer({ home, poller, calls, clock, delay: 10, extraEnv: { NIGHTSHIFT_PR_LEASE_MS: '60' } });
  try {
    await sleep(100);
    assert.equal(starts(calls).length, 1, 'dead supervisor alone does not invalidate its live writer binding');
    assert.ok(await waitFor(() => starts(calls).length === 2), 'replacement begins after the orphan writer exits');
  } finally {
    await stopServers(second.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('graceful supervisor shutdown terminates and awaits every active child', async () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const calls = path.join(dir, 'calls.jsonl');
  const clock = path.join(dir, 'clock');
  fs.writeFileSync(clock, '1001');
  const poller = writeFakePoller(dir);
  const session = setupSession(dir, 'shutdown', [
    { t: 1000, source: 'hook', type: 'session', phase: 'start' },
    { t: 1001, source: 'hook', type: 'pr_ref', repo: 'org/shutdown', number: 1 },
  ]);
  session.sessionId = 'shutdown-session'; register(home, session);
  const server = await startServer({ home, poller, calls, clock, delay: 10_000,
    extraEnv: { FAKE_POLLER_TERM_DELAY_MS: '75' } });
  assert.ok(await waitFor(() => starts(calls).length === 1));
  server.child.kill('SIGTERM');
  await exited(server.child);
  const phases = readJsonl(calls).map(event => event.phase);
  assert.deepEqual(phases.slice(-2), ['term', 'end'], 'server exits only after the child termination completes');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('global durable slots cap two writers across rival server processes', async () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const calls = path.join(dir, 'calls.jsonl');
  const clock = path.join(dir, 'clock');
  fs.writeFileSync(clock, '1001');
  const poller = writeFakePoller(dir);
  for (let i = 0; i < 4; i++) {
    const session = setupSession(dir, `global-${i}`, [
      { t: 1000, source: 'hook', type: 'session', phase: 'start' },
      { t: 1001, source: 'hook', type: 'pr_ref', repo: `org/global-${i}`, number: 1 },
    ]);
    session.sessionId = `global-session-${i}`; register(home, session);
  }
  const first = await startServer({ home, poller, calls, clock, delay: 600 });
  const second = await startServer({ home, poller, calls, clock, delay: 600 });
  try {
    assert.ok(await waitFor(() => starts(calls).length >= 2));
    await sleep(50);
    assert.equal(starts(calls).length, 2, 'durable semaphore is global, not per server process');
    assert.ok(await waitFor(() => starts(calls).length === 4));
  } finally {
    await stopServers(first.child, second.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduler honors fresh, idle, and stale cadence and caps concurrency at two', async () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const calls = path.join(dir, 'calls.jsonl');
  const clock = path.join(dir, 'clock');
  fs.writeFileSync(clock, '1001');
  const poller = writeFakePoller(dir);
  const fresh = setupSession(dir, 'fresh', [
    { t: 1000, source: 'hook', type: 'session', phase: 'start' },
    { t: 1001, source: 'hook', type: 'pr_ref', repo: 'org/fresh', number: 1 },
  ]);
  const idle = setupSession(dir, 'idle', [
    { t: 1000, source: 'hook', type: 'session', phase: 'idle' },
    { t: 1001, source: 'hook', type: 'pr_ref', repo: 'org/idle', number: 1 },
  ]);
  const stale = setupSession(dir, 'stale', [
    { t: 1000, source: 'hook', type: 'session', phase: 'end' },
    { t: 1001, source: 'hook', type: 'pr_ref', repo: 'org/stale', number: 1 },
  ]);
  for (const [i, session] of [fresh, idle, stale].entries()) {
    session.sessionId = `cadence-${i}`;
    register(home, session);
  }

  const server = await startServer({ home, poller, calls, clock, delay: 100 });
  try {
    assert.ok(await waitFor(() => starts(calls).length === 2), 'only two pollers start concurrently');
    await sleep(30);
    assert.equal(starts(calls).length, 2, 'third waits while both slots are occupied');
    assert.ok(await waitFor(() => starts(calls).length === 3), 'queued session runs after a slot frees');
    assert.ok(await waitFor(() => [fresh, idle, stale].every(s =>
      readJsonl(s.log).some(event => event.type === 'poller_status' && event.status === 'success'))));

    fs.writeFileSync(clock, String(1001 + 15_000 - 1));
    await sleep(40);
    assert.equal(starts(calls, fs.realpathSync(fresh.log)).length, 1);
    fs.writeFileSync(clock, String(1001 + 15_000));
    assert.ok(await waitFor(() => starts(calls, fs.realpathSync(fresh.log)).length === 2), 'fresh = 15s');

    fs.writeFileSync(clock, String(1001 + 60_000 - 1));
    await sleep(40);
    assert.equal(starts(calls, fs.realpathSync(idle.log)).length, 1);
    fs.writeFileSync(clock, String(1001 + 60_000));
    assert.ok(await waitFor(() => starts(calls, fs.realpathSync(idle.log)).length === 2), 'idle/attention = 60s');

    fs.writeFileSync(clock, String(1001 + 300_000 - 1));
    await sleep(40);
    assert.equal(starts(calls, fs.realpathSync(stale.log)).length, 1);
    fs.writeFileSync(clock, String(1001 + 300_000));
    assert.ok(await waitFor(() => starts(calls, fs.realpathSync(stale.log)).length === 2), 'stale = 5m');
  } finally {
    await stopServers(server.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('new pr_ref is immediately due, terminal sets stop, and retention expiry is diagnosed', async () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const calls = path.join(dir, 'calls.jsonl');
  const clock = path.join(dir, 'clock');
  fs.writeFileSync(clock, '1001');
  const poller = writeFakePoller(dir);
  const active = setupSession(dir, 'immediate', [
    { t: 1000, source: 'hook', type: 'session', phase: 'start' },
    { t: 1001, source: 'hook', type: 'pr_ref', repo: 'org/immediate', number: 1 },
  ]);
  active.sessionId = 'immediate-session'; register(home, active);
  const expired = setupSession(dir, 'expired', [
    { t: -10, source: 'hook', type: 'session', phase: 'end' },
    { t: -1, source: 'hook', type: 'pr_ref', repo: 'org/expired', number: 9 },
  ]);
  expired.sessionId = 'expired-session'; register(home, expired);

  const server = await startServer({ home, poller, calls, clock, extraEnv: { NIGHTSHIFT_PR_RETENTION_MS: '1000' } });
  try {
    assert.ok(await waitFor(() => starts(calls, fs.realpathSync(active.log)).length === 1));
    fs.writeFileSync(clock, '1100');
    append(active.log, { t: 1100, source: 'hook', type: 'pr_ref', repo: 'org/immediate', number: 2 });
    assert.ok(await waitFor(() => starts(calls, fs.realpathSync(active.log)).length >= 2),
      'a newly appended PR sighting bypasses the cadence deadline');

    append(active.log, { t: 1101, source: 'poll-github', type: 'pr', repo: 'org/immediate', number: 1, state: 'merged' });
    append(active.log, { t: 1102, source: 'poll-github', type: 'pr', repo: 'org/immediate', number: 2, state: 'closed' });
    fs.writeFileSync(clock, '1000000');
    await sleep(80);
    assert.equal(starts(calls, fs.realpathSync(active.log)).length, 2, 'all-terminal PRs stop reconciliation');

    assert.ok(await waitFor(() => readJsonl(expired.log).some(event =>
      event.type === 'poller_status' && event.status === 'expired')),
    'retention expiry is append-only diagnostic state');
    assert.equal(starts(calls, fs.realpathSync(expired.log)).length, 0, 'expired session is never polled');
  } finally {
    await stopServers(server.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an appended recovered ref schedules one recheck by recordedAt even when its observation predates terminal', async () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const calls = path.join(dir, 'calls.jsonl');
  const clock = path.join(dir, 'clock');
  fs.writeFileSync(clock, '1000');
  const poller = writeFakePoller(dir);
  const session = setupSession(dir, 'recovered-ref', [
    { t: 100, source: 'hook', type: 'session', phase: 'end' },
    { t: 110, id: 'ref-old', source: 'hook', type: 'pr_ref', repo: 'org/recovered', number: 1 },
    { t: 120, source: 'poll-github', type: 'pr', repo: 'org/recovered', number: 1, state: 'merged' },
    { t: 130, source: 'server', type: 'poller_status', status: 'success',
      refFingerprint: '1:org/recovered#1:110:ref-old', failures: 0 },
  ]);
  append(session.log, {
    t: 90, id: 'ref-recovered-new', source: 'recovery', type: 'pr_ref', repo: 'org/recovered', number: 1,
    recordedAt: 1000, recovery: 'transcript',
  });
  session.sessionId = 'recovered-ref-session'; register(home, session);
  const server = await startServer({ home, poller, calls, clock });
  try {
    assert.ok(await waitFor(() => starts(calls, fs.realpathSync(session.log)).length === 1),
      'append order and recordedAt make the recovered sighting immediately actionable for an ended session');
    await sleep(100);
    assert.equal(starts(calls, fs.realpathSync(session.log)).length, 1,
      'the success fingerprint acknowledges that recovered sighting exactly once');
    const status = withHome(home, () => require(REGISTRATION).readStatus(require(REGISTRATION).logKey(session.log)));
    assert.match(status.refFingerprint, /ref-recovered-new/,
      'the scheduler fingerprint follows append observation order rather than historical t sorting');
  } finally {
    await stopServers(server.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing and empty registrations stay untouched while one durable expiry diagnostic is deduped', async () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const calls = path.join(dir, 'calls.jsonl');
  const clock = path.join(dir, 'clock');
  fs.writeFileSync(clock, '1000');
  const poller = writeFakePoller(dir);
  const cwd = path.join(dir, 'repo'); fs.mkdirSync(cwd);
  const missing = { cwd, log: path.join(cwd, 'missing.jsonl'), sessionId: 'missing-session' };
  const empty = { cwd, log: path.join(cwd, 'empty.jsonl'), sessionId: 'empty-session' };
  fs.writeFileSync(empty.log, '');
  register(home, missing); register(home, empty);
  const server = await startServer({ home, poller, calls, clock });
  try {
    const statusDir = path.join(home, 'poller-status');
    assert.ok(await waitFor(() => {
      try { return fs.readdirSync(statusDir).filter(file => file.endsWith('.json')).length === 2; } catch { return false; }
    }));
    await sleep(80);
    assert.equal(fs.existsSync(missing.log), false, 'missing registered tape is never recreated for a diagnostic');
    assert.equal(fs.statSync(empty.log).size, 0, 'empty registered tape remains empty');
    const statuses = fs.readdirSync(statusDir).filter(file => file.endsWith('.json'))
      .map(file => JSON.parse(fs.readFileSync(path.join(statusDir, file), 'utf8')));
    assert.equal(statuses.length, 2, 'one durable sidecar per canonical log');
    assert.ok(statuses.every(status => status.status === 'expired'));
    assert.ok(statuses.every(status => status.occurrences === 1), 'repeated scheduler ticks dedupe expiry');
    assert.equal(starts(calls).length, 0);
  } finally {
    await stopServers(server.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checked unregister cancels and drains the writer before reporting success', async () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const calls = path.join(dir, 'calls.jsonl');
  const clock = path.join(dir, 'clock');
  fs.writeFileSync(clock, '1001');
  const poller = writeFakePoller(dir);
  const session = setupSession(dir, 'drain', [
    { t: 1000, source: 'hook', type: 'session', phase: 'start' },
    { t: 1001, source: 'hook', type: 'pr_ref', repo: 'org/drain', number: 1 },
  ]);
  session.sessionId = 'drain-session'; register(home, session);
  const server = await startServer({ home, poller, calls, clock, delay: 10_000,
    extraEnv: { FAKE_POLLER_TERM_DELAY_MS: '60' } });
  try {
    assert.ok(await waitFor(() => starts(calls).length === 1));
    const unregister = spawn(node, [REGISTRATION, 'unregister', '--log', session.log,
      '--session', session.sessionId, '--drain', '--timeout', '2000'], {
      env: { ...process.env, NIGHTSHIFT_HOME: home }, stdio: 'ignore',
    });
    const result = await exited(unregister);
    assert.equal(result.code, 0);
    assert.deepEqual(readJsonl(calls).slice(-2).map(event => event.phase), ['term', 'end'],
      'unregister does not return until the child acknowledges termination');
    assert.equal(withHome(home, () => require(REGISTRATION).listRegistrations()).length, 0);
    assert.equal(withHome(home, () => require(REGISTRATION).readLease(
      require(REGISTRATION).logKey(session.log))), null);
  } finally {
    await stopServers(server.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an un-ended session polls while its producer is fresh, then rests unless a PR is nonterminal', async () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const calls = path.join(dir, 'calls.jsonl');
  const clock = path.join(dir, 'clock');
  fs.writeFileSync(clock, '1000');
  const poller = writeFakePoller(dir);
  const session = setupSession(dir, 'freshness', [
    { t: 1000, source: 'hook', type: 'session', phase: 'start' },
  ]);
  session.sessionId = 'freshness-session'; register(home, session);
  const server = await startServer({ home, poller, calls, clock });
  try {
    assert.ok(await waitFor(() => starts(calls, fs.realpathSync(session.log)).length === 1),
      'fresh producer activity is eligible even before a structured PR sighting');
    fs.writeFileSync(clock, String(1000 + 300_001));
    await sleep(80);
    assert.equal(starts(calls, fs.realpathSync(session.log)).length, 1,
      'latched working without a fresh producer does not poll for the full retention window');

    append(session.log, { t: 1000 + 300_001, source: 'hook', type: 'pr_ref', repo: 'org/freshness', number: 1 });
    assert.ok(await waitFor(() => starts(calls, fs.realpathSync(session.log)).length === 2),
      'a discovered nonterminal PR remains eligible even after producer freshness lapses');
    assert.ok(await waitFor(() => readJsonl(session.log).filter(event =>
      event.type === 'poller_status' && event.status === 'success').length === 2),
      'the second one-shot writer exits before test cleanup');
  } finally {
    await stopServers(server.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('poll failures back off exponentially and cap at five minutes', async () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const calls = path.join(dir, 'calls.jsonl');
  const failures = path.join(dir, 'failures');
  const clock = path.join(dir, 'clock');
  fs.writeFileSync(clock, '1001'); fs.writeFileSync(failures, '6');
  const poller = writeFakePoller(dir);
  const session = setupSession(dir, 'backoff', [
    { t: 1000, source: 'hook', type: 'session', phase: 'start' },
    { t: 1001, source: 'hook', type: 'pr_ref', repo: 'org/backoff', number: 1 },
  ]);
  session.sessionId = 'backoff-session'; register(home, session);
  const server = await startServer({ home, poller, calls, clock, failures });
  try {
    assert.ok(await waitFor(() => readJsonl(session.log).filter(e => e.type === 'poller_status').length === 1));
    const expectedDelays = [15_000, 30_000, 60_000, 120_000, 240_000, 300_000];
    let at = 1001;
    for (let i = 0; i < expectedDelays.length; i++) {
      const status = readJsonl(session.log).filter(e => e.type === 'poller_status').at(-1);
      assert.equal(status.status, 'error');
      assert.equal(status.nextDue - status.t, expectedDelays[i]);
      at += expectedDelays[i];
      fs.writeFileSync(clock, String(at - 1)); await sleep(25);
      assert.equal(starts(calls, fs.realpathSync(session.log)).length, i + 1);
      fs.writeFileSync(clock, String(at));
      assert.ok(await waitFor(() => starts(calls, fs.realpathSync(session.log)).length === i + 2));
      assert.ok(await waitFor(() => readJsonl(session.log).filter(e => e.type === 'poller_status').length === i + 2));
    }
  } finally {
    await stopServers(server.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('poll-github keeps only the supervised --once executor and never self-detaches', () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const log = path.join(dir, 'events.jsonl');
  fs.writeFileSync(log, '');
  let legacyPid = null;
  try {
    const result = spawnSync(node, [POLL_GITHUB, '--known', '--repo', 'org/repo', '--log', log], {
      env: { ...process.env, NIGHTSHIFT_HOME: home }, encoding: 'utf8', timeout: 2_000,
    });
    try {
      const state = JSON.parse(fs.readFileSync(path.join(home, 'pr-pollers.json'), 'utf8'));
      legacyPid = state[path.resolve(log)]?.pid || null;
    } catch { /* desired: no legacy registry */ }
    assert.equal(result.status, 2, 'resident mode is rejected; the server must invoke --once');
    assert.match(result.stderr, /server supervisor|--once/i);
    assert.equal(fs.existsSync(path.join(home, 'pr-pollers.json')), false, 'no detached worker registry');
  } finally {
    if (legacyPid) try { process.kill(legacyPid, 'SIGKILL'); } catch { /* gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('poll-github treats unavailable PRs as benign but gh/auth/network failure as retryable error', () => {
  const dir = mkTmp();
  const mode = path.join(dir, 'mode');
  const calls = path.join(dir, 'gh-calls.jsonl');
  const bin = writeGhStub(dir, mode, calls);
  const log = path.join(dir, 'events.jsonl');
  append(log, { t: 1, source: 'hook', type: 'pr_ref', repo: 'org/repo', number: 1,
    url: 'https://github.com/org/repo/pull/1' });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };

  fs.writeFileSync(mode, 'unavailable');
  const unavailable = spawnSync(node, [POLL_GITHUB, '--once', '--known', '--repo', 'org/repo', '--log', log],
    { env, encoding: 'utf8' });
  assert.equal(unavailable.status, 0, unavailable.stderr);

  fs.writeFileSync(mode, 'failure');
  const failure = spawnSync(node, [POLL_GITHUB, '--once', '--known', '--repo', 'org/repo', '--log', log],
    { env, encoding: 'utf8' });
  assert.equal(failure.status, 1, 'transport/auth failures drive supervisor error backoff');
  assert.match(failure.stderr, /failed to connect/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('server-like poll-github invocation fails when implicit repository resolution fails', () => {
  const dir = mkTmp();
  const mode = path.join(dir, 'mode');
  const calls = path.join(dir, 'gh-calls.jsonl');
  const bin = writeGhStub(dir, mode, calls);
  const log = path.join(dir, 'events.jsonl');
  append(log, { t: 1, source: 'hook', type: 'pr_ref', repo: 'org/repo', number: 1,
    url: 'https://github.com/org/repo/pull/1' });
  fs.writeFileSync(mode, 'repo-failure');

  const result = spawnSync(node, [POLL_GITHUB, '--once', '--known', '--log', log], {
    cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8',
  });
  assert.equal(result.status, 1, 'the production --known path must feed repo/auth errors into supervisor backoff');
  assert.match(result.stderr, /authentication required/i);
  assert.equal(readJsonl(log).filter(event => event.source === 'poll-github').length, 0,
    'repo identity failure cannot append an unqualified PR fact');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a later pr_ref forces exactly one authoritative recheck after terminal state', () => {
  const dir = mkTmp();
  const mode = path.join(dir, 'mode');
  const calls = path.join(dir, 'gh-calls.jsonl');
  const bin = writeGhStub(dir, mode, calls);
  fs.writeFileSync(mode, 'success');
  const log = path.join(dir, 'events.jsonl');
  append(log, { t: 10, source: 'poll-github', type: 'pr', repo: 'org/repo', number: 1,
    state: 'merged', url: 'https://github.com/org/repo/pull/1' });
  append(log, { t: 20, source: 'hook', type: 'pr_ref', repo: 'org/repo', number: 1,
    url: 'https://github.com/org/repo/pull/1' });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(node, [POLL_GITHUB, '--once', '--known', '--repo', 'org/repo', '--log', log],
      { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(readJsonl(calls).length, 1, 'second run sees the forced terminal observation after the ref');
  assert.equal(readJsonl(log).filter(event => event.type === 'pr' && event.state === 'merged').length, 2,
    'the forced unchanged observation fences that ref as authoritatively checked');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nightshift start/continue registers supervision and reset/off unregister it', () => {
  const skill = fs.readFileSync(NIGHTSHIFT_SKILL, 'utf8');
  assert.match(skill, /poller-registration\.js" register --log "\$LOG" --session "\$POLL_SID" --cwd "\$PWD"/);
  assert.match(skill, /poller-registration\.js" unregister --log "\$LOG" --session "\$POLL_SID"/);
  assert.doesNotMatch(skill, /poll-github\.js" --known --interval|poll-github\.js" --stop/,
    'the skill never starts or stops a competing detached writer');
  assert.match(skill, /if ! node "\$REPO\/tools\/poller-registration\.js" unregister[^\n]*--drain/,
    'reset/off abort instead of rotating or stopping before cancellation drains');
});

test('nightshift start registration failure rolls recording back before reporting failure', () => {
  const dir = mkTmp();
  const home = path.join(dir, 'home');
  const repo = path.join(dir, 'fake-repo');
  const toolsDir = path.join(repo, 'tools');
  const calls = path.join(dir, 'rollback-calls.jsonl');
  const sessionId = 'claude-start-session';
  const marker = path.join(home, '.nightshift', 'active', sessionId);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.writeFileSync(marker, '');
  const fake = `
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(process.env.ROLLBACK_CALLS, JSON.stringify({ tool: path.basename(process.argv[1]), args: process.argv.slice(2) }) + '\\n');
if (path.basename(process.argv[1]) === 'poller-registration.js') process.exit(7);
`;
  for (const name of ['poller-registration.js', 'turn-attachment.js', 'codex-tail.js', 'emit.js']) {
    fs.writeFileSync(path.join(toolsDir, name), fake);
  }

  const skill = fs.readFileSync(NIGHTSHIFT_SKILL, 'utf8');
  const block = skill.match(/# BEGIN_CHECKED_POLLER_REGISTRATION\n([\s\S]*?)# END_CHECKED_POLLER_REGISTRATION/);
  assert.ok(block, 'the documented start workflow exposes one checked registration/rollback block');
  const result = spawnSync('/bin/sh', ['-c', block[1]], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: home,
      REPO: repo,
      LOG: path.join(dir, 'events.jsonl'),
      POLL_SID: sessionId,
      CLAUDE_CODE_SESSION_ID: sessionId,
      CODEX_THREAD_ID: '',
      ROLLBACK_CALLS: calls,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /registration failed|not started/i);
  assert.equal(fs.existsSync(marker), false, 'failed registration removes the recording gate');
  const observed = readJsonl(calls);
  assert.deepEqual(observed.map(call => call.tool),
    ['poller-registration.js', 'turn-attachment.js', 'emit.js']);
  assert.deepEqual(observed[1].args.slice(0, 2), ['cancel', '--sid']);
  assert.deepEqual(observed[2].args.slice(0, 3), ['session', '--phase', 'idle']);
  fs.rmSync(dir, { recursive: true, force: true });
});
