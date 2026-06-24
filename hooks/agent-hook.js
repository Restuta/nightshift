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

const NS_HOME = process.env.NIGHTSHIFT_HOME || path.join(os.homedir(), '.nightshift');

// Folding for Claude's incremental Task tools (see tools/tasks-fold.js). Loaded
// defensively — a missing/broken module must never take the hook down.
let tasksFold = null;
try { tasksFold = require(path.join(__dirname, '..', 'tools', 'tasks-fold.js')); } catch { /* optional */ }

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
function recording(hook, central) {
  if (!central || process.env.NIGHTSHIFT) return true;
  const sid = hook.session_id;
  return !!(sid && fs.existsSync(path.join(NS_HOME, 'active', sid)));
}

function makeAppend(LOG) {
  return ev => {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...ev }) + '\n');
  };
}

function readLog(LOG) {
  try {
    return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
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

// PRs the session itself touches via gh, so the board shows THIS session's PRs
// (not the repo's hundreds). State must be a recorded FACT, never an assumption:
//   - create: gh prints the new PR's URL on success → that's the number, state open.
//   - merge:  the COMMAND running proves nothing (it also runs for --auto, blocked,
//     or failed merges); only the success line "Merged pull request #N" is proof.
// Anything else (view/list/checks) is left to the poller, which reads gh state.
function parseGhPr(cmd, out) {
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
    return m ? { type: 'pr', number: Number(m[2]), url: 'https://' + m[1], state: 'open' } : null;
  }
  if (verb === 'merge') {
    // gh's success line is "Merged pull request owner/repo#N (...)" (older builds
    // omit owner/repo). Keep the owner/repo as a URL when present — a cross-repo
    // merge must carry its repo, or the poller would re-scope the bare number to
    // the current repo and record the wrong PR.
    const m = (out || '').match(/Merged pull request\s+([\w.-]+\/[\w.-]+)?#(\d+)/i);
    if (!m) return null;
    const ev = { type: 'pr', number: Number(m[2]), state: 'merged' };
    // Repo from the output if gh printed it, else from the command's -R/--repo —
    // an older gh prints a bare "#N", and a repo-less merged event would let the
    // poller re-scope a cross-repo merge to the current repo.
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
  const sid = hook.session_id;

  if (name === 'SessionStart') {
    append({ type: 'session', phase: 'start', agent, session: sid, cwd: hook.cwd });
    return;
  }

  if (name === 'Stop') { // Claude only — Codex fires no Stop
    // For central recordings (where we synthesize the turn card, below), retire
    // it here: Claude gives a clean end-of-turn signal Codex lacks, so the card
    // moves to "done" the moment the turn ends — no card stuck in "doing" until
    // the next prompt. Locally-attached repos keep their hand-emitted cards, so
    // leave those alone.
    // Capture any last task change before the card is retired (a TaskUpdate with
    // no following tool call would otherwise be missed until the next turn).
    if (agent === 'claude' && !SELF) { try { syncClaudeTasks(hook, sid, append); } catch { /* never break */ } }
    if (!SELF && sid) {
      const st = turnState(sid);
      if (st.card) { append({ type: 'item', id: st.card, status: 'done' }); st.card = null; saveTurn(sid, st); }
    }
    append({ type: 'session', phase: 'idle', session: sid });
    return;
  }

  if (name === 'Notification') { // Claude only
    append({ type: 'session', phase: 'attention', text: hook.message || '', session: sid });
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
    const synth = sid && isHumanPrompt(hook.prompt) && (agent === 'codex' || !SELF);
    if (synth) {
      const st = turnState(sid);
      if (st.card) append({ type: 'item', id: st.card, status: 'done' });
      st.turnN++;
      st.card = `turn-${st.turnN}`;
      append({ type: 'item', id: st.card, title: promptTitle(hook.prompt) || `turn ${st.turnN}`, status: 'doing' });
      append({ type: 'session', phase: 'resume', agent, session: sid });
      saveTurn(sid, st);
      // Show the current task plan on the fresh card right away (Claude) — so the
      // active card carries its checklist from the start of the turn, not only
      // after the next task change. Pulled from the state the transcript tail keeps.
      if (tasksFold && agent === 'claude') {
        try {
          const ts = JSON.parse(fs.readFileSync(path.join(TASKS, sid + '.json'), 'utf8'));
          const todos = tasksFold.toTodos(ts);
          if (todos.todos.length) append({ ...todos, item: st.card });
        } catch { /* no task state yet */ }
      }
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

  if (name === 'PostToolUse') {
    const tool = hook.tool_name || '';
    const inp = hook.tool_input || {};
    const item = sid ? turnState(sid).card : null;
    const withItem = ev => (item ? { ...ev, item } : ev);

    // Piggyback on this firing tool to pull in any Claude task-list changes
    // (TaskCreate/TaskUpdate live only in the transcript, not in this payload).
    if (agent === 'claude' && !SELF) { try { syncClaudeTasks(hook, sid, append); } catch { /* never break */ } }

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
      // Capture PRs only for Claude — a hook-mode Codex session's meter already
      // emits pr events from the same rollout, so doing it here too would double
      // them. Don't `return`: fall through to the activity event below so the
      // session wakes (the reducer's pr case doesn't, but a tool event does — a
      // gh pr run right after an approval prompt would otherwise stay in ATTENTION).
      if (CENTRAL && agent === 'claude' && /\bgh\b[^\n]*\bpr\b/.test(inp.command || '')) {
        const pr = parseGhPr(inp.command || '', out); // null unless it's a create/merge
        if (pr) append(withItem(pr));
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
