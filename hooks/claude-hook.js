#!/usr/bin/env node
// Single entrypoint for all Claude Code hooks (wired in .claude/settings.json).
// Reads the hook payload from stdin, appends traceboard events to the log.
// Contract: never crash, never block — agent work must not be disturbed by
// observability. Every path exits 0.

const fs = require('fs');
const path = require('path');

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG = path.join(root, '.traceboard', 'events.jsonl');

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
    append({ type: 'session', phase: 'start', session: hook.session_id, cwd: hook.cwd });
    return;
  }

  if (name === 'Stop') {
    append({ type: 'session', phase: 'idle', session: hook.session_id });
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
    }
    return;
  }

  if (name === 'UserPromptSubmit') {
    append({ type: 'session', phase: 'resume', session: hook.session_id });
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
        `Traceboard inbox has ${inbox.length} open card(s) added by the human:\n` +
        lines.join('\n') +
        `\nIf one is relevant to this turn, move it to "doing" via tools/emit.js and handle it; otherwise leave it.`
      );
    }
    return;
  }
}

try { main(); } catch { /* observability must never break the session */ }
process.exit(0);
