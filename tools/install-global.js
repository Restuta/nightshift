#!/usr/bin/env node
// Record every Claude Code session you run, in any project, automatically —
// without attaching to each one. Merges nightshift's hooks into your *global*
// ~/.claude/settings.json so they fire in all sessions, and routes each
// project's events to a central per-project log under ~/.nightshift/sessions/
// (nothing is written inside your repos).
//
//   node tools/install-global.js          # install / update (idempotent)
//   node tools/install-global.js --remove # uninstall
//
// Projects you explicitly `attach` still keep their own local .nightshift/ log
// and take precedence; everything else lands centrally. No git config is
// touched (a global core.hooksPath would override per-repo hooks like Husky),
// so commits are captured from the agent's Bash output instead.

const fs = require('fs');
const os = require('os');
const path = require('path');

const remove = process.argv.includes('--remove');
const here = path.resolve(__dirname, '..');
const HOOK = path.join(here, 'hooks', 'claude-hook.js');
const MARK = 'hooks/claude-hook.js'; // identifies our hook command on re-runs
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const sessionsDir = path.join(os.homedir(), '.nightshift', 'sessions');

const CMD = `node "${HOOK}"`;
const EVENTS = {
  SessionStart: null, UserPromptSubmit: null, Stop: null, Notification: null,
  PostToolUse: 'Edit|Write|MultiEdit|NotebookEdit|TodoWrite|Bash',
};

let settings = {};
if (fs.existsSync(settingsPath)) {
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch {
    console.error(`refusing to touch unparsable ${settingsPath} — fix it and rerun`);
    process.exit(1);
  }
}
settings.hooks = settings.hooks || {};

function isOurs(group) {
  return (group.hooks || []).some(h => (h.command || '').includes(MARK));
}

if (remove) {
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(g => !isOurs(g));
    removed += before - settings.hooks[event].length;
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`nightshift global hooks removed (${removed} group(s)) from ${settingsPath}`);
  console.log(`Central logs left in place at ${sessionsDir} — delete them by hand if you want.`);
  process.exit(0);
}

// Back up once before the first edit, so there's always a way back.
if (fs.existsSync(settingsPath) && !fs.existsSync(settingsPath + '.nightshift-bak')) {
  fs.copyFileSync(settingsPath, settingsPath + '.nightshift-bak');
}

let wired = 0;
for (const [event, matcher] of Object.entries(EVENTS)) {
  const groups = settings.hooks[event] = settings.hooks[event] || [];
  if (groups.some(isOurs)) continue; // already installed — leave as is
  const group = { hooks: [{ type: 'command', command: CMD }] };
  if (matcher) group.matcher = matcher;
  groups.push(group);
  wired++;
}

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
fs.mkdirSync(sessionsDir, { recursive: true });

console.log(`nightshift global install ${wired ? `— ${wired} hook(s) merged into` : '— already wired in'} ${settingsPath}`);
console.log(`central logs:  ${sessionsDir}/<project>.jsonl  (one per project)`);
console.log('');
console.log('Start a NEW Claude Code session in any project — it records automatically.');
console.log('Watch all of them with the session switcher:');
console.log(`  node "${path.join(here, 'server.js')}" --dir "${sessionsDir}"`);
console.log('');
console.log('Uninstall:  node tools/install-global.js --remove');
