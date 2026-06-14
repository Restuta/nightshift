#!/usr/bin/env node
// Live-record a Codex session by tailing its rollout file. Codex has no
// per-tool hooks, but it journals every turn to ~/.codex/sessions/.../rollout-*
// as the session runs — so we watch that and convert new entries to nightshift
// events in the project's central log, giving a live board.
//
//   node tools/codex-tail.js [rollout.jsonl] [--log <events.jsonl>]
//       ensure a detached tailer is running for the current rollout (idempotent)
//   node tools/codex-tail.js --stop [--log <events.jsonl>]   stop it
//   node tools/codex-tail.js --once  [rollout] [--log ...]   one synchronous pass
//
// With no rollout path, the newest rollout (the active session) is used. With
// no --log, the central per-project log for the rollout's cwd is used. It
// appends only new events, so the board's SSE tail stays clean.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const val = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const once = args.includes('--once');
const worker = args.includes('--worker');
const stop = args.includes('--stop');
let rollout = args.find(a => !a.startsWith('--') && a !== val('--log'));

// Newest rollout = the session being written right now.
function newestRollout() {
  const base = path.join(os.homedir(), '.codex', 'sessions');
  let best = null, bestT = 0;
  const walk = d => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^rollout-.*\.jsonl$/.test(e.name)) {
        const m = fs.statSync(p).mtimeMs;
        if (m > bestT) { bestT = m; best = p; }
      }
    }
  };
  walk(base);
  return best;
}

const NS_HOME = process.env.NIGHTSHIFT_HOME || path.join(os.homedir(), '.nightshift');
const stateFile = path.join(NS_HOME, 'codex-tails.json');

// Resolve the destination log from the rollout's cwd (so it lands in that
// project's central tape) unless --log was given.
function centralLogFor(cwd) {
  const slug = (cwd || 'codex').replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '-') || 'codex';
  return path.join(NS_HOME, 'sessions', `${slug}.jsonl`);
}

let LOG = val('--log') || null;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function readState() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } }
function writeState(s) { fs.mkdirSync(NS_HOME, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s) + '\n'); }

// --stop: kill the worker tailing this log (or all of them).
if (stop) {
  const s = readState();
  for (const [key, e] of Object.entries(s)) {
    if (LOG && key !== LOG) continue;
    if (e && e.pid && alive(e.pid)) { try { process.kill(e.pid); } catch { /* gone */ } }
    delete s[key];
  }
  writeState(s);
  process.exit(0);
}

// A long Codex session gets split across rollout files (context compaction
// starts a fresh rollout and continues there). When our rollout goes quiet,
// look for a newer one for the SAME project that has surpassed it, so the tail
// follows the session instead of freezing on the old file.
function findSuccessor(cwd, current) {
  if (!cwd) return null;
  let curM = 0;
  try { curM = fs.statSync(current).mtimeMs; } catch { /* gone */ }
  const base = path.join(os.homedir(), '.codex', 'sessions');
  let best = null, bestM = curM;
  const firstCwd = p => {
    try {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, 4096, 0);
      fs.closeSync(fd);
      const j = JSON.parse(buf.toString('utf8', 0, n).split('\n', 1)[0]);
      return j.payload && j.payload.cwd;
    } catch { return null; }
  };
  const walk = d => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^rollout-.*\.jsonl$/.test(e.name) && p !== current) {
        let m = 0; try { m = fs.statSync(p).mtimeMs; } catch { continue; }
        if (m > bestM && firstCwd(p) === cwd) { best = p; bestM = m; }
      }
    }
  };
  walk(base);
  return best;
}

rollout = rollout || newestRollout();
if (!rollout || !fs.existsSync(rollout)) {
  console.error('no rollout file found — pass one explicitly or start a Codex session first');
  process.exit(1);
}

// Default entrypoint: ensure ONE detached worker is tailing, then return. Keyed
// by the destination log so /nightshift in the same project never double-starts.
if (!worker && !once) {
  if (!LOG) {
    // Peek the rollout's cwd to resolve the log for the dedupe key.
    let cwd = null;
    try {
      for (const line of fs.readFileSync(rollout, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const e = JSON.parse(line);
        if (e.type === 'session_meta' && e.payload && e.payload.cwd) { cwd = e.payload.cwd; break; }
      }
    } catch { /* ignore */ }
    LOG = centralLogFor(cwd);
  }
  const s = readState();
  if (s[LOG] && s[LOG].pid && alive(s[LOG].pid)) { process.exit(0); } // already tailing
  const out = fs.openSync(path.join(NS_HOME, 'codex-tail.log'), 'a');
  const child = spawn(process.execPath, [__filename, '--worker', rollout, '--log', LOG],
    { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  s[LOG] = { pid: child.pid, rollout };
  writeState(s);
  process.exit(0);
}

// --- incremental rollout → nightshift event stepper -------------------------

const state = {
  phase: null, model: null, lastActivityT: null, started: false, titled: false,
  turnN: 0, card: null, // one card per turn (prompt)
  lastToolKey: null, // dedupe Codex's same-instant double-logged commands
  prsSeen: new Set(), // PR numbers we've already emitted 'open' for
  toastPending: new Map(), // call_id → pr number (toast review-ci → ci status)
  openListPending: new Set(), // call_ids of `gh pr list --state open` (authoritative open set)
  pending: new Map(), // call_id → t
};

function parseCommitOutput(text, t) {
  const head = text.match(/\[[^\s\]]+ ([0-9a-f]{7,40})\] (.+)/);
  if (!head) return null;
  const num = re => { const m = text.match(re); return m ? Number(m[1]) : 0; };
  return {
    t, type: 'commit', sha: head[1].slice(0, 7), message: head[2].trim(),
    add: num(/(\d+) insertions?\(\+\)/), del: num(/(\d+) deletions?\(-\)/),
    files: num(/(\d+) files? changed/),
  };
}

// PRs the agent touched show up as github.com/owner/repo/pull/N in command
// output and agent messages — emit one 'pr' open the first time we see each.
function prOpensFrom(text, t) {
  const evs = [];
  const re = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
  let m;
  while ((m = re.exec(text))) {
    const n = Number(m[2]);
    if (state.prsSeen.has(n)) continue;
    state.prsSeen.add(n);
    evs.push({ t, type: 'pr', number: n, state: 'open', url: `https://github.com/${m[1]}/pull/${n}` });
  }
  return evs;
}

// The agent narrates merges reliably ("PR #198 merged", "merged in PR #205").
// Parse those, guarding against negations ("#261 is not merged yet").
function prMergesFrom(text, t) {
  const nums = new Set();
  for (const m of text.matchAll(/\bmerged\b[^.\n#]{0,12}#(\d+)/gi)) {
    const pre = text.slice(Math.max(0, m.index - 16), m.index).toLowerCase();
    if (/\bnot\b|isn'?t|aren'?t|\bun|will|would|should|before|once|after|when|if\b/.test(pre)) continue;
    nums.add(Number(m[1]));
  }
  for (const m of text.matchAll(/#(\d+)[^.\n]{0,12}\bmerged\b/gi)) {
    if (/\bnot\b|isn'?t|n'?t |\bun/i.test(m[0])) continue;
    nums.add(Number(m[1]));
  }
  return [...nums].map(n => ({ t, type: 'pr', number: n, state: 'merged' }));
}

// Map a toast review-ci result to a ci status: ready→pass, anything else→pending,
// an explicit fail/error→fail.
function toastCi(text) {
  if (/"status":"(ready|clean|passing)"/.test(text)) return 'pass';
  if (/"status":"(fail|error|failing)"/.test(text)) return 'fail';
  if (/"status":"(blocking|pending|in_progress)"/.test(text)) return 'pending';
  return null;
}

// Returns an array of nightshift events for one rollout entry.
function step(e) {
  const out = [];
  const p = e.payload;
  const t = e.timestamp ? Date.parse(e.timestamp) : null;
  if (t == null || !p) return out;

  if (e.type === 'session_meta') {
    if (!state.started) {
      state.started = true;
      out.push({ t, type: 'session', phase: 'start', agent: 'codex', cwd: p.cwd, session: p.id });
      if (!LOG) LOG = centralLogFor(p.cwd);
    }
    return out;
  }
  if (e.type === 'turn_context' && p.model) { state.model = p.model; return out; }

  if (e.type === 'event_msg') {
    if (p.type === 'user_message') {
      // Codex has no intent layer, so each prompt (turn) becomes a card: the
      // current turn sits in "in progress" and moves to "done" when the next
      // prompt arrives or the turn completes. Edits/commits in between attach
      // to it, so the board isn't an empty grid of facts-only.
      const title = p.message ? String(p.message).trim().split('\n')[0].slice(0, 64).trim() : null;
      if (state.card) out.push({ t, type: 'item', id: state.card, status: 'done' });
      state.turnN++;
      state.card = `turn-${state.turnN}`;
      out.push({ t, type: 'item', id: state.card, title: title || `turn ${state.turnN}`, status: 'doing' });
      out.push({ t, type: 'session', phase: 'resume', agent: 'codex', ...(state.titled ? {} : { title }) });
      state.titled = true;
      state.phase = 'working';
    } else if (p.type === 'task_complete') {
      // Do NOT go idle here — Codex fires task_complete after every internal
      // task, and an autonomous run continues. The tailer emits idle only when
      // the rollout actually goes quiet (see the static check below), so the
      // badge reflects real activity, not task boundaries.
    } else if (p.type === 'patch_apply_end' && p.success && p.changes) {
      state.lastActivityT = t;
      for (const file of Object.keys(p.changes)) {
        out.push({ t, type: 'edit', path: relCwd(file), tool: 'apply_patch', ...(state.card ? { item: state.card } : {}) });
      }
    } else if (p.type === 'token_count' && p.info && p.info.last_token_usage) {
      const u = p.info.last_token_usage;
      const cached = u.cached_input_tokens || 0;
      out.push({
        t, type: 'usage', model: state.model,
        in: Math.max(0, (u.input_tokens || 0) - cached), out: u.output_tokens || 0, cacheRead: cached,
      });
    } else if (p.type === 'agent_message' && p.message) {
      out.push(...prOpensFrom(p.message, t), ...prMergesFrom(p.message, t));
    }
    return out;
  }

  if (e.type === 'response_item') {
    if (p.type === 'function_call' && p.name === 'update_plan') {
      // Codex's plan == the board's todo drill-in. Attach it to the current
      // turn's card so an in-progress card shows live steps + a progress ring.
      let plan = [];
      try { plan = JSON.parse(p.arguments || '{}').plan || []; } catch { /* skip */ }
      out.push({
        t, type: 'todos', ...(state.card ? { item: state.card } : {}),
        todos: plan.map(s => ({ text: s.step, done: s.status === 'completed' })),
      });
    } else if (p.type === 'function_call') {
      let cmd = '';
      try { cmd = JSON.parse(p.arguments || '{}').cmd || ''; } catch { /* not json */ }
      if (cmd) {
        // Surface the command as activity so a working turn scrolls the tape.
        // Codex sometimes logs the same call twice at one timestamp — skip the
        // byte-identical repeat (legit reruns differ by t and are kept).
        const text = cmd.replace(/\s+/g, ' ').trim().slice(0, 120);
        const key = `${t}|${text}`;
        if (key !== state.lastToolKey) {
          state.lastToolKey = key;
          out.push({ t, type: 'tool', tool: 'run', text, ...(state.card ? { item: state.card } : {}) });
        }
        if (/git\s+.*commit/.test(cmd)) state.pending.set(p.call_id, t);
        // NB: a `gh pr merge N` command is NOT proof of merge — these go through
        // a Toast gate and are often blocked. Merge state comes only from the
        // authoritative open-list reconciliation below.
        const tt = cmd.match(/toast\s+review-ci[^\n]*--pr\s+(\d+)/);
        if (tt) state.toastPending.set(p.call_id, Number(tt[1]));
        // An unfiltered open-list is the source of truth for what's still open.
        if (/gh pr list/.test(cmd) && /--state open/.test(cmd) && !/--head/.test(cmd)) {
          state.openListPending.add(p.call_id);
        }
      }
    } else if (p.type === 'function_call_output') {
      const o = String(p.output || '');
      if (state.pending.has(p.call_id)) {
        const ct = state.pending.get(p.call_id);
        state.pending.delete(p.call_id);
        const c = parseCommitOutput(o, ct);
        if (c) { if (state.card) c.item = state.card; out.push(c); }
      }
      if (state.toastPending.has(p.call_id)) {
        const n = state.toastPending.get(p.call_id);
        state.toastPending.delete(p.call_id);
        const ci = toastCi(o);
        if (ci) out.push({ t, type: 'ci', pr: n, status: ci });
      }
      if (state.openListPending.has(p.call_id)) {
        // Reconcile: PRs in the list are open (corrects a premature 'merged');
        // previously-seen PRs absent from it are merged/closed.
        state.openListPending.delete(p.call_id);
        const openNow = new Set([...o.matchAll(/"number":\s*(\d+)/g)].map(m => Number(m[1])));
        for (const n of openNow) { state.prsSeen.add(n); out.push({ t, type: 'pr', number: n, state: 'open' }); }
        for (const n of state.prsSeen) if (!openNow.has(n)) out.push({ t, type: 'pr', number: n, state: 'merged' });
      }
      out.push(...prOpensFrom(o, t)); // PR urls in command output → opens
    }
  }
  return out;
}

let rolloutCwd = null;
function relCwd(file) {
  return rolloutCwd ? path.relative(rolloutCwd, file) : file;
}

function append(events) {
  if (!events.length || !LOG) return;
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

// --- tail loop --------------------------------------------------------------

let offset = 0, partial = '', idleTicks = 0, emittedIdle = false;
const IDLE_EMIT_TICKS = 120;     // ~60s of no rollout growth → the agent is idle
const IDLE_EXIT_TICKS = 12 * 3600 * 2; // ~12h of no growth → worker exits. Long on
// purpose: a paused overnight session must NOT lose its tailer (the old 30-min
// exit froze the board mid-run). Re-running /nightshift restarts a dead tailer.
function drain() {
  let size;
  try { size = fs.statSync(rollout).size; } catch { return; }
  if (size < offset) { offset = 0; partial = ''; }
  if (size === offset) { idleTicks++; return; }
  idleTicks = 0;
  emittedIdle = false; // rollout grew → the session is live again
  const buf = Buffer.alloc(size - offset);
  const fd = fs.openSync(rollout, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
  offset = size;
  const lines = (partial + buf.toString('utf8')).split('\n');
  partial = lines.pop();
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'session_meta' && e.payload && e.payload.cwd) rolloutCwd = e.payload.cwd;
    events.push(...step(e));
  }
  append(events);
}

function cleanupState() {
  const s = readState();
  if (s[LOG] && s[LOG].pid === process.pid) { delete s[LOG]; writeState(s); }
}

drain();
if (!once) {
  try { fs.watch(rollout, drain); } catch { /* polling covers it */ }
  setInterval(() => {
    drain();
    // Our rollout went quiet — did the session rotate to a new file? Follow it.
    if (idleTicks > 0 && idleTicks % 10 === 0) {
      const succ = findSuccessor(rolloutCwd, rollout);
      if (succ) {
        rollout = succ; offset = 0; partial = ''; idleTicks = 0; emittedIdle = false;
        // turn/card/model state carries over → the tape stays one continuous session
      }
    }
    // Rollout quiet for a while → mark idle once (a later flush wakes it).
    if (idleTicks >= IDLE_EMIT_TICKS && !emittedIdle && state.started) {
      emittedIdle = true;
      append([{ t: Date.now(), type: 'session', phase: 'idle' }]);
    }
    if (idleTicks > IDLE_EXIT_TICKS) { cleanupState(); process.exit(0); } // long-dead → exit
  }, 500);
  process.on('SIGTERM', () => { cleanupState(); process.exit(0); });
  console.error(`tailing ${rollout}\n     → ${LOG}`);
}
