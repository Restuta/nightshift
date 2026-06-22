#!/usr/bin/env node
// Pick how to record THIS Codex session, and start it. Codex loads hooks at
// session start, so a session that began BEFORE the nightshift hook was
// installed can't be recorded by hooks — `/nightshift` must fall back to the
// full rollout tailer for it. This decides and starts the right one, so the
// skill never has to think about it:
//
//   - session started AFTER the hook install  → hook recording + thin --meter
//   - session started BEFORE (or unknown)     → full tailer, pinned to the exact
//     rollout (no marker, so hooks can't double-record), backfilling the session
//
// Either way it pins to the exact rollout via $CODEX_THREAD_ID (== the hook
// payload's session_id), so there's no rollout guessing. Prints the mode chosen.
//
//   node tools/codex-recorder.js <log>

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const here = path.resolve(__dirname, '..');
const NS_HOME = process.env.NIGHTSHIFT_HOME || path.join(os.homedir(), '.nightshift');
const LOG = process.argv[2];
const tid = process.env.CODEX_THREAD_ID || '';

if (!LOG) { console.error('usage: codex-recorder.js <log>'); process.exit(1); }

// The rollout file whose name carries this thread id.
function findRollout(id) {
  if (!id) return null;
  const base = path.join(os.homedir(), '.codex', 'sessions');
  let found = null;
  const walk = d => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.includes(id) && /^rollout-.*\.jsonl$/.test(e.name)) found = p;
    }
  };
  walk(base);
  return found;
}

// Session start time, parsed from the rollout filename (rollout-YYYY-MM-DDTHH-MM-SS-…).
function startTime(p) {
  const m = path.basename(p).match(/rollout-(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)/);
  if (m) { const v = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`); if (v) return v; }
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

const node = process.execPath;
const tail = path.join(here, 'tools', 'codex-tail.js');
const rollout = findRollout(tid);

let installedAt = 0;
try { installedAt = fs.statSync(path.join(NS_HOME, 'codex-hook-installed')).mtimeMs; } catch { /* hook never installed */ }

// Hooks can record only a session that started after they were installed (Codex
// loads hooks at session start). Need the thread id + a found rollout to judge.
const hookLive = !!(tid && rollout && installedAt && startTime(rollout) >= installedAt);

if (hookLive) {
  // Hook mode: mark the session (gates the hooks), seed the session-start event
  // the hook missed (it fired before the marker existed), start the thin meter.
  fs.mkdirSync(path.join(NS_HOME, 'active'), { recursive: true });
  fs.writeFileSync(path.join(NS_HOME, 'active', tid), '');
  spawnSync(node, [path.join(here, 'tools', 'emit.js'), 'session', '--phase', 'start',
    '--agent', 'codex', '--title', path.basename(process.cwd()), '--cwd', process.cwd(), '--log', LOG], { stdio: 'ignore' });
  spawnSync(node, [tail, '--meter', '--log', LOG, ...(rollout ? [rollout] : [])], { stdio: 'ignore' });
  console.log('hook');
} else {
  // Fallback: full tailer pinned to the rollout. No marker, so even if the hook
  // is somehow loaded it stays gated off and can't double-record. The tailer
  // backfills the whole session from the rollout.
  spawnSync(node, [tail, '--log', LOG, ...(rollout ? [rollout] : [])], { stdio: 'ignore' });
  console.log('tail');
}
