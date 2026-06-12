#!/usr/bin/env node
// Synthesize a nightshift tape from a past agent session — attach the board
// retroactively, no hooks required. Reads Claude Code transcripts and Codex
// rollouts; the format is auto-detected.
//   node tools/import-transcript.js <session.jsonl> [--out <file>]
//     [--repo <path>] [--no-repo] [--no-item]
//
// Claude Code transcripts: ~/.claude/projects/<munged-cwd>/<session-id>.jsonl
// Codex rollouts:          ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//
// Mapping (same vocabulary the live hooks produce, see docs/EVENTS.md):
//   first/last timestamp           → session start / end (start carries `agent`)
//   human prompts                  → session resume (idle closes the prior turn)
//   Edit/Write / patch_apply_end   → edit
//   TodoWrite                      → todos
//   AskUserQuestion                → session attention
//   `git commit` tool output       → commit (sha, message, shortstat)
//
// Commit facts default to `git log` over the session window when the
// transcript's cwd is a git repo (or pass --repo, repeatable) — exact numbers
// from git, not parsed from model output. Wins on sha collision. --no-repo
// falls back to parsing tool output only.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const flags = { repo: [] };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') flags.out = argv[++i];
  else if (argv[i] === '--repo') flags.repo.push(argv[++i]);
  else if (argv[i] === '--no-repo') flags.noRepo = true;
  else if (argv[i] === '--no-item') flags.noItem = true;
  else positional.push(argv[i]);
}

const src = positional[0];
if (!src) {
  console.error('usage: import-transcript.js <session.jsonl> [--out <file>] [--repo <path>] [--no-repo] [--no-item]');
  process.exit(1);
}

const lines = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean);

// Standard `git commit` output anywhere in a tool result:
// "[branch sha] message" plus the shortstat line.
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

// ---- Claude Code transcript --------------------------------------------------

function parseClaude(lines) {
  const r = {
    events: [], parsedCommits: [], agent: 'claude',
    sessionId: null, cwd: null, title: null,
    firstT: null, lastT: null, prompts: 0, edits: 0,
  };
  let aiTitle = null, lastActivityT = null, phase = null;
  const pendingCommitCalls = new Map(); // tool_use id → t of the bash call

  // A human prompt is a non-meta user line whose content is plain text (string,
  // or an array with text blocks and no tool_result) and not a command echo.
  const isHumanPrompt = e => {
    if (e.type !== 'user' || e.isMeta) return false;
    const c = e.message && e.message.content;
    if (typeof c === 'string') return !/^\s*</.test(c);
    if (Array.isArray(c)) return c.some(b => b.type === 'text') && !c.some(b => b.type === 'tool_result');
    return false;
  };

  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.sessionId && !r.sessionId) r.sessionId = e.sessionId;
    if (e.cwd && !r.cwd) r.cwd = e.cwd;
    if (e.type === 'custom-title' && e.customTitle) r.title = e.customTitle;
    if (e.type === 'ai-title' && e.aiTitle) aiTitle = e.aiTitle;
    const t = e.timestamp ? Date.parse(e.timestamp) : null;
    if (t == null) continue;
    if (r.firstT == null) r.firstT = t;
    r.lastT = t;

    if (isHumanPrompt(e)) {
      // The lull before a prompt was idle time — close the previous turn there.
      if (phase === 'working' && lastActivityT != null) {
        r.events.push({ t: lastActivityT, type: 'session', phase: 'idle' });
      }
      r.events.push({ t, type: 'session', phase: 'resume' });
      phase = 'working';
      r.prompts++;
      continue;
    }

    if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      lastActivityT = t;
      const u = e.message.usage;
      if (u) {
        r.events.push({
          t, type: 'usage', model: e.message.model,
          in: u.input_tokens || 0, out: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheWrite: u.cache_creation_input_tokens || 0,
        });
        r.tokOut = (r.tokOut || 0) + (u.output_tokens || 0);
      }
      for (const b of e.message.content) {
        if (b.type !== 'tool_use') continue;
        const inp = b.input || {};
        if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name) && (inp.file_path || inp.notebook_path)) {
          r.events.push({ t, type: 'edit', path: path.relative(r.cwd || '.', inp.file_path || inp.notebook_path), tool: b.name });
          r.edits++;
        } else if (b.name === 'TodoWrite' && Array.isArray(inp.todos)) {
          r.events.push({
            t, type: 'todos',
            todos: inp.todos.map(td => ({ text: td.content, done: td.status === 'completed' })),
          });
        } else if (b.name === 'AskUserQuestion') {
          const q = inp.questions && inp.questions[0] && inp.questions[0].question;
          r.events.push({ t, type: 'session', phase: 'attention', text: q || 'agent asked a question' });
        } else if (b.name === 'Bash' && /git .*commit/.test(inp.command || '')) {
          pendingCommitCalls.set(b.id, t);
        }
      }
      continue;
    }

    if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
      for (const b of e.message.content) {
        if (b.type !== 'tool_result' || !pendingCommitCalls.has(b.tool_use_id)) continue;
        const callT = pendingCommitCalls.get(b.tool_use_id);
        pendingCommitCalls.delete(b.tool_use_id);
        const text = typeof b.content === 'string'
          ? b.content
          : (b.content || []).map(c => c.text || '').join('\n');
        const c = parseCommitOutput(text, callT);
        if (c) r.parsedCommits.push(c);
      }
    }
  }
  r.title = r.title || aiTitle;
  return r;
}

// ---- Codex rollout -----------------------------------------------------------

function parseCodex(lines) {
  const r = {
    events: [], parsedCommits: [], agent: 'codex',
    sessionId: null, cwd: null, title: null,
    firstT: null, lastT: null, prompts: 0, edits: 0,
  };
  let lastActivityT = null, phase = null, model = null, turnN = 0, card = null;
  const pendingCommitCalls = new Map(); // call_id → t of the exec call

  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const p = e.payload;
    const t = e.timestamp ? Date.parse(e.timestamp) : null;
    if (t == null || !p) continue;
    if (r.firstT == null) r.firstT = t;
    r.lastT = t;

    if (e.type === 'session_meta') {
      r.sessionId = p.id || r.sessionId;
      r.cwd = p.cwd || r.cwd;
      continue;
    }

    if (e.type === 'turn_context' && p.model) { model = p.model; continue; }

    if (e.type === 'event_msg') {
      if (p.type === 'user_message') {
        const line = p.message ? String(p.message).trim().split('\n')[0].slice(0, 64).trim() : null;
        if (!r.title && line) r.title = line;
        if (phase === 'working' && lastActivityT != null) {
          r.events.push({ t: lastActivityT, type: 'session', phase: 'idle' });
        }
        // One card per turn — Codex has no intent layer, so derive it.
        if (card) r.events.push({ t, type: 'item', id: card, status: 'done' });
        card = `turn-${++turnN}`;
        r.events.push({ t, type: 'item', id: card, title: line || `turn ${turnN}`, status: 'doing' });
        r.events.push({ t, type: 'session', phase: 'resume' });
        phase = 'working';
        r.prompts++;
      } else if (p.type === 'task_complete') {
        // Keep the turn's card in progress until the next prompt supersedes it.
        r.events.push({ t, type: 'session', phase: 'idle' });
        phase = 'idle';
      } else if (p.type === 'patch_apply_end' && p.success && p.changes) {
        lastActivityT = t;
        for (const file of Object.keys(p.changes)) {
          r.events.push({ t, type: 'edit', path: path.relative(r.cwd || '.', file), tool: 'apply_patch', ...(card ? { item: card } : {}) });
          r.edits++;
        }
      } else if (p.type === 'token_count' && p.info && p.info.last_token_usage) {
        // last_token_usage is the per-turn delta; input_tokens includes the
        // cached portion, so split it out for accurate cost.
        const u = p.info.last_token_usage;
        const cached = u.cached_input_tokens || 0;
        r.events.push({
          t, type: 'usage', model,
          in: Math.max(0, (u.input_tokens || 0) - cached),
          out: u.output_tokens || 0, cacheRead: cached,
        });
        r.tokOut = (r.tokOut || 0) + (u.output_tokens || 0);
      }
      continue;
    }

    if (e.type === 'response_item') {
      if (p.type === 'function_call') {
        lastActivityT = t;
        let cmd = '';
        try { cmd = JSON.parse(p.arguments || '{}').cmd || ''; } catch { /* not json */ }
        if (/git .*commit/.test(cmd)) pendingCommitCalls.set(p.call_id, t);
      } else if (p.type === 'function_call_output' && pendingCommitCalls.has(p.call_id)) {
        const callT = pendingCommitCalls.get(p.call_id);
        pendingCommitCalls.delete(p.call_id);
        const c = parseCommitOutput(String(p.output || ''), callT);
        if (c) { if (card) c.item = card; r.parsedCommits.push(c); }
      }
    }
  }
  return r;
}

// ---- detect, parse, assemble -------------------------------------------------

const isCodex = lines.slice(0, 25).some(l => l.includes('"session_meta"'));
const r = isCodex ? parseCodex(lines) : parseClaude(lines);

if (r.firstT == null) {
  console.error('no timestamped entries found — is this a Claude Code transcript or Codex rollout?');
  process.exit(1);
}

const sid8 = (r.sessionId || 'unknown').slice(0, 8);
const title = r.title || (r.cwd ? path.basename(r.cwd) : `session ${sid8}`);
const events = r.events;

// commit facts: default --repo to the session's cwd when it's a git repo
let autoRepo = false;
if (!flags.repo.length && !flags.noRepo && r.cwd) {
  try {
    execFileSync('git', ['-C', r.cwd, 'rev-parse', '--is-inside-work-tree'], { stdio: ['ignore', 'pipe', 'ignore'] });
    flags.repo = [r.cwd];
    autoRepo = true;
  } catch { /* not a repo — tool-output parsing only */ }
}

const gitCommits = [];
for (const repo of flags.repo) {
  const out = execFileSync('git', [
    '-C', repo, 'log', '--no-merges',
    '--since', new Date(r.firstT - 60000).toISOString(),
    '--until', new Date(r.lastT + 60000).toISOString(),
    '--pretty=format:%x01%h%x09%ct%x09%s', '--shortstat',
  ], { encoding: 'utf8' });
  for (const chunk of out.split('\x01').filter(Boolean)) {
    const [headLine, statLine] = chunk.split('\n').map(s => s.trim()).filter(Boolean);
    const [sha, ct, message] = headLine.split('\t');
    const num = re => { const m = (statLine || '').match(re); return m ? Number(m[1]) : 0; };
    gitCommits.push({
      t: Number(ct) * 1000, type: 'commit', sha, message,
      add: num(/(\d+) insertions?\(\+\)/), del: num(/(\d+) deletions?\(-\)/),
      files: num(/(\d+) files? changed/),
    });
  }
}
const gitShas = new Set(gitCommits.map(c => c.sha));
const commits = [...gitCommits, ...r.parsedCommits.filter(c => !gitShas.has(c.sha))];
events.push(...commits);

events.push({ t: r.firstT, type: 'session', phase: 'start', title, agent: r.agent, session: r.sessionId, cwd: r.cwd });
if (!flags.noItem) {
  events.push({
    t: r.firstT, type: 'item', id: `wi-import-${sid8}`, title, status: 'doing',
    note: `imported from ${path.basename(src)}`,
  });
}
events.push({ t: r.lastT, type: 'session', phase: 'end' });

events.sort((a, b) => a.t - b.t);

const out = flags.out || path.join('.nightshift', `import-${sid8}.jsonl`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, events.map(e => JSON.stringify(e)).join('\n') + '\n');

const mins = Math.round((r.lastT - r.firstT) / 60000);
const usageCount = events.filter(e => e.type === 'usage').length;
console.log(`${out}: ${events.length} events — "${title}" (${r.agent})`);
console.log(`  ${mins} min, ${r.prompts} prompts, ${r.edits} edits, ${commits.length} commits` +
  (gitCommits.length ? ` (${gitCommits.length} from git${autoRepo ? `, auto: ${flags.repo[0]}` : ''})` : '') +
  (usageCount ? `, ${(r.tokOut || 0).toLocaleString('en-US')} out-tokens over ${usageCount} turns` : ''));
console.log(`  replay: node server.js --log ${out}`);
