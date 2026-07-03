#!/usr/bin/env node
// Retire THIS session's open per-turn card, if any, then forget it.
//
// Per-turn cards (Codex always, Claude in central recordings) are normally
// closed by an end-of-turn signal: Claude's Stop hook, or the Codex meter's
// idle-retire. But `/nightshift off` drops the active marker, which gates the
// hook/meter out — so a card opened mid-turn would sit in "doing" forever on the
// kept tape. The off flow runs this first to close it cleanly.
//
//   node tools/retire-turn.js --log <log>
//
// Session id comes from the host env ($CLAUDE_CODE_SESSION_ID or
// $CODEX_THREAD_ID), the same key the hook writes turns/<sid>.json under.
// No open card → no-op. Like every nightshift recorder path: never throw.

const fs = require('fs');
const os = require('os');
const path = require('path');

try {
  const args = process.argv.slice(2);
  const li = args.indexOf('--log');
  const log = li !== -1 ? args[li + 1] : process.env.NIGHTSHIFT_LOG;
  const sid = process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID;
  if (!log || !sid) process.exit(0);

  const NS_HOME = process.env.NIGHTSHIFT_HOME || path.join(os.homedir(), '.nightshift');
  const tf = path.join(NS_HOME, 'turns', sid + '.json');
  let st;
  try { st = JSON.parse(fs.readFileSync(tf, 'utf8')); } catch { process.exit(0); }
  if (!st || !st.card) process.exit(0);

  // Envelope v2: source + v. No UUID — this is an item event, so `id` is the
  // work-item (card) id, the same identity the hook created it under. `st.card`
  // carries the full namespaced id (turn-<sid8>-<n>) from THIS session's turnState,
  // so a scoped retire only ever closes our own card, never another session's on a
  // shared tape (plan 1.3).
  fs.appendFileSync(log, JSON.stringify({ t: Date.now(), source: 'hook', v: 2, type: 'item', id: st.card, status: 'done' }) + '\n');
  // Forget the card but keep the turn counter: a later `/nightshift on` (continue)
  // resumes numbering instead of restarting at turn 1.
  st.card = null;
  fs.writeFileSync(tf, JSON.stringify(st));
} catch { /* observability must never break the session */ }
process.exit(0);
