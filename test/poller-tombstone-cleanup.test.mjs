import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const registrationFile = require.resolve('../tools/poller-registration.js');

function withHome(home, fn) {
  const previous = process.env.NIGHTSHIFT_HOME;
  process.env.NIGHTSHIFT_HOME = home;
  try { return fn(); }
  finally {
    if (previous == null) delete process.env.NIGHTSHIFT_HOME;
    else process.env.NIGHTSHIFT_HOME = previous;
  }
}

function retirementEntries(home, scope, key) {
  const dir = path.join(home, scope === 'slots' ? 'poller-slots' : 'poller-leases');
  try {
    return fs.readdirSync(dir).filter(file =>
      file.startsWith(`${key}.lock.stale.`) || file.startsWith(`${key}.lock.claims.`));
  } catch { return []; }
}

test('repeated lease and slot generations do not accumulate retirement directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-retirement-bound-'));
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'repo');
  const log = path.join(cwd, 'events.jsonl');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(log, '');

  withHome(home, () => {
    delete require.cache[registrationFile];
    const api = require(registrationFile);
    const registration = api.registerSession({ log, sessionId: 'bounded-retirements', cwd });
    let logFence;
    let slotFence;
    for (let generation = 0; generation < 20; generation++) {
      const lease = api.acquireLease(registration.logKey, { ttlMs: 10_000 });
      assert.ok(lease, `log generation ${generation} acquires`);
      assert.equal(api.releaseLease(registration.logKey, lease), true);
      const slot = api.acquireSlot({ limit: 1, ttlMs: 10_000 });
      assert.ok(slot, `slot generation ${generation} acquires`);
      assert.equal(api.releaseLease(slot), true);
      if (generation === 0) {
        logFence = retirementEntries(home, 'logs', registration.logKey);
        slotFence = retirementEntries(home, 'slots', 'slot-0');
      }
    }
    assert.equal(logFence.filter(entry => entry.includes('.claims.')).length, 0);
    assert.equal(slotFence.filter(entry => entry.includes('.claims.')).length, 0);
    assert.equal(logFence.filter(entry => entry.includes('.stale.')).length, 1);
    assert.equal(slotFence.filter(entry => entry.includes('.stale.')).length, 1);
    assert.deepEqual(retirementEntries(home, 'logs', registration.logKey), logFence,
      'log generations reuse one bounded legacy compatibility fence');
    assert.deepEqual(retirementEntries(home, 'slots', 'slot-0'), slotFence,
      'slot generations reuse one bounded legacy compatibility fence');
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a live contender claim keeps its generation tombstone until a later collection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-retirement-claim-'));
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'repo');
  const log = path.join(cwd, 'events.jsonl');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(log, '');

  withHome(home, () => {
    delete require.cache[registrationFile];
    const api = require(registrationFile);
    const registration = api.registerSession({ log, sessionId: 'claimed-retirement', cwd });
    const leases = path.join(home, 'poller-leases');
    const tombstone = path.join(leases, `${registration.logKey}.lock.stale.protected`);
    const claims = path.join(leases, `${registration.logKey}.lock.claims.protected`);
    const claim = path.join(claims, `${process.pid}.live.json`);
    fs.mkdirSync(tombstone, { recursive: true });
    fs.writeFileSync(path.join(tombstone, 'owner.json'), `${JSON.stringify({
      generation: 'nightshift-claims-v2', claimGeneration: 'protected', leaseProtocol: 2,
    })}\n`);
    fs.mkdirSync(claims, { recursive: true });
    fs.writeFileSync(claim, `${JSON.stringify({ pid: process.pid })}\n`);

    let lease = api.acquireLease(registration.logKey, { ttlMs: 10_000 });
    assert.ok(lease);
    assert.equal(api.releaseLease(registration.logKey, lease), true);
    assert.equal(fs.existsSync(tombstone), true, 'a paused live contender keeps the ABA fence');

    fs.unlinkSync(claim);
    const orphanClaims = path.join(leases, `${registration.logKey}.lock.claims.orphan`);
    fs.mkdirSync(orphanClaims);
    fs.writeFileSync(path.join(orphanClaims, '999999999.orphan.json'), '{}\n');
    lease = api.acquireLease(registration.logKey, { ttlMs: 10_000 });
    assert.ok(lease);
    assert.equal(api.releaseLease(registration.logKey, lease), true);
    assert.equal(fs.existsSync(tombstone), false, 'the unclaimed tombstone is collected later');
    assert.equal(fs.existsSync(claims), false, 'the empty claim directory is collected with it');
    assert.equal(fs.existsSync(orphanClaims), false, 'a dead claim without a tombstone is also collected');
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('one non-empty compatibility fence blocks a delayed pre-claim contender', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-retirement-legacy-'));
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'repo');
  const log = path.join(cwd, 'events.jsonl');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(log, '');

  withHome(home, () => {
    delete require.cache[registrationFile];
    const api = require(registrationFile);
    const registration = api.registerSession({ log, sessionId: 'mixed-version', cwd });
    const stale = api.acquireLease(registration.logKey, { now: 1, ttlMs: 1 });
    assert.ok(stale);
    const observedByLegacy = api.readLease(registration.logKey);
    const leaseDir = path.join(home, 'poller-leases', `${registration.logKey}.lock`);
    const legacyIdentity = crypto.createHash('sha256')
      .update(`generation:${observedByLegacy.generation}`).digest('hex').slice(0, 32);
    const legacyDestination = `${leaseDir}.stale.${legacyIdentity}`;
    assert.ok(fs.readdirSync(legacyDestination).length > 0, 'legacy destination is already non-empty');

    const successor = api.acquireLease(registration.logKey, { now: 10, ttlMs: 10_000 });
    assert.ok(successor, 'claim-aware takeover publishes a successor');
    assert.throws(() => fs.renameSync(leaseDir, legacyDestination), error =>
      error && ['EEXIST', 'ENOTEMPTY'].includes(error.code),
    'a delayed old contender cannot rename the live successor onto its stable destination');
    const current = api.readLease(registration.logKey);
    assert.equal(current.claimGeneration, successor.generation);
    assert.equal(api.isLeaseCurrent(successor, { allowExpired: true }), true);
    assert.equal(api.releaseLease(successor), true);
    if (stale._fd != null) try { fs.closeSync(stale._fd); } catch { /* retired generation */ }
  });

  fs.rmSync(dir, { recursive: true, force: true });
});
