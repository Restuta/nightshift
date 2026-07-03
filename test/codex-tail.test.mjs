// Single-recorder tests for tools/codex-tail.js — hermetic, zero-dep.
//
// These lock in plan item 1.2 ("one recorder per rollout") against the F1 failure
// shape: one Codex session fanned into 15 identical worktree tapes, and n154's
// self-double from a re-attach. Everything runs against FIXTURE rollouts under a
// throwaway $HOME + $NIGHTSHIFT_HOME (no machine-local paths, no network, and the
// real ~/.codex / ~/.nightshift are never read or written).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fold } from '../public/reducer.js';
import { sid8 } from '../public/turn-id.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TAIL = path.join(here, '..', 'tools', 'codex-tail.js');

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readLines = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
const readEvents = f => readLines(f).map(l => JSON.parse(l));
// Stream events only: `alive` heartbeats are legitimate per-attach traffic (a
// worker beats on start), so re-drain assertions count everything BUT them.
const streamLines = f => readEvents(f).filter(e => e.type !== 'alive');
const readState = ns => { try { return JSON.parse(fs.readFileSync(path.join(ns, 'codex-tails.json'), 'utf8')); } catch { return {}; } }
const writeState = (ns, s) => { fs.mkdirSync(ns, { recursive: true }); fs.writeFileSync(path.join(ns, 'codex-tails.json'), JSON.stringify(s) + '\n'); };

// A fresh, isolated home + nightshift home + sessions dir per test.
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tail-'));
  const home = path.join(root, 'home');
  const ns = path.join(root, 'ns');
  const sessions = path.join(home, '.codex', 'sessions', '2026', '07', '01');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(ns, { recursive: true });
  return { root, home, ns, sessions, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// Write a minimal but realistic rollout: a session_meta line (id + cwd) and one
// user prompt. Names the file rollout-<ts>-<id>.jsonl the way Codex does, so
// selection can match by filename. `mtime` lets a test order rollouts explicitly.
function writeRollout(sessions, { id, cwd, ts = '2026-07-01T01:00:00.000Z', mtime }) {
  const file = path.join(sessions, `rollout-${ts.replace(/[:.]/g, '-')}-${id}.jsonl`);
  const meta = { timestamp: ts, type: 'session_meta', payload: { session_id: id, id, timestamp: ts, cwd, originator: 'codex-tui', source: 'cli', thread_source: 'user' } };
  const prompt = { timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: 'do the thing' } };
  fs.writeFileSync(file, JSON.stringify(meta) + '\n' + JSON.stringify(prompt) + '\n');
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

// Write a rollout whose DRAINED log is deliberately larger than the re-attach
// guard's chunk size, so the lone session-start marker (top of the log) sits far
// before any tail window. `prompts` user turns → ~3 log lines each; the caller
// asserts the resulting log clears 256KB.
function writeBigRollout(sessions, { id, cwd, prompts }) {
  const ts = '2026-07-01T01:00:00.000Z';
  const file = path.join(sessions, `rollout-${ts.replace(/[:.]/g, '-')}-${id}.jsonl`);
  const lines = [JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { session_id: id, id, timestamp: ts, cwd, originator: 'codex-tui', source: 'cli', thread_source: 'user' } })];
  for (let i = 0; i < prompts; i++) {
    lines.push(JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: `prompt ${i} — a chunk of the overnight work, long enough that the tape outgrows the tail window` } }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

// A multi-turn rollout: session_meta + N user prompts at rising timestamps (60s
// apart from t0). Full mode mints one namespaced card per prompt, closing the
// prior one — so a 2-prompt rollout emits card 1 doing → card 1 done + card 2 doing.
function writeConvo(sessions, { id, cwd, prompts, t0 }) {
  const iso = t => new Date(t).toISOString();
  const file = path.join(sessions, `rollout-${iso(t0).replace(/[:.]/g, '-')}-${id}.jsonl`);
  const lines = [JSON.stringify({ timestamp: iso(t0), type: 'session_meta', payload: { session_id: id, id, timestamp: iso(t0), cwd, originator: 'codex-tui', source: 'cli', thread_source: 'user' } })];
  for (let i = 0; i < prompts; i++) {
    lines.push(JSON.stringify({ timestamp: iso(t0 + (i + 1) * 60000), type: 'event_msg', payload: { type: 'user_message', message: `prompt ${i + 1}` } }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

// Append one more user prompt to a live rollout (a fresh turn arriving).
function appendPrompt(file, { message, t }) {
  fs.appendFileSync(file, JSON.stringify({ timestamp: new Date(t).toISOString(), type: 'event_msg', payload: { type: 'user_message', message } }) + '\n');
}

const delay = ms => new Promise(r => setTimeout(r, ms));
function workerEnv({ home, ns }) {
  const env = { ...process.env };
  delete env.CODEX_THREAD_ID; delete env.NIGHTSHIFT_LOG; delete env.NIGHTSHIFT;
  if (home) env.HOME = home; if (ns) env.NIGHTSHIFT_HOME = ns;
  return env;
}

// Run codex-tail synchronously (default entry, --once, --status, --stop) with a
// scoped env. Returns { status, stdout, stderr }.
function runTail(args, { home, ns, sid } = {}) {
  const env = { ...process.env };
  delete env.CODEX_THREAD_ID; delete env.NIGHTSHIFT_LOG; delete env.NIGHTSHIFT;
  if (home) env.HOME = home;
  if (ns) env.NIGHTSHIFT_HOME = ns;
  if (sid) env.CODEX_THREAD_ID = sid;
  return spawnSync(process.execPath, [TAIL, ...args], { encoding: 'utf8', env, timeout: 8000 });
}

// Run a --worker (the long-lived tail) just long enough to do its startup drain +
// checkpoint, then SIGTERM it. Returns after it exits.
function runWorker(args, { home, ns } = {}, settle = 700) {
  const env = { ...process.env };
  delete env.CODEX_THREAD_ID; delete env.NIGHTSHIFT_LOG; delete env.NIGHTSHIFT;
  if (home) env.HOME = home;
  if (ns) env.NIGHTSHIFT_HOME = ns;
  return new Promise(resolve => {
    const child = spawn(process.execPath, [TAIL, '--worker', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    const t = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, settle);
    child.on('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal, stdout: out, stderr: err }); });
  });
}

const A = '019f0a00-0000-7000-8000-000000000001';
const B = '019f0b00-0000-7000-8000-000000000002';
const MISSING = 'ffffffff-0000-7000-8000-00000000ffff';

// (1) Deterministic selection: attach to THIS session's rollout by id, and NEVER
// fall back to the newest rollout in the dir — the exact mechanism of F1. The
// recorded cwd is therefore this session's worktree, not the newer session's repo.
test('selection: matches this session by id, never the newest rollout (F1)', () => {
  const sb = sandbox();
  try {
    const WORKTREE = '/Users/dev/wt/feature-a';
    const OTHER = '/Users/dev/main-repo';
    // A is OUR session (older); B is a newer, unrelated session in the same dir.
    writeRollout(sb.sessions, { id: A, cwd: WORKTREE, ts: '2026-07-01T01-00-00', mtime: 1_000_000 });
    writeRollout(sb.sessions, { id: B, cwd: OTHER, ts: '2026-07-01T02-00-00', mtime: 2_000_000 }); // newer

    const log = path.join(sb.ns, 'out.jsonl');
    const r = runTail(['--once', '--log', log], { home: sb.home, ns: sb.ns, sid: A });
    assert.equal(r.status, 0, r.stderr);

    const start = readEvents(log).find(e => e.type === 'session' && e.phase === 'start');
    assert.ok(start, 'a session start was recorded');
    assert.equal(start.session, A, 'attached to OUR session, not the newest one');
    assert.equal(start.cwd, WORKTREE, 'recorded this session\'s worktree cwd, not the newer session\'s repo');
  } finally { sb.cleanup(); }
});

// (2) Refuse loudly rather than guess when no rollout matches the session id.
test('selection: refuses (exit 3) when no rollout matches the session id', () => {
  const sb = sandbox();
  try {
    writeRollout(sb.sessions, { id: A, cwd: '/Users/dev/wt/feature-a' });
    const log = path.join(sb.ns, 'nope.jsonl');
    const r = runTail(['--once', '--log', log], { home: sb.home, ns: sb.ns, sid: MISSING });
    assert.equal(r.status, 3, 'exits non-zero (refuses to guess)');
    assert.match(r.stderr, /refusing to guess/);
    assert.equal(readLines(log).length, 0, 'nothing was recorded on a refusal');
  } finally { sb.cleanup(); }
});

// (3) Rollout-keyed lock: a live worker on a rollout makes a second attach — even
// from a different worktree resolving a DIFFERENT log — a no-op. One rollout is
// recorded exactly once (kills F1's 15-tape fan-out).
test('lock: a second attach to a live rollout is a no-op, even into a different log', () => {
  const sb = sandbox();
  try {
    const rollout = writeRollout(sb.sessions, { id: A, cwd: '/Users/dev/wt/feature-a' });
    // Pretend a live worker (this test process) already tails the rollout into logA.
    const logA = path.join(sb.ns, 'sessions', 'feature-a.jsonl');
    writeState(sb.ns, { [rollout]: { pid: process.pid, log: logA, rollout, mode: 'full' } });

    const logB = path.join(sb.ns, 'sessions', 'feature-b.jsonl');
    const r = runTail([rollout, '--log', logB], { home: sb.home, ns: sb.ns });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /already recording/, 'reports it is already recording this rollout');
    assert.match(r.stderr, /not double-recording/);

    const st = readState(sb.ns);
    assert.deepEqual(Object.keys(st), [rollout], 'no second registry entry was created');
    assert.equal(st[rollout].pid, process.pid, 'the live worker was left untouched');
    assert.equal(st[rollout].log, logA, 'the destination log was not hijacked');
    assert.ok(!fs.existsSync(logB), 'the second log was never written');
  } finally { sb.cleanup(); }
});

// (4) Stale lock (dead pid) is taken over: a new worker is spawned and claims the
// rollout entry.
test('lock: a stale (dead-pid) entry is taken over by a new worker', () => {
  const sb = sandbox();
  try {
    const rollout = writeRollout(sb.sessions, { id: A, cwd: '/Users/dev/wt/feature-a' });
    // A pid that is guaranteed dead: spawn a node that exits, reuse its pid.
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    assert.ok(!alive(dead), 'seed pid is dead');
    const logOld = path.join(sb.ns, 'sessions', 'old.jsonl');
    writeState(sb.ns, { [rollout]: { pid: dead, log: logOld, rollout, mode: 'full' } });

    const logNew = path.join(sb.ns, 'sessions', 'new.jsonl');
    const r = runTail([rollout, '--log', logNew], { home: sb.home, ns: sb.ns });
    assert.equal(r.status, 0, r.stderr);

    const st = readState(sb.ns);
    const e = st[rollout];
    assert.ok(e && e.pid && e.pid !== dead, 'the dead pid was replaced by a live worker');
    assert.equal(e.log, logNew, 'the takeover records into the new log');
    try { process.kill(e.pid); } catch { /* already gone */ } // stop the detached worker
  } finally { sb.cleanup(); }
});

// (5) Re-attach guard (the n154 double): a worker whose checkpoint is gone but whose
// destination log ALREADY holds this session must NOT re-drain from zero.
test('re-attach guard: no re-drain when the snapshot is lost but the log has the session', async () => {
  const sb = sandbox();
  try {
    const rollout = writeRollout(sb.sessions, { id: A, cwd: '/Users/dev/wt/feature-a' });
    const log = path.join(sb.ns, 'sessions', 'feature-a.jsonl');

    // First pass populates the log (a fresh --once drain).
    const seed = runTail(['--once', rollout, '--log', log], { home: sb.home, ns: sb.ns });
    assert.equal(seed.status, 0, seed.stderr);
    const n = streamLines(log).length;
    assert.ok(n > 0, 'the first pass recorded the session');
    // The registry has NO checkpoint for this rollout (--once never persists).
    assert.ok(!readState(sb.ns)[rollout], 'no snapshot exists for the rollout');

    // A worker re-attaches with no checkpoint. The guard must see the session
    // already in the log and refuse to re-drain, leaving the line count unchanged.
    const w = await runWorker([rollout, '--log', log], { home: sb.home, ns: sb.ns });
    assert.match(w.stderr, /re-attach guard/, 'the guard fired');
    assert.equal(streamLines(log).length, n, 'the stream was NOT re-appended (no double)');
  } finally { sb.cleanup(); }
});

// (5b) The re-attach guard must hold for a REAL overnight tape, not just a tiny
// fixture: when the recorded log outgrows the guard's scan window, the lone
// session-start marker sits at the TOP, far before any tail. A tail-only probe
// misses it and re-drains the entire multi-MB stream from zero — the precise n154
// double this guard exists to eliminate. The scan must cover the whole log.
test('re-attach guard: no re-drain even when the log is far larger than the scan window', async () => {
  const sb = sandbox();
  try {
    const rollout = writeBigRollout(sb.sessions, { id: A, cwd: '/Users/dev/wt/feature-a', prompts: 2000 });
    const log = path.join(sb.ns, 'sessions', 'feature-a.jsonl');

    // Seed via --once (no checkpoint), exactly like an import/reset/crash-before-persist.
    const seed = runTail(['--once', rollout, '--log', log], { home: sb.home, ns: sb.ns });
    assert.equal(seed.status, 0, seed.stderr);
    const n = streamLines(log).length;
    const bytes = fs.statSync(log).size;
    assert.ok(bytes > 262144, `the recorded log must exceed the 256KB scan window (was ${bytes} bytes)`);
    assert.ok(!readState(sb.ns)[rollout], 'no snapshot exists for the rollout');

    // Re-attach with no checkpoint: the guard must still detect the session (its
    // marker is nowhere near the tail) and refuse to re-drain.
    const w = await runWorker([rollout, '--log', log], { home: sb.home, ns: sb.ns });
    assert.match(w.stderr, /re-attach guard/, 'the guard fired despite the marker being outside a tail window');
    assert.equal(streamLines(log).length, n, 'the large stream was NOT re-appended (no double)');
  } finally { sb.cleanup(); }
});

// (6) The guard does not over-trigger: a genuinely fresh log IS drained from zero.
test('re-attach guard: a fresh (empty) log is still recorded from zero', async () => {
  const sb = sandbox();
  try {
    const rollout = writeRollout(sb.sessions, { id: A, cwd: '/Users/dev/wt/feature-a' });
    const fresh = path.join(sb.ns, 'sessions', 'fresh.jsonl');
    assert.ok(!fs.existsSync(fresh), 'log starts empty');

    const w = await runWorker([rollout, '--log', fresh], { home: sb.home, ns: sb.ns });
    assert.doesNotMatch(w.stderr, /re-attach guard/, 'the guard did not fire on an empty log');
    assert.ok(readLines(fresh).length > 0, 'the session was recorded fresh');

    const e = readState(sb.ns)[rollout];
    if (e && e.pid) { try { process.kill(e.pid); } catch { /* gone */ } }
  } finally { sb.cleanup(); }
});

// (7b) Migration belt: a pre-upgrade, LOG-keyed live worker whose entry stores
// `rollout` still blocks a second attach to the same rollout (no double during the
// registry-format changeover).
test('lock: a pre-upgrade (log-keyed) live worker on the rollout blocks a second attach', () => {
  const sb = sandbox();
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    const rollout = writeRollout(sb.sessions, { id: A, cwd: '/Users/dev/wt/feature-a' });
    const logOld = path.join(sb.ns, 'sessions', 'old-format.jsonl');
    // Old registry shape: keyed by the LOG path, with `rollout` stored inside.
    writeState(sb.ns, { [logOld]: { pid: sleeper.pid, rollout, mode: 'full', snap: { offset: 10 } } });

    const logNew = path.join(sb.ns, 'sessions', 'new.jsonl');
    const r = runTail([rollout, '--log', logNew], { home: sb.home, ns: sb.ns });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(Object.keys(readState(sb.ns)), [logOld], 'no second (rollout-keyed) worker was spawned');
    assert.ok(!fs.existsSync(logNew), 'the new log was never written');
  } finally { try { sleeper.kill('SIGKILL'); } catch { /* gone */ } sb.cleanup(); }
});

// (7) --stop --log scopes to the worker feeding that log and keeps a resume
// checkpoint (pause), while --status reports liveness by destination log.
test('stop/status: scoped by destination log; a scoped stop keeps the resume checkpoint', () => {
  const sb = sandbox();
  // A disposable live process to stand in for a running worker (so a real --stop
  // has something safe to signal — never the test runner itself).
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    const rollout = writeRollout(sb.sessions, { id: A, cwd: '/Users/dev/wt/feature-a' });
    const log = path.join(sb.ns, 'sessions', 'feature-a.jsonl');
    writeState(sb.ns, { [rollout]: { pid: sleeper.pid, log, rollout, mode: 'full', snap: { offset: 4242, logSize: 99 } } });

    // A live worker feeding this log reads as `live`.
    const st1 = runTail(['--status', '--log', log], { home: sb.home, ns: sb.ns });
    assert.equal(st1.stdout.trim(), 'live');
    // An unrelated log reads as `off`.
    const st2 = runTail(['--status', '--log', path.join(sb.ns, 'sessions', 'other.jsonl')], { home: sb.home, ns: sb.ns });
    assert.equal(st2.stdout.trim(), 'off');

    // Scoped stop pauses this worker but KEEPS its checkpoint for a later continue.
    runTail(['--stop', '--log', log], { home: sb.home, ns: sb.ns });
    const e = readState(sb.ns)[rollout];
    assert.ok(e, 'a scoped stop keeps the entry (paused)');
    assert.ok(!e.pid, 'the pid is cleared (worker stopped)');
    assert.equal(e.snap.offset, 4242, 'the resume checkpoint survives the pause');
  } finally { try { sleeper.kill('SIGKILL'); } catch { /* gone */ } sb.cleanup(); }
});

// (8) Namespaced turn ids (plan 1.3). Two rollouts of the SAME project — legal
// under the rollout-keyed lock — resolve to ONE central log. Before, both minted
// `turn-1`, so one worker's retire closed the other's live card (the board showed a
// running session with nothing in progress). Namespacing by sid8 makes the ids
// disjoint: each worker retires only ITS OWN card, and the second session's active
// card survives the first's retire.
test('two rollouts, one log: namespaced ids never collide; a retire closes only its own card (1.3)', () => {
  const sb = sandbox();
  try {
    const base = Date.parse('2026-07-01T01:00:00.000Z');
    const CWD = '/Users/dev/main-repo';                 // same project → same central log
    // B opens its turn FIRST; A retires its own turn LATER. Pre-fix, A's `turn-1 done`
    // closed B's live `turn-1`. Namespacing makes that impossible.
    const rollB = writeConvo(sb.sessions, { id: B, cwd: CWD, prompts: 1, t0: base });
    const rollA = writeConvo(sb.sessions, { id: A, cwd: CWD, prompts: 2, t0: base + 3600_000 });
    const log = path.join(sb.ns, 'sessions', 'main-repo.jsonl');

    assert.equal(runTail(['--once', rollB, '--log', log], { home: sb.home, ns: sb.ns }).status, 0);
    assert.equal(runTail(['--once', rollA, '--log', log], { home: sb.home, ns: sb.ns }).status, 0);

    const a8 = sid8(A), b8 = sid8(B);
    assert.notEqual(a8, b8, 'the two sessions have distinct namespaces');

    const items = readEvents(log).filter(e => e.type === 'item');
    const ids = new Set(items.map(e => e.id));
    assert.ok(ids.has(`turn-${a8}-1`) && ids.has(`turn-${b8}-1`), 'both sessions minted a namespaced card 1');
    assert.ok(!ids.has('turn-1'), 'no un-namespaced (colliding) turn-1 was minted');
    assert.ok(items.some(e => e.id === `turn-${a8}-1` && e.status === 'done'), 'A closed its OWN card');
    assert.ok(!items.some(e => e.id === `turn-${b8}-1` && e.status === 'done'), "A's retire never touched B's card");

    // The reducer agrees: B's active card survives A's retire.
    const s = fold(readEvents(log).sort((x, y) => x.t - y.t));
    assert.equal(s.items.get(`turn-${b8}-1`).status, 'doing', "B's card is still in progress");
    assert.equal(s.items.get(`turn-${a8}-1`).status, 'done', "A's first card is done");
    assert.equal(s.items.get(`turn-${a8}-2`).status, 'doing', "A's second card is in progress");
  } finally { sb.cleanup(); }
});

// (9) Restart continuity (plan 1.3): a worker whose checkpoint is gone must resume
// turn numbering from the log's own namespace, so a new turn continues at -(max+1)
// instead of re-minting -1 and colliding with a card this session already wrote.
test('restart: a lost checkpoint resumes turn numbering from the log, never re-mints turn 1 (1.3)', async () => {
  const sb = sandbox();
  try {
    const base = Date.parse('2026-07-01T01:00:00.000Z');
    const rollout = writeConvo(sb.sessions, { id: A, cwd: '/Users/dev/wt/feature-a', prompts: 2, t0: base });
    const log = path.join(sb.ns, 'sessions', 'feature-a.jsonl');
    const a8 = sid8(A);
    // A fresh --once drains the two turns but persists NO checkpoint (an import, a
    // reset, or a crash before persist — the lost-checkpoint condition).
    assert.equal(runTail(['--once', rollout, '--log', log], { home: sb.home, ns: sb.ns }).status, 0);
    assert.ok(readEvents(log).some(e => e.type === 'item' && e.id === `turn-${a8}-2`), 'card 2 was minted');
    assert.ok(!readState(sb.ns)[rollout], 'no checkpoint persisted (lost-checkpoint condition)');

    // Restart a --worker (no checkpoint). Once up, a NEW prompt (turn 3) lands. The
    // worker must number it turn-<a8>-3, continuing from the log — not re-mint -1.
    const child = spawn(process.execPath, [TAIL, '--worker', rollout, '--log', log], { env: workerEnv(sb), stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => (err += d));
    await delay(450);
    appendPrompt(rollout, { message: 'the third turn', t: base + 3 * 60000 });
    await delay(1000);
    child.kill('SIGTERM');
    await new Promise(res => child.on('exit', res));

    assert.match(err, /re-attach guard/, 'the guard fired (checkpoint was lost)');
    const items = readEvents(log).filter(e => e.type === 'item');
    assert.ok(items.some(e => e.id === `turn-${a8}-3` && e.status === 'doing'), 'the new turn continued as -3');
    assert.equal(items.filter(e => e.id === `turn-${a8}-1` && e.status === 'doing').length, 1, 'turn 1 was NOT re-minted');
  } finally { sb.cleanup(); }
});

// (10) Explicit attribution (plan 1.3): every card-attributable event codex-tail
// emits (say / tool / edit / …) stamps the namespaced card as `item`, so the
// reducer never has to fall back to most-recently-touched-doing — which would
// cross-attribute between two sessions interleaved on one shared tape.
test('full mode stamps explicit item (namespaced) on say + tool events (1.3)', () => {
  const sb = sandbox();
  try {
    const ts = '2026-07-01T01:00:00.000Z';
    const file = path.join(sb.sessions, `rollout-${ts.replace(/[:.]/g, '-')}-${A}.jsonl`);
    const j = o => JSON.stringify(o);
    fs.writeFileSync(file, [
      j({ timestamp: ts, type: 'session_meta', payload: { session_id: A, id: A, cwd: '/Users/dev/wt/feature-a', thread_source: 'user' } }),
      j({ timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: 'do the thing' } }),
      j({ timestamp: ts, type: 'event_msg', payload: { type: 'agent_message', message: 'waiting one more interval for the harvest' } }),
      j({ timestamp: ts, type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: j({ cmd: 'ls -la' }) } }),
    ].join('\n') + '\n');

    const log = path.join(sb.ns, 'out.jsonl');
    assert.equal(runTail(['--once', file, '--log', log], { home: sb.home, ns: sb.ns, sid: A }).status, 0);

    const a8 = sid8(A);
    const evs = readEvents(log);
    const say = evs.find(e => e.type === 'say');
    const tool = evs.find(e => e.type === 'tool');
    assert.equal(say && say.item, `turn-${a8}-1`, 'the say event carries the namespaced card as explicit item');
    assert.equal(tool && tool.item, `turn-${a8}-1`, 'the tool event carries the namespaced card as explicit item');
  } finally { sb.cleanup(); }
});
