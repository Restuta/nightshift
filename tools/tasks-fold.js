// Shared folding for Claude's task tools (TaskCreate / TaskUpdate / delete).
//
// Claude Code keeps the session task list only in the transcript and mutates it
// one task at a time — unlike the old TodoWrite, which sent the whole list every
// call. nightshift's board wants the full plan as a `todos` snapshot, so this
// module reconstructs the list from transcript lines. Both consumers agree on it:
//   - the live hook tails new transcript bytes (by saved byte offset) per tool call,
//   - the /nightshift backfill replays the whole transcript once at recording start.
//
// State shape: { tasks: [{id, subject, status}], pending: {<tool_use_id>: subject}, offset }
// `pending` holds a TaskCreate whose result (which carries the assigned "#N" id)
// hasn't been seen yet — the result can land in a later transcript read.

const fs = require('fs');

function emptyState() { return { tasks: [], pending: {}, offset: 0 }; }

// Apply one parsed transcript line's tool_use / tool_result blocks to `state`.
// Returns true if the visible task list changed. Subagent (sidechain) threads are
// skipped — their task ops aren't the main session's plan shown to the human.
function applyLine(ev, state) {
  if (!ev || ev.isSidechain) return false;
  const msg = ev.message;
  if (!msg || !Array.isArray(msg.content)) return false;
  if (!state.pending) state.pending = {};
  let changed = false;
  for (const b of msg.content) {
    if (!b) continue;
    if (b.type === 'tool_use' && b.name === 'TaskCreate') {
      state.pending[b.id] = (b.input && b.input.subject) || '';
    } else if (b.type === 'tool_use' && b.name === 'TaskUpdate' && b.input) {
      const t = state.tasks.find(x => x.id === String(b.input.taskId));
      if (t) {
        if (b.input.status && t.status !== b.input.status) { t.status = b.input.status; changed = true; }
        if (b.input.subject && t.subject !== b.input.subject) { t.subject = b.input.subject; changed = true; }
      }
    } else if (b.type === 'tool_result' && b.tool_use_id != null && state.pending[b.tool_use_id] !== undefined) {
      // "Task #N created successfully: ..." — N is the real id Claude assigned.
      const txt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
      const m = /#(\d+)/.exec(txt);
      const id = m ? m[1] : String(state.tasks.reduce((a, t) => Math.max(a, +t.id || 0), 0) + 1);
      state.tasks.push({ id, subject: state.pending[b.tool_use_id], status: 'pending' });
      delete state.pending[b.tool_use_id];
      changed = true;
    }
  }
  return changed;
}

// Map the kept tasks to a `todos` event payload (the shape TodoWrite/update_plan
// already produce), dropping deleted tasks.
function toTodos(state) {
  return {
    type: 'todos',
    todos: state.tasks
      .filter(t => t.status !== 'deleted')
      .map(t => ({ text: t.subject, done: t.status === 'completed', status: t.status || 'pending' })),
  };
}

// Read complete new lines from `file` starting at byte `offset`. Returns the RAW
// lines (callers parse only the ones that matter — see lineMayMatter) and the
// offset just past the last newline consumed. A shrunk file (rotation/truncation)
// resets to its new size. Reads always start on a newline boundary (ASCII \n), so
// no multibyte char is ever split at the start; the partial tail past the last \n
// is dropped, so the end is safe too.
function readNewLines(file, offset) {
  let size;
  try { size = fs.statSync(file).size; } catch { return { lines: [], offset }; }
  if (size < offset) return { lines: [], offset: size };  // truncated — adopt new size
  if (size === offset) return { lines: [], offset };
  const fd = fs.openSync(file, 'r');
  try {
    const len = size - offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) return { lines: [], offset };        // only a partial line so far
    const complete = text.slice(0, lastNl);
    const consumed = Buffer.byteLength(complete, 'utf8') + 1; // + the newline
    return { lines: complete.split('\n').filter(Boolean), offset: offset + consumed };
  } finally { fs.closeSync(fd); }
}

// Cheap pre-filter so callers can skip JSON.parse on the bulk of transcript lines
// (big file reads, edits, assistant text) that can't touch the task list — keeping
// the per-tool-call hook cost flat regardless of tool-output size. A line matters
// only if it names a task tool, or — while a TaskCreate awaits its id — carries a
// tool_result. (A false positive, e.g. a file whose text contains "TaskCreate",
// just costs one harmless parse.)
function lineMayMatter(raw, havePending) {
  if (!raw) return false;
  if (raw.includes('TaskCreate') || raw.includes('TaskUpdate')) return true;
  return havePending && raw.includes('tool_result');
}

// Byte offset just past the last complete line of `text` — what to persist after
// a full replay so a tailer continues exactly where the replay stopped.
function offsetAfterLastLine(text) {
  const lastNl = text.lastIndexOf('\n');
  return lastNl === -1 ? 0 : Buffer.byteLength(text.slice(0, lastNl), 'utf8') + 1;
}

module.exports = { emptyState, applyLine, toTodos, readNewLines, lineMayMatter, offsetAfterLastLine };
