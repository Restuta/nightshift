#!/usr/bin/env node
// Single entrypoint for ALL agent hooks — Claude Code and Codex. Both now speak
// the same hook contract: a JSON payload on stdin, routed on `hook_event_name`,
// with `session_id`, `cwd`, `transcript_path`, and (for tools) `tool_name` /
// `tool_input` / `tool_response`. Codex normalizes shell to `tool_name:"Bash"`;
// its `apply_patch` and `update_plan` keep their names and carry the shapes we
// parse below. (Verified by driving `codex exec` — see docs/codex-hooks.md.)
//
// Contract: never crash, never block — agent work must not be disturbed by
// observability. Every path exits 0.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash, randomUUID } = require('node:crypto');

const NS_HOME = process.env.NIGHTSHIFT_HOME || path.join(os.homedir(), '.nightshift');

// Folding for Claude's incremental Task tools (see tools/tasks-fold.js). Loaded
// defensively — a missing/broken module must never take the hook down.
let tasksFold = null;
try { tasksFold = require(path.join(__dirname, '..', 'tools', 'tasks-fold.js')); } catch { /* optional */ }

// Mid-turn /nightshift attachment recovery. Loaded defensively for vendored or
// partially upgraded installs: observability must remain fail-open.
let turnAttachment = null;
try { turnAttachment = require(path.join(__dirname, '..', 'tools', 'turn-attachment.js')); } catch { /* optional */ }

// Which agent produced this payload — read it from the transcript path, which
// is namespaced (~/.codex/… vs ~/.claude/…); fall back to the Claude env var.
function agentOf(h) {
  const tp = h.transcript_path || '';
  if (tp.includes('/.codex/')) return 'codex';
  if (tp.includes('/.claude/')) return 'claude';
  return process.env.CLAUDE_CODE_SESSION_ID ? 'claude' : 'codex';
}

// A Codex session fans work out to subagent threads (review/explorer/guardian)
// that run in the SAME cwd. We must not fold their tool calls into the parent's
// tape. Per-session gating already excludes them IF they carry their own
// session_id; this is a belt-and-suspenders check for an explicit subagent
// marker in the payload (exact field TBD — guard defensively).
function isSubagent(h) {
  if (h.source === 'subagent' || h.subagent || h.parent_thread_id || h.parent_session_id) return true;
  if (h.source && typeof h.source === 'object' && h.source.subagent) return true;
  return false;
}

// The nightshift repo recorded by a global install (from ~/.nightshift/install.json),
// or null if there's no global install. The one repo that records locally + curates
// its own board.
function installRepo() {
  try { return JSON.parse(fs.readFileSync(path.join(NS_HOME, 'install.json'), 'utf8')).repo || null; }
  catch { return null; }
}

// Where this project's events go (resolved from the SESSION's cwd, which the
// payload carries — the hook process's own cwd is not the project dir for Codex):
//   1. $NIGHTSHIFT_LOG                          — explicit override
//   2. <root>/.nightshift/events.jsonl          — local-attached mode (dir exists)
//   3. ~/.nightshift/sessions/<slug>.jsonl      — central, for global install
// Under a global install the local dir is honored ONLY for the nightshift repo
// itself; a stray .nightshift/ in any other repo is ignored, because the global
// board serves ~/.nightshift/sessions and would never show a local log (it'd look
// empty). Without a global install, the local dir is the attach.js embed use case.
function resolveLog(root, repo, self) {
  if (process.env.NIGHTSHIFT_LOG) return { log: process.env.NIGHTSHIFT_LOG, central: false };
  const localDir = path.join(root, '.nightshift');
  if (fs.existsSync(localDir) && (self || !repo)) {
    return { log: path.join(localDir, 'events.jsonl'), central: false };
  }
  const slug = root.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '-') || 'session';
  return { log: path.join(NS_HOME, 'sessions', `${slug}.jsonl`), central: true };
}

// Recording gate for central sessions: opt in via NIGHTSHIFT env or a per-session
// marker (created by /nightshift), keyed on the payload's session_id.
function sessionIdOf(hook) {
  return hook.session_id || hook.sessionId || process.env.CODEX_THREAD_ID || process.env.CLAUDE_CODE_SESSION_ID || null;
}
function recording(hook, central) {
  if (!central || process.env.NIGHTSHIFT) return true;
  const sid = sessionIdOf(hook);
  return !!(sid && fs.existsSync(path.join(NS_HOME, 'active', sid)));
}

function makeAppend(LOG) {
  return ev => {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    // Envelope v2: stamp a unique event id + this producer's source + v. `...ev`
    // last so an item event's own `id` (the work-item id) wins over the UUID —
    // item ids are legitimately reused across a card's transitions (see EVENTS.md).
    fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), id: randomUUID(), source: 'hook', v: 2, ...ev }) + '\n');
  };
}

function readLog(LOG) {
  try {
    return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// Turn-card ids are NAMESPACED per session — `turn-<sid8>-<n>` — so two sessions
// writing ONE central log never collide on `turn-3` and never close each other's
// live card (plan 1.3). sid8 = the session id's first 8 hex chars. The shared
// browser copy lives in public/turn-id.js (kept in sync by hand — no build step).
const sid8 = s => String(s || '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 8);

// Highest turn number already minted in namespace `s8` in the log — the tape is the
// truth. When a session's per-sid counter file is lost, we resume numbering from
// here so a fresh turn-1 can't re-collide with a card this same session wrote.
function maxTurnN(LOG, s8) {
  if (!s8) return 0;
  let max = 0;
  for (const ev of readLog(LOG)) {
    if (ev.type !== 'item' || !ev.id) continue;
    const m = new RegExp('^turn-' + s8 + '-(\\d+)$').exec(ev.id);
    if (m) { const n = Number(m[1]); if (n > max) max = n; }
  }
  return max;
}

// Per-turn card state, persisted per session (hooks are separate processes, so
// the turn counter can't live in memory). One card per user prompt — the Codex
// "product invariant" the rollout tailer produced, now driven by the hook.
const TURNS = path.join(NS_HOME, 'turns');
function turnState(sid) {
  try { return JSON.parse(fs.readFileSync(path.join(TURNS, sid + '.json'), 'utf8')); }
  catch { return { turnN: 0, card: null }; }
}
function saveTurn(sid, st) {
  fs.mkdirSync(TURNS, { recursive: true });
  fs.writeFileSync(path.join(TURNS, sid + '.json'), JSON.stringify(st));
}

// Open tool calls are durable hook state because PreToolUse/PostToolUse/Stop run
// in separate processes. Keep one identity file per compound key inside a
// session directory: unrelated agents/tools never overwrite one shared JSON
// snapshot, and rename is an atomic claim when a PostToolUse races a boundary.
const TOOL_CALLS = path.join(NS_HOME, 'tool-calls');
const sessionStateName = value => createHash('sha256').update(String(value || '')).digest('hex');
const toolSessionDir = sid => path.join(TOOL_CALLS, sessionStateName(sid));
const toolIdentityName = (agentId, toolUseId) =>
  Buffer.from(JSON.stringify([agentId, toolUseId])).toString('base64url') + '.json';
const toolIdentityPath = identity =>
  path.join(toolSessionDir(identity.sessionId), toolIdentityName(identity.agentId, identity.toolUseId));

function beginTool(identity, append) {
  const file = toolIdentityPath(identity);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    // Write the full record privately, then publish it with one exclusive hard
    // link. Readers can only observe complete JSON, while EEXIST makes duplicate
    // PreToolUse delivery idempotent without a shared read/modify/write race.
    fs.writeFileSync(tmp, JSON.stringify(identity));
    fs.linkSync(tmp, file);
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
  append({ type: 'tool_call', state: 'start', ...identity });
  return true;
}

function claimOpenTool(identity) {
  const file = toolIdentityPath(identity);
  const claimed = `${file}.claim-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try { fs.renameSync(file, claimed); } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  let open = null;
  try { open = JSON.parse(fs.readFileSync(claimed, 'utf8')); } catch { /* corrupt state is not evidence */ }
  try { fs.unlinkSync(claimed); } catch { /* already gone */ }
  return open;
}

function sameToolIdentity(left, right) {
  return !!left && !!right
    && left.sessionId === right.sessionId
    && left.agentId === right.agentId
    && left.toolUseId === right.toolUseId;
}

function finishTool(identity, append) {
  const open = claimOpenTool(identity);
  if (!sameToolIdentity(open, identity)) return false;
  append({ type: 'tool_call', state: 'success', ...open });
  return true;
}

function closeOpenTools(sid, append) {
  if (!sid) return;
  const dir = toolSessionDir(sid);
  let files;
  try { files = fs.readdirSync(dir).filter(file => file.endsWith('.json')); } catch { return; }
  for (const name of files) {
    const file = path.join(dir, name);
    const claimed = `${file}.claim-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try { fs.renameSync(file, claimed); } catch { continue; }
    let open = null;
    try { open = JSON.parse(fs.readFileSync(claimed, 'utf8')); } catch { /* corrupt state is not evidence */ }
    try { fs.unlinkSync(claimed); } catch { /* already gone */ }
    const expectedName = open && toolIdentityName(open.agentId, open.toolUseId);
    if (open && open.sessionId === sid && expectedName === name) {
      append({ type: 'tool_call', state: 'unknown', ...open });
    }
  }
  try { fs.rmdirSync(dir); } catch { /* non-empty or already removed */ }
}

function toolIdentity(hook, sid, item) {
  const toolUseId = hook.tool_use_id || hook.toolUseId;
  if (!sid || !toolUseId) return null;
  const identity = {
    sessionId: sid,
    agentId: hook.agent_id || hook.agentId || 'main',
    toolUseId,
    tool: hook.tool_name || hook.toolName || '',
  };
  if (item) identity.item = item;
  const parentRunId = hook.parent_run_id || hook.parentRunId;
  if (parentRunId) identity.parentRunId = parentRunId;
  return identity;
}

// Notification text is display-only. Actionability comes exclusively from
// structured subtype/reason/type fields; an unfamiliar subtype stays an
// informational system_notice rather than being guessed from prose.
function notificationReason(hook) {
  const nested = hook.notification && typeof hook.notification === 'object' ? hook.notification : {};
  const candidates = [
    hook.notification_type, hook.notificationType, hook.subtype, hook.reason, hook.type,
    nested.notification_type, nested.notificationType, nested.subtype, nested.reason, nested.type,
  ];
  const reasons = new Map([
    ['next_prompt', 'next_prompt'], ['idle_prompt', 'next_prompt'],
    ['permission', 'permission'], ['permission_prompt', 'permission'], ['permission_request', 'permission'],
    ['question', 'question'], ['elicitation', 'question'], ['elicitation_dialog', 'question'],
    ['background_complete', 'background_complete'], ['background_task_complete', 'background_complete'],
    ['task_complete', 'background_complete'], ['task_completed', 'background_complete'],
    ['system_notice', 'system_notice'],
  ]);
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (reasons.has(normalized)) return reasons.get(normalized);
  }
  return 'system_notice';
}

// Live capture of Claude's task list (TaskCreate/TaskUpdate). Those tools aren't
// in the hook matcher and Claude keeps the list only in the transcript, so we
// tail the transcript on every firing PostToolUse/Stop instead: read the bytes
// since last time, fold in any task changes, and emit the whole plan as a `todos`
// snapshot attached to the open turn card. The /nightshift backfill seeds the
// state file (and the initial offset) so we never replay a huge transcript here.
const TASKS = path.join(NS_HOME, 'tasks');
function syncClaudeTasks(hook, sid, append) {
  if (!tasksFold || !sid) return;
  const tp = hook.transcript_path;
  if (!tp) return;
  const f = path.join(TASKS, sid + '.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { state = null; }
  if (!state) {
    // No backfill ran (e.g. NIGHTSHIFT env recording) — start at EOF so we don't
    // replay history; new task ops still stream in from here.
    let size = 0; try { size = fs.statSync(tp).size; } catch { /* none yet */ }
    state = { ...tasksFold.emptyState(), offset: size };
    fs.mkdirSync(TASKS, { recursive: true });
    fs.writeFileSync(f, JSON.stringify(state));
    return;
  }
  const { lines, offset } = tasksFold.readNewLines(tp, state.offset || 0);
  let changed = false;
  for (const raw of lines) {
    if (!tasksFold.lineMayMatter(raw, Object.keys(state.pending || {}).length > 0)) continue;
    let ev; try { ev = JSON.parse(raw); } catch { continue; }
    if (tasksFold.applyLine(ev, state)) changed = true;
  }
  state.offset = offset;
  fs.writeFileSync(f, JSON.stringify(state));
  if (changed) {
    const card = turnState(sid).card;
    const ev = tasksFold.toTodos(state);
    append(card ? { ...ev, item: card } : ev);
  }
}

// Live capture of Claude's plaintext narration — the status text it prints
// between tool calls ("Now I'll check whether the eval run finished"). Like the
// task list, it lives only in the transcript (no hook payload carries it), so we
// tail the transcript on each firing PostToolUse/Stop, pull the latest assistant
// text block, and emit it as a `say` attached to the open turn card. The board
// shows the latest one on the active card's live "now" line. We start a fresh
// session at EOF (no offset file) so we never replay history as a flood; only
// the LAST text block in each new batch is emitted (the now-line shows one line,
// and emitting once per crossing avoids duplicating a block across tool calls).
const SAYS = path.join(NS_HOME, 'says');
function syncClaudeSay(hook, sid, append, card) {
  if (!tasksFold || !sid) return;
  const tp = hook.transcript_path;
  if (!tp) return;
  const f = path.join(SAYS, sid + '.json');
  let st;
  try { st = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { st = null; }
  if (!st) {
    let size = 0; try { size = fs.statSync(tp).size; } catch { /* none yet */ }
    fs.mkdirSync(SAYS, { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ offset: size }));
    return; // start at EOF — new narration streams from here, no history replay
  }
  const { lines, offset } = tasksFold.readNewLines(tp, st.offset || 0);
  let last = '';
  for (const raw of lines) {
    if (!raw.includes('"text"')) continue; // cheap pre-filter
    let ev; try { ev = JSON.parse(raw); } catch { continue; }
    const msg = ev && ev.type === 'assistant' && ev.message;
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) last = b.text;
    }
  }
  st.offset = offset;
  fs.writeFileSync(f, JSON.stringify(st));
  if (last) {
    const text = last.replace(/\s+/g, ' ').trim().slice(0, 280);
    if (text) append(card ? { type: 'say', text, item: card } : { type: 'say', text });
  }
}

// Files an apply_patch command (Codex edits) touches.
function patchFiles(cmd) {
  const files = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let m;
  while ((m = re.exec(cmd || ''))) files.push(m[1].trim());
  return files;
}

function parseCommit(out) {
  const head = out.match(/\[[^\s\]]+ ([0-9a-f]{7,40})\] (.+)/);
  if (!head) return null;
  const num = re => { const m = out.match(re); return m ? Number(m[1]) : 0; };
  return {
    type: 'commit', sha: head[1].slice(0, 7), message: head[2].trim(),
    add: num(/(\d+) insertions?\(\+\)/), del: num(/(\d+) deletions?\(-\)/),
    files: num(/(\d+) files? changed/),
  };
}

// Some turns reach UserPromptSubmit but aren't human intent: background-task
// notifications, system reminders, and the captured stdout of local `!` commands.
// Those must not mint a card titled "<task-notification>". A slash command
// (<command-name>…) IS the human asking for work, so it stays human (titled from
// the command below).
function isHumanPrompt(p) {
  const t = (p || '').trimStart();
  if (!t) return false;
  return !/^<(task-notification|system-reminder|local-command)/.test(t);
}

// A readable card title from a prompt: a slash command becomes "/cmd args";
// otherwise the first non-empty line, stripped of leading quote/markdown markers,
// capped. Keeps "turn N" only as a last resort.
function promptTitle(p) {
  const s = p || '';
  const name = s.match(/<command-name>\s*([\s\S]*?)\s*<\/command-name>/);
  if (name) {
    const args = s.match(/<command-args>\s*([\s\S]*?)\s*<\/command-args>/);
    return `${name[1]}${args && args[1].trim() ? ' ' + args[1].trim() : ''}`.replace(/\s+/g, ' ').slice(0, 64).trim();
  }
  const line = s.split('\n').map(x => x.trim()).find(Boolean) || '';
  return line.replace(/^["'>`*•\-\s]+/, '').slice(0, 64).trim();
}

// The `gh pr <verb>` a command runs, tolerant of flag PLACEMENT — gh accepts the
// repo flag before or after `pr` (`gh -R o/r pr view`, `gh pr -R o/r view`), so we
// can't rely on adjacency or regex. Tokenize: find gh → pr → the verb, skipping
// flags (and a space-form flag's value, unless that value is itself the verb, so a
// boolean flag right before the verb doesn't swallow it).
const GH_VERBS = /^(create|merge|view|checks|checkout|close|reopen|ready|edit|diff|comment|review|list|status)$/;
function ghPrVerb(cmd) {
  const t = (cmd || '').split(/\s+/);
  const out = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i].startsWith('-')) {
      if (!t[i].includes('=') && t[i + 1] && !t[i + 1].startsWith('-') && !GH_VERBS.test(t[i + 1])) i++;
      continue;
    }
    out.push(t[i]);
  }
  const k = out.indexOf('pr');
  return k > 0 && out[k - 1] === 'gh' ? (out[k + 1] || null) : null;
}

// PRs the session itself surfaces via gh become pr_ref SIGHTINGS, never state.
// The hook no longer writes pr state at all (plan 1.4: poll-github is the SOLE
// writer). A ref only tells the poller "this PR is relevant to this session"; the
// poller then fetches authoritative state AND real fact-time (mergedAt/createdAt).
//   - create: gh prints the new PR's URL on success → number + url.
//   - merge:  the "Merged pull request #N" success line → number (+ repo url).
// Both are only sightings now — even the merge success line: the poller confirms
// within seconds and records the true merge time, so no prose/stdout state parsing
// stays alive outside poll-github. Anything else (view/list/checks) is the poller's.
function parseGhPrRef(cmd, out) {
  const verb = ghPrVerb(cmd);
  // Strip quoted segments before flag checks so a flag named inside a title/body
  // (e.g. --title "test --dry-run") isn't mistaken for a real flag.
  const bare = (cmd || '').replace(/"[^"]*"|'[^']*'/g, '');
  if (verb === 'create') {
    if (/--dry-run\b/.test(bare)) return null; // prints the would-be PR, creates nothing
    // gh prints the created PR URL as the LAST line of stdout on success. Match
    // only that line (not the whole output / command) so a URL quoted in the PR
    // body can't masquerade as a created PR. Store an absolute URL — the board
    // uses ev.url directly, so a scheme-less one resolves under the nightshift host.
    const last = (out || '').replace(/\s+$/, '').split('\n').pop() || '';
    const m = last.match(/(?:https?:\/\/)?(github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+))/);
    return m ? { type: 'pr_ref', number: Number(m[2]), url: 'https://' + m[1] } : null;
  }
  if (verb === 'merge') {
    // gh's success line is "Merged pull request owner/repo#N (...)" (older builds
    // omit owner/repo). Keep the owner/repo as a URL when present so the poller can
    // scope the number to the right repo (a bare number would re-scope to cwd).
    const m = (out || '').match(/Merged pull request\s+([\w.-]+\/[\w.-]+)?#(\d+)/i);
    if (!m) return null;
    const ev = { type: 'pr_ref', number: Number(m[2]) };
    const rf = (cmd || '').match(/(?:--repo|-R)[=\s]+["']?([\w.-]+\/[\w.-]+)/);
    const repo = m[1] || (rf && rf[1]);
    if (repo) ev.url = `https://github.com/${repo}/pull/${m[2]}`;
    return ev;
  }
  return null;
}

function main() {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { return; }
  let hook;
  try { hook = JSON.parse(input); } catch { return; }

  const root = process.env.CLAUDE_PROJECT_DIR || hook.cwd || process.cwd();
  // The nightshift repo hand-curates its own board via tools/emit.js, so there we
  // must NOT auto-synthesize per-turn cards or capture its task list (it would
  // double up), and it keeps recording to its own local log. Every OTHER recorded
  // Claude session — central OR locally-attached — gets the full card + plan
  // treatment. SELF = "is this session running in the nightshift repo itself" —
  // keyed off where THIS hook lives (robust even without a global install), not on
  // install.json. It also decides local-vs-central below.
  const SELF = path.resolve(root) === path.resolve(__dirname, '..');
  const { log: LOG, central: CENTRAL } = resolveLog(root, installRepo(), SELF);

  if (!recording(hook, CENTRAL)) return; // central session that hasn't opted in
  if (isSubagent(hook)) return;          // a subagent thread — not the parent's tape

  const append = makeAppend(LOG);
  const name = hook.hook_event_name;
  const agent = agentOf(hook);
  const sid = sessionIdOf(hook);

  // The one path for opening both normal UserPromptSubmit turns and a reserved
  // mid-turn attachment. An explicit id is tape-deterministic and may already
  // exist when claimAttachment repaired a crash after append.
  const openTurn = ({ id, title, promptT, sessionId }) => {
    if (!sessionId) return null;
    const st = turnState(sessionId);
    const namespace = sid8(sessionId);
    if (st.turnN === 0) st.turnN = maxTurnN(LOG, namespace);

    let turnId = id;
    if (turnId) {
      const match = namespace && new RegExp(`^turn-${namespace}-(\\d+)$`).exec(turnId);
      if (match) st.turnN = Math.max(st.turnN, Number(match[1]));
    } else {
      st.turnN++;
      turnId = namespace ? `turn-${namespace}-${st.turnN}` : `turn-${st.turnN}`;
    }

    if (st.card && st.card !== turnId) append({ type: 'item', id: st.card, status: 'done' });
    const exists = readLog(LOG).some(event => event.type === 'item' && event.id === turnId);
    st.card = turnId;
    if (!exists) {
      append({
        ...(promptT != null ? { t: promptT } : {}),
        type: 'item', id: turnId, title: title || `turn ${st.turnN}`, status: 'doing',
      });
    }
    saveTurn(sessionId, st);

    // The /nightshift skill backfills Claude's task state immediately after it
    // requests the attachment. Put that current snapshot on the recovered card
    // before the triggering tool event is recorded.
    if (tasksFold && agent === 'claude') {
      try {
        const taskState = JSON.parse(fs.readFileSync(path.join(TASKS, sessionId + '.json'), 'utf8'));
        const todos = tasksFold.toTodos(taskState);
        if (todos.todos.length) append({ ...todos, item: turnId });
      } catch { /* no task state yet */ }
    }
    return turnId;
  };

  // Stop/next-prompt atomically make the reservation non-claimable under its fs
  // lease. A returned helper-appended id is safe to close after lease release:
  // delayed PostToolUse delivery can only observe terminal state.
  const transitionAttachmentBoundary = reason => {
    if (SELF || !sid || !turnAttachment || !turnAttachment.boundaryAttachment) return null;
    try { return turnAttachment.boundaryAttachment({ sid, log: LOG, reason }); }
    catch { return null; }
  };

  const closeBoundaryAttachment = boundary => {
    if (!boundary || !boundary.turnId) return false;
    const st = turnState(sid);
    const itemStatus = id => {
      let status = null;
      for (const event of readLog(LOG)) {
        if (event.type === 'item' && event.id === id && event.status) status = event.status;
      }
      return status;
    };
    if (st.card && st.card !== boundary.turnId && itemStatus(st.card) !== 'done') {
      append({ type: 'item', id: st.card, status: 'done' });
    }
    if (itemStatus(boundary.turnId) !== 'done') append({ type: 'item', id: boundary.turnId, status: 'done' });
    st.turnN = Math.max(st.turnN || 0, maxTurnN(LOG, sid8(sid)));
    st.card = null;
    saveTurn(sid, st);
    if (turnAttachment && turnAttachment.ackBoundaryAttachment) {
      turnAttachment.ackBoundaryAttachment({ sid, turnId: boundary.turnId });
    }
    return true;
  };

  if (name === 'SessionStart') {
    append({ type: 'session', phase: 'start', agent, session: sid, cwd: hook.cwd });
    return;
  }

  // Claude Code fires SessionEnd when the session actually closes (reason:
  // clear|logout|prompt_input_exit|other). Codex fires no such hook — its end
  // comes from the rollout tailer's self-retirement (tools/codex-tail.js). This
  // is where a session boundary is genuinely KNOWABLE for a hook-based recorder,
  // so record it: the reducer sweeps any card still in `doing` to abandoned and
  // freezes the now-lines (1.6). Retire the open turn card first so it doesn't
  // strand in "in progress" behind the end.
  if (name === 'SessionEnd') {
    try { closeOpenTools(sid, append); } catch { /* never break */ }
    if (!SELF && sid) {
      const st = turnState(sid);
      if (st.card) { append({ type: 'item', id: st.card, status: 'done' }); st.card = null; saveTurn(sid, st); }
    }
    append({ type: 'session', phase: 'end', session: sid, reason: hook.reason });
    return;
  }

  if (name === 'Stop') { // Claude only — Codex fires no Stop
    try { closeOpenTools(sid, append); } catch { /* never break */ }
    // For central recordings (where we synthesize the turn card, below), retire
    // it here: Claude gives a clean end-of-turn signal Codex lacks, so the card
    // moves to "done" the moment the turn ends — no card stuck in "doing" until
    // the next prompt. Locally-attached repos keep their hand-emitted cards, so
    // leave those alone.
    // Capture any last task change before the card is retired (a TaskUpdate with
    // no following tool call would otherwise be missed until the next turn).
    const boundaryAttachment = transitionAttachmentBoundary('stop');
    if (agent === 'claude' && !SELF) {
      try { syncClaudeTasks(hook, sid, append); } catch { /* never break */ }
      try { syncClaudeSay(hook, sid, append, turnState(sid).card); } catch { /* never break */ }
    }
    if (!SELF && sid) {
      const st = turnState(sid);
      if (!closeBoundaryAttachment(boundaryAttachment) && st.card) {
        append({ type: 'item', id: st.card, status: 'done' }); st.card = null; saveTurn(sid, st);
      }
    }
    append({ type: 'session', phase: 'idle', session: sid });
    return;
  }

  if (name === 'Notification') { // Claude only
    append({ type: 'notification', reason: notificationReason(hook), text: hook.message || hook.text || '', session: sid });
    return;
  }

  if (name === 'UserPromptSubmit') {
    // Synthesize one card per prompt whenever there's no hand-curated intent
    // layer to defer to: always for Codex (it has no intent layer at all), and for
    // Claude everywhere EXCEPT the nightshift repo itself (which curates its board
    // via emit.js — see SELF). Any other Claude session, central or locally-attached,
    // won't call emit.js, so without this its board has zero cards. Close the prior
    // turn, open a new one titled by the prompt.
    // Skip card synthesis for harness-injected turns — they'd just litter the
    // board with "<task-notification>" cards. The agent still does work in that
    // turn; it attaches to the open card (or none), and Stop retires as usual.
    const humanPrompt = sid && isHumanPrompt(hook.prompt);
    const boundaryAttachment = humanPrompt ? transitionAttachmentBoundary('next_prompt') : null;
    closeBoundaryAttachment(boundaryAttachment);
    const synth = humanPrompt && (agent === 'codex' || !SELF);
    if (synth) {
      const promptT = hook.timestamp ? Date.parse(hook.timestamp) : null;
      openTurn({
        title: promptTitle(hook.prompt),
        promptT: Number.isFinite(promptT) ? promptT : null,
        sessionId: sid,
      });
      append({ type: 'session', phase: 'resume', agent, session: sid });
    } else {
      append({ type: 'session', phase: 'resume', agent, session: sid });
    }
    // Bidirectional pickup: surface open inbox cards as context for the turn.
    const items = new Map();
    for (const ev of readLog(LOG)) {
      if (ev.type !== 'item' || !ev.id) continue;
      items.set(ev.id, { ...(items.get(ev.id) || {}), ...ev });
    }
    const inbox = [...items.values()].filter(it => it.status === 'inbox');
    if (inbox.length) {
      console.log(
        `Nightshift inbox has ${inbox.length} open card(s) added by the human:\n` +
        inbox.map(it => `- [${it.id}] ${it.title || '(untitled)'}`).join('\n') +
        `\nIf one is relevant to this turn, move it to "doing" via tools/emit.js and handle it; otherwise leave it.`
      );
    }
    return;
  }

  if (name === 'PreToolUse') {
    const item = sid ? turnState(sid).card : null;
    const identity = toolIdentity(hook, sid, item);
    if (identity) {
      try { beginTool(identity, append); } catch { /* never break */ }
    }
    return;
  }

  if (name === 'PostToolUse') {
    // This must be the first PostToolUse action: claim before any turn-state read
    // so the triggering tool/task snapshot attaches to the recovered card.
    let attachment = null;
    if (!SELF && turnAttachment && sid) {
      try { attachment = turnAttachment.claimAttachment({ sid, log: LOG, transcriptPath: hook.transcript_path }); }
      catch { /* leave the reservation retryable */ }
    }
    if (attachment && attachment.turnId && /^(adopted_existing|recovered)$/.test(attachment.status)) {
      try {
        turnAttachment.ackAttachment({
          sid,
          turnId: attachment.turnId,
          adopt: () => {
            const currentCard = turnState(sid).card;
            if (currentCard !== attachment.turnId) {
              openTurn({
                id: attachment.turnId,
                title: promptTitle(attachment.prompt),
                promptT: attachment.promptT,
                sessionId: sid,
              });
            }
          },
        });
      } catch { /* leave pending so the next tool/boundary can retry */ }
    }
    const tool = hook.tool_name || '';
    const inp = hook.tool_input || {};
    const item = sid ? turnState(sid).card : null;
    const withItem = ev => (item ? { ...ev, item } : ev);
    const identity = toolIdentity(hook, sid, item);
    if (identity) {
      try { finishTool(identity, append); } catch { /* never break */ }
    }

    // Piggyback on this firing tool to pull in any Claude task-list changes and
    // narration (both live only in the transcript, not in this payload).
    if (agent === 'claude' && !SELF) {
      try { syncClaudeTasks(hook, sid, append); } catch { /* never break */ }
      try { syncClaudeSay(hook, sid, append, item); } catch { /* never break */ }
    }

    if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) && inp.file_path) {
      append(withItem({ type: 'edit', path: path.relative(root, inp.file_path), tool }));
    } else if (tool === 'apply_patch') { // Codex edits
      for (const f of patchFiles(inp.command)) {
        const abs = path.isAbsolute(f) ? f : path.join(hook.cwd || root, f);
        append(withItem({ type: 'edit', path: path.relative(root, abs), tool: 'apply_patch' }));
      }
    } else if (tool === 'TodoWrite' && Array.isArray(inp.todos)) {
      append(withItem({ type: 'todos', todos: inp.todos.map(td => ({ text: td.content, done: td.status === 'completed', status: td.status })) }));
    } else if (tool === 'update_plan' && Array.isArray(inp.plan)) { // Codex plan
      append(withItem({ type: 'todos', todos: inp.plan.map(s => ({ text: s.step, done: s.status === 'completed', status: s.status })) }));
    } else if (tool === 'Bash') {
      const r = hook.tool_response;
      const out = typeof r === 'string' ? r : (r && (r.stdout || r.output)) || '';
      if (CENTRAL && /git\s+commit/.test(inp.command || '')) {
        const c = parseCommit(out);
        if (c) { append(withItem(c)); return; }
      }
      // Emit a pr_ref SIGHTING (never pr state) only for Claude — a hook-mode Codex
      // session's meter already emits pr_ref from the same rollout, so doing it here
      // too would double it. Don't `return`: fall through to the activity event below
      // so the session wakes (the reducer's pr_ref case doesn't, but a tool event
      // does — a gh pr run right after an approval prompt would otherwise stay ATTENTION).
      if (CENTRAL && agent === 'claude' && /\bgh\b[^\n]*\bpr\b/.test(inp.command || '')) {
        const ref = parseGhPrRef(inp.command || '', out); // null unless it's a create/merge
        if (ref) append(withItem(ref));
      }
      const full = (inp.command || '').replace(/\s+/g, ' ').trim();
      if (full) {
        const ev = { type: 'tool', tool: 'run', text: full.slice(0, 120) };
        // The display text is truncated; for a gh pr command keep the full command
        // too, so the PR poller can find a PR ref that sits past 120 chars.
        if (full.length > 120 && /\bgh\b[^\n]*\bpr\b/.test(full)) ev.cmd = full.slice(0, 500);
        append(withItem(ev));
      }
    }
    return;
  }
}

try { main(); } catch { /* observability must never break the session */ }
process.exit(0);
