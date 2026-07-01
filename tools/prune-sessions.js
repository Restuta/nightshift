#!/usr/bin/env node
// Keep the board's session list from growing without bound: archive (or delete)
// tapes that have gone stale. Freshness is the file's mtime — a tape untouched
// for N days is done. Archiving MOVES the tape to ~/.nightshift/archive/ (fully
// reversible — move it back to re-list it); --delete removes it for good.
//
//   node tools/prune-sessions.js [--days N=14] [--delete] [--dry-run] [--dir <sessions>]
//
// The board drops archived/deleted tapes from its list within a few seconds (its
// --dir rescan reconciles removals), so no restart is needed.

const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = f => argv.includes(f);

const DAYS = Number(val('--days', '14'));
const DELETE = has('--delete');
const DRY = has('--dry-run');
const NS_HOME = process.env.NIGHTSHIFT_HOME || path.join(os.homedir(), '.nightshift');
const DIR = path.resolve(val('--dir', path.join(NS_HOME, 'sessions')));
const ARCHIVE = path.join(NS_HOME, 'archive');

if (!Number.isFinite(DAYS) || DAYS < 0) { console.error('--days must be a non-negative number'); process.exit(1); }
const cutoff = Date.now() - DAYS * 86400e3;

let files;
try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.jsonl')); }
catch { console.error(`cannot read sessions dir: ${DIR}`); process.exit(1); }

const now = Date.now();
const ageD = m => Math.round((now - m) / 86400e3);
const stale = [];
for (const f of files) {
  const p = path.join(DIR, f);
  let m; try { m = fs.statSync(p).mtimeMs; } catch { continue; }
  if (m < cutoff) stale.push({ f, p, m });
}
stale.sort((a, b) => a.m - b.m); // oldest first

if (!stale.length) { console.log(`nothing untouched > ${DAYS}d in ${DIR} (${files.length} tape(s) kept)`); process.exit(0); }

const verb = DELETE ? 'delete' : 'archive';
console.log(`${verb}${DRY ? ' (dry-run)' : ''}: ${stale.length} of ${files.length} tape(s) untouched > ${DAYS}d`);
for (const s of stale) console.log(`  ${String(ageD(s.m)).padStart(3)}d  ${s.f}`);
if (DRY) { console.log('\n(dry-run — nothing changed)'); process.exit(0); }

if (!DELETE) fs.mkdirSync(ARCHIVE, { recursive: true });
let done = 0;
for (const s of stale) {
  try {
    if (DELETE) fs.unlinkSync(s.p);
    else fs.renameSync(s.p, path.join(ARCHIVE, s.f));
    done++;
  } catch (e) { console.error(`  failed: ${s.f} — ${e.message}`); }
}
console.log(DELETE ? `deleted ${done}/${stale.length}` : `archived ${done}/${stale.length} → ${ARCHIVE}`);
