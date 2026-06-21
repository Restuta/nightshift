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
const probe = path.join(here, 'tools', 'hook-probe.js');
const PROBE_MARK = 'tools/hook-probe.js'; // identifies our hook group on re-runs
const PROBE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse'];

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

  const isOurs = g => (g.hooks || []).some(h => (h.command || '').includes(PROBE_MARK));
  const cmd = `node ${JSON.stringify(probe)}`;
  let removedNotLast = false;
  for (const ev of PROBE_EVENTS) {
    const groups = cfg.hooks[ev] || [];
    const ourIdx = groups.findIndex(isOurs);
    const kept = groups.filter(g => !isOurs(g)); // drop our prior group (idempotent)
    if (doRemove) {
      // If ours wasn't the last group, removing it shifts later groups' indices,
      // and Codex trust is index-keyed — warn so the user re-approves them.
      if (ourIdx !== -1 && ourIdx !== groups.length - 1) removedNotLast = true;
      if (kept.length) cfg.hooks[ev] = kept; else delete cfg.hooks[ev];
    } else {
      kept.push({ hooks: [{ type: 'command', command: cmd }] }); // APPEND at end
      cfg.hooks[ev] = kept;
    }
  }
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, JSON.stringify(cfg, null, 2) + '\n');
  return { real, removedNotLast };
}

if (remove) {
  const { real, removedNotLast } = updateCodexHooks(true);
  clearSkill();
  console.log(`nightshift Codex skill removed from ${skillDir}`);
  console.log(`probe hook removed from ${real}`);
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

console.log('nightshift installed for Codex:');
console.log(`  skill  → ${skillDir}  (use /nightshift in any Codex session)`);
console.log(`  probe  → ${hooksFile}  (capture-only; writes ~/.nightshift/hook-debug.jsonl)`);
console.log(`  tapes  → ${path.join(nsHome, 'sessions')}/<project>.jsonl`);
console.log('');
console.log('Recording today still tails the rollout via /nightshift. The probe is');
console.log('instrumentation only — it records nothing, just captures Codex hook payloads');
console.log('so hook-based recording can be built next.');
console.log('');
console.log('⚠ Codex will ask to TRUST the nightshift probe hook on your next session —');
console.log('  approve it, or it captures nothing.');
console.log('Then run any Codex session and inspect:  ~/.nightshift/hook-debug.jsonl');
console.log('');
console.log('Uninstall:  node tools/install-codex.js --remove');
