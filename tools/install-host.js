#!/usr/bin/env node
// One-time setup for a portless board URL: http://nightshift.local
//
//   sudo node tools/install-host.js [--host nightshift.local]
//   sudo node tools/install-host.js --remove
//
// Does three things, all reversible with --remove:
//   1. maps the host to loopback in /etc/hosts (fenced, idempotent block)
//   2. installs a root LaunchDaemon that runs tools/forward80.js — forwarding
//      127.0.0.1:80 to the board's actual port (read live from board.json), so
//      the board itself stays unprivileged and keeps owning its log writes
//   3. records the host in ~/.nightshift/install.json so the board opens the
//      pretty URL going forward
//
// Needs root (it edits /etc/hosts and /Library/LaunchDaemons). It never touches
// the board process or the session logs.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const HOST = val('--host') || 'nightshift.local';
const REMOVE = has('--remove');

const LABEL = 'com.nightshift.proxy';
const PLIST = `/Library/LaunchDaemons/${LABEL}.plist`;
const HOSTS = '/etc/hosts';
const BEGIN = '# >>> nightshift >>>';
const END = '# <<< nightshift <<<';

const repo = path.resolve(__dirname, '..');
const forwarder = path.join(repo, 'tools', 'forward80.js');
const node = process.execPath;

// Resolve the REAL user behind sudo, so install.json / logs land in their home.
const sudoUser = process.env.SUDO_USER;
const realHome = sudoUser ? `/Users/${sudoUser}` : (process.env.HOME || '');
const nsHome = path.join(realHome, '.nightshift');
const installJson = path.join(nsHome, 'install.json');
const sudoUid = process.env.SUDO_UID ? Number(process.env.SUDO_UID) : null;
const sudoGid = process.env.SUDO_GID ? Number(process.env.SUDO_GID) : null;

function isRoot() {
  return typeof process.geteuid === 'function' ? process.geteuid() === 0 : false;
}

function fail(msg) { console.error(msg); process.exit(1); }

if (!isRoot()) {
  const self = path.relative(process.cwd(), __filename) || __filename;
  fail(`install-host needs root.\n  sudo node ${self}${REMOVE ? ' --remove' : ''}`);
}

// ---- /etc/hosts: replace any existing fenced block, then (on install) add ours
function writeHosts(add) {
  let text = '';
  try { text = fs.readFileSync(HOSTS, 'utf8'); } catch (e) { fail(`cannot read ${HOSTS}: ${e.message}`); }
  const fenced = new RegExp(`\\n?${BEGIN}[\\s\\S]*?${END}\\n?`, 'g');
  text = text.replace(fenced, '\n').replace(/\n{3,}/g, '\n\n');
  if (add) {
    if (!text.endsWith('\n')) text += '\n';
    text += `${BEGIN}\n127.0.0.1 ${HOST}\n::1 ${HOST}\n${END}\n`;
  }
  fs.writeFileSync(HOSTS, text);
}

// ---- LaunchDaemon plist
function plistXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${forwarder}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NS_FORWARD_PORT</key><string>80</string>
    <key>NS_BOARD_JSON</key><string>${path.join(nsHome, 'board.json')}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(nsHome, 'forward.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(nsHome, 'forward.log')}</string>
</dict>
</plist>
`;
}

function launchctl(...a) {
  try { execFileSync('launchctl', a, { stdio: 'pipe' }); return true; }
  catch { return false; }
}

function loadDaemon() {
  launchctl('bootout', 'system', PLIST);            // clear any prior instance
  if (!launchctl('bootstrap', 'system', PLIST)) {   // modern path
    launchctl('load', '-w', PLIST);                 // legacy fallback
  }
}

function unloadDaemon() {
  if (!launchctl('bootout', 'system', PLIST)) launchctl('unload', PLIST);
}

// ---- install.json: record/clear the host (kept owned by the real user)
function patchInstallJson(host) {
  let obj = {};
  try { obj = JSON.parse(fs.readFileSync(installJson, 'utf8')); } catch { /* may not exist */ }
  if (host) obj.host = host; else delete obj.host;
  try {
    fs.mkdirSync(nsHome, { recursive: true });
    fs.writeFileSync(installJson, JSON.stringify(obj, null, 2) + '\n');
    if (sudoUid != null && sudoGid != null) fs.chownSync(installJson, sudoUid, sudoGid);
  } catch (e) { console.warn(`note: could not update ${installJson}: ${e.message}`); }
}

if (REMOVE) {
  writeHosts(false);
  unloadDaemon();
  try { fs.unlinkSync(PLIST); } catch { /* already gone */ }
  patchInstallJson(null);
  console.log('nightshift host removed: /etc/hosts entry, LaunchDaemon, and install.json host cleared.');
  console.log('The board is back to http://localhost:<port>.');
  process.exit(0);
}

if (!fs.existsSync(forwarder)) fail(`forwarder not found: ${forwarder}`);
writeHosts(true);
fs.writeFileSync(PLIST, plistXml());
try { fs.chmodSync(PLIST, 0o644); } catch { /* best effort */ }
loadDaemon();
patchInstallJson(HOST);

console.log(`nightshift is now reachable at  http://${HOST}`);
console.log(`  /etc/hosts   127.0.0.1 ${HOST}`);
console.log(`  daemon       ${LABEL}  (127.0.0.1:80 -> board)`);
console.log(`  forwarder    ${forwarder}`);
console.log(`\nStart or refresh a board (e.g. /nightshift) and open http://${HOST}`);
console.log(`Undo anytime:  sudo node ${path.relative(process.cwd(), __filename)} --remove`);
