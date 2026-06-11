#!/usr/bin/env node
// Best-effort live adapter for Codex sessions. Wire it in ~/.codex/config.toml:
//   notify = ["node", "/path/to/nightshift/hooks/codex-notify.js"]
// Codex invokes it with one JSON argument per notification. Coverage is
// thinner than Claude Code hooks (no per-tool lifecycle): turn completion →
// idle, approval requests → attention. For full Codex tapes, import the
// rollout after the fact (tools/import-transcript.js reads ~/.codex/sessions).
//
// Log resolution: $NIGHTSHIFT_LOG wins; otherwise <cwd>/.nightshift/events.jsonl,
// and only if that .nightshift/ directory already exists — the adapter never
// scatters logs into unattached projects. Contract: never crash, never block.

const fs = require('fs');
const path = require('path');

try {
  const n = JSON.parse(process.argv[process.argv.length - 1] || '{}');
  const type = n.type || '';

  let ev = null;
  if (type === 'agent-turn-complete') {
    ev = { type: 'session', phase: 'idle', agent: 'codex' };
  } else if (/approval/.test(type)) {
    ev = { type: 'session', phase: 'attention', agent: 'codex', text: n.message || 'codex requests approval' };
  }
  if (!ev) process.exit(0);

  let log = process.env.NIGHTSHIFT_LOG;
  if (!log) {
    const cwd = n.cwd || n['turn-cwd'];
    if (!cwd || !fs.existsSync(path.join(cwd, '.nightshift'))) process.exit(0);
    log = path.join(cwd, '.nightshift', 'events.jsonl');
  }
  fs.appendFileSync(log, JSON.stringify({ t: Date.now(), ...ev }) + '\n');
} catch { /* observability must never break the session */ }
process.exit(0);
