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
const { randomUUID } = require('node:crypto');

const args = process.argv.slice(2);
const val = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const once = args.includes('--once');
const worker = args.includes('--worker');
const stop = args.includes('--stop');
// Meter mode: a thin companion to hook-based recording. The agent-hook owns the
// human-facing facts (cards, edits, tools, todos, commits, session start); the
// rollout still has things hooks can't carry — token counts (cost), PR sightings
// (pr_ref), and the quiet signal for idle + card retirement. In --meter we emit
// ONLY those, so the two recorders never double-count. PR/CI STATE is no longer
// emitted here at all (plan 1.4: poll-github is the single writer) — we surface
// only pr_ref sightings so the poller knows which PRs this session touched.
const meter = args.includes('--meter');
const meterKeep = e =>
  e.type === 'alive' || // recorder heartbeat — always emitted, in both modes
  e.type === 'usage' || e.type === 'pr_ref' ||
  (e.type === 'session' && (e.phase === 'idle' || e.phase === 'end')) ||
  e.type === 'item'; // in meter mode the only items emitted are idle-retire/reopen of the hook's card
let rollout = args.find(a => !a.startsWith('--') && a !== val('--log'));

// This Codex session's id (== the hook payload's session_id / $CODEX_THREAD_ID).
// When known, the rollout is selected by matching THIS id — never "newest in the
// dir", the fallback that let 15 worktree /nightshift runs all attach to one
// main-repo rollout and record one session into 15 identical tapes (F1).
const SESSION_ID = val('--session') || process.env.CODEX_THREAD_ID || null;

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
const SID_RE = /"session_id"\s*:\s*"([0-9a-f-]{36})"/;
function rolloutCwdOf(p) { return headField(rolloutHead(p), CWD_RE); }
// A rollout's own session id: session_meta carries both `id` and `session_id`
// (same value); either identifies which session the file belongs to.
function rolloutSessionIdOf(p) { const h = rolloutHead(p); return headField(h, ID_RE) || headField(h, SID_RE); }

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

// Deterministic selection: the ONE rollout that IS this session. Matched by the
// thread id embedded in the filename (Codex names rollouts
// rollout-<ts>-<id>.jsonl) or by the session_meta id in the head. A subagent
// rollout is never chosen (its head carries a different id). Returns null when
// nothing matches — the caller then refuses to guess rather than grabbing the
// newest unrelated rollout.
function rolloutForSession(id) {
  if (!id) return null;
  const base = path.join(os.homedir(), '.codex', 'sessions');
  let best = null, bestT = -1;
  const walk = d => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/^rollout-.*\.jsonl$/.test(e.name)) continue;
      if (!e.name.includes(id) && rolloutSessionIdOf(p) !== id) continue;
      let m = 0; try { m = fs.statSync(p).mtimeMs; } catch { continue; }
      if (m >= bestT) { bestT = m; best = p; } // newest, if a session ever spans files
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

// Does the destination log already hold this rollout's session? Both recorders'
// session-start events carry `session:<rolloutSessionId>`. The newest session's
// events sit at the END of an append-only (possibly multi-session central) log, so
// we scan the tail. Used only to decide whether a from-zero drain would re-append
// a stream the log already has (the n154 double), so a cheap probe is enough.
function logHasSession(log, sid) {
  if (!sid) return false;
  let size = 0; try { size = fs.statSync(log).size; } catch { return false; }
  if (!size) return false;
  // Scan the WHOLE log, not a fixed tail. In FULL mode the only `session:<sid>`
  // marker is codex-tail's single phase:'start' event at the TOP of the
  // (append-only, possibly multi-session) log; resume events carry no `session`.
  // So for any session whose recorded stream outgrows a tail window — i.e. every
  // real overnight tape, and specifically the n154-class multi-MB one — that lone
  // marker sits BEFORE the tail, and a tail-only scan would miss it and wrongly
  // re-drain the entire stream from zero (the exact n154 double this guard exists
  // to kill). In meter mode the marker is the hook's newest per-resume line, which
  // a single long autonomous turn can likewise push out of a tail window — same
  // blind spot, same fix. A one-time O(file) chunked read at worker start is cheap
  // and correct; byte-level search bridges the chunk boundary so a marker split
  // across two reads still matches.
  const needle = Buffer.from(`"session":"${sid}"`, 'utf8');
  const CHUNK = 262144;
  const keep = needle.length - 1; // bytes carried across a chunk boundary
  let fd;
  try { fd = fs.openSync(log, 'r'); } catch { return false; }
  try {
    const buf = Buffer.alloc(CHUNK + keep);
    let pos = 0, carried = 0;
    while (pos < size) {
      const n = fs.readSync(fd, buf, carried, CHUNK, pos);
      if (n <= 0) break;
      const end = carried + n;
      if (buf.subarray(0, end).indexOf(needle) !== -1) return true;
      const carryStart = end > keep ? end - keep : 0; // retain a marker-1 tail
      buf.copy(buf, 0, carryStart, end);
      carried = end - carryStart;
      pos += n;
    }
    return false;
  } catch { return false; }
  finally { fs.closeSync(fd); }
}

// --status: print `live` if a worker is tailing this log right now, else `off`.
// Lets /nightshift tell "already recording" from "an old tape is sitting here".
if (args.includes('--status')) {
  // The registry is keyed by rollout path, so a worker's destination log lives in
  // its entry. `live` if some entry feeding THIS log has an alive worker. (`key ===
  // LOG` also matches a pre-upgrade, log-keyed entry from an in-flight old worker.)
  const s = readState();
  const live = Object.entries(s).some(([key, e]) => e && e.pid && alive(e.pid) && (e.log === LOG || key === LOG));
  process.stdout.write(live ? 'live\n' : 'off\n');
  process.exit(0);
}

// --stop: kill the worker tailing this log (or all of them).
if (stop) {
  const s = readState();
  for (const [key, e] of Object.entries(s)) {
    // --log scopes the stop to the worker feeding that log (its stored `log`, or an
    // old log-keyed entry). Bare --stop stops every worker.
    if (LOG && !(e && (e.log === LOG || key === LOG))) continue;
    if (e && e.pid && alive(e.pid)) { try { process.kill(e.pid); } catch { /* gone */ } }
    if (LOG && e && e.snap) {
      // Scoped stop = pause. Keep the resume checkpoint (no pid) so a later continue
      // onto the SAME tape resumes instead of re-draining from zero. A Reset moves
      // the log aside, which the checkpoint's logSize guard detects (the fresh log
      // is smaller) → a clean from-zero drain, exactly as a reset intends.
      s[key] = { rollout: e.rollout || key, log: e.log, mode: e.mode, snap: e.snap };
    } else {
      delete s[key];
    }
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

// Pick the rollout to tail. An explicit path always wins (codex-recorder pins the
// exact rollout via $CODEX_THREAD_ID). Otherwise, if we know THIS session's id,
// select by it and REFUSE to guess when nothing matches — never fall back to
// "newest rollout in the dir", the mechanism that made 15 worktree sessions
// converge on one rollout (F1). Only a truly identity-less run (a manual/import
// invocation with no session id) uses the newest-mtime heuristic, and even then it
// prefers this project dir.
if (!rollout) {
  if (SESSION_ID) {
    rollout = rolloutForSession(SESSION_ID);
    if (!rollout) {
      console.error(`no rollout matches session ${SESSION_ID} — refusing to guess a different session's rollout. Start recording from the Codex session itself, or pass its rollout path explicitly.`);
      process.exit(3);
    }
  } else {
    rollout = newestRollout(process.cwd());
  }
}
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
  // The registry is keyed by ROLLOUT path, not log — so a second /nightshift in
  // another worktree that resolves the SAME rollout finds this lock and no-ops,
  // instead of spawning a duplicate recorder that fans one session into N identical
  // tapes (F1). One rollout is recorded exactly once.
  const own = s[rollout]; // this rollout's own entry (its resume checkpoint lives here)
  const wantMode = meter ? 'meter' : 'full';
  // A live worker on this rollout — under the rollout key (new) OR any entry whose
  // stored `rollout` matches (a pre-upgrade, log-keyed worker still tailing it) —
  // means it is already recorded. Detecting the old-format worker too keeps the
  // one-recorder guarantee across the registry-format migration.
  let live = own && own.pid && alive(own.pid) ? own : null;
  if (!live) for (const e of Object.values(s)) { if (e && e.rollout === rollout && e.pid && alive(e.pid)) { live = e; break; } }
  if (live) {
    if ((live.mode || 'full') === wantMode) {
      if (live.log && live.log !== LOG) {
        console.error(`already recording ${path.basename(rollout)} → ${live.log} (pid ${live.pid}); not double-recording it into ${LOG}`);
      }
      process.exit(0); // a live worker already tails this rollout in this mode
    }
    try { process.kill(live.pid); } catch { /* gone */ } // wrong mode (e.g. a pre-upgrade full tailer) → replace
  }
  // No live worker (fresh, or a stale entry with a dead pid) → take it over.
  const out = fs.openSync(path.join(NS_HOME, 'codex-tail.log'), 'a');
  const child = spawn(process.execPath, [__filename, '--worker', rollout, '--log', LOG, ...(meter ? ['--meter'] : [])],
    { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  // Preserve this rollout's resume snapshot when respawning in the SAME mode, so a
  // restart continues instead of re-draining the whole tape.
  const prev = own && (own.mode || 'full') === wantMode ? own : {};
  s[rollout] = { ...prev, pid: child.pid, rollout, log: LOG, mode: wantMode };
  writeState(s);
  process.exit(0);
}

// --- incremental rollout → nightshift event stepper -------------------------

const state = {
  phase: null, model: null, lastActivityT: null, started: false, titled: false,
  turnN: 0, card: null, // one card per turn (prompt)
  lastToolKey: null, // dedupe Codex's same-instant double-logged commands
  prsSeen: new Set(), // PR numbers we've already sighted (pr_ref dedupe)
  createPending: new Set(), // call_ids of `gh pr create` (its url output carries the new number)
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

// In meter mode the agent-hook owns the cards; a pr_ref links to the SAME card the
// hook has open (its per-session turn statefile). In full mode we use our own turn
// card. hookCard()/rolloutSessionId are defined below (both live at call time).
function curCard() {
  return meter ? hookCard(rolloutSessionId) : state.card;
}

// One pr_ref SIGHTING, deduped. codex-tail no longer writes any pr/ci STATE — the
// poller is the single writer (plan 1.4). A ref only tells the poller which PRs
// this session touched and links the current card so the poller's real events can
// carry it pr -> done.
function prRef(n, repoPath, t) {
  if (state.prsSeen.has(n)) return null;
  state.prsSeen.add(n);
  const ev = { t, type: 'pr_ref', number: n };
  if (repoPath) ev.url = `https://github.com/${repoPath}/pull/${n}`;
  const card = curCard();
  if (card) ev.item = card;
  return ev;
}

// `gh pr create` prints the new PR's url on success — the number lives only in that
// output, so we scan it (createPending gates this to create calls; a url in a
// list/view/comment dump is NOT scanned — that flooded the board with 747 stale
// "open" rows).
function prRefsFromCreate(text, t) {
  const evs = [];
  const re = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
  let m;
  while ((m = re.exec(text))) { const e = prRef(Number(m[2]), m[1], t); if (e) evs.push(e); }
  return evs;
}

// A `gh pr merge` success line — "Merged pull request owner/repo#N" (older gh omits
// owner/repo). Safe to scan any output: it's gh's distinctive success phrase, not a
// state assertion — the poller confirms the real merge (and its true time) in secs.
function prRefsFromMerge(text, t) {
  const m = text.match(/Merged pull request\s+([\w.-]+\/[\w.-]+)?#(\d+)/i);
  if (!m) return [];
  const e = prRef(Number(m[2]), m[1] || null, t);
  return e ? [e] : [];
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
      // The message is the agent's plaintext status — its running thoughts
      // ("waiting one more interval for the harvest to finish"). Emit it as a
      // `say` so the active card shows what the agent's doing. We deliberately do
      // NOT infer PR merges from this prose: narration is intent, not fact, and it
      // false-merged #404 (the agent wrote "merged" about a PR still open). Per
      // invariant #4 and plan 1.4, PR state comes only from the poller's gh queries;
      // codex-tail emits only pr_ref sightings (below), never state.
      const say = String(p.message).replace(/\s+/g, ' ').trim();
      if (say) out.push({ t, type: 'say', text: say.slice(0, 280), ...(state.card ? { item: state.card } : {}) });
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
        // A freshly created PR's number lives only in its url OUTPUT — flag the call
        // so the output handler scans it for a sighting. All state classification
        // (toast ci, `gh pr list` open/merged) is gone: the poller is the single
        // writer of pr/ci now (plan 1.4). A `gh pr merge` success line is read from
        // any output below; `gh pr view/merge N` numbers ride the hook's tool event.
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
      // PR SIGHTINGS only (plan 1.4) — no state parsing. A created PR's number comes
      // from its url output; a merge success line is a sighting from any output.
      if (state.createPending.has(p.call_id)) {
        state.createPending.delete(p.call_id);
        out.push(...prRefsFromCreate(o, t));
      }
      out.push(...prRefsFromMerge(o, t));
    }
  }
  return out;
}

let rolloutCwd = null;
let rolloutSessionId = null; // this session's id — gates rotation-following
function relCwd(file) {
  return rolloutCwd ? path.relative(rolloutCwd, file) : file;
}

// In meter mode the agent-hook owns the cards; read its current card from the
// per-session turn statefile so idle-retire / reopen target the SAME card the
// hook has open. (The meter's own state.card diverges when /nightshift starts
// mid-session — the meter drains the rollout from the beginning, the hook counts
// turns only from /nightshift forward.)
function hookCard(sid) {
  if (!sid) return null;
  try { return JSON.parse(fs.readFileSync(path.join(NS_HOME, 'turns', sid + '.json'), 'utf8')).card || null; }
  catch { return null; }
}

function append(events) {
  if (meter) events = events.filter(meterKeep);
  if (!events.length || !LOG) return;
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  // Envelope v2: unique event id + source + v per line. `...e` last so item
  // events keep their work-item `id`.
  fs.appendFileSync(LOG, events.map(e => JSON.stringify({ id: randomUUID(), source: 'codex-tail', v: 2, ...e })).join('\n') + '\n');
}

// --- tail loop --------------------------------------------------------------

let offset = 0, partial = '', idleTicks = 0, emittedIdle = false;
// Recorder heartbeat cadence. A RESIDENT tailer emits `alive` every ~30s so the
// board can tell a live-but-quiet agent (still heartbeating) from a dead tailer
// (heartbeat stops → badge goes STALE). Hook-based recording can't do this.
const ALIVE_MS = 30000;
let lastAliveT = 0;
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
  // We'd retired the card on idle, but the same turn just resumed — reopen it
  // (in meter mode the hook never re-opens it on PostToolUse, so this is the
  // only reopen). Target the hook's card; only reopen if it's still the card we
  // retired (a fresh prompt would have moved the hook to a new card).
  const reopen = meter ? hookCard(rolloutSessionId) : state.card;
  if (idleClosedCard && idleClosedCard === reopen) {
    events.push({ t: Date.now(), type: 'item', id: reopen, status: 'doing' });
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
  if (s[rollout] && s[rollout].pid === process.pid) { delete s[rollout]; writeState(s); }
}

// Checkpoint enough to resume after a restart/crash: the file position (so we
// don't re-emit history) plus the turn/PR state (so numbering and dedup carry
// over). Transient call_id maps are intentionally dropped — losing an in-flight
// command's classification at the seam is harmless; re-emitting 18k events isn't.
function persist() {
  const s = readState();
  const e = s[rollout];
  if (!e || e.pid !== process.pid) return; // a newer worker owns it
  let logSize = 0; try { logSize = fs.statSync(LOG).size; } catch { /* not written yet */ }
  s[rollout] = {
    ...e, rollout, log: LOG,
    snap: {
      offset, partial, rolloutCwd, rolloutSessionId, emittedIdle, idleClosedCard,
      hasPlan: state.hasPlan, planComplete: state.planComplete,
      turnN: state.turnN, card: state.card, model: state.model,
      started: state.started, titled: state.titled, prsSeen: [...state.prsSeen],
      // Destination-log byte length at this checkpoint. On restart we resume only
      // if the log hasn't shrunk below it — a Reset/archive moves the log aside, and
      // resuming mid-rollout into a fresh empty tape would skip the session's start.
      logSize,
    },
  };
  writeState(s);
}

// Restore a prior worker's checkpoint for this exact rollout (resume, don't
// re-drain). Guarded: only if the file is the same and hasn't shrunk below our
// mark (a shrink means rotation → start fresh).
if (worker) {
  // Learn this rollout's session id up front — drain() sets it from session_meta,
  // but the re-attach guard below needs it before the first read.
  rolloutSessionId = rolloutSessionIdOf(rollout) || rolloutSessionId;
  const entry = readState()[rollout] || {};
  const snap = entry.snap;
  let size = 0; try { size = fs.statSync(rollout).size; } catch { /* gone */ }
  let logSize = 0; try { logSize = fs.statSync(LOG).size; } catch { /* none yet */ }
  // The checkpoint is usable only if the rollout hasn't shrunk below our mark
  // (rotation → start fresh) AND the destination log still holds what we wrote
  // (logSize hasn't dropped below the checkpoint — a Reset/archive moves the log
  // aside, and resuming mid-rollout into a fresh empty tape would skip the start).
  const snapUsable = snap && entry.rollout === rollout
    && typeof snap.offset === 'number' && snap.offset <= size
    && logSize >= (snap.logSize || 0);
  if (snapUsable) {
    offset = snap.offset; partial = snap.partial || ''; rolloutCwd = snap.rolloutCwd || null;
    rolloutSessionId = snap.rolloutSessionId || rolloutSessionId;
    emittedIdle = !!snap.emittedIdle; idleClosedCard = snap.idleClosedCard || null;
    state.turnN = snap.turnN || 0; state.card = snap.card || null; state.model = snap.model || null;
    state.hasPlan = !!snap.hasPlan; state.planComplete = !!snap.planComplete;
    state.started = !!snap.started; state.titled = !!snap.titled;
    if (Array.isArray(snap.prsSeen)) state.prsSeen = new Set(snap.prsSeen);
    console.error(`resumed at offset ${offset} (turn ${state.turnN})`);
  } else if (offset === 0 && logHasSession(LOG, rolloutSessionId)) {
    // Re-attach guard (the n154 double): no usable checkpoint, but the destination
    // log ALREADY holds this rollout's session — draining from zero would re-append
    // the whole stream (that is what doubled n154 into 14k duplicate lines). Resume
    // from the checkpoint offset if we still have one that fits the rollout;
    // otherwise skip to the current end rather than re-draining and doubling.
    const usedSnapOffset = snap && typeof snap.offset === 'number' && snap.offset <= size;
    offset = usedSnapOffset ? snap.offset : size;
    // The session's start already sits in the log, so mark it started — otherwise
    // the idle gate (state.started, below) never lets a re-attached session go IDLE.
    // Carry the checkpoint's turn/card numbering when it belongs to this rollout so a
    // resumed turn keeps its id instead of minting a colliding fresh turn-1.
    if (snap && entry.rollout === rollout) {
      if (usedSnapOffset) partial = snap.partial || '';
      rolloutCwd = snap.rolloutCwd || rolloutCwd;
      emittedIdle = !!snap.emittedIdle; idleClosedCard = snap.idleClosedCard || null;
      state.turnN = snap.turnN || 0; state.card = snap.card || null; state.model = snap.model || null;
      state.hasPlan = !!snap.hasPlan; state.planComplete = !!snap.planComplete;
      state.titled = !!snap.titled;
      if (Array.isArray(snap.prsSeen)) state.prsSeen = new Set(snap.prsSeen);
    }
    state.started = true;
    console.error(`re-attach guard: log already has session ${rolloutSessionId} — resuming at ${offset}, not re-draining from 0`);
  }
}

drain();
if (worker) persist();
if (!once) {
  try { fs.watch(rollout, drain); } catch { /* polling covers it */ }
  setInterval(() => {
    const before = offset;
    drain();
    // Recorder heartbeat, independent of rollout growth: prove the tailer is
    // alive every ~30s even while the agent quietly thinks. `alive` updates only
    // per-source freshness in the reducer (no feed, no timers) — see EVENTS.md.
    if (state.started && Date.now() - lastAliveT >= ALIVE_MS) {
      lastAliveT = Date.now();
      append([{ t: Date.now(), type: 'alive' }]);
    }
    // Our rollout went quiet — did the session rotate to a new file? Follow it.
    if (idleTicks > 0 && idleTicks % 10 === 0) {
      const succ = findSuccessor(rolloutCwd, rollout, rolloutSessionId);
      if (succ) {
        // Rotation → the registry is keyed by rollout path, so MOVE our lock from the
        // old rollout to the successor. Otherwise the successor has no lock and a
        // second attach could double-record it.
        const s = readState();
        if (s[rollout] && s[rollout].pid === process.pid) {
          s[succ] = { ...s[rollout], rollout: succ };
          delete s[rollout];
          writeState(s);
        }
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
      const card = meter ? hookCard(rolloutSessionId) : state.card;
      if (card && idleClosedCard !== card && turnDone) {
        idleClosedCard = card;
        evs.push({ t: Date.now(), type: 'item', id: card, status: 'done' });
      }
      append(evs);
      persist();
    }
    if (offset !== before) persist(); // checkpoint after any growth
    if (idleTicks > IDLE_EXIT_TICKS) {
      // The tailer self-retires (rollout long dead) — record the session END
      // first (1.6): a knowable boundary Codex gives no hook for. The reducer
      // sweeps any still-`doing` card to abandoned instead of latching forever.
      if (state.started) append([{ t: Date.now(), type: 'session', phase: 'end' }]);
      cleanupState();
      process.exit(0);
    }
  }, 500);
  // Exit but KEEP the snapshot, so a kill-and-restart resumes instead of
  // re-draining. `--stop` deletes the entry parent-side (explicit forget); a
  // 12h idle-exit cleans up itself. A bare SIGTERM (restart) leaves resume state.
  process.on('SIGTERM', () => process.exit(0));
  console.error(`tailing ${rollout}\n     → ${LOG}`);
}
