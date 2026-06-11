#!/usr/bin/env node
// Single entrypoint for all Claude Code hooks (wired in .claude/settings.json).
// Reads the hook payload from stdin, appends traceboard events to the log.
// Contract: never crash, never block — agent work must not be disturbed by
// observability. Every path exits 0.

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Where this project's events go:
//   1. $NIGHTSHIFT_LOG                          — explicit override
//   2. <root>/.nightshift/events.jsonl          — if attached (dir exists)
//   3. ~/.nightshift/sessions/<slug>.jsonl      — central, for global install
// Central mode lets one global hook record every project without dropping a
// .nightshift/ folder into repos that never opted in.
function resolveLog() {
  if (process.env.NIGHTSHIFT_LOG) return { log: process.env.NIGHTSHIFT_LOG, central: false };
  const localDir = path.join(root, '.nightshift');
  if (fs.existsSync(localDir)) return { log: path.join(localDir, 'events.jsonl'), central: false };
  const home = process.env.NIGHTSHIFT_HOME || path.join(os.homedir(), '.nightshift');
  const slug = root.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '-') || 'session';
  return { log: path.join(home, 'sessions', `${slug}.jsonl`), central: true };
}

const { log: LOG, central: CENTRAL } = resolveLog();

function append(ev) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...ev }) + '\n');
}

function readLog() {
  try {
    return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function main() {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { return; }
  let hook;
  try { hook = JSON.parse(input); } catch { return; }

  const name = hook.hook_event_name;

  if (name === 'SessionStart') {
    append({ type: 'session', phase: 'start', agent: 'claude', session: hook.session_id, cwd: hook.cwd });
    return;
  }

  if (name === 'Stop') {
    append({ type: 'session', phase: 'idle', session: hook.session_id });
    return;
  }

  if (name === 'Notification') {
    // Fires when the agent needs permission or input — the one state the
    // human must act on. Surfaced loudly by the board.
    append({ type: 'session', phase: 'attention', text: hook.message || '', session: hook.session_id });
    return;
  }

  if (name === 'PostToolUse') {
    const tool = hook.tool_name || '';
    const inp = hook.tool_input || {};
    if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) && inp.file_path) {
      append({ type: 'edit', path: path.relative(root, inp.file_path), tool });
    } else if (tool === 'TodoWrite' && Array.isArray(inp.todos)) {
      append({
        type: 'todos',
        todos: inp.todos.map(td => ({ text: td.content, done: td.status === 'completed' })),
      });
    } else if (CENTRAL && tool === 'Bash' && /git\s+commit/.test(inp.command || '')) {
      // No git hook is installed in central/global mode, so capture commits the
      // agent makes by parsing the Bash output (only emits if the commit
      // actually printed its "[branch sha] message" confirmation). Attached
      // projects skip this — their git post-commit hook already covers commits,
      // including ones made by hand.
      const r = hook.tool_response;
      const out = typeof r === 'string' ? r : (r && (r.stdout || r.output)) || '';
      const head = out.match(/\[[^\s\]]+ ([0-9a-f]{7,40})\] (.+)/);
      if (head) {
        const num = re => { const m = out.match(re); return m ? Number(m[1]) : 0; };
        append({
          type: 'commit', sha: head[1].slice(0, 7), message: head[2].trim(),
          add: num(/(\d+) insertions?\(\+\)/), del: num(/(\d+) deletions?\(-\)/),
          files: num(/(\d+) files? changed/),
        });
      }
    }
    return;
  }

  if (name === 'UserPromptSubmit') {
    append({ type: 'session', phase: 'resume', agent: 'claude', session: hook.session_id });
    // Bidirectional pickup: surface open inbox cards as context for the turn.
    const items = new Map();
    for (const ev of readLog()) {
      if (ev.type !== 'item' || !ev.id) continue;
      items.set(ev.id, { ...(items.get(ev.id) || {}), ...ev });
    }
    const inbox = [...items.values()].filter(it => it.status === 'inbox');
    if (inbox.length) {
      const lines = inbox.map(it => `- [${it.id}] ${it.title || '(untitled)'}`);
      console.log(
        `Nightshift inbox has ${inbox.length} open card(s) added by the human:\n` +
        lines.join('\n') +
        `\nIf one is relevant to this turn, move it to "doing" via tools/emit.js and handle it; otherwise leave it.`
      );
    }
    return;
  }
}

try { main(); } catch { /* observability must never break the session */ }
process.exit(0);
