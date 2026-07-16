// Supervision tests — hermetic, zero-dep (node:test + node:assert). Run: npm test
//
// Covers plan item 1.5: a LaunchAgent keeps the board server (and portless proxy)
// alive across restarts, and the supervised server owns board.json so tools/board.js
// never spawns a second board. Everything runs against temp dirs and EPHEMERAL
// ports — no writes to ~/.nightshift or ~/Library/LaunchAgents, port 4173 is never
// bound, no network, no real launchctl mutation (only --dry-run / read-only paths).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const INSTALLER = path.join(repo, 'tools', 'install-launchd.js');
const BOARD = path.join(repo, 'tools', 'board.js');
const SERVER = path.join(repo, 'server.js');
const node = process.execPath;

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ns-sup-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A guaranteed-free port right now (small TOCTOU window, fine for a test).
function freePort() {
  return new Promise(res => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function whoami(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/whoami', timeout: 1000 }, res => {
      let b = ''; res.on('data', d => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function getStatus(port, pathname) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 1000 }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function waitFor(fn, { tries = 60, gap = 50 } = {}) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
  return null;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function killQuiet(pid) { if (pid != null) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }

// Start the board in supervised (--managed) foreground mode on an ephemeral port.
async function startManaged(nsHome, sessionsDir) {
  const port = await freePort();
  const child = spawn(node, [SERVER, '--dir', sessionsDir, '--port', String(port), '--managed'],
    { env: { ...process.env, NIGHTSHIFT_HOME: nsHome }, stdio: 'ignore' });
  const boardJson = path.join(nsHome, 'board.json');
  const ok = await waitFor(() => (fs.existsSync(boardJson) && whoami(port)));
  return { child, port, boardJson, up: !!ok };
}

// --- install-launchd generates a valid board plist (plutil -lint) --------------
test('install-launchd --install --dry-run writes a lint-clean board plist', async () => {
  const dir = mkTmp();
  const nsHome = path.join(dir, '.nightshift');
  const agents = path.join(dir, 'agents');
  const port = await freePort();
  const out = execFileSync(node, [INSTALLER, '--install', '--dry-run', '--no-portless', '--port', String(port)],
    { env: { ...process.env, NIGHTSHIFT_HOME: nsHome, NIGHTSHIFT_LAUNCH_AGENTS_DIR: agents }, encoding: 'utf8' });

  const plist = path.join(agents, 'com.nightshift.board.plist');
  assert.ok(fs.existsSync(plist), 'board plist is written even in --dry-run');
  assert.match(out, /launchctl not touched/, '--dry-run does not touch launchctl');

  // plutil validates the plist is well-formed (the whole reason this file exists).
  const lint = execFileSync('plutil', ['-lint', plist], { encoding: 'utf8' });
  assert.match(lint, /OK\s*$/);

  const xml = fs.readFileSync(plist, 'utf8');
  assert.ok(xml.includes(node), 'the absolute node path is baked in (launchd has a bare PATH)');
  assert.ok(xml.includes(SERVER), 'runs server.js');
  assert.ok(xml.includes('--managed'), 'runs the server in --managed (foreground) mode');
  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/, 'RunAtLoad');
  assert.match(xml, /<key>KeepAlive<\/key><true\/>/, 'KeepAlive');
  assert.ok(xml.includes(path.join(nsHome, 'logs', 'board.out.log')), 'StandardOut log path');
  assert.ok(!fs.existsSync(path.join(agents, 'com.nightshift.portless.plist')), '--no-portless skips the proxy agent');

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- portless proxy agent: foreground supported → agent; unsupported → skip ----
function writeStub(dir, name, helpText) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\ncase "$1" in\n  --help) cat <<'EOF'\n${helpText}\nEOF\n  ;;\nesac\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

test('install-launchd supervises the portless proxy when it has a --foreground mode', async () => {
  const dir = mkTmp();
  const nsHome = path.join(dir, '.nightshift');
  const agents = path.join(dir, 'agents');
  const port = await freePort();
  const stub = writeStub(dir, 'portless', '  --foreground   Run proxy in foreground (for debugging)');

  execFileSync(node, [INSTALLER, '--install', '--dry-run', '--port', String(port), '--proxy-port', '1355'],
    { env: { ...process.env, NIGHTSHIFT_HOME: nsHome, NIGHTSHIFT_LAUNCH_AGENTS_DIR: agents, NIGHTSHIFT_PORTLESS_BIN: stub }, encoding: 'utf8' });

  const plist = path.join(agents, 'com.nightshift.portless.plist');
  assert.ok(fs.existsSync(plist), 'a proxy LaunchAgent is written');
  execFileSync('plutil', ['-lint', plist]); // throws if malformed
  const xml = fs.readFileSync(plist, 'utf8');
  assert.ok(xml.includes(stub), 'runs the resolved portless binary');
  assert.match(xml, /<string>proxy<\/string>[\s\S]*<string>start<\/string>[\s\S]*<string>--foreground<\/string>/, 'proxy start --foreground');
  assert.ok(xml.includes('<string>1355</string>'), 'on the configured proxy port');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('install-launchd skips the proxy agent (with a note) when portless has no --foreground', async () => {
  const dir = mkTmp();
  const nsHome = path.join(dir, '.nightshift');
  const agents = path.join(dir, 'agents');
  const port = await freePort();
  const stub = writeStub(dir, 'portless', '  proxy start   Start the HTTPS proxy (daemon only)');

  const out = execFileSync(node, [INSTALLER, '--install', '--dry-run', '--port', String(port), '--proxy-port', '1355'],
    { env: { ...process.env, NIGHTSHIFT_HOME: nsHome, NIGHTSHIFT_LAUNCH_AGENTS_DIR: agents, NIGHTSHIFT_PORTLESS_BIN: stub }, encoding: 'utf8' });

  assert.ok(!fs.existsSync(path.join(agents, 'com.nightshift.portless.plist')), 'no proxy agent without a foreground mode');
  assert.match(out, /no --foreground mode/, 'the install prints a clear note and skips (no hacks)');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- --status is read-only and safe with nothing installed ---------------------
test('install-launchd --status reports "not installed" without mutating anything', async () => {
  const dir = mkTmp();
  const nsHome = path.join(dir, '.nightshift');
  const agents = path.join(dir, 'agents');
  const port = await freePort(); // nothing will be listening here
  const out = execFileSync(node, [INSTALLER, '--status', '--port', String(port)],
    { env: { ...process.env, NIGHTSHIFT_HOME: nsHome, NIGHTSHIFT_LAUNCH_AGENTS_DIR: agents }, encoding: 'utf8' });

  assert.match(out, /com\.nightshift\.board {2}not installed/);
  assert.match(out, /board\.json {2}none/);
  assert.match(out, /no nightshift board answering/);
  assert.ok(!fs.existsSync(path.join(agents, 'com.nightshift.board.plist')), '--status never writes a plist');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- the supervised server owns board.json (atomic), answering /whoami ----------
test('server --managed writes board.json atomically and serves its sessions dir', async () => {
  const dir = mkTmp();
  const nsHome = path.join(dir, '.nightshift');
  const sessionsDir = path.join(nsHome, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const { child, port, boardJson, up } = await startManaged(nsHome, sessionsDir);
  try {
    assert.ok(up, 'managed server comes up and writes board.json');
    const rec = JSON.parse(fs.readFileSync(boardJson, 'utf8'));
    assert.equal(rec.port, port, 'board.json records the actual bound port');
    assert.equal(rec.pid, child.pid, 'board.json records the server pid');
    assert.equal(rec.managed, true, 'board.json is flagged managed');
    assert.ok(!fs.existsSync(`${boardJson}.${child.pid}.tmp`), 'the atomic temp file is renamed away, not left behind');

    const who = await whoami(port);
    assert.ok(who && who.nightshift, '/whoami identifies a nightshift board');
    assert.equal(who.dir, sessionsDir, '/whoami reports the served sessions dir');
  } finally {
    killQuiet(child.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replay-only /events requests never register or trigger current reconciliation', async () => {
  const dir = mkTmp();
  const nsHome = path.join(dir, '.nightshift');
  const sessionsDir = path.join(nsHome, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, 'replay.jsonl'), JSON.stringify({
    t: 1, source: 'hook', type: 'pr_ref', repo: 'org/replay', number: 1,
  }) + '\n');
  const { child, port, up } = await startManaged(nsHome, sessionsDir);
  try {
    assert.ok(up, 'managed server up');
    assert.equal(await getStatus(port, '/events?session=replay'), 200);
    await sleep(50);
    assert.equal(fs.existsSync(path.join(nsHome, 'poller-sessions')), false,
      'reading a historical tape does not make it a live registered session');
    assert.equal(fs.existsSync(path.join(nsHome, 'poller-leases')), false,
      'replay does not acquire a writer lease or launch reconciliation');
  } finally {
    killQuiet(child.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- tools/board.js reuses the supervised board instead of spawning a rival -----
test('tools/board.js detects the managed board (pid + /whoami) and does not spawn a second', async () => {
  const dir = mkTmp();
  const nsHome = path.join(dir, '.nightshift');
  const sessionsDir = path.join(nsHome, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const { child, port, boardJson, up } = await startManaged(nsHome, sessionsDir);
  try {
    assert.ok(up, 'managed server up');
    const before = JSON.parse(fs.readFileSync(boardJson, 'utf8'));

    const url = execFileSync(node, [BOARD, '--port', String(port)],
      { env: { ...process.env, NIGHTSHIFT_HOME: nsHome }, encoding: 'utf8' }).trim();
    assert.equal(url, `http://localhost:${port}/`, 'board.js hands back the supervised board URL');

    const after = JSON.parse(fs.readFileSync(boardJson, 'utf8'));
    assert.equal(after.pid, before.pid, 'board.json still points at the SAME (supervised) pid — no rival spawned');
    assert.equal(after.managed, true, 'still the managed record');
  } finally {
    killQuiet(child.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- a STALE board.json (dead pid) is not reused — board.js starts a fresh one ---
test('tools/board.js ignores a stale board.json (dead pid) and starts a fresh board', async () => {
  const dir = mkTmp();
  const nsHome = path.join(dir, '.nightshift');
  const sessionsDir = path.join(nsHome, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const deadPort = await freePort();
  const startPort = await freePort();
  // A dead pid: spawn a node that exits immediately, then reuse its (now-dead) pid.
  const dead = spawn(node, ['-e', '0']); await new Promise(r => dead.on('exit', r));
  fs.writeFileSync(path.join(nsHome, 'board.json'),
    JSON.stringify({ port: deadPort, pid: dead.pid, managed: true }) + '\n');

  let spawnedPid = null;
  try {
    const url = execFileSync(node, [BOARD, '--port', String(startPort)],
      { env: { ...process.env, NIGHTSHIFT_HOME: nsHome }, encoding: 'utf8' }).trim();

    const rec = JSON.parse(fs.readFileSync(path.join(nsHome, 'board.json'), 'utf8'));
    spawnedPid = rec.pid;
    assert.notEqual(rec.pid, dead.pid, 'board.json was rewritten to a live server, not the dead pid');
    assert.ok(alive(rec.pid), 'the freshly spawned board is running');
    const who = await whoami(rec.port);
    assert.ok(who && who.dir === sessionsDir, 'the fresh board serves our sessions dir');
    assert.equal(url, `http://localhost:${rec.port}/`, 'board.js returns the fresh board URL');
  } finally {
    killQuiet(spawnedPid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
