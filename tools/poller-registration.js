#!/usr/bin/env node
// Durable PR supervision state. Registrations are session-qualified; writer
// leases, cancellation, diagnostics, and concurrency slots are canonical-log or
// global resources shared by every board process.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const INCOMPLETE_LEASE_GRACE_MS = 1_000;
const LEASE_PROTOCOL = 2;
// Older Nightshift processes derive their ABA retirement destination from the
// persisted `generation`. Keeping that value stable lets one permanent,
// non-empty compatibility fence protect every claim-aware generation.
const LEGACY_FENCE_GENERATION = 'nightshift-claims-v2';

function home() { return process.env.NIGHTSHIFT_HOME || path.join(os.homedir(), '.nightshift'); }
function sessionsDir() { return path.join(home(), 'poller-sessions'); }
function leasesDir(scope = 'logs') {
  return path.join(home(), scope === 'slots' ? 'poller-slots' : 'poller-leases');
}
function cancellationsDir() { return path.join(home(), 'poller-cancellations'); }
function statusDir() { return path.join(home(), 'poller-status'); }

function canonical(file) {
  const absolute = path.resolve(file);
  try { return fs.realpathSync.native(absolute); }
  catch {
    try { return path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute)); }
    catch { return absolute; }
  }
}

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function logKey(log) { return hash(canonical(log)); }
function registrationKey(log, sessionId) { return hash(`${canonical(log)}\0${String(sessionId)}`); }

function atomicWrite(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed or never created */ }
  }
}

function registerSession({ log, sessionId, cwd }) {
  if (!log) throw new Error('registerSession: log is required');
  if (!sessionId) throw new Error('registerSession: sessionId is required');
  if (!cwd) throw new Error('registerSession: cwd is required');
  const realLog = canonical(log);
  const realCwd = canonical(cwd);
  const key = registrationKey(realLog, sessionId);
  const writerKey = logKey(realLog);
  const file = path.join(sessionsDir(), `${key}.json`);
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new/corrupt → replace */ }
  const now = Date.now();
  const registration = {
    key,
    logKey: writerKey,
    log: realLog,
    sessionId: String(sessionId),
    cwd: realCwd,
    registeredAt: existing && Number.isFinite(existing.registeredAt) ? existing.registeredAt : now,
    updatedAt: now,
  };
  atomicWrite(file, registration);
  clearCancellation(writerKey);
  return registration;
}

function requestCancellation({ log, sessionId, reason = 'unregister' }) {
  const key = logKey(log);
  const cancellation = {
    logKey: key,
    log: canonical(log),
    sessionId: sessionId == null ? null : String(sessionId),
    reason,
    generation: crypto.randomUUID(),
    requestedAt: Date.now(),
  };
  atomicWrite(path.join(cancellationsDir(), `${key}.json`), cancellation);
  return cancellation;
}

function readCancellation(key) {
  try { return JSON.parse(fs.readFileSync(path.join(cancellationsDir(), `${key}.json`), 'utf8')); }
  catch { return null; }
}

function clearCancellation(key) {
  try { fs.unlinkSync(path.join(cancellationsDir(), `${key}.json`)); return true; }
  catch { return false; }
}

function unregisterSession({ log, sessionId, cancel = true }) {
  if (!log || !sessionId) return false;
  if (cancel) requestCancellation({ log, sessionId });
  const key = registrationKey(log, sessionId);
  try { fs.unlinkSync(path.join(sessionsDir(), `${key}.json`)); return true; }
  catch { return false; }
}

function listRegistrations() {
  let files = [];
  try { files = fs.readdirSync(sessionsDir()).filter(file => /^[a-f0-9]{64}\.json$/.test(file)).sort(); }
  catch { return []; }
  const out = [];
  for (const file of files) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(sessionsDir(), file), 'utf8'));
      if (!value || !value.key || !value.log || !value.sessionId || !value.cwd) continue;
      value.log = canonical(value.log);
      value.logKey = logKey(value.log);
      out.push(value);
    } catch { /* one torn/foreign file must not hide other sessions */ }
  }
  return out;
}

function alive(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function leasePath(key, scope = 'logs') { return path.join(leasesDir(scope), `${key}.lock`); }
function ownerPath(key, scope = 'logs') { return path.join(leasePath(key, scope), 'owner.json'); }

function readLease(key, options = {}) {
  try { return JSON.parse(fs.readFileSync(ownerPath(key, options.scope), 'utf8')); }
  catch { return null; }
}

function registrationForLog(key) {
  return listRegistrations().find(registration => registration.logKey === key || registration.key === key) || null;
}

function configuredLeaseMs(options) {
  const env = Number(process.env.NIGHTSHIFT_PR_LEASE_MS);
  if (Number.isFinite(options.ttlMs) && options.ttlMs > 0) return options.ttlMs;
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_LEASE_MS;
}

function writeFd(fd, record) {
  const durable = record.leaseProtocol === LEASE_PROTOCOL
    ? { ...record, generation: LEGACY_FENCE_GENERATION, claimGeneration: record.claimGeneration || record.generation }
    : record;
  const body = Buffer.from(JSON.stringify(durable) + '\n');
  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, body, 0, body.length, 0);
  fs.fsyncSync(fd);
}

function sameOwnerFile(lease) {
  if (!lease || lease._fd == null) return false;
  try {
    const held = fs.fstatSync(lease._fd);
    const current = fs.statSync(ownerPath(lease.key, lease.scope));
    return held.dev === current.dev && held.ino === current.ino;
  } catch { return false; }
}

function recordAlive(record, now) {
  if (!record) return false;
  // Once bound, the actual append-capable process is the fence. A dead
  // supervisor cannot make its still-running child safe to overlap merely by
  // letting wall time pass; recovery waits for that writer pid to exit.
  if (record.writerPid && alive(record.writerPid)) return true;
  if (Number(record.expiresAt) <= now) return false;
  return alive(record.ownerPid || record.pid);
}

function quarantineIdentity(record, stat) {
  const generation = record && (record.claimGeneration || record.generation);
  const identity = generation
    ? `${record && record.claimGeneration ? 'claim-generation' : 'generation'}:${generation}`
    : `incomplete:${stat.dev}:${stat.ino}`;
  return hash(identity).slice(0, 32);
}

function legacyFenceIdentity() {
  return hash(`generation:${LEGACY_FENCE_GENERATION}`).slice(0, 32);
}

function legacyFencePath(dir) {
  return `${dir}.stale.${legacyFenceIdentity()}`;
}

function ensureLegacyFence(dir) {
  const fence = legacyFencePath(dir);
  try {
    if (fs.statSync(fence).isDirectory() && fs.readdirSync(fence).length > 0) return true;
  } catch { /* publish below */ }
  const temporary = `${fence}.tmp.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.mkdirSync(temporary, { mode: 0o700 });
    fs.writeFileSync(path.join(temporary, '.legacy-fence'), `${LEASE_PROTOCOL}\n`, { flag: 'wx', mode: 0o600 });
    try { fs.renameSync(temporary, fence); }
    catch (error) {
      if (!error || (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY')) throw error;
    }
  } finally {
    try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* published or raced */ }
  }
  try { return fs.statSync(fence).isDirectory() && fs.readdirSync(fence).length > 0; }
  catch { return false; }
}

function retirementPath(dir, record, stat) {
  return `${dir}.stale.${quarantineIdentity(record, stat)}`;
}

function retirementClaimDir(dir, record, stat) {
  return `${dir}.claims.${quarantineIdentity(record, stat)}`;
}

// A contender publishes its intent outside the directory it may retire, then
// revalidates the authoritative generation before renaming it. That claim is
// the durable fence which lets completed generation tombstones be collected:
// a paused contender either has a visible live claim, or has not revalidated
// yet and will observe that the authoritative generation changed.
function claimRetirement(dir, record, stat) {
  const claimDir = retirementClaimDir(dir, record, stat);
  const token = `${process.pid}.${crypto.randomUUID()}`;
  const file = path.join(claimDir, `${token}.json`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(claimDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token, claimedAt: Date.now() }) + '\n', {
        flag: 'wx', mode: 0o600,
      });
      return { dir: claimDir, file };
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return null;
}

function releaseRetirementClaim(claim) {
  if (!claim) return;
  try { fs.unlinkSync(claim.file); } catch { /* already collected or never published */ }
  try { fs.rmdirSync(claim.dir); } catch { /* another contender still claims this generation */ }
}

function liveRetirementClaims(claimDir) {
  let files;
  try { files = fs.readdirSync(claimDir); } catch { return false; }
  let live = false;
  for (const file of files) {
    const claimFile = path.join(claimDir, file);
    // The pid is in the name so a collector never mistakes a claim whose JSON
    // body is still being written for an abandoned contender.
    const pid = Number(file.split('.', 1)[0]);
    if (alive(pid)) {
      live = true;
      continue;
    }
    try { fs.unlinkSync(claimFile); } catch { /* raced claimant cleanup */ }
  }
  if (!live) {
    try { live = fs.readdirSync(claimDir).length > 0; } catch { live = false; }
  }
  return live;
}

function collectRetirements(dir) {
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  const stalePrefix = `${base}.stale.`;
  const claimPrefix = `${base}.claims.`;
  let entries;
  try { entries = fs.readdirSync(parent); }
  catch { return; }
  const identities = new Set(entries.flatMap(entry => {
    if (entry.startsWith(stalePrefix)) return [entry.slice(stalePrefix.length)];
    if (entry.startsWith(claimPrefix)) return [entry.slice(claimPrefix.length)];
    return [];
  }));
  for (const identity of identities) {
    const claimDir = path.join(parent, `${base}.claims.${identity}`);
    if (liveRetirementClaims(claimDir)) continue;
    const tombstone = path.join(parent, `${base}.stale.${identity}`);
    // Legacy and ownerless generations may still have arbitrarily paused
    // claim-less contenders, so they remain as finite migration fences. Only
    // claim-aware v2 generations are safe to collect automatically.
    let retired = null;
    try { retired = JSON.parse(fs.readFileSync(path.join(tombstone, 'owner.json'), 'utf8')); }
    catch { /* absent compatibility fence, ownerless generation, or no tombstone */ }
    const collectible = identity !== legacyFenceIdentity()
      && retired && retired.leaseProtocol === LEASE_PROTOCOL && retired.claimGeneration;
    if (collectible) {
      try { fs.rmSync(tombstone, { recursive: true, force: true }); }
      catch { continue; }
    }
    try { fs.rmdirSync(claimDir); } catch { /* absent, raced, or newly claimed */ }
  }
}

function acquireLease(key, options = {}) {
  if (!key) throw new Error('acquireLease: key is required');
  const scope = options.scope || 'logs';
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const ttlMs = configuredLeaseMs(options);
  const registration = options.registration || (scope === 'logs' ? registrationForLog(key) : null) || {};
  const dir = leasePath(key, scope);
  fs.mkdirSync(leasesDir(scope), { recursive: true });
  if (!ensureLegacyFence(dir)) return null;

  for (let attempt = 0; attempt < 8; attempt++) {
    const generation = crypto.randomUUID();
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      const fd = fs.openSync(ownerPath(key, scope), 'wx+', 0o600);
      const record = {
        key,
        scope,
        generation,
        claimGeneration: generation,
        leaseProtocol: LEASE_PROTOCOL,
        ownerPid: process.pid,
        writerPid: options.writerPid || null,
        acquiredAt: now,
        renewedAt: now,
        expiresAt: now + ttlMs,
        log: registration.log || options.log || null,
        sessionId: registration.sessionId || options.sessionId || null,
      };
      writeFd(fd, record);
      return Object.assign(record, { _fd: fd, ttlMs });
    } catch (error) {
      if (!error || (error.code !== 'EEXIST' && error.code !== 'ENOTDIR')) {
        // Do not clean up by pathname: this creator may have been quarantined
        // and a successor may already own `dir`. Any ownerless directory left by
        // this failed initialization is recovered after the grace interval.
        throw error;
      }
      const current = readLease(key, { scope });
      let currentStat;
      try { currentStat = fs.statSync(dir); }
      catch (statError) {
        if (statError && statError.code === 'ENOENT') continue;
        return null;
      }
      // Fail closed while a mkdir winner may still be creating owner.json, but
      // eventually recover a process that died between mkdir and owner write.
      if (!current && now - currentStat.mtimeMs <= INCOMPLETE_LEASE_GRACE_MS) return null;
      if (recordAlive(current, now)) return null;
      // Every contender that observed the same generation uses the same durable
      // quarantine path. The first rename wins and leaves a non-empty tombstone;
      // a delayed contender therefore cannot ABA-rename the live successor.
      const stale = retirementPath(dir, current, currentStat);
      if (!current) {
        try {
          // Make an ownerless source non-empty before the atomic rename. If the
          // recovery process dies immediately afterwards, the destination still
          // cannot be replaced by another directory rename.
          fs.writeFileSync(path.join(dir, '.quarantined'), `${Date.now()}\n`, { flag: 'wx', mode: 0o600 });
        } catch (markerError) {
          if (!markerError || markerError.code !== 'EEXIST') {
            if (markerError && markerError.code === 'ENOENT') continue;
            return null;
          }
        }
      }
      let claim;
      try {
        claim = claimRetirement(dir, current, currentStat);
        if (!claim) return null;
        const rechecked = readLease(key, { scope });
        let recheckedStat;
        try { recheckedStat = fs.statSync(dir); }
        catch (statError) {
          if (statError && statError.code === 'ENOENT') continue;
          return null;
        }
        if (quarantineIdentity(rechecked, recheckedStat) !== quarantineIdentity(current, currentStat)) continue;
        try { fs.renameSync(dir, stale); }
        catch (renameError) {
          if (renameError && (renameError.code === 'ENOENT' || renameError.code === 'EEXIST' ||
            renameError.code === 'ENOTEMPTY')) continue;
          return null;
        }
        try {
          fs.writeFileSync(path.join(stale, '.quarantined'), `${Date.now()}\n`, { flag: 'wx', mode: 0o600 });
        } catch { /* owner.json already makes normal-generation quarantines non-empty */ }
      } finally {
        releaseRetirementClaim(claim);
        collectRetirements(dir);
      }
    }
  }
  return null;
}

function isLeaseCurrent(lease, options = {}) {
  if (!sameOwnerFile(lease)) return false;
  let current;
  try { current = JSON.parse(fs.readFileSync(ownerPath(lease.key, lease.scope), 'utf8')); }
  catch { return false; }
  if ((current.claimGeneration || current.generation) !== (lease.claimGeneration || lease.generation)) return false;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  return options.allowExpired === true || Number(current.expiresAt) > now;
}

function updateLease(lease, changes, options = {}) {
  if (!isLeaseCurrent(lease, { now: options.now, allowExpired: options.allowExpired })) return false;
  Object.assign(lease, changes);
  const record = { ...lease };
  delete record._fd; delete record.ttlMs; delete record.slot;
  try { writeFd(lease._fd, record); } catch { return false; }
  return sameOwnerFile(lease);
}

function bindLease(lease, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const ttlMs = configuredLeaseMs({ ttlMs: options.ttlMs || lease.ttlMs });
  if (!Number.isSafeInteger(Number(options.writerPid)) || Number(options.writerPid) <= 0) return false;
  return updateLease(lease, { writerPid: Number(options.writerPid), renewedAt: now, expiresAt: now + ttlMs },
    { now, allowExpired: true });
}

function renewLease(lease, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const ttlMs = configuredLeaseMs({ ttlMs: options.ttlMs || lease.ttlMs });
  return updateLease(lease, { renewedAt: now, expiresAt: now + ttlMs }, { now });
}

function releaseLease(key, held) {
  const lease = held || key;
  if (!lease || !lease.key) return false;
  const previous = {
    writerPid: lease.writerPid,
    renewedAt: lease.renewedAt,
    expiresAt: lease.expiresAt,
    releaseGeneration: lease.releaseGeneration || null,
  };
  const now = Date.now();
  // Install a release guard through this generation's held fd, then verify that
  // fd is still the authoritative owner inode. A successor that won after the
  // read makes updateLease fail; once installed, the live releaser pid prevents
  // protocol-compliant stale takeover until the atomic rename completes.
  if (!updateLease(lease, {
    writerPid: process.pid,
    renewedAt: now,
    expiresAt: Number.MAX_SAFE_INTEGER,
    releaseGeneration: lease.generation,
  }, { now, allowExpired: true })) return false;
  const dir = leasePath(lease.key, lease.scope);
  // Takeover and release retire the same predecessor generation to the same
  // retained non-empty destination. Whichever rename wins excludes the other;
  // the loser cannot accidentally rename a successor at the authoritative path.
  const retired = retirementPath(dir, lease);
  try { fs.renameSync(dir, retired); }
  catch {
    updateLease(lease, previous, { allowExpired: true });
    return false;
  }
  try { if (lease._fd != null) fs.closeSync(lease._fd); } catch { /* already closed */ }
  lease._fd = null;
  try {
    fs.writeFileSync(path.join(retired, '.quarantined'), `${Date.now()}\n`, { flag: 'wx', mode: 0o600 });
  } catch { /* owner.json already keeps the generation tombstone non-empty */ }
  collectRetirements(dir);
  return true;
}

function acquireSlot(options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 2;
  for (let slot = 0; slot < limit; slot++) {
    const lease = acquireLease(`slot-${slot}`, { ...options, scope: 'slots' });
    if (lease) { lease.slot = slot; return lease; }
  }
  return null;
}

function readStatus(key) {
  try { return JSON.parse(fs.readFileSync(path.join(statusDir(), `${key}.json`), 'utf8')); }
  catch { return null; }
}

function writeStatus(key, status, { dedupeKey } = {}) {
  const existing = readStatus(key);
  if (dedupeKey && existing && existing.dedupeKey === dedupeKey) return existing;
  const value = { ...status, logKey: key, dedupeKey: dedupeKey || null, occurrences: 1 };
  atomicWrite(path.join(statusDir(), `${key}.json`), value);
  return value;
}

function cancelAndDrain({ log, sessionId, timeoutMs = 10_000, reason = 'unregister' }) {
  const cancellation = requestCancellation({ log, sessionId, reason });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const lease = readLease(cancellation.logKey);
    if (!lease) {
      unregisterSession({ log, sessionId, cancel: false });
      if (listRegistrations().some(registration => registration.logKey === cancellation.logKey)) {
        clearCancellation(cancellation.logKey);
      }
      return true;
    }
    // A crashed supervisor/writer leaves a recoverable generation. Claim and
    // release it so callers do not wait for a timeout with no process to drain.
    if (!alive(lease.ownerPid) && !alive(lease.writerPid)) {
      const recovered = acquireLease(cancellation.logKey, { now: Number(lease.expiresAt) + 1, ttlMs: 100 });
      if (recovered) releaseLease(cancellation.logKey, recovered);
    }
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); } catch { /* retry */ }
  }
  return false;
}

module.exports = {
  registerSession,
  unregisterSession,
  listRegistrations,
  registrationKey,
  logKey,
  acquireLease,
  bindLease,
  renewLease,
  isLeaseCurrent,
  releaseLease,
  readLease,
  acquireSlot,
  requestCancellation,
  readCancellation,
  clearCancellation,
  cancelAndDrain,
  readStatus,
  writeStatus,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const flag = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
  try {
    if (command === 'register') {
      const result = registerSession({ log: flag('log'), sessionId: flag('session'), cwd: flag('cwd') || process.cwd() });
      process.stdout.write(JSON.stringify(result) + '\n');
    } else if (command === 'unregister') {
      const input = { log: flag('log'), sessionId: flag('session') };
      if (argv.includes('--drain')) {
        const timeoutMs = Number(flag('timeout')) || 10_000;
        if (!cancelAndDrain({ ...input, timeoutMs })) throw new Error(`cancel-and-drain timed out after ${timeoutMs}ms`);
      } else {
        unregisterSession(input);
      }
    } else if (command === 'list') {
      process.stdout.write(JSON.stringify(listRegistrations()) + '\n');
    } else {
      process.stderr.write('usage: poller-registration.js register|unregister --log FILE --session ID [--cwd DIR] [--drain]\n');
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`poller-registration: ${error.message || error}\n`);
    process.exitCode = 1;
  }
}
