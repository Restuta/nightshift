#!/usr/bin/env node
// Seed a Claude session's task list into nightshift from its transcript.
//
// Claude's Task tools (TaskCreate/TaskUpdate) live only in the session transcript
// and aren't in the hook matcher, so a session that already had tasks before
// recording started would show none. Run this at /nightshift start: it replays
// the transcript once, writes the per-session task state (and the byte offset the
// live hook tails from), and emits one `todos` snapshot so the board shows the
// plan immediately. Idempotent and fail-open.
//
//   node tools/backfill-tasks.js --log <log> --sid <sid> [--transcript <path>] [--cwd <dir>]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { emptyState, applyLine, toTodos, offsetAfterLastLine } = require('./tasks-fold.js');

function arg(name) { const i = process.argv.indexOf(name); return i !== -1 ? process.argv[i + 1] : null; }

try {
  const log = arg('--log') || process.env.NIGHTSHIFT_LOG;
  const sid = arg('--sid') || process.env.CLAUDE_CODE_SESSION_ID;
  const cwd = arg('--cwd') || process.cwd();
  if (!log || !sid) process.exit(0);
  const NS_HOME = process.env.NIGHTSHIFT_HOME || path.join(os.homedir(), '.nightshift');

  // Locate the transcript: ~/.claude/projects/<escaped-cwd>/<sid>.jsonl, where
  // Claude escapes every non-alphanumeric char in the cwd to '-'.
  let tp = arg('--transcript');
  if (!tp) {
    const proj = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    tp = path.join(os.homedir(), '.claude', 'projects', proj, sid + '.jsonl');
  }
  if (!fs.existsSync(tp)) process.exit(0);

  // Replay the whole transcript to reconstruct the current task list, and pick up
  // Claude's own session name (customTitle) — it's the human-meaningful label the
  // user knows the session by, not the worktree basename.
  const state = emptyState();
  let customTitle = null;
  const text = fs.readFileSync(tp, 'utf8');
  for (const l of text.split('\n')) {
    if (!l) continue;
    let ev; try { ev = JSON.parse(l); } catch { continue; }
    if (ev.customTitle) customTitle = ev.customTitle;   // last one wins (renames)
    applyLine(ev, state);
  }
  state.offset = offsetAfterLastLine(text);   // hook tails from exactly here

  // Flow the session name into the tape as the title (the board prefers it over
  // the worktree basename). Emit before the todos so the title is set first.
  if (customTitle) {
    fs.appendFileSync(log, JSON.stringify({ t: Date.now(), type: 'session', title: customTitle }) + '\n');
  }

  const tasksDir = path.join(NS_HOME, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, sid + '.json'), JSON.stringify(state));

  // Emit the snapshot, attached to a card so it actually shows. Prefer the open
  // turn card; at idle (no open card) fall back to the most recent card, so the
  // plan is visible now and the next turn's card picks it up live.
  const todos = toTodos(state);
  if (todos.todos.length) {
    let card = null;
    try { card = JSON.parse(fs.readFileSync(path.join(NS_HOME, 'turns', sid + '.json'), 'utf8')).card; } catch { /* none */ }
    if (!card) {
      try {
        const lines = fs.readFileSync(log, 'utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i]) continue;
          let e; try { e = JSON.parse(lines[i]); } catch { continue; }
          if (e.type === 'item' && e.id) { card = e.id; break; }
        }
      } catch { /* none */ }
    }
    const ev = card ? { ...todos, item: card } : todos;
    fs.appendFileSync(log, JSON.stringify({ t: Date.now(), ...ev }) + '\n');
    process.stdout.write(`seeded ${todos.todos.length} task(s)\n`);
  }
} catch { /* observability must never break the session */ }
process.exit(0);
