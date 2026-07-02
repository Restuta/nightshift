#!/usr/bin/env node
// tools/tape-doctor.js — offline tape repair. Zero deps.
//
// Operates ONLY on the explicit file/dir you pass. It NEVER defaults to, scans,
// or writes ~/.nightshift — the coordinator points it at real tapes explicitly.
//
//   node tools/tape-doctor.js <file> [--dedupe] [--sort] [--retract-junk] [--apply]
//   node tools/tape-doctor.js --collapse-dupes <dir> [--archive-to <dir>] [--apply]
//
// Default is a DRY RUN: it prints a human-readable report of what WOULD change.
// Pass --apply to actually write. Before modifying any file it first writes a
// sibling backup <file>.bak-<epoch>. It never deletes: --collapse-dupes MOVES the
// redundant tapes to an archive location (default: alongside, suffixed .dup).
//
// What each pass fixes (from the real-corpus forensics behind Phase 0):
//   --dedupe        the n154 corruption — a whole 14k-event stream re-appended,
//                   creating exact-duplicate lines and a backward-time "seam".
//   --sort          out-of-order tapes, so scrub-to-end == live fold.
//   --retract-junk  harness-injected cards ("<task-notification>", …) that an
//                   append-only tape would otherwise render forever.
//   --collapse-dupes  a fleet of near-identical worktree copies of one session.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');

// A backward jump in t larger than this is almost certainly a re-append seam
// (the n154 tape jumped ~10h backward mid-file), not real clock skew.
const REAPPEND_SEAM_MS = 60 * 60 * 1000;

// Two tapes whose core-event sets overlap by more than this are the same session
// (a worktree copy). Compared on core content, ignoring envelope meta, so copies
// re-stamped with fresh ids still match.
const SAME_SESSION_OVERLAP = 0.9;

// Harness-injected junk card titles — cards a producer bug minted that were never
// real work (system reminders, captured local-command output, task notifications,
// or a bare command tag). A documented, auditable constant.
const JUNK_TITLE_PATTERNS = [
  /^<task-notification>/,   // background task notification echoed as a prompt
  /^<local-command/,        // captured stdout of a local `!` command
  /^Caveat:/,               // the "Caveat: The messages below..." system preamble
  /^<[a-z][\w-]*>$/i,       // a bare command tag, e.g. "<command-name>"
];

// ------------------------------------------------------------------ parsing

function readLines(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.length) continue; // skip blank lines (incl. a trailing newline)
    let ev = null;
    try { ev = JSON.parse(line); } catch { /* keep unparseable lines verbatim */ }
    out.push({ raw: line, ev });
  }
  return out;
}

function writeLines(file, records) {
  fs.writeFileSync(file, records.map(r => r.raw).join('\n') + '\n');
}

function backup(file) {
  const bak = `${file}.bak-${Date.now()}`;
  fs.copyFileSync(file, bak);
  return bak;
}

// ------------------------------------------------------------------ dedupe

// Remove exact-duplicate lines (keep first) AND duplicate envelope-id lines
// (keep first). Item events are exempt from id-dedupe: their `id` is the
// work-item id, legitimately reused across a card's transitions (doing→done),
// so they are deduped by exact line only.
function dedupe(records) {
  const seenRaw = new Set();
  const seenId = new Set();
  const kept = [];
  let removedExact = 0, removedId = 0;
  for (const r of records) {
    if (seenRaw.has(r.raw)) { removedExact++; continue; }
    const ev = r.ev;
    const idDedupable = ev && ev.id != null && ev.type !== 'item';
    if (idDedupable && seenId.has(ev.id)) { removedId++; continue; }
    seenRaw.add(r.raw);
    if (idDedupable) seenId.add(ev.id);
    kept.push(r);
  }
  return { kept, removedExact, removedId };
}

// Backward time jumps (> REAPPEND_SEAM_MS) in file order — the signature of a
// stream re-appended onto itself. Report-only; --dedupe is the actual fix.
function findSeams(records) {
  const seams = [];
  let prevT = null, prevI = -1;
  records.forEach((r, i) => {
    const t = r.ev && typeof r.ev.t === 'number' ? r.ev.t : null;
    if (t == null) return;
    if (prevT != null && prevT - t > REAPPEND_SEAM_MS) {
      seams.push({ index: i, fromT: prevT, toT: t, backMs: prevT - t, prevIndex: prevI });
    }
    prevT = t; prevI = i;
  });
  return seams;
}

// -------------------------------------------------------------------- sort

// Stable sort by t (V8's Array.sort is stable, so equal t keeps file order).
// Unparseable / t-less lines sort to the end, order preserved.
function sortByT(records) {
  const key = r => (r.ev && typeof r.ev.t === 'number') ? r.ev.t : Infinity;
  const sorted = records.map((r, i) => ({ r, i, k: key(r) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map(x => x.r);
  let moved = 0;
  for (let i = 0; i < sorted.length; i++) if (sorted[i] !== records[i]) moved++;
  return { sorted, moved };
}

// -------------------------------------------------------------- retract-junk

// Item ids whose title matches a junk pattern (first title seen wins), minus any
// already retracted by an existing retract event — so a second run is a no-op.
function junkItemIds(records) {
  const titled = new Map();          // item id → title
  const alreadyRetracted = new Set();
  for (const { ev } of records) {
    if (!ev) continue;
    if (ev.type === 'item' && ev.id != null && ev.title != null && !titled.has(ev.id)) {
      titled.set(ev.id, ev.title);
    }
    if (ev.type === 'retract' && ev.target && ev.target.item != null) {
      alreadyRetracted.add(ev.target.item);
    }
  }
  const junk = [];
  for (const [id, title] of titled) {
    if (alreadyRetracted.has(id)) continue;
    if (JUNK_TITLE_PATTERNS.some(re => re.test(title))) junk.push({ id, title });
  }
  return junk;
}

function retractRecord(itemId) {
  const ev = {
    t: Date.now(), id: randomUUID(), source: 'backfill', v: 2,
    type: 'retract', target: { item: itemId }, reason: 'harness-injected card (tape-doctor --retract-junk)',
  };
  return { raw: JSON.stringify(ev), ev };
}

// ----------------------------------------------------------- collapse-dupes

// The set of core-event strings for a tape: t + type + payload, with the
// envelope meta (id/source/v) stripped so copies re-stamped with fresh ids still
// match. Used to measure how much two tapes overlap.
function coreSet(file) {
  const set = new Set();
  let records;
  try { records = readLines(file); } catch { return set; }
  for (const { ev, raw } of records) {
    if (!ev) { set.add('raw:' + raw); continue; }
    const { id, source, v, ...core } = ev;
    // Stable stringify: sort keys so field order can't change the hash.
    const keys = Object.keys(core).sort();
    set.add(JSON.stringify(keys.map(k => [k, core[k]])));
  }
  return set;
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / small.size; // fraction of the smaller tape contained in the larger
}

function collapseDupes(dir, archiveTo, apply) {
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(dir, f));
  const cores = new Map(files.map(f => [f, coreSet(f)]));
  const assigned = new Set();
  const clusters = [];
  // Largest core-set first, so the biggest/cleanest tape anchors each cluster.
  const bySize = files.slice().sort((a, b) => cores.get(b).size - cores.get(a).size);
  for (const f of bySize) {
    if (assigned.has(f)) continue;
    const members = [f];
    assigned.add(f);
    for (const g of bySize) {
      if (assigned.has(g)) continue;
      if (overlap(cores.get(f), cores.get(g)) > SAME_SESSION_OVERLAP) {
        members.push(g); assigned.add(g);
      }
    }
    if (members.length > 1) clusters.push(members);
  }

  const moves = [];
  for (const members of clusters) {
    const [keep, ...dups] = members; // keep is the largest (anchor)
    for (const dup of dups) {
      const dest = archiveTo
        ? path.join(archiveTo, path.basename(dup) + '.dup')
        : dup + '.dup';
      moves.push({ from: dup, to: dest, keep });
      if (apply) {
        if (archiveTo) fs.mkdirSync(archiveTo, { recursive: true });
        try { fs.renameSync(dup, dest); }
        catch { fs.copyFileSync(dup, dest); fs.unlinkSync(dup); } // cross-device
      }
    }
  }
  return { clusters, moves, fileCount: files.length };
}

// --------------------------------------------------------------------- cli

function parseArgs(argv) {
  const flags = { dedupe: false, sort: false, retractJunk: false, apply: false, collapseDir: null, archiveTo: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dedupe') flags.dedupe = true;
    else if (a === '--sort') flags.sort = true;
    else if (a === '--retract-junk') flags.retractJunk = true;
    else if (a === '--apply') flags.apply = true;
    else if (a === '--collapse-dupes') flags.collapseDir = argv[++i];
    else if (a === '--archive-to') flags.archiveTo = argv[++i];
    else positional.push(a);
  }
  flags.file = positional[0] || null;
  return flags;
}

function reportCollapse(dir, res, apply) {
  const out = [];
  out.push(`tape-doctor --collapse-dupes ${dir}`);
  out.push(`  ${res.fileCount} tape(s) scanned, ${res.clusters.length} duplicate cluster(s)`);
  for (const c of res.clusters) {
    out.push(`  same session (${c.length} copies): keep ${path.basename(c[0])}`);
    for (const m of res.moves.filter(x => x.keep === c[0])) {
      out.push(`    ${apply ? 'moved' : 'would move'} ${path.basename(m.from)} → ${m.to}`);
    }
  }
  if (!res.clusters.length) out.push('  no near-identical tapes found');
  if (!apply && res.moves.length) out.push('  (dry run — pass --apply to move)');
  return out.join('\n');
}

function doctorFile(file, flags) {
  let records = readLines(file);
  const before = records.map(r => r.raw).join('\n');
  const out = [`tape-doctor ${file}`, `  ${records.length} line(s) read`];

  if (flags.dedupe) {
    const seams = findSeams(records);
    const { kept, removedExact, removedId } = dedupe(records);
    records = kept;
    out.push(`  dedupe: removed ${removedExact} exact-duplicate + ${removedId} duplicate-id line(s)`);
    if (seams.length) {
      out.push(`  seams: ${seams.length} re-append seam(s) (backward t jump > ${REAPPEND_SEAM_MS / 3600e3}h)`);
      for (const s of seams) {
        out.push(`    line ${s.index}: t jumps back ${(s.backMs / 3600e3).toFixed(1)}h ` +
          `(${new Date(s.fromT).toISOString()} → ${new Date(s.toT).toISOString()})`);
      }
    }
  }

  if (flags.sort) {
    const { sorted, moved } = sortByT(records);
    records = sorted;
    out.push(`  sort: reordered ${moved} line(s) by t`);
  }

  if (flags.retractJunk) {
    const junk = junkItemIds(records);
    for (const j of junk) records.push(retractRecord(j.id));
    out.push(`  retract-junk: ${junk.length} junk card(s) retracted` +
      (junk.length ? ` — ${junk.map(j => j.id).join(', ')}` : ''));
  }

  const after = records.map(r => r.raw).join('\n');
  const changed = after !== before;
  if (!changed) {
    out.push('  no changes');
  } else if (flags.apply) {
    const bak = backup(file);
    writeLines(file, records);
    out.push(`  applied — backup at ${path.basename(bak)}`);
  } else {
    out.push('  (dry run — pass --apply to write; a .bak is made first)');
  }
  return out.join('\n');
}

function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.collapseDir) {
    if (!fs.existsSync(flags.collapseDir) || !fs.statSync(flags.collapseDir).isDirectory()) {
      console.error(`--collapse-dupes: not a directory: ${flags.collapseDir}`);
      process.exit(1);
    }
    const res = collapseDupes(flags.collapseDir, flags.archiveTo, flags.apply);
    console.log(reportCollapse(flags.collapseDir, res, flags.apply));
    return;
  }

  if (!flags.file) {
    console.error('usage: tape-doctor.js <file> [--dedupe] [--sort] [--retract-junk] [--apply]');
    console.error('       tape-doctor.js --collapse-dupes <dir> [--archive-to <dir>] [--apply]');
    process.exit(1);
  }
  if (!fs.existsSync(flags.file)) { console.error(`no such file: ${flags.file}`); process.exit(1); }
  if (!flags.dedupe && !flags.sort && !flags.retractJunk) {
    console.error('nothing to do — pass at least one of --dedupe / --sort / --retract-junk');
    process.exit(1);
  }
  console.log(doctorFile(flags.file, flags));
}

if (require.main === module) main();

// Exported for the golden-tape tests (and reuse); the CLI is the primary use.
module.exports = {
  readLines, dedupe, findSeams, sortByT, junkItemIds, collapseDupes,
  JUNK_TITLE_PATTERNS, REAPPEND_SEAM_MS, SAME_SESSION_OVERLAP,
};
