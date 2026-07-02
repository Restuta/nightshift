#!/usr/bin/env node
// One-time setup for the /nightshift skill: register nightshift's hooks in your
// global ~/.claude/settings.json, gated so they're dormant until you opt a
// session in. You then start recording from inside any session by typing:
//
//   /nightshift            # records THIS session (creates a per-session marker)
//   /nightshift off        # stops it
//
// You can also opt in at launch with `NIGHTSHIFT=1 claude`.
//
// Cost when a session is NOT recording: Claude Code runs the hook command, but
// it's a one-line shell test that exits before spawning node — sub-millisecond,
// imperceptible. Only a session you've turned on pays for node + logging.
// Events route to a central per-project log under ~/.nightshift/sessions/
// (nothing inside your repos).
//
//   node tools/install-global.js          # install / update (idempotent)
//   node tools/install-global.js --remove # uninstall
//
// Projects you explicitly `attach` keep their own local .nightshift/ log, always
// record, and take precedence. No git config is touched (a global
// core.hooksPath would override per-repo hooks like Husky), so in recording
// sessions commits are captured from the agent's Bash output instead.

const fs = require('fs');
const os = require('os');
const path = require('path');

const remove = process.argv.includes('--remove');
const here = path.resolve(__dirname, '..');
const HOOK = path.join(here, 'hooks', 'claude-hook.js');
const MARK = 'hooks/claude-hook.js'; // identifies our hook command on re-runs
const home = os.homedir();
const settingsPath = path.join(home, '.claude', 'settings.json');
const nsHome = path.join(home, '.nightshift');
const sessionsDir = path.join(nsHome, 'sessions');
const activeDir = path.join(nsHome, 'active');
const skillDir = path.join(home, '.claude', 'skills', 'nightshift');

// Cheap shell pre-gate — spawns node only when a session might be recording:
//   - NIGHTSHIFT env set at launch, OR
//   - this session's marker exists (when $CLAUDE_CODE_SESSION_ID is in the
//     hook env — the fast, fully per-session path), OR
//   - that env var is absent but *some* session has a marker, so node must
//     check the payload's session_id to decide (claude-hook's `recording()`).
// When nothing is recording, this is a couple of `[` builtins and an empty-dir
// `ls` — no node. `if … then node … fi; true` keeps the exit code 0.
const CMD =
  'if [ -n "$NIGHTSHIFT" ] ' +
  '|| { [ -n "$CLAUDE_CODE_SESSION_ID" ] && [ -e "$HOME/.nightshift/active/$CLAUDE_CODE_SESSION_ID" ]; } ' +
  '|| { [ -z "$CLAUDE_CODE_SESSION_ID" ] && [ -n "$(ls -A "$HOME/.nightshift/active" 2>/dev/null)" ]; }; ' +
  `then node "${HOOK}"; fi; true`;
const EVENTS = {
  SessionStart: null, SessionEnd: null, UserPromptSubmit: null, Stop: null, Notification: null,
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

// Remove whatever is at the skill path — a symlink (unlink) or an older
// copy-install (recursive rm) — so install/remove handle both.
function clearSkill() {
  try {
    if (fs.lstatSync(skillDir).isSymbolicLink()) fs.unlinkSync(skillDir);
    else fs.rmSync(skillDir, { recursive: true, force: true });
  } catch { /* not there */ }
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
  clearSkill();
  fs.rmSync(path.join(nsHome, 'install.json'), { force: true });
  console.log(`nightshift removed: ${removed} hook group(s) from ${settingsPath}, /nightshift skill, install.json`);
  console.log(`Recorded tapes left in place at ${sessionsDir} — delete them by hand if you want.`);
  process.exit(0);
}

// Back up once before the first edit, so there's always a way back.
if (fs.existsSync(settingsPath) && !fs.existsSync(settingsPath + '.nightshift-bak')) {
  fs.copyFileSync(settingsPath, settingsPath + '.nightshift-bak');
}

// Drop any prior version of our group first, then add the current one — this
// makes re-runs idempotent and migrates an older (e.g. ungated) command.
for (const [event, matcher] of Object.entries(EVENTS)) {
  const groups = (settings.hooks[event] || []).filter(g => !isOurs(g));
  const group = { hooks: [{ type: 'command', command: CMD }] };
  if (matcher) group.matcher = matcher;
  groups.push(group);
  settings.hooks[event] = groups;
}

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
fs.mkdirSync(sessionsDir, { recursive: true });
fs.mkdirSync(activeDir, { recursive: true });

// Symlink the /nightshift skill (not copy) so repo edits — and `git pull` —
// are live with no reinstall. Record paths for the skill to read.
clearSkill();
fs.mkdirSync(path.dirname(skillDir), { recursive: true });
fs.symlinkSync(path.join(here, 'skills', 'nightshift'), skillDir, 'dir');
fs.writeFileSync(path.join(nsHome, 'install.json'), JSON.stringify({
  repo: here,
  server: path.join(here, 'server.js'),
  emit: path.join(here, 'tools', 'emit.js'),
  resolveLog: path.join(here, 'tools', 'resolve-log.js'),
}, null, 2) + '\n');

console.log(`nightshift installed:`);
console.log(`  hooks  → ${settingsPath} (dormant until a session opts in)`);
console.log(`  skill  → ${skillDir}  (use /nightshift in any session)`);
console.log(`  tapes  → ${sessionsDir}/<project>.jsonl`);
console.log('');
console.log('In any session, start recording with:  /nightshift   (stop: /nightshift off)');
console.log('Sessions where you never type it are unaffected (a sub-ms shell test, no node).');
console.log('');
console.log('Watch your recorded sessions (one tab per project):');
console.log(`  node "${path.join(here, 'server.js')}" --dir "${sessionsDir}"`);
console.log('');
console.log('Uninstall:  node tools/install-global.js --remove');
