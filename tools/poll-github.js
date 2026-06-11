#!/usr/bin/env node
// Record GitHub PR/CI facts as events — never fetched at render time, per the
// core rule in docs/EVENTS.md: replaying yesterday's session must show
// yesterday's CI status.
//   node tools/poll-github.js [--once] [--interval <sec>=30] [--limit <prs>=100]
//     [--repo owner/name] [--log <file>]
//
// Uses the gh CLI (auth included), zero deps. Stateless across restarts: the
// known pr/ci state per PR number is folded out of the log itself — the full
// log on the first tick, then only newly appended bytes — and each tick
// appends only what changed. Safe to restart, safe to run alongside hooks,
// idempotent.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--once') flags.once = true;
  else if (argv[i] === '--interval') flags.interval = Number(argv[++i]);
  else if (argv[i] === '--limit') flags.limit = Number(argv[++i]);
  else if (argv[i] === '--repo') flags.repo = argv[++i];
  else if (argv[i] === '--log') flags.log = argv[++i];
}
const posInt = (n, dflt) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt);
const LOG = flags.log || path.join('.nightshift', 'events.jsonl');
const INTERVAL = posInt(flags.interval, 30) * 1000;
const LIMIT = posInt(flags.limit, 100);

function ghPrs() {
  const args = ['pr', 'list', '--state', 'all', '--limit', String(LIMIT),
    '--json', 'number,title,url,state,statusCheckRollup'];
  if (flags.repo) args.push('--repo', flags.repo);
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
}

// Collapse a statusCheckRollup array to one ci status; null when there are no
// checks (a ci event with nothing behind it would be noise).
function rollupCi(checks) {
  if (!Array.isArray(checks) || !checks.length) return null;
  let pending = false;
  for (const c of checks) {
    const conclusion = c.conclusion || '';
    if (/FAILURE|TIMED_OUT|STARTUP_FAILURE|ACTION_REQUIRED/.test(conclusion)) return 'fail';
    if (c.status && c.status !== 'COMPLETED') pending = true;
  }
  return pending ? 'pending' : 'pass';
}

// What the log already knows, folded incrementally: full read on the first
// call, then only the bytes appended since. The offset only advances past
// complete lines, so a concurrent writer's half-flushed line is re-read whole
// on the next tick instead of being lost.
const known = new Map(); // number → {state, ci}
let offset = 0;

function refreshKnown() {
  let fd;
  try { fd = fs.openSync(LOG, 'r'); } catch { return; } // no log yet
  try {
    const size = fs.fstatSync(fd).size;
    if (size < offset) { known.clear(); offset = 0; } // log truncated/replaced
    if (size === offset) return;
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const chunk = buf.toString('utf8');
    const complete = chunk.lastIndexOf('\n');
    if (complete < 0) return;
    offset += Buffer.byteLength(chunk.slice(0, complete + 1));
    for (const line of chunk.slice(0, complete).split('\n').filter(Boolean)) {
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'pr' && ev.number != null) {
        known.set(ev.number, { ...(known.get(ev.number) || {}), state: ev.state });
      } else if (ev.type === 'ci' && ev.pr != null) {
        known.set(ev.pr, { ...(known.get(ev.pr) || {}), ci: ev.status });
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function append(ev) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...ev }) + '\n');
  console.log(JSON.stringify(ev));
}

function tick() {
  let prs;
  try { prs = ghPrs(); } catch (err) {
    console.error(`gh failed: ${String(err.message || err).split('\n')[0]}`);
    if (flags.once) process.exit(1);
    return;
  }
  refreshKnown();
  for (const pr of prs) {
    const state = pr.state.toLowerCase(); // open | merged | closed
    const ci = rollupCi(pr.statusCheckRollup);
    const k = known.get(pr.number) || {};
    if (k.state !== state) {
      append({ type: 'pr', number: pr.number, title: pr.title, url: pr.url, state });
      known.set(pr.number, { ...known.get(pr.number), state });
    }
    if (ci != null && k.ci !== ci) {
      append({ type: 'ci', pr: pr.number, status: ci });
      known.set(pr.number, { ...known.get(pr.number), ci });
    }
  }
}

tick();
if (!flags.once) {
  console.error(`polling every ${INTERVAL / 1000}s (limit ${LIMIT} PRs) → ${LOG} (ctrl-c to stop)`);
  setInterval(tick, INTERVAL);
}
