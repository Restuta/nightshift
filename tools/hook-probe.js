#!/usr/bin/env node
// Instrumentation, not recording. Codex now supports Claude-Code-style hooks
// (~/.codex/hooks.json), which means we can record Codex from the source
// instead of reverse-engineering its rollout files by heuristic. Before we
// build that, we need to KNOW the exact payload Codex hands a hook — the field
// names we'd depend on are unverified:
//
//   - session_id?  (gating is per-session)               cwd?  rollout/transcript path?
//   - for PostToolUse: tool_name / tool_input shape for exec_command, apply_patch,
//     update_plan; and is exec_command's stdout in the payload (commit/PR capture)?
//   - a thread_source / subagent / parent-id field?  (subagents share the parent
//     cwd and dominate the rollout set — we must be able to suppress them)
//
// This probe just appends each raw payload to ~/.nightshift/hook-debug.jsonl so
// one real Codex session reveals the truth. It is CAPTURE-ONLY: it never writes
// a session tape, never records, never blocks, and cannot grow unbounded. Like
// every nightshift hook, observability must not disturb the agent — every path
// exits 0.

const fs = require('fs');
const os = require('os');
const path = require('path');

const NS_HOME = process.env.NIGHTSHIFT_HOME || path.join(os.homedir(), '.nightshift');
const OUT = path.join(NS_HOME, 'hook-debug.jsonl');
const CAP = 2 * 1024 * 1024; // ~2MB then stop — a probe, not a logger

try {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }

  let size = 0;
  try { size = fs.statSync(OUT).size; } catch { /* not there yet */ }
  if (size >= CAP) process.exit(0);

  let payload;
  try { payload = JSON.parse(input); } catch { payload = { _unparsed: input.slice(0, 4000) }; }

  fs.mkdirSync(NS_HOME, { recursive: true });
  // Record the top-level keys explicitly too — the whole point is to learn the
  // shape, and a quick scan of `keys` across events answers most of it.
  fs.appendFileSync(OUT, JSON.stringify({
    t: Date.now(),
    keys: payload && typeof payload === 'object' ? Object.keys(payload) : null,
    payload,
  }) + '\n');
} catch { /* a probe must never break the session */ }

process.exit(0);
