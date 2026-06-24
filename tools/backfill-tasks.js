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
const { emptyState, applyLine, toTodos, lineMayMatter, offsetAfterLastLine } = require('./tasks-fold.js');

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
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    // Parse only task ops, tool_results (while a create awaits its id), and the
    // session-name lines — skip the bulk (big reads/edits) without parsing.
    const hasTitle = raw.includes('customTitle');
    if (!hasTitle && !lineMayMatter(raw, Object.keys(state.pending).length > 0)) continue;
    let ev; try { ev = JSON.parse(raw); } catch { continue; }
    if (ev.customTitle) customTitle = ev.customTitle;   // last one wins (renames)
    applyLine(ev, state);
  }
  state.offset = offsetAfterLastLine(text);   // hook tails from exactly here

  const tasksDir = path.join(NS_HOME, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, sid + '.json'), JSON.stringify(state));

  // One reverse pass over the existing tape gives both the current session title
  // (so we don't re-emit an unchanged rename on every /nightshift) and the most
  // recent card (the todos fallback target when no turn is open).
  let lastTitle = null, lastCard = null;
  try {
    const lines = fs.readFileSync(log, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0 && (lastTitle == null || lastCard == null); i--) {
      if (!lines[i]) continue;
      let e; try { e = JSON.parse(lines[i]); } catch { continue; }
      if (lastTitle == null && e.type === 'session' && e.title) lastTitle = e.title;
      if (lastCard == null && e.type === 'item' && e.id) lastCard = e.id;
    }
  } catch { /* fresh tape */ }

  // Flow Claude's session name into the tape as the title (the board prefers it
  // over the worktree basename), only when it actually changed.
  if (customTitle && customTitle !== lastTitle) {
    fs.appendFileSync(log, JSON.stringify({ t: Date.now(), type: 'session', title: customTitle }) + '\n');
  }

  // Emit the snapshot, attached to a card so it shows: the open turn card if any,
  // else the most recent card — the next turn's card picks it up live.
  const todos = toTodos(state);
  if (todos.todos.length) {
    let card = null;
    try { card = JSON.parse(fs.readFileSync(path.join(NS_HOME, 'turns', sid + '.json'), 'utf8')).card; } catch { /* none */ }
    if (!card) card = lastCard;
    const ev = card ? { ...todos, item: card } : todos;
    fs.appendFileSync(log, JSON.stringify({ t: Date.now(), ...ev }) + '\n');
    process.stdout.write(`seeded ${todos.todos.length} task(s)\n`);
  }
} catch { /* observability must never break the session */ }
process.exit(0);
