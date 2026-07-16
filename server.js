#!/usr/bin/env node
// nightshift server — zero-dep static + SSE event-log tail.
// Usage: node server.js [--log <file>]... [--dir <folder>] [--port 4173]
//
// One server, many tapes: pass --log repeatedly and/or --dir to scan a folder
// for *.jsonl. The masthead shows a session switcher when more than one tape
// is served. A single --log (the default) behaves exactly as before.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const {
  listRegistrations,
  acquireLease,
  bindLease,
  renewLease,
  isLeaseCurrent,
  releaseLease,
  acquireSlot,
  readCancellation,
  readStatus,
  writeStatus,
} = require('./tools/poller-registration.js');

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const PORT = Number(flag('port', process.env.PORT || 4173));
const PUBLIC = path.join(__dirname, 'public');

// --managed: run supervised (a LaunchAgent keeps us up in the FOREGROUND, since
// KeepAlive needs a process that stays alive — see tools/install-launchd.js).
// In this mode the server OWNS ~/.nightshift/board.json: it writes it atomically
// on boot and refreshes it, so tools/board.js and the /nightshift skill detect
// the supervised board (pid alive + /whoami) and never spawn a second one on
// another port. Unmanaged, board.json is written by whoever spawned us
// (tools/board.js) — unchanged.
const MANAGED = args.includes('--managed');
const NS_HOME = process.env.NIGHTSHIFT_HOME || path.join(os.homedir(), '.nightshift');
const BOARD_JSON = path.join(NS_HOME, 'board.json');

function writeBoardJson(port) {
  const tmp = `${BOARD_JSON}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(NS_HOME, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ port, pid: process.pid, managed: true, at: Date.now() }) + '\n');
    fs.renameSync(tmp, BOARD_JSON); // atomic replace — a reader never sees a half file
  } catch { /* best effort: if we can't claim board.json, board.js just spawns its own */ }
}

// ---------------------------------------------------------------- sessions
// Collect log files from repeated --log and/or a scanned --dir, preserving
// order. Each becomes a session with its own tail offset and SSE client set.

const logPaths = [];
let servedDir = null; // the --dir, if any — reported by /whoami and rescanned
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--log' && args[i + 1]) logPaths.push(path.resolve(args[++i]));
  else if (args[i] === '--dir' && args[i + 1]) {
    servedDir = path.resolve(args[++i]);
    try {
      for (const f of fs.readdirSync(servedDir).sort()) {
        if (f.endsWith('.jsonl')) logPaths.push(path.join(servedDir, f));
      }
    } catch { console.error(`--dir: cannot read ${servedDir}`); }
  }
}
if (!logPaths.length) logPaths.push(path.resolve(path.join('.nightshift', 'events.jsonl')));

const sessions = new Map(); // id → {id, file, offset, partial, clients, seen}
const usedIds = new Set();
function addSession(file) {
  if ([...sessions.values()].some(s => s.file === file)) return null; // already served
  let id = path.basename(file).replace(/\.jsonl$/, '') || 'session';
  let n = 2;
  while (usedIds.has(id)) id = `${path.basename(file).replace(/\.jsonl$/, '')}-${n++}`;
  usedIds.add(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  // `seen`: envelope ids we've observed being appended to this log while the
  // board is up (populated by drain() below + accepted POSTs). The POST /event
  // dedupe guard consults it so a client re-posting the same event id is acked
  // but not appended again — killing the "same event twice" class at the door.
  const s = { id, file, offset: fs.statSync(file).size, partial: '', clients: new Set(), seen: new Set() };
  sessions.set(id, s);
  try { fs.watch(s.file, () => drain(s)); } catch { /* polling covers it */ }
  return s;
}
for (const file of logPaths) addSession(file);

const defaultSession = sessions.keys().next().value;

// A persistent --dir board should surface projects recorded after it started,
// so rescan the folder for new *.jsonl (open pages see them on refresh) — and
// reconcile removals: a tape archived/deleted by prune-sessions.js is dropped
// from the list within a few seconds, so cleanup reflects live without a restart.
// The default session is never dropped, so the board always has a fallback.
if (servedDir) {
  setInterval(() => {
    let files = [];
    try { files = fs.readdirSync(servedDir); } catch { return; }
    const present = new Set(files.filter(f => f.endsWith('.jsonl')).map(f => path.join(servedDir, f)));
    for (const f of present) addSession(f);
    for (const [id, s] of sessions) {
      if (id !== defaultSession && s.file.startsWith(servedDir + path.sep) && !present.has(s.file)) {
        sessions.delete(id);
        usedIds.delete(id);
      }
    }
  }, 3000).unref();
}

// A cheap scan for the switcher: title, agent, event count, last activity,
// and the latest session phase. Parses lines but folds nothing heavy.
function scanMeta(s) {
  let title = null, agent = null, cwd = null, phase = null, count = 0, lastT = 0;
  let raw = '';
  try { raw = fs.readFileSync(s.file, 'utf8'); } catch { /* gone */ }
  // Sort by t so the latest session phase/title wins by time, not by file
  // position — an out-of-order tape must not report a stale phase (stable sort
  // keeps file order among equal t).
  const evs = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    evs.push(ev);
  }
  evs.sort((a, b) => (a.t || 0) - (b.t || 0));
  for (const ev of evs) {
    count++;
    if (typeof ev.t === 'number') lastT = ev.t;
    if (ev.type === 'session') {
      if (ev.title != null) title = ev.title;
      if (ev.agent != null) agent = ev.agent;
      if (ev.cwd != null) cwd = ev.cwd;
      if (ev.phase === 'start' || ev.phase === 'resume') phase = 'working';
      else if (ev.phase === 'idle') phase = 'idle';
      else if (ev.phase === 'attention') phase = 'attention';
      else if (ev.phase === 'end') phase = 'ended';
    }
  }
  return {
    id: s.id, title: title || (cwd ? path.basename(cwd) : s.id),
    cwd, agent, phase, events: count, lastT,
  };
}

// ---------------------------------------------------------------- tailing
// Track a byte offset per session; on growth, push complete new lines to that
// session's SSE clients. fs.watch is fast but flaky, so polling backs it up.

function drain(s) {
  let size;
  try { size = fs.statSync(s.file).size; } catch { return; }
  if (size < s.offset) { s.offset = 0; s.partial = ''; } // truncated/rotated
  if (size === s.offset) return;
  const stream = fs.createReadStream(s.file, { start: s.offset, end: size - 1, encoding: 'utf8' });
  s.offset = size;
  stream.on('data', chunk => {
    const lines = (s.partial + chunk).split('\n');
    s.partial = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      // Record each appended event's id so a later duplicate POST is caught. Any
      // writer's appends flow through here (hooks, tailers, our own POST), so the
      // guard sees them all. Direct file-writers still can't be deduped at write
      // time — that's Phase 1's single-recorder lock; tape-doctor --dedupe is the
      // offline cure for already-doubled tapes.
      try { const ev = JSON.parse(line); if (ev && ev.id != null) s.seen.add(ev.id); } catch { /* keep streaming */ }
      for (const res of s.clients) res.write(`data: ${line}\n\n`);
    }
  });
}

// addSession() sets up each file's watch; a poll backs them up.
setInterval(() => { for (const s of sessions.values()) drain(s); }, 300).unref();

// --------------------------------------------------- PR state reconciliation
// Recording registers a tape durably; every board server loads those records at
// boot. A per-session wx lease turns multiple launchd/manual board processes into
// one one-shot writer. Scheduling state is itself appended as poller_status, so a
// replacement server resumes the same deadline without needing an SSE viewer or
// trusting process-local memory.
const POLLER = process.env.NIGHTSHIFT_PR_POLLER || path.join(__dirname, 'tools', 'poll-github.js');
const FRESH_MS = 15_000;
const IDLE_MS = 60_000;
const STALE_MS = 300_000;
const retentionEnv = Number(process.env.NIGHTSHIFT_PR_RETENTION_MS);
const RECONCILE_RETENTION_MS = Number.isFinite(retentionEnv) && retentionEnv >= 0
  ? retentionEnv
  : 86_400_000;
const supervisorTickEnv = Number(process.env.NIGHTSHIFT_PR_SUPERVISOR_TICK_MS);
const SUPERVISOR_TICK_MS = Number.isFinite(supervisorTickEnv) && supervisorTickEnv > 0
  ? supervisorTickEnv
  : 1_000;
const MAX_POLLS = 2;
const RECONCILE_SOURCES = new Set(['poll-github', 'server', 'recovery']);
const expiredRegistrationScans = new Map();
// A board relaunched on login can inherit a minimal PATH, leaving the reconciler
// unable to find gh/toast. Augment with the usual tool dirs (+ node's own).
const TOOL_PATH = process.env.NIGHTSHIFT_PR_TOOL_PATH || [
  path.dirname(process.execPath),
  process.env.HOME && path.join(process.env.HOME, '.volta/bin'),
  process.env.HOME && path.join(process.env.HOME, '.local/bin'),
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  process.env.PATH,
].filter(Boolean).join(':');

function supervisorNow() {
  const file = process.env.NIGHTSHIFT_PR_NOW_FILE;
  if (file) {
    try {
      const value = Number(fs.readFileSync(file, 'utf8'));
      if (Number.isFinite(value)) return value;
    } catch { /* test clock removed → wall time */ }
  }
  return Date.now();
}

function repoFromEvent(ev, fallback) {
  if (ev && ev.repo) return String(ev.repo).toLowerCase();
  const match = String((ev && ev.url) || '').match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/i);
  return match ? match[1].toLowerCase() : fallback;
}

function registrationGroups() {
  const groups = new Map();
  for (const registration of listRegistrations()) {
    let group = groups.get(registration.logKey);
    if (!group) {
      group = {
        logKey: registration.logKey,
        log: registration.log,
        cwd: registration.cwd,
        registrations: [],
      };
      groups.set(registration.logKey, group);
    }
    group.registrations.push(registration);
    if (!fs.existsSync(group.cwd) && fs.existsSync(registration.cwd)) group.cwd = registration.cwd;
  }
  return groups;
}

function statusEvent(group, status, now, extra = {}, dedupeKey = null) {
  const event = {
    t: now,
    id: randomUUID(),
    source: 'server',
    v: 2,
    type: 'poller_status',
    status,
    logKey: group.logKey,
    sessionIds: group.registrations.map(registration => registration.sessionId).sort(),
    ...extra,
  };
  const previous = readStatus(group.logKey);
  if (dedupeKey && previous && previous.dedupeKey === dedupeKey) return previous;
  writeStatus(group.logKey, event, { dedupeKey });
  // Missing/empty registered tapes are historical placeholders. Diagnostics
  // live in the durable sidecar without recreating or populating those tapes.
  try {
    if (fs.statSync(group.log).size > 0) fs.appendFileSync(group.log, JSON.stringify(event) + '\n');
  } catch { /* sidecar is authoritative when the tape is absent */ }
  return event;
}

// Fold only scheduler facts. PR identities always carry a repo component; old
// repo-less tapes use the registered real cwd as a conservative namespace, so
// org/alpha#1 and org/beta#1 can never overwrite one another.
function prScan(group) {
  let raw = '';
  try { raw = fs.readFileSync(group.log, 'utf8'); }
  catch {
    return {
      missing: true, empty: false, cwd: group.cwd, prs: new Map(), refFingerprint: '0',
      producerAt: null, activityAt: null, latestRefAt: null, phase: null,
      lastStatus: readStatus(group.logKey),
    };
  }
  let cwd = group.cwd;
  let phase = null;
  let producerAt = null;
  let activityAt = null;
  let lastStatus = null;
  const prs = new Map();
  const evs = [];
  let position = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    evs.push({ ev, position: position++ });
  }
  // PR state folds by historical event time, but reconciliation freshness is an
  // observation-order fact. A recovered ref can be appended today with the old
  // transcript timestamp in `t`; recordedAt and append position must still make
  // it a new authoritative-check request after a terminal PR observation.
  let latestRefAt = null;
  let refCount = 0;
  let lastRefIdentity = '';
  for (const { ev, position: appendPosition } of evs) {
    if (ev.type !== 'pr_ref' || ev.number == null) continue;
    const observedAt = ev.source === 'recovery' && Number.isFinite(ev.recordedAt)
      ? ev.recordedAt
      : (Number.isFinite(ev.t) ? ev.t : 0);
    const repo = repoFromEvent(ev, group.cwd.toLowerCase());
    const key = `${repo}#${Number(ev.number)}`;
    refCount++;
    latestRefAt = latestRefAt == null ? observedAt : Math.max(latestRefAt, observedAt);
    lastRefIdentity = `${key}:${observedAt}:${ev.id || appendPosition}`;
  }
  evs.sort((a, b) => ((a.ev.t || 0) - (b.ev.t || 0)) || (a.position - b.position));
  for (const { ev } of evs) {
    const at = Number.isFinite(ev.t) ? ev.t : 0;
    if (!RECONCILE_SOURCES.has(ev.source)) {
      if (producerAt == null || at > producerAt) producerAt = at;
      if (activityAt == null || at > activityAt) activityAt = at;
    }
    if (ev.type === 'session') {
      if (ev.cwd) cwd = ev.cwd;
      if (ev.phase === 'start' || ev.phase === 'resume') phase = 'working';
      else if (ev.phase === 'idle') phase = 'idle';
      else if (ev.phase === 'attention') phase = 'attention';
      else if (ev.phase === 'end') phase = 'ended';
    } else if (ev.type === 'pr_ref' && ev.number != null) {
      const repo = repoFromEvent(ev, group.cwd.toLowerCase());
      const key = `${repo}#${Number(ev.number)}`;
      prs.set(key, { state: 'open', at, repo, number: Number(ev.number), ref: true });
      activityAt = activityAt == null ? at : Math.max(activityAt, at);
    } else if (ev.type === 'pr' && ev.number != null && ev.state) {
      const repo = repoFromEvent(ev, group.cwd.toLowerCase());
      const key = `${repo}#${Number(ev.number)}`;
      prs.set(key, { state: String(ev.state).toLowerCase(), at, repo, number: Number(ev.number), ref: false });
      activityAt = activityAt == null ? at : Math.max(activityAt, at);
    } else if (ev.type === 'poller_status' && (!ev.logKey || ev.logKey === group.logKey)) {
      lastStatus = ev;
    }
  }
  const sidecar = readStatus(group.logKey);
  if (sidecar && (!lastStatus || Number(sidecar.t || 0) >= Number(lastStatus.t || 0))) lastStatus = sidecar;
  return {
    missing: false,
    empty: raw.length === 0,
    cwd,
    phase,
    producerAt,
    activityAt,
    latestRefAt,
    prs,
    refFingerprint: `${refCount}:${lastRefIdentity}`,
    lastStatus,
  };
}

function terminal(state) {
  return state === 'merged' || state === 'closed';
}

function producerIsFresh(scan, now) {
  return scan.phase === 'working' && scan.producerAt != null && now - scan.producerAt <= STALE_MS;
}

function cadence(scan, now) {
  if (producerIsFresh(scan, now)) return FRESH_MS;
  if (scan.phase === 'idle' || scan.phase === 'attention') return IDLE_MS;
  return STALE_MS;
}

function statIdentity(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

// Expired registrations remain durable so a late tape append or an explicit
// registration refresh can resume reconciliation. Checking those wake-up
// signals only needs metadata; reopening and parsing the historical tape on
// every supervisor tick does not.
function expiredRegistrationObservation(group) {
  const registrations = group.registrations.map(registration => {
    const file = path.join(NS_HOME, 'poller-sessions', `${registration.key}.json`);
    return `${registration.key}:${registration.updatedAt ?? registration.registeredAt ?? 0}:${statIdentity(file)}`;
  }).sort().join('|');
  return `${statIdentity(group.log)}\0${registrations}`;
}

function rememberExpiredRegistration(group, scan, reason, observation) {
  // Do not hide an append/refresh that raced the scan.
  if (expiredRegistrationObservation(group) !== observation) return false;
  expiredRegistrationScans.set(group.logKey, { observation, scan, reason });
  return true;
}

function retentionAnchor(scan) {
  const anchor = Math.max(scan.activityAt ?? -Infinity, scan.latestRefAt ?? -Infinity);
  return Number.isFinite(anchor) ? anchor : null;
}

function sameExpiryStatus(scan, reason) {
  const status = scan.lastStatus;
  return Boolean(status && status.status === 'expired' && status.reason === reason
    && (status.retentionAnchorAt ?? null) === retentionAnchor(scan)
    && (status.refFingerprint ?? '0') === scan.refFingerprint);
}

function dueRegistration(group, now) {
  const observation = expiredRegistrationObservation(group);
  const cached = expiredRegistrationScans.get(group.logKey);
  if (cached && cached.observation === observation) {
    return { group, scan: cached.scan, reason: cached.reason, skip: true };
  }
  expiredRegistrationScans.delete(group.logKey);

  const scan = prScan(group);
  if (scan.missing) {
    const already = sameExpiryStatus(scan, 'missing_log');
    if (already) rememberExpiredRegistration(group, scan, 'missing_log', observation);
    return { group, scan, expired: !already, reason: 'missing_log', skip: true, observation };
  }
  const anchor = retentionAnchor(scan);
  if (anchor == null || now - anchor > RECONCILE_RETENTION_MS) {
    const reason = scan.empty ? 'empty_log' : 'retention';
    const already = sameExpiryStatus(scan, reason);
    if (already) rememberExpiredRegistration(group, scan, reason, observation);
    return { group, scan, expired: !already, reason, skip: true, observation };
  }

  const refChanged = !scan.lastStatus || scan.lastStatus.refFingerprint !== scan.refFingerprint;
  const values = [...scan.prs.values()];
  const nonterminal = values.some(pr => !terminal(pr.state));
  const terminalSet = values.length > 0 && !nonterminal;
  // A new sighting after a terminal result must get one immediate authoritative
  // check (reopen is possible); otherwise a fully terminal set rests until a new
  // pr_ref appears.
  if (terminalSet && !refChanged) return { group, scan, skip: true };

  // A recorder that never emitted end does not grant 24 hours of 15-second
  // polling by itself. Once its producer signal is stale, only a discovered
  // nonterminal PR keeps the registration eligible (at stale cadence).
  if (!refChanged && !producerIsFresh(scan, now) && !nonterminal) return { group, scan, skip: true };

  let dueAt = now;
  if (!refChanged && scan.lastStatus) {
    if (scan.lastStatus.status === 'error' && Number.isFinite(scan.lastStatus.nextDue)) {
      dueAt = scan.lastStatus.nextDue;
    } else {
      dueAt = Number(scan.lastStatus.t || 0) + cadence(scan, now);
    }
  }
  return { group, scan, dueAt, cadenceMs: cadence(scan, now), due: now >= dueAt };
}

const supervisor = {
  active: new Map(),
  ticking: false,
  shuttingDown: false,

  tick() {
    if (this.ticking || this.shuttingDown) return;
    this.ticking = true;
    try {
      const now = supervisorNow();
      const candidates = [];
      const groups = registrationGroups();
      for (const key of expiredRegistrationScans.keys()) {
        if (!groups.has(key)) expiredRegistrationScans.delete(key);
      }
      // Cancellation is log-scoped and remains visible after the session record
      // is removed, so active children are stopped before group enumeration.
      for (const [key, entry] of this.active) {
        if (readCancellation(key)) this.terminate(entry);
      }
      for (const group of groups.values()) {
        if (readCancellation(group.logKey) || this.active.has(group.logKey)) continue;
        const candidate = dueRegistration(group, now);
        if (candidate.expired) {
          this.recordExpired(candidate, now);
        }
        if (candidate.due) candidates.push(candidate);
      }
      for (const candidate of candidates) {
        this.launch(candidate);
      }
    } finally {
      this.ticking = false;
    }
  },

  recordExpired(candidate, now) {
    const { group } = candidate;
    const lease = acquireLease(group.logKey, { registration: group.registrations[0] });
    if (!lease) return;
    try {
      if (readCancellation(group.logKey)) return;
      const current = dueRegistration(group, now);
      if (!current.expired) return;
      const activityAt = Number.isFinite(current.scan.activityAt) ? current.scan.activityAt : null;
      const latestRefAt = Number.isFinite(current.scan.latestRefAt) ? current.scan.latestRefAt : null;
      const retentionAnchorAt = retentionAnchor(current.scan);
      const dedupeKey = `expired:${current.reason}:${retentionAnchorAt}:${current.scan.refFingerprint}`;
      statusEvent(group, 'expired', now, {
        reason: current.reason,
        activityAt,
        latestRefAt,
        retentionAnchorAt,
        refFingerprint: current.scan.refFingerprint,
      }, dedupeKey);
      // Re-read once after recording the status. This makes the cached scan
      // include the durable status append and keeps racing tape changes visible.
      dueRegistration(group, now);
    } finally {
      releaseLease(group.logKey, lease);
    }
  },

  launch(candidate) {
    const { group, scan, cadenceMs } = candidate;
    if (readCancellation(group.logKey)) return;
    const lease = acquireLease(group.logKey, { registration: group.registrations[0] });
    if (!lease) return;
    const slot = acquireSlot({ limit: MAX_POLLS, log: group.log, sessionId: group.registrations[0].sessionId });
    if (!slot) { releaseLease(group.logKey, lease); return; }
    const acquiredAt = supervisorNow();
    if (!scan.cwd || !fs.existsSync(scan.cwd)) {
      const failures = Number((scan.lastStatus && scan.lastStatus.failures) || 0) + 1;
      const delay = Math.min(STALE_MS, FRESH_MS * (2 ** Math.max(0, failures - 1)));
      statusEvent(group, 'error', acquiredAt, {
        message: 'registered cwd is unavailable', failures, nextDue: acquiredAt + delay,
        refFingerprint: scan.refFingerprint,
      });
      releaseLease(group.logKey, lease); releaseLease(slot.key, slot);
      return;
    }

    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const entry = {
      group, scan, cadenceMs, lease, slot, child: null, renewTimer: null,
      settled: false, fenced: false, terminating: false, done, resolveDone,
    };
    const finish = (ok, message) => {
      if (entry.settled) return;
      entry.settled = true;
      if (entry.renewTimer) clearInterval(entry.renewTimer);
      const now = supervisorNow();
      // Renew then revalidate both generations immediately before recording the
      // completion. Cancellation, takeover, or shutdown fences the append.
      const ownsLog = renewLease(lease) && isLeaseCurrent(lease);
      const ownsSlot = renewLease(slot) && isLeaseCurrent(slot);
      const canRecord = ownsLog && ownsSlot && !entry.fenced && !this.shuttingDown && !readCancellation(group.logKey);
      const latest = prScan(group);
      if (canRecord && ok) {
        statusEvent(group, 'success', now, {
          cadenceMs,
          nextDue: now + cadence(latest, now),
          failures: 0,
          refFingerprint: latest.refFingerprint,
          leaseGeneration: lease.generation,
        });
      } else if (canRecord) {
        const failures = Number((scan.lastStatus && scan.lastStatus.failures) || 0) + 1;
        const delay = Math.min(STALE_MS, FRESH_MS * (2 ** Math.max(0, failures - 1)));
        statusEvent(group, 'error', now, {
          message: message || 'poller failed', failures, nextDue: now + delay,
          refFingerprint: latest.refFingerprint,
          leaseGeneration: lease.generation,
        });
      }
      releaseLease(group.logKey, lease); releaseLease(slot.key, slot);
      this.active.delete(group.logKey);
      resolveDone();
      if (!this.shuttingDown) setImmediate(() => this.tick());
    };

    try {
      const child = spawn(process.execPath, [POLLER, '--once', '--known', '--log', group.log], {
        cwd: scan.cwd,
        env: { ...process.env, PATH: TOOL_PATH, NIGHTSHIFT_PR_START_FD: '3' },
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      });
      entry.child = child;
      this.active.set(group.logKey, entry);
      child.once('error', error => finish(false, error && error.message));
      child.once('exit', (code, signal) => finish(code === 0,
        code === 0 ? null : `poller exited ${signal || code}`));
      const bound = bindLease(lease, { writerPid: child.pid }) && bindLease(slot, { writerPid: child.pid });
      if (!bound) {
        entry.fenced = true;
        child.kill('SIGTERM');
        child.stdio[3].destroy();
        return;
      }
      const ttl = Number(process.env.NIGHTSHIFT_PR_LEASE_MS) || 10 * 60 * 1000;
      entry.renewTimer = setInterval(() => {
        const renewed = renewLease(lease) && renewLease(slot);
        if (!renewed) { entry.fenced = true; this.terminate(entry); }
      }, Math.max(10, Math.floor(ttl / 3)));
      entry.renewTimer.unref();
      child.stdio[3].end('g');
    } catch (error) {
      finish(false, error && error.message);
    }
  },

  terminate(entry) {
    if (!entry || entry.settled || entry.terminating) return;
    entry.terminating = true;
    try { entry.child.kill('SIGTERM'); } catch { /* child already gone */ }
  },

  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const entries = [...this.active.values()];
    for (const entry of entries) this.terminate(entry);
    const force = setTimeout(() => {
      for (const entry of entries) if (!entry.settled) try { entry.child.kill('SIGKILL'); } catch { /* gone */ }
    }, 5_000);
    force.unref();
    await Promise.all(entries.map(entry => entry.done));
    clearTimeout(force);
  },

  // A viewer can ask the same durable scheduler to look now; due timestamps and
  // leases remain authoritative, so this never creates a viewer-owned writer.
  kick() { setImmediate(() => this.tick()); },
};

const supervisorTimer = setInterval(() => supervisor.tick(), SUPERVISOR_TICK_MS);
supervisorTimer.unref();
setImmediate(() => supervisor.tick());

// ------------------------------------------------------------------- fleet
// Fleet home (/fleet page + /api/fleet data): one folded row per session — the
// aggregate view an overnight run needs. Folding every tape on every ~15s poll
// would re-parse tens of MB per request (the scanMeta pattern above re-reads the
// whole file each call — deliberately NOT copied here). So each tape's fold is
// CACHED by (size, mtime): a tape only re-folds when it actually grows. The
// summary builder is the SAME pure fold the board uses (public/reducer.js via
// public/fleet-summary.js), so Fleet numbers match the board. It's ESM and this
// server is CommonJS, so it's brought in via dynamic import at boot.
let fleetMod = null;
const fleetReady = import(pathToFileURL(path.join(__dirname, 'public', 'fleet-summary.js')).href)
  .then(m => { fleetMod = m; })
  .catch(err => { console.error('fleet-summary failed to load:', err); });

const fleetCache = new Map(); // file → { size, mtimeMs, id, base }

// The cached half is time-INDEPENDENT (the expensive fold); freshness and the
// 24h merge count are applied per request with the current clock, so a tape with
// no new events still ages from live→stale without a re-fold.
function fleetBase(s) {
  let st;
  try { st = fs.statSync(s.file); } catch { return null; }
  const hit = fleetCache.get(s.file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.id === s.id) return hit.base;
  let raw = '';
  try { raw = fs.readFileSync(s.file, 'utf8'); } catch { return null; }
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    events.push(ev);
  }
  const base = fleetMod.summarizeBase(events, { id: s.id });
  fleetCache.set(s.file, { size: st.size, mtimeMs: st.mtimeMs, id: s.id, base });
  return base;
}

async function serveFleetApi(res) {
  await fleetReady;
  if (!fleetMod) { res.writeHead(503); return res.end('fleet summary unavailable'); }
  const now = Date.now();
  const out = [];
  for (const s of sessions.values()) {
    let row = null;
    try { const base = fleetBase(s); if (base) row = fleetMod.applyNow(base, now); }
    catch { /* one bad tape must not sink the whole fleet view */ }
    if (row) out.push(row);
  }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(out));
}

// ----------------------------------------------------------------- http bits
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2',
};

// ----------------------------------------------------------- shift report
// GET /report?session=<id>&since=<ISO|epoch-ms|Nh> — the morning answer, a pure
// server-side fold of the tape(s) (tools/report-model.mjs) rendered to static
// HTML. Session omitted = aggregate across all served sessions. The heavy work
// (fold → model) is cached per (file, mtime, since); render is cheap and fresh.
const REPORT_MODEL_URL = pathToFileURL(path.join(__dirname, 'tools', 'report-model.mjs')).href;
const reportCache = new Map(); // `${file}\0${mtime}\0${since}` → model

// since accepts an ISO date, an epoch-ms number, or the shorthand Nh/Nd/Nm/Nw
// (also `0` for "all time"). Default: 24h ago.
function parseSince(param, now) {
  const s = (param || '').trim();
  if (!s) return now - 24 * 3600e3;
  const m = /^(\d+)\s*([hdmw])$/i.exec(s);
  if (m) {
    const unit = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2].toLowerCase()];
    return now - Number(m[1]) * unit;
  }
  if (/^\d+$/.test(s)) return Number(s);            // epoch ms (0 = all)
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? now - 24 * 3600e3 : parsed;
}

function readEvents(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const evs = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { evs.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return evs;
}

function sessionModel(s, buildReportModel, sinceParam, now) {
  let mtime = 0;
  try { mtime = fs.statSync(s.file).mtimeMs; } catch { /* gone */ }
  const key = `${s.file}\0${mtime}\0${sinceParam}`;
  const hit = reportCache.get(key);
  if (hit) return hit;
  const model = buildReportModel(readEvents(s.file), parseSince(sinceParam, now), { now });
  reportCache.set(key, model);
  if (reportCache.size > 200) reportCache.delete(reportCache.keys().next().value);
  return model;
}

async function handleReport(req, res, url) {
  let buildReportModel, renderReportHTML;
  try {
    ({ buildReportModel, renderReportHTML } = await import(REPORT_MODEL_URL));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('report module failed to load: ' + (e && e.message));
    return;
  }
  const wantId = url.searchParams.get('session');
  let targets;
  if (wantId) {
    const s = sessions.get(wantId);
    if (!s) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end(`unknown session: ${wantId}`); return; }
    targets = [s];
  } else {
    targets = [...sessions.values()];
  }
  const sinceParam = (url.searchParams.get('since') || '').trim() || '24h';
  const now = Date.now();
  const built = targets.map(s => ({ id: s.id, model: sessionModel(s, buildReportModel, sinceParam, now) }));
  const html = renderReportHTML({ sessions: built, sinceParam });
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    // The board is a live dev tool on localhost with tiny assets — never let the
    // browser cache app code, or a reducer/UI fix silently fails to show up on a
    // plain refresh (the "board looks outdated after a fix" trap).
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  });
}

function sessionFromQuery(url) {
  const id = url.searchParams.get('session');
  return (id && sessions.get(id)) || sessions.get(defaultSession);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/whoami') {
    // Lets tools/board.js confirm it's talking to the GLOBAL sessions board
    // (serving servedDir) and not, say, a `npm run demo` on the same port.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ nightshift: true, dir: servedDir, port: PORT }));
    return;
  }

  if (url.pathname === '/sessions') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([...sessions.values()].map(scanMeta)));
    return;
  }

  if (url.pathname === '/api/fleet') { serveFleetApi(res); return; }

  if (url.pathname === '/fleet') {
    // The Fleet home page. Served explicitly (not via serveStatic, which would
    // 404 an extensionless path) so the URL stays clean — /fleet, not /fleet.html.
    fs.readFile(path.join(PUBLIC, 'fleet.html'), (err, body) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(body);
    });
    return;
  }

  if (url.pathname === '/events') {
    // Whole-tape snapshot as newline-delimited JSON — a plain one-shot GET for
    // consumers that fold the tape once and don't need the live SSE stream (the
    // lane timeline). Same bytes SSE replays on connect, minus the framing.
    const s = sessionFromQuery(url);
    let raw = '';
    try { raw = fs.readFileSync(s.file, 'utf8'); } catch { /* empty/gone → '' */ }
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    res.end(raw);
    return;
  }

  if (url.pathname === '/sse') {
    const s = sessionFromQuery(url);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    // Replay full history, then a ready marker, then live tail.
    const history = fs.readFileSync(s.file, 'utf8');
    for (const line of history.split('\n')) {
      if (line.trim()) res.write(`data: ${line}\n\n`);
    }
    res.write('event: ready\ndata: {}\n\n');
    s.clients.add(res);
    supervisor.kick(); // accelerate the same durable scheduler; never a viewer-owned poller
    // Real `ping` event (not a `:` comment) so the client can observe liveness
    // and detect a wedged socket — a comment fires no handler, so a board left
    // running through a laptop sleep can't tell its stream died.
    const ping = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 25000);
    req.on('close', () => { s.clients.delete(res); clearInterval(ping); });
    return;
  }

  if (url.pathname === '/event' && req.method === 'POST') {
    const s = sessionFromQuery(url);
    let body = '';
    req.on('data', c => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try {
        const ev = JSON.parse(body);
        if (typeof ev.type !== 'string') throw new Error('missing type');
        if (typeof ev.t !== 'number') ev.t = Date.now();
        // Envelope v2: stamp id + source + v only if missing, so a client that
        // already stamped (the board UI) keeps its own, and an item event keeps
        // its work-item id as its identity.
        if (ev.id == null) ev.id = randomUUID();
        if (ev.source == null) ev.source = 'ui';
        if (ev.v == null) ev.v = 2;
        // Dedupe guard: an id we've already appended this session is acked but
        // not written again (add to `seen` synchronously so two racing POSTs with
        // the same id can't both slip through before drain() catches up).
        if (s.seen.has(ev.id)) { res.writeHead(204); res.end(); return; }
        s.seen.add(ev.id);
        fs.appendFileSync(s.file, JSON.stringify(ev) + '\n');
        res.writeHead(204); res.end();
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return;
  }

  if (url.pathname === '/report') {
    handleReport(req, res, url).catch(e => {
      if (res.headersSent) return;
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('report error: ' + (e && e.message));
    });
    return;
  }

  // /lanes?session= is the lane-timeline page (a clean URL for the ?t= deep link
  // target); the query is read client-side, so serve the static HTML as-is.
  if (url.pathname === '/lanes') { req.url = '/lanes.html'; return serveStatic(req, res); }

  // /graph?session= is the work-structure node canvas — the React Flow app whose
  // committed build lives under public/graph-flow/ (see graph-app/ + CLAUDE.md).
  // /graph-svg keeps the legacy hand-rolled SVG view as a temporary escape hatch.
  if (url.pathname === '/graph') { req.url = '/graph-flow/index.html'; return serveStatic(req, res); }
  if (url.pathname === '/graph-svg') { req.url = '/graph.html'; return serveStatic(req, res); }

  // /story?session= is the chaptered session recap — same additive pattern.
  if (url.pathname === '/story') { req.url = '/story.html'; return serveStatic(req, res); }

  serveStatic(req, res);
});

// A supervised board is pinned to its port (board.js and the portless proxy
// expect it there). If the port is already taken — most often by an old
// unmanaged board that hasn't exited yet — fail fast; launchd's KeepAlive retries
// and takes over once the squatter exits. Unmanaged, this just surfaces the
// clash instead of crashing with a stack trace.
server.on('error', err => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use — another server owns it.` +
      (MANAGED ? ' KeepAlive will retry and take over once it exits.' : ''));
  } else {
    console.error('server error:', (err && err.message) || err);
  }
  process.exit(1);
});

let exitStarted = false;
async function gracefulExit() {
  if (exitStarted) return;
  exitStarted = true;
  clearInterval(supervisorTimer);
  await supervisor.shutdown();
  server.close(() => process.exit(0));
  // An idle server can already be non-listening during startup failure.
  if (!server.listening) process.exit(0);
}
process.once('SIGTERM', gracefulExit);
process.once('SIGINT', gracefulExit);

server.listen(PORT, () => {
  const port = server.address().port; // the real bound port (PORT may be 0 = ephemeral)
  console.log(`nightshift  http://localhost:${port}`);
  if (sessions.size === 1) console.log(`tailing     ${sessions.get(defaultSession).file}`);
  else {
    console.log(`serving     ${sessions.size} sessions:`);
    for (const s of sessions.values()) console.log(`  ${s.id}  ${s.file}`);
  }
  if (MANAGED) {
    writeBoardJson(port); // claim board.json now…
    setInterval(() => writeBoardJson(port), 15000).unref(); // …and keep it fresh
  }
});
