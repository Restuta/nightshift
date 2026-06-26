#!/usr/bin/env node
// Start recording for THIS Codex session: tail its rollout in full mode. Pins to
// the exact rollout via $CODEX_THREAD_ID (== the hook payload's session_id), so
// there's no rollout guessing. See below for why it's always the full tailer.
//
//   node tools/codex-recorder.js <log>

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const here = path.resolve(__dirname, '..');
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

const node = process.execPath;
const tail = path.join(here, 'tools', 'codex-tail.js');
const rollout = findRollout(tid);

// Always record Codex from the rollout via the full tailer. Codex's hooks don't
// reliably fire tool/prompt events (it varies by Codex version), so the old
// hook+meter hybrid could leave a board showing only cost and PRs — no cards,
// no plan (exactly what the rh-docs session hit). The rollout is the complete,
// authoritative record, so the tailer derives everything: cards from prompts,
// edits from apply_patch, the plan from update_plan, commits/PRs from the shell.
// We write NO active marker, so the agent-hook stays gated off and can't
// double-record. (Sessions that predate the hook install already used this.)
spawnSync(node, [tail, '--log', LOG, ...(rollout ? [rollout] : [])], { stdio: 'ignore' });
console.log('tail');
