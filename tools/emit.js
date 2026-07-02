#!/usr/bin/env node
// Append an event to the log from the CLI.
//   node tools/emit.js item --id wi-ui --title "Kanban UI" --status doing
//   node tools/emit.js note --text "switched SSE to chunked tail"
//   node tools/emit.js pr --number 1 --state open --url https://...
// Numbers are auto-coerced. --log overrides the target log file.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');

const [type, ...rest] = process.argv.slice(2);
if (!type || type.startsWith('--')) {
  console.error('usage: emit.js <type> [--key value ...]');
  process.exit(1);
}

// Envelope v2: unique event id + source + v. `--id` (item events' work-item id)
// overrides the UUID in the loop below — item ids are reused across a card's
// transitions, so the item id, not a per-line UUID, is this event's identity.
const ev = { t: Date.now(), id: randomUUID(), source: 'emit', v: 2, type };
let log = path.join(process.env.CLAUDE_PROJECT_DIR || '.', '.nightshift', 'events.jsonl');

for (let i = 0; i < rest.length; i += 2) {
  const key = String(rest[i] || '').replace(/^--/, '');
  const raw = rest[i + 1];
  if (!key || raw === undefined) continue;
  if (key === 'log') { log = raw; continue; }
  ev[key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
}

fs.mkdirSync(path.dirname(log), { recursive: true });
fs.appendFileSync(log, JSON.stringify(ev) + '\n');
console.log(JSON.stringify(ev));
