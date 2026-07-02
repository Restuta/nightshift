#!/usr/bin/env node
// One-command attach: wire nightshift into another project.
//   npm run attach -- /path/to/project
//
// Vendors the event-emitting kit into <target>/.nightshift/ (self-contained,
// no dependency on this repo's location), merges the Claude Code hooks into
// the target's .claude/settings.json, installs the git post-commit hook, and
// gitignores the log. Idempotent — safe to run again after an update here.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const target = process.argv[2];
if (!target || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
  console.error('usage: attach.js /path/to/project');
  process.exit(1);
}
const root = path.resolve(target);
const here = path.resolve(__dirname, '..');
const done = [];

// 1. vendor the kit — hooks + emit, runnable without this repo on disk
const kit = [
  ['hooks/claude-hook.js', '.nightshift/hooks/claude-hook.js'],
  ['hooks/agent-hook.js', '.nightshift/hooks/agent-hook.js'], // claude-hook is a shim that requires this
  ['hooks/git-post-commit.js', '.nightshift/hooks/git-post-commit.js'],
  ['tools/emit.js', '.nightshift/tools/emit.js'],
];
for (const [src, dst] of kit) {
  const out = path.join(root, dst);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(path.join(here, src), out);
}
done.push('kit       vendored into .nightshift/ (agent-hook + claude-hook shim, git hook, emit)');

// 2. merge Claude Code hooks into .claude/settings.json (never clobber)
const settingsPath = path.join(root, '.claude', 'settings.json');
let settings = {};
if (fs.existsSync(settingsPath)) {
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch {
    console.error(`refusing to touch unparsable ${settingsPath} — fix it and rerun`);
    process.exit(1);
  }
}
const CMD = 'node "$CLAUDE_PROJECT_DIR/.nightshift/hooks/claude-hook.js"';
const HOOK_EVENTS = {
  SessionStart: null, SessionEnd: null, UserPromptSubmit: null, Stop: null, Notification: null,
  PostToolUse: 'Edit|Write|MultiEdit|NotebookEdit|TodoWrite',
};
settings.hooks = settings.hooks || {};
let wired = 0;
for (const [event, matcher] of Object.entries(HOOK_EVENTS)) {
  const groups = settings.hooks[event] = settings.hooks[event] || [];
  const present = groups.some(g => (g.hooks || []).some(h => (h.command || '').includes('.nightshift/hooks/claude-hook.js')));
  if (present) continue;
  const group = { hooks: [{ type: 'command', command: CMD }] };
  if (matcher) group.matcher = matcher;
  groups.push(group);
  wired++;
}
if (wired) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}
done.push(`claude    ${wired ? `${wired} hook(s) merged into` : 'already wired in'} .claude/settings.json`);

// 3. git post-commit hook
if (fs.existsSync(path.join(root, '.git'))) {
  let hooksPath = '';
  try { hooksPath = execFileSync('git', ['-C', root, 'config', 'core.hooksPath'], { encoding: 'utf8' }).trim(); } catch { /* unset */ }
  if (hooksPath) {
    done.push(`git       SKIPPED — core.hooksPath=${hooksPath} is custom; add this line to its post-commit:\n            node "$(git rev-parse --show-toplevel)/.nightshift/hooks/git-post-commit.js" 2>/dev/null || true`);
  } else {
    const hookFile = path.join(root, '.git', 'hooks', 'post-commit');
    const line = 'node "$(git rev-parse --show-toplevel)/.nightshift/hooks/git-post-commit.js" 2>/dev/null || true';
    if (!fs.existsSync(hookFile)) {
      fs.mkdirSync(path.dirname(hookFile), { recursive: true });
      fs.writeFileSync(hookFile, `#!/bin/sh\n${line}\n`, { mode: 0o755 });
      done.push('git       post-commit hook installed');
    } else if (fs.readFileSync(hookFile, 'utf8').includes('.nightshift')) {
      done.push('git       post-commit hook already installed');
    } else {
      fs.appendFileSync(hookFile, `\n${line}\n`);
      done.push('git       appended to existing post-commit hook');
    }
  }
} else {
  done.push('git       SKIPPED — not a git repository (no commit events)');
}

// 4. keep the log out of version control
const giPath = path.join(root, '.gitignore');
const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
if (!/^\.nightshift\/?$/m.test(gi)) {
  fs.writeFileSync(giPath, gi + (gi && !gi.endsWith('\n') ? '\n' : '') + '.nightshift/\n');
  done.push('gitignore .nightshift/ added');
} else {
  done.push('gitignore .nightshift/ already present');
}

// 5. first event, so the board has something to show immediately
const logFile = path.join(root, '.nightshift', 'events.jsonl');
if (!fs.existsSync(logFile)) {
  fs.writeFileSync(logFile, JSON.stringify({
    t: Date.now(), type: 'note', text: `🔌 nightshift attached to ${path.basename(root)}`,
  }) + '\n');
}

console.log(`nightshift attached to ${root}\n`);
for (const d of done) console.log(`  ${d}`);
console.log(`\nwatch it:  node ${path.relative(process.cwd(), path.join(here, 'server.js')) || 'server.js'} --log ${path.join(root, '.nightshift', 'events.jsonl')}`);
console.log('intent layer (optional): add the dogfooding protocol from CLAUDE.md;');
console.log(`the agent emits items via: node .nightshift/tools/emit.js item --id <slug> --title "..." --status doing`);
