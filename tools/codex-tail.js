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
// Meter mode: a thin companion to hook-based recording. The agent-hook owns the
// human-facing facts (cards, edits, tools, todos, commits, session start); the
// rollout still has things hooks can't carry — token counts (cost), PR/CI
// state, and the quiet signal for idle + card retirement. In --meter we emit
// ONLY those, so the two recorders never double-count.
const meter = args.includes('--meter');
const meterKeep = e =>
  e.type === 'usage' || e.type === 'pr' || e.type === 'ci' ||
  (e.type === 'session' && e.phase === 'idle') ||
  (e.type === 'item' && e.status === 'done'); // idle-retire of the hook's card
let rollout = args.find(a => !a.startsWith('--') && a !== val('--log'));

// Read the head of a rollout. The session_meta first line can be tens of KB (it
// embeds base_instructions), so a small read truncates it — 64KB covers the
// meta fields we match by regex without slurping the whole file.
function rolloutHead(p) {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, n);
  } catch { return ''; }
}
const headField = (head, re) => { const m = head.match(re); return m ? m[1] : null; };
const CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const ID_RE = /"id"\s*:\s*"([0-9a-f-]{36})"/;
function rolloutCwdOf(p) { return headField(rolloutHead(p), CWD_RE); }

// Newest rollout = the session being written right now. With preferCwd, the
// newest rollout recorded in THAT directory wins — so `/nightshift` attaches to
// this project's session, not whatever Codex session happened to write last.
function newestRollout(preferCwd) {
  const base = path.join(os.homedir(), '.codex', 'sessions');
  let best = null, bestT = 0, bestCwd = null, bestCwdT = 0;
  const walk = d => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^rollout-.*\.jsonl$/.test(e.name)) {
        let m = 0; try { m = fs.statSync(p).mtimeMs; } catch { continue; }
        if (m > bestT) { bestT = m; best = p; }
        if (preferCwd && m > bestCwdT && rolloutCwdOf(p) === preferCwd) { bestCwdT = m; bestCwd = p; }
      }
    }
  };
  walk(base);
  return bestCwd || best;
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

// --status: print `live` if a worker is tailing this log right now, else `off`.
// Lets /nightshift tell "already recording" from "an old tape is sitting here".
if (args.includes('--status')) {
  const e = readState()[LOG];
  process.stdout.write(e && e.pid && alive(e.pid) ? 'live\n' : 'off\n');
  process.exit(0);
}

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

// A long Codex session can be split across rollout files (context compaction
// continues in a fresh rollout). When our rollout goes quiet, follow such a
// continuation so the tail doesn't freeze on the old file — but ONLY a genuine
// continuation of THIS session. The same project dir also hosts subagent
// rollouts (review/explorer/guardian) and unrelated new sessions; bridging
// those onto this tape is wrong (it dumps a subagent's work, or a fresh
// session, into the current board). Require same session id, or a rollout that
// references our id (a resume/continuation), and never a subagent.
function findSuccessor(cwd, current, sessionId) {
  if (!cwd || !sessionId) return null;
  let curM = 0;
  try { curM = fs.statSync(current).mtimeMs; } catch { /* gone */ }
  const base = path.join(os.homedir(), '.codex', 'sessions');
  let best = null, bestM = curM;
  const walk = d => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^rollout-.*\.jsonl$/.test(e.name) && p !== current) {
        let m = 0; try { m = fs.statSync(p).mtimeMs; } catch { continue; }
        if (m <= bestM) continue;
        const head = rolloutHead(p);
        if (headField(head, CWD_RE) !== cwd) continue;
        if (/"thread_source"\s*:\s*"subagent"/.test(head)) continue; // subagents tape separately
        const id = headField(head, ID_RE);
        if (id !== sessionId && !head.includes(sessionId)) continue;  // a different session
        best = p; bestM = m;
      }
    }
  };
  walk(base);
  return best;
}

// Prefer the newest rollout recorded in the current project dir (where the
// skill runs), so `/nightshift` attaches to THIS session, not a parallel one.
rollout = rollout || newestRollout(process.cwd());
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
  const child = spawn(process.execPath, [__filename, '--worker', rollout, '--log', LOG, ...(meter ? ['--meter'] : [])],
    { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  // Preserve a prior worker's resume snapshot when respawning on the SAME
  // rollout, so a restart continues instead of re-draining the whole tape.
  const prev = s[LOG] && s[LOG].rollout === rollout ? s[LOG] : {};
  s[LOG] = { ...prev, pid: child.pid, rollout };
  writeState(s);
  process.exit(0);
}

// --- incremental rollout → nightshift event stepper -------------------------

const state = {
  phase: null, model: null, lastActivityT: null, started: false, titled: false,
  turnN: 0, card: null, // one card per turn (prompt)
  lastToolKey: null, // dedupe Codex's same-instant double-logged commands
  prsSeen: new Set(), // PR numbers we've already recorded a state for
  toastPending: new Map(), // call_id → pr number (toast review-ci → ci status)
  listPending: new Map(), // call_id → {filter, json} for `gh pr list` (state-aware)
  createPending: new Set(), // call_ids of `gh pr create` (its url output means 'open')
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

// `gh pr create` prints the new PR's url on success — the ONE place a bare
// pull url proves a PR is open. (A url appearing in any other output — a merged
// list, a `pr view`, a comment — proves nothing about its state.)
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

// Parse gh's json PR output (a `--json` array, or jq-filtered ndjson) into rows.
function parsePrRows(text) {
  if (!text.includes('"number"')) return [];
  let objs = [];
  try { const a = JSON.parse(text); if (Array.isArray(a)) objs = a; } catch { /* not a clean array */ }
  if (!objs.length) {
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (s[0] === '{') { try { objs.push(JSON.parse(s)); } catch { /* skip */ } }
    }
  }
  return objs.filter(o => typeof o.number === 'number');
}

const prMeta = o => {
  const ev = {};
  if (o.title) ev.title = o.title;
  else if (o.headRefName) ev.title = o.headRefName; // branch name as a fallback
  if (o.url) ev.url = o.url;
  return ev;
};

// Titles/urls (and an explicit state when the json carries one) from a single
// `gh pr view --json ...` style output. A row WITHOUT an authoritative state is
// `meta:true` — the reducer attaches its title/url but won't invent an open PR
// (an unknown number defaulting to 'open' is exactly what flooded the panel).
function prMetaFrom(text, t) {
  return parsePrRows(text).map(o => {
    const ev = { t, type: 'pr', number: o.number, ...prMeta(o) };
    const st = o.state ? String(o.state).toLowerCase() : null;
    if (st === 'open') ev.state = 'open';
    else if (st === 'merged' || st === 'closed') ev.state = 'merged';
    else ev.meta = true;
    return ev;
  });
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
  // Completed-merge phrasings the past-tense match misses ("#223 did merge",
  // "#236 was merged", "merged successfully"). Intentionally NOT "merging #224"
  // — present tense is intent, not done, and the merge can still be gate-blocked.
  for (const m of text.matchAll(/#(\d+)\b[^.\n]{0,24}\b(?:did merge|was merged|got merged|has merged|merged successfully|merge commit)\b/gi)) {
    if (/\bnot\b|isn'?t|n'?t |\bun|\bwill\b|\bwould\b|\bshould\b|\bonce\b|\bbefore\b|\bafter\b|\bwhen\b|\bif\b/i.test(m[0])) continue;
    nums.add(Number(m[1]));
  }
  // "pull/N at merge commit <sha>" — a merge commit hash is proof it landed.
  for (const m of text.matchAll(/pull\/(\d+)\b[^.\n]{0,30}\bmerge commit\b/gi)) nums.add(Number(m[1]));
  return [...nums].map(n => ({ t, type: 'pr', number: n, state: 'merged' }));
}

// Map a toast review-ci result to a ci status. Toast's vocabulary: ready (good),
// pending (running), needs_fix / blocked / github_blocked (action needed).
function toastCi(text) {
  if (/"status":\s*"(ready|pass|passing|clean)"/.test(text)) return 'pass';
  if (/"status":\s*"(needs_fix|blocked|github_blocked|fail|failing|error)"/.test(text)) return 'fail';
  if (/"status":\s*"(pending|in_progress|active|running|blocking)"/.test(text)) return 'pending';
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
      // In meter mode the agent-hook owns the card lifecycle (open on prompt,
      // close on next prompt). We still advance turnN/card so the idle-retire
      // below targets the same card the hook has open, but we emit no card
      // events here — emitting the next-prompt close would race the hook and
      // could close an active card (codex review P1).
      if (state.card && !meter) out.push({ t, type: 'item', id: state.card, status: 'done' });
      state.turnN++;
      state.card = `turn-${state.turnN}`;
      state.hasPlan = false; state.planComplete = false; // fresh turn, no plan yet
      if (!meter) out.push({ t, type: 'item', id: state.card, title: title || `turn ${state.turnN}`, status: 'doing' });
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
      // Merge narration ("PR #205 merged") is reliable and guarded; opens come
      // from `gh pr create` output, not prose urls (which may cite merged PRs).
      out.push(...prMergesFrom(p.message, t));
    }
    return out;
  }

  if (e.type === 'response_item') {
    if (p.type === 'function_call' && p.name === 'update_plan') {
      // Codex's plan == the board's todo drill-in. Attach it to the current
      // turn's card so an in-progress card shows live steps + a progress ring.
      let plan = [];
      try { plan = JSON.parse(p.arguments || '{}').plan || []; } catch { /* skip */ }
      // Track plan completeness so idle doesn't retire a turn whose steps aren't
      // finished — a quiet rollout mid-plan is a pause, not a completed turn.
      state.hasPlan = plan.length > 0;
      state.planComplete = plan.length > 0 && plan.every(s => s.status === 'completed');
      out.push({
        t, type: 'todos', ...(state.card ? { item: state.card } : {}),
        todos: plan.map(s => ({ text: s.step, done: s.status === 'completed', status: s.status })),
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
        if (/\btoast\b/.test(cmd)) {
          const tt = cmd.match(/--pr\s+(\d+)/);
          if (tt) state.toastPending.set(p.call_id, Number(tt[1]));
        }
        // `gh pr list` is state-aware: remember its --state filter (gh defaults
        // to open) and whether it's --json (parseable) so the output handler
        // classifies by what was actually queried — not by urls in the dump.
        if (/gh pr list\b/.test(cmd) && !/--head/.test(cmd)) {
          const sm = cmd.match(/--state\s+(\w+)/);
          state.listPending.set(p.call_id, { filter: sm ? sm[1].toLowerCase() : 'open', json: /--json\b/.test(cmd) });
        }
        // A freshly created PR's url output is a real 'open' signal.
        if (/gh pr create\b/.test(cmd)) state.createPending.add(p.call_id);
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
      if (state.listPending.has(p.call_id)) {
        // Classify the listed PRs by what was queried, not by urls in the dump.
        const { filter, json } = state.listPending.get(p.call_id);
        state.listPending.delete(p.call_id);
        if (json) {
          const rows = parsePrRows(o);
          if (filter === 'open') {
            // Listed → open. We do NOT infer merged from absence: open lists get
            // truncated by --limit or narrowed by filters, so a missing PR isn't
            // proof it merged (that false-merged the one real open PR). Merges
            // come only from positive signals (merged list, narration, state).
            for (const r of rows) { state.prsSeen.add(r.number); out.push({ t, type: 'pr', number: r.number, state: 'open', ...prMeta(r) }); }
          } else if (filter === 'merged' || filter === 'closed') {
            for (const r of rows) { state.prsSeen.add(r.number); out.push({ t, type: 'pr', number: r.number, state: 'merged', ...prMeta(r) }); }
          } else { // 'all' or unknown — trust each row's own state field if present
            for (const r of rows) out.push(...prMetaFrom(JSON.stringify(r), t));
          }
        }
      } else if (state.createPending.has(p.call_id)) {
        state.createPending.delete(p.call_id);
        out.push(...prOpensFrom(o, t)); // the new PR's url → open
      } else {
        out.push(...prMetaFrom(o, t)); // titles/urls (+ explicit state) only
      }
    }
  }
  return out;
}

let rolloutCwd = null;
let rolloutSessionId = null; // this session's id — gates rotation-following
function relCwd(file) {
  return rolloutCwd ? path.relative(rolloutCwd, file) : file;
}

function append(events) {
  if (meter) events = events.filter(meterKeep);
  if (!events.length || !LOG) return;
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

// --- tail loop --------------------------------------------------------------

let offset = 0, partial = '', idleTicks = 0, emittedIdle = false;
// A turn card has no terminal event of its own — it closes on the next prompt.
// When the session goes idle we retire it to `done` so a finished agent doesn't
// leave a card stuck in "In progress"; we remember which card so the SAME turn
// resuming (a long buffering pause, not a real finish) can reopen it.
let idleClosedCard = null;
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
  // We'd retired the open turn card on idle, but the same turn just resumed —
  // reopen it before applying the new activity. If these lines carry a fresh
  // prompt, step() closes this card and opens a new one, so it ends correctly.
  if (idleClosedCard && idleClosedCard === state.card && !meter) {
    events.push({ t: Date.now(), type: 'item', id: state.card, status: 'doing' });
  }
  idleClosedCard = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'session_meta' && e.payload) {
      if (e.payload.cwd) rolloutCwd = e.payload.cwd;
      if (e.payload.id) rolloutSessionId = e.payload.id;
    }
    events.push(...step(e));
  }
  append(events);
}

function cleanupState() {
  const s = readState();
  if (s[LOG] && s[LOG].pid === process.pid) { delete s[LOG]; writeState(s); }
}

// Checkpoint enough to resume after a restart/crash: the file position (so we
// don't re-emit history) plus the turn/PR state (so numbering and dedup carry
// over). Transient call_id maps are intentionally dropped — losing an in-flight
// command's classification at the seam is harmless; re-emitting 18k events isn't.
function persist() {
  const s = readState();
  if (!s[LOG] || s[LOG].pid !== process.pid) return; // a newer worker owns it
  s[LOG] = {
    ...s[LOG], rollout,
    snap: {
      offset, partial, rolloutCwd, rolloutSessionId, emittedIdle, idleClosedCard,
      hasPlan: state.hasPlan, planComplete: state.planComplete,
      turnN: state.turnN, card: state.card, model: state.model,
      started: state.started, titled: state.titled, prsSeen: [...state.prsSeen],
    },
  };
  writeState(s);
}

// Restore a prior worker's checkpoint for this exact rollout (resume, don't
// re-drain). Guarded: only if the file is the same and hasn't shrunk below our
// mark (a shrink means rotation → start fresh).
if (worker) {
  const entry = readState()[LOG] || {};
  const snap = entry.snap;
  let size = 0; try { size = fs.statSync(rollout).size; } catch { /* gone */ }
  if (snap && entry.rollout === rollout && typeof snap.offset === 'number' && snap.offset <= size) {
    offset = snap.offset; partial = snap.partial || ''; rolloutCwd = snap.rolloutCwd || null;
    rolloutSessionId = snap.rolloutSessionId || null;
    emittedIdle = !!snap.emittedIdle; idleClosedCard = snap.idleClosedCard || null;
    state.turnN = snap.turnN || 0; state.card = snap.card || null; state.model = snap.model || null;
    state.hasPlan = !!snap.hasPlan; state.planComplete = !!snap.planComplete;
    state.started = !!snap.started; state.titled = !!snap.titled;
    if (Array.isArray(snap.prsSeen)) state.prsSeen = new Set(snap.prsSeen);
    console.error(`resumed at offset ${offset} (turn ${state.turnN})`);
  }
}

drain();
if (worker) persist();
if (!once) {
  try { fs.watch(rollout, drain); } catch { /* polling covers it */ }
  setInterval(() => {
    const before = offset;
    drain();
    // Our rollout went quiet — did the session rotate to a new file? Follow it.
    if (idleTicks > 0 && idleTicks % 10 === 0) {
      const succ = findSuccessor(rolloutCwd, rollout, rolloutSessionId);
      if (succ) {
        rollout = succ; offset = 0; partial = ''; idleTicks = 0; emittedIdle = false;
        persist(); // checkpoint the new file before reading it
        // turn/card/model state carries over → the tape stays one continuous session
      }
    }
    // Rollout quiet for a while → mark idle once (a later flush wakes it).
    if (idleTicks >= IDLE_EMIT_TICKS && !emittedIdle && state.started) {
      emittedIdle = true;
      const evs = [{ t: Date.now(), type: 'session', phase: 'idle' }];
      // Retire the open turn card too — the agent stopped, so it shouldn't sit
      // in "In progress." Reopened by drain() if the same turn resumes. But only
      // if the turn looks finished: no plan, or a plan with all steps done. A
      // quiet rollout with an unfinished plan is a pause mid-step, not a
      // completed turn — retiring it would falsely mark the card done.
      const turnDone = !state.hasPlan || state.planComplete;
      if (state.card && idleClosedCard !== state.card && turnDone) {
        idleClosedCard = state.card;
        evs.push({ t: Date.now(), type: 'item', id: state.card, status: 'done' });
      }
      append(evs);
      persist();
    }
    if (offset !== before) persist(); // checkpoint after any growth
    if (idleTicks > IDLE_EXIT_TICKS) { cleanupState(); process.exit(0); } // long-dead → exit
  }, 500);
  // Exit but KEEP the snapshot, so a kill-and-restart resumes instead of
  // re-draining. `--stop` deletes the entry parent-side (explicit forget); a
  // 12h idle-exit cleans up itself. A bare SIGTERM (restart) leaves resume state.
  process.on('SIGTERM', () => process.exit(0));
  console.error(`tailing ${rollout}\n     → ${LOG}`);
}
