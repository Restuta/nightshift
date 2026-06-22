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

// Where this project's events go (resolved from the SESSION's cwd, which the
// payload carries — the hook process's own cwd is not the project dir for Codex):
//   1. $NIGHTSHIFT_LOG                          — explicit override
//   2. <root>/.nightshift/events.jsonl          — if attached (dir exists)
//   3. ~/.nightshift/sessions/<slug>.jsonl      — central, for global install
function resolveLog(root) {
  if (process.env.NIGHTSHIFT_LOG) return { log: process.env.NIGHTSHIFT_LOG, central: false };
  const localDir = path.join(root, '.nightshift');
  if (fs.existsSync(localDir)) return { log: path.join(localDir, 'events.jsonl'), central: false };
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

function main() {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { return; }
  let hook;
  try { hook = JSON.parse(input); } catch { return; }

  const root = process.env.CLAUDE_PROJECT_DIR || hook.cwd || process.cwd();
  const { log: LOG, central: CENTRAL } = resolveLog(root);

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
    if (CENTRAL && sid) {
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
    // layer to defer to: always for Codex (it has no intent layer at all), and
    // for Claude in CENTRAL recordings — a globally-recorded session (e.g. some
    // other repo) that won't call emit.js itself, so without this its board has
    // zero cards. A locally-attached repo (CENTRAL false) keeps emitting its own
    // PR-sized cards via emit.js, so we leave Claude alone there. Close the prior
    // turn, open a new one titled by the prompt.
    const synth = sid && (CENTRAL || agent === 'codex');
    if (synth) {
      const st = turnState(sid);
      if (st.card) append({ type: 'item', id: st.card, status: 'done' });
      st.turnN++;
      st.card = `turn-${st.turnN}`;
      const title = (hook.prompt || '').trim().split('\n')[0].slice(0, 64).trim();
      append({ type: 'item', id: st.card, title: title || `turn ${st.turnN}`, status: 'doing' });
      append({ type: 'session', phase: 'resume', agent, session: sid });
      saveTurn(sid, st);
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
      const text = (inp.command || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (text) append(withItem({ type: 'tool', tool: 'run', text }));
    }
    return;
  }
}

try { main(); } catch { /* observability must never break the session */ }
process.exit(0);
