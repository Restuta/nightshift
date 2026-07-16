#!/usr/bin/env node
// One-time setup for /nightshift in *Codex*. Recording today works by tailing
// the rollout file Codex writes (see codex-tail.js). Codex has since gained
// Claude-Code-style hooks (~/.codex/hooks.json), and we're moving toward
// recording from those instead of guessing which rollout is this session. As a
// first, safe step this installer registers a CAPTURE-ONLY probe hook
// (tools/hook-probe.js) so we can confirm Codex's exact hook payload before
// building hook-based recording. The probe never records a tape — it only
// appends payloads to ~/.nightshift/hook-debug.jsonl (capped). It also makes
// the /nightshift skill available and creates the data dirs.
//
//   node tools/install-codex.js          # install / update (idempotent)
//   node tools/install-codex.js --remove # uninstall (incl. the probe hook)
//
// hooks.json is edited safely: parse-guarded, backed up once, our group always
// APPENDED at the end (Codex keys hook trust by array index, so inserting or
// reordering would silently de-trust your existing hooks), and --remove strips
// only our group. If hooks.json is a symlink (dotfiles), we write through to the
// real file and say so.

const fs = require('fs');
const os = require('os');
const path = require('path');

const remove = process.argv.includes('--remove');
const here = path.resolve(__dirname, '..');
const home = os.homedir();
const nsHome = path.join(home, '.nightshift');
const skillSrc = path.join(here, 'skills', 'nightshift');
const skillDir = path.join(home, '.codex', 'skills', 'nightshift');
const agentHook = path.join(here, 'hooks', 'agent-hook.js');
const HOOK_MARK = 'hooks/agent-hook.js'; // identifies our hook group on re-runs
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'];
// Cheap pre-gate (mirrors the Claude installer): spawn node only when a session
// has opted in. Codex sets CODEX_THREAD_ID (== the hook payload's session_id) in
// the command env, so the marker check is per-session. When nothing is
// recording the marker dir is empty → no node, no cost to other sessions.
const GATE =
  'if [ -n "$NIGHTSHIFT" ] ' +
  '|| { [ -n "$CODEX_THREAD_ID" ] && [ -e "$HOME/.nightshift/active/$CODEX_THREAD_ID" ]; } ' +
  '|| { [ -z "$CODEX_THREAD_ID" ] && [ -n "$(ls -A "$HOME/.nightshift/active" 2>/dev/null)" ]; }; ' +
  `then ${JSON.stringify(process.execPath)} ${JSON.stringify(agentHook)}; fi; true`;

function clearSkill() {
  try {
    if (fs.lstatSync(skillDir).isSymbolicLink()) fs.unlinkSync(skillDir);
    else fs.rmSync(skillDir, { recursive: true, force: true });
  } catch { /* not there */ }
}

// Add or remove our capture probe in ~/.codex/hooks.json without disturbing the
// user's own hooks. Append-only (trust is index-keyed); back up once; refuse to
// touch an unparsable file; follow a symlink to the real dotfile.
function updateCodexHooks(doRemove) {
  const link = path.join(home, '.codex', 'hooks.json');
  let real = link, symlinked = false;
  try { if (fs.lstatSync(link).isSymbolicLink()) { symlinked = true; real = fs.realpathSync(link); } } catch { /* missing */ }

  let cfg = { hooks: {} };
  if (fs.existsSync(real)) {
    try { cfg = JSON.parse(fs.readFileSync(real, 'utf8')); }
    catch {
      console.error(`refusing to touch unparsable ${real} — fix it and rerun`);
      process.exit(1);
    }
  }
  cfg.hooks = cfg.hooks || {};
  if (symlinked) console.log(`note: ${link} is a symlink → editing ${real}`);

  if (fs.existsSync(real) && !fs.existsSync(real + '.nightshift-bak')) {
    fs.copyFileSync(real, real + '.nightshift-bak');
  }

  const isOurs = g => (g.hooks || []).some(h => (h.command || '').includes(HOOK_MARK));
  const cmd = GATE;
  let removedNotLast = false;
  for (const ev of HOOK_EVENTS) {
    const groups = cfg.hooks[ev] || [];
    const ourIdx = groups.findIndex(isOurs);
    if (doRemove) {
      // If ours wasn't the last group, removing it shifts later groups' indices,
      // and Codex trust is index-keyed — warn so the user re-approves them.
      if (ourIdx !== -1 && ourIdx !== groups.length - 1) removedNotLast = true;
      const kept = groups.filter(g => !isOurs(g));
      if (kept.length) cfg.hooks[ev] = kept; else delete cfg.hooks[ev];
    } else {
      const group = { hooks: [{ type: 'command', command: cmd }] };
      // Update in place if present (keeps our index, and every other hook's,
      // stable — trust is index-keyed); append only when absent (codex review P2).
      if (ourIdx !== -1) groups[ourIdx] = group; else groups.push(group);
      cfg.hooks[ev] = groups;
    }
  }
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, JSON.stringify(cfg, null, 2) + '\n');
  return { real, removedNotLast };
}

if (remove) {
  const { real, removedNotLast } = updateCodexHooks(true);
  fs.rmSync(path.join(nsHome, 'codex-hook-installed'), { force: true });
  clearSkill();
  console.log(`nightshift Codex skill removed from ${skillDir}`);
  console.log(`recording hook removed from ${real}`);
  if (removedNotLast) console.log('  (a later hook shifted index — re-approve your other Codex hooks once.)');
  console.log(`(Claude install, install.json, and recorded tapes are left alone.)`);
  process.exit(0);
}

if (!fs.existsSync(path.join(home, '.codex'))) {
  console.error('~/.codex not found — is Codex installed for this user?');
  process.exit(1);
}

// Symlink the shared skill (same source as the Claude install) so repo edits
// and `git pull` are live with no reinstall.
clearSkill();
fs.mkdirSync(path.dirname(skillDir), { recursive: true });
fs.symlinkSync(skillSrc, skillDir, 'dir');

fs.mkdirSync(path.join(nsHome, 'sessions'), { recursive: true });
fs.mkdirSync(path.join(nsHome, 'active'), { recursive: true });
fs.writeFileSync(path.join(nsHome, 'install.json'), JSON.stringify({
  repo: here,
  server: path.join(here, 'server.js'),
  emit: path.join(here, 'tools', 'emit.js'),
  resolveLog: path.join(here, 'tools', 'resolve-log.js'),
}, null, 2) + '\n');

const { real: hooksFile } = updateCodexHooks(false);
// Stamp when the hook became active. /nightshift uses this to tell whether a
// session started with the hook loaded (→ hook recording) or before it (→ the
// full tailer fallback), since Codex loads hooks only at session start.
fs.writeFileSync(path.join(nsHome, 'codex-hook-installed'), new Date().toISOString() + '\n');

console.log('nightshift installed for Codex:');
console.log(`  skill  → ${skillDir}  (use /nightshift in any Codex session)`);
console.log(`  hooks  → ${hooksFile}  (dormant until a session opts in via /nightshift)`);
console.log(`  tapes  → ${path.join(nsHome, 'sessions')}/<project>.jsonl`);
console.log('');
console.log('Recording is per-session and hook-based: /nightshift marks THIS session');
console.log('(via $CODEX_THREAD_ID); the hooks record only marked sessions. Sessions where');
console.log('you never type it pay nothing (a sub-ms shell test, no node).');
console.log('');
console.log('⚠ Codex will ask to TRUST the nightshift hook on your next session — approve it,');
console.log('  or recording stays off.');
console.log('');
console.log('Uninstall:  node tools/install-codex.js --remove');
