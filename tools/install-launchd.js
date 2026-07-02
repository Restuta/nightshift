#!/usr/bin/env node
// Supervise the nightshift board (and, when present, the portless proxy) with
// macOS LaunchAgents, so they survive logout, sleep, restart, and crashes.
// The board server died on every laptop restart this month; board.json pointed
// at dead pids. This makes launchd, not luck, keep it up.
//
//   node tools/install-launchd.js --install     # install / update (idempotent)
//   node tools/install-launchd.js --remove       # uninstall
//   node tools/install-launchd.js --status       # show state (read-only, default)
//
// The board runs in the FOREGROUND under launchd (KeepAlive needs a process that
// stays alive): `node server.js --dir <sessions> --port <port> --managed`. In
// --managed mode the server writes ~/.nightshift/board.json itself, so
// tools/board.js and the /nightshift skill detect the supervised board (pid
// alive + /whoami) and never spawn a second one on another port.
//
// Flags:
//   --port <n>        board port (default 4173)
//   --dir <path>      sessions dir (default ~/.nightshift/sessions)
//   --stop-existing   at install, stop an unmanaged board already on the port —
//                     only after /whoami confirms it IS a nightshift board
//   --no-portless     skip the portless proxy LaunchAgent even if portless exists
//   --proxy-port <n>  override the portless proxy port
//                     (default: ~/.portless/proxy.port)
//   --dry-run         write the plist(s) but don't touch launchctl or any server
//
// launchd has a bare PATH, so the node binary is resolved to an absolute path at
// install time (process.execPath) and a sane PATH is baked into the plist. This
// tool never writes session logs; only --install/--remove mutate the system.

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = (f, d = null) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const INSTALL = has('--install');
const REMOVE = has('--remove');
const DRY = has('--dry-run');
const STOP_EXISTING = has('--stop-existing');
const NO_PORTLESS = has('--no-portless');

const repo = path.resolve(__dirname, '..');
const serverJs = path.join(repo, 'server.js');
const node = process.execPath; // absolute node path — launchd can't find a bare `node`

const home = os.homedir();
const nsHome = process.env.NIGHTSHIFT_HOME || path.join(home, '.nightshift');
const sessionsDir = path.resolve(val('--dir', path.join(nsHome, 'sessions')));
const logsDir = path.join(nsHome, 'logs');
const boardJson = path.join(nsHome, 'board.json');
const port = Number(val('--port', '4173')) || 4173;

// Overridable so tests never write to the real ~/Library/LaunchAgents.
const agentsDir = process.env.NIGHTSHIFT_LAUNCH_AGENTS_DIR || path.join(home, 'Library', 'LaunchAgents');

const BOARD_LABEL = 'com.nightshift.board';
const PROXY_LABEL = 'com.nightshift.portless';
const boardPlist = path.join(agentsDir, `${BOARD_LABEL}.plist`);
const proxyPlist = path.join(agentsDir, `${PROXY_LABEL}.plist`);

const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const domain = uid != null ? `gui/${uid}` : null;

// A generous PATH for the supervised processes (launchd starts them with a bare
// one). Includes node's own dir and the usual tool locations so gh/toast/portless
// and node resolve.
const launchPath = [
  path.dirname(node),
  path.join(home, '.volta', 'bin'),
  path.join(home, '.local', 'bin'),
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
].join(':');

const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plistXml(label, argv, outLog, errLog) {
  const argXml = argv.map(a => `    <string>${esc(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(launchPath)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${esc(repo)}</string>
  <key>StandardOutPath</key><string>${esc(outLog)}</string>
  <key>StandardErrorPath</key><string>${esc(errLog)}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

function boardArgv() {
  return [node, serverJs, '--dir', sessionsDir, '--port', String(port), '--managed'];
}

// -------------------------------------------------------------------- portless
// The board prints https://nightshift.localhost:<proxy-port> URLs when a portless
// proxy is configured. If the portless CLI is on PATH AND supports a foreground
// run mode, supervise it too; otherwise say so and skip (no hacks).
function resolvePortless() {
  if (process.env.NIGHTSHIFT_PORTLESS_BIN) return process.env.NIGHTSHIFT_PORTLESS_BIN;
  try {
    const p = execFileSync('/usr/bin/which', ['portless'], { encoding: 'utf8' }).trim();
    return p || null;
  } catch { return null; }
}

function portlessSupportsForeground(bin) {
  // `--help` prints the option list without starting anything (unlike
  // `proxy start --help`, which tries to start when a proxy already runs).
  try {
    const help = execFileSync(bin, ['--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return /--foreground/.test(help);
  } catch { return false; }
}

function portlessProxyPort() {
  const explicit = val('--proxy-port');
  if (explicit) return Number(explicit) || null;
  try {
    return Number(fs.readFileSync(path.join(home, '.portless', 'proxy.port'), 'utf8').trim()) || null;
  } catch { return null; }
}

function portlessTls() {
  try { return fs.readFileSync(path.join(home, '.portless', 'proxy.tls'), 'utf8').trim() !== '0'; }
  catch { return true; } // portless default is HTTPS
}

function proxyArgv(bin, proxyPort) {
  const a = [bin, 'proxy', 'start', '--foreground', '-p', String(proxyPort)];
  if (!portlessTls()) a.push('--no-tls');
  return a;
}

// ------------------------------------------------------------------ launchctl
function launchctl(...a) {
  try { execFileSync('launchctl', a, { stdio: 'pipe' }); return true; }
  catch { return false; }
}

function loadAgent(plistPath, label) {
  if (domain) launchctl('bootout', `${domain}/${label}`); // clear any prior instance
  if (domain && launchctl('bootstrap', domain, plistPath)) return; // modern path
  launchctl('load', '-w', plistPath);                              // legacy fallback
}

function unloadAgent(plistPath, label) {
  if (!(domain && launchctl('bootout', `${domain}/${label}`))) launchctl('unload', plistPath);
}

// `launchctl list <label>` prints a dict (PID / LastExitStatus) when loaded, and
// exits non-zero otherwise — a safe, read-only probe for --status.
function agentState(label) {
  let out;
  try { out = execFileSync('launchctl', ['list', label], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
  const pid = /"PID"\s*=\s*(\d+)/.exec(out);
  const last = /"LastExitStatus"\s*=\s*(-?\d+)/.exec(out);
  return { loaded: true, pid: pid ? Number(pid[1]) : null, lastExit: last ? Number(last[1]) : null };
}

// -------------------------------------------------------------------- probes
const alivePid = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function whoami(p) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: p, path: '/whoami', timeout: 700 }, res => {
      let b = '';
      res.on('data', d => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function portInUse(p) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port: p });
    const done = v => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => resolve(false));
    s.setTimeout(600, () => done(false));
  });
}

function readBoardJson() {
  try { return JSON.parse(fs.readFileSync(boardJson, 'utf8')); } catch { return null; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------------- install
async function doInstall() {
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  const notes = [];

  // --- port conflict: is something already on our board port?
  if (await portInUse(port)) {
    const who = await whoami(port);
    const rec = readBoardJson();
    const isNs = who && who.nightshift;
    if (isNs && who.dir === sessionsDir && rec && rec.managed && alivePid(rec.pid)) {
      notes.push(`A supervised board is already on :${port} (pid ${rec.pid}); reloading its LaunchAgent.`);
    } else if (isNs && STOP_EXISTING) {
      // Only ever kill a pid /whoami has confirmed is a nightshift board.
      if (rec && rec.pid && alivePid(rec.pid)) {
        try { process.kill(rec.pid, 'SIGTERM'); notes.push(`Stopped the unmanaged board on :${port} (pid ${rec.pid}).`); }
        catch { notes.push(`Could not stop pid ${rec.pid} on :${port} (already gone?).`); }
        for (let i = 0; i < 40 && await portInUse(port); i++) await sleep(100); // let it release the port
      } else {
        notes.push(`Port :${port} answers /whoami as nightshift but board.json has no live pid to stop; KeepAlive will take over once it exits.`);
      }
    } else if (isNs) {
      notes.push(`Port :${port} is held by an existing nightshift board. Leaving it; KeepAlive takes over once it exits.\n` +
                 `  Re-run with --stop-existing (or kill ${rec && rec.pid ? rec.pid : 'its pid'}) to hand off now.`);
    } else {
      notes.push(`WARNING: port :${port} is in use by a NON-nightshift process. The supervised board will crash-loop until it frees.\n` +
                 `  Free :${port} or install with --port <other>.`);
    }
  }

  // --- board LaunchAgent
  const boardXml = plistXml(BOARD_LABEL, boardArgv(),
    path.join(logsDir, 'board.out.log'), path.join(logsDir, 'board.err.log'));
  writeFileAtomic(boardPlist, boardXml);

  // --- portless proxy LaunchAgent (optional)
  let proxyInstalled = false;
  if (!NO_PORTLESS) {
    const bin = resolvePortless();
    if (!bin) {
      notes.push('portless not found on PATH — skipping the proxy LaunchAgent (board only).');
    } else if (!portlessSupportsForeground(bin)) {
      notes.push(`portless (${bin}) has no --foreground mode — skipping the proxy LaunchAgent.\n` +
                 '  launchd needs a foreground process; not hacking around a backgrounding CLI.');
    } else {
      const proxyPort = portlessProxyPort();
      if (!proxyPort) {
        notes.push('portless found, but its proxy port is unknown (no ~/.portless/proxy.port).\n' +
                   '  Start the proxy once, or pass --proxy-port <n>, then re-run --install. Skipping proxy supervision.');
      } else {
        const proxyXml = plistXml(PROXY_LABEL, proxyArgv(bin, proxyPort),
          path.join(logsDir, 'portless.out.log'), path.join(logsDir, 'portless.err.log'));
        writeFileAtomic(proxyPlist, proxyXml);
        proxyInstalled = true;
        if (await portInUse(proxyPort)) {
          notes.push(`A portless proxy is already on :${proxyPort}; the LaunchAgent takes over once it exits (or run \`portless proxy stop\`).`);
        }
      }
    }
  }

  if (!DRY) {
    loadAgent(boardPlist, BOARD_LABEL);
    if (proxyInstalled) loadAgent(proxyPlist, PROXY_LABEL);
  }

  console.log(`nightshift supervision ${DRY ? '(dry run) ' : ''}installed:`);
  console.log(`  board LaunchAgent  ${boardPlist}`);
  console.log(`    → ${boardArgv().join(' ')}`);
  console.log(`    logs ${path.join(logsDir, 'board.out.log')} / board.err.log`);
  if (proxyInstalled) console.log(`  proxy LaunchAgent  ${proxyPlist}`);
  if (DRY) console.log('  (launchctl not touched — --dry-run)');
  for (const n of notes) console.log(`  note: ${n}`);
  console.log('');
  console.log(`Check state:  node tools/install-launchd.js --status`);
  console.log(`Undo:         node tools/install-launchd.js --remove`);
}

// -------------------------------------------------------------------- remove
function doRemove() {
  if (!DRY) {
    unloadAgent(boardPlist, BOARD_LABEL);
    unloadAgent(proxyPlist, PROXY_LABEL);
  }
  let removed = 0;
  for (const p of [boardPlist, proxyPlist]) {
    try { fs.unlinkSync(p); removed++; } catch { /* already gone */ }
  }
  console.log(`nightshift supervision removed (${removed} plist${removed === 1 ? '' : 's'}).`);
  console.log('board.json left in place — with the supervisor gone, tools/board.js falls back to');
  console.log('spawning its own board on demand (its pid is now dead, so it detects the staleness).');
}

// -------------------------------------------------------------------- status
async function doStatus() {
  console.log('nightshift supervision status');
  console.log(`  launch agents dir  ${agentsDir}`);

  for (const [label, plistPath] of [[BOARD_LABEL, boardPlist], [PROXY_LABEL, proxyPlist]]) {
    const present = fs.existsSync(plistPath);
    const st = agentState(label);
    let line = `  ${label}  ${present ? 'plist installed' : 'not installed'}`;
    if (st) line += `; loaded (pid ${st.pid ?? '—'}, lastExit ${st.lastExit ?? '—'})`;
    else if (present) line += '; not loaded';
    console.log(line);
  }

  const rec = readBoardJson();
  if (rec) {
    const live = rec.pid != null ? (alivePid(rec.pid) ? 'alive' : 'DEAD') : 'unknown';
    console.log(`  board.json  port ${rec.port}, pid ${rec.pid ?? '—'} (${live}), managed=${!!rec.managed}`);
  } else {
    console.log(`  board.json  none (${boardJson})`);
  }

  const who = await whoami(port);
  if (who && who.nightshift) {
    console.log(`  /whoami :${port}  nightshift board, dir=${who.dir}${who.dir === sessionsDir ? '' : ' (DIFFERENT sessions dir)'}`);
  } else {
    console.log(`  /whoami :${port}  no nightshift board answering`);
  }
  console.log(`  logs  ${path.join(logsDir, 'board.out.log')} / board.err.log`);
}

async function main() {
  if (INSTALL) return doInstall();
  if (REMOVE) return doRemove();
  return doStatus(); // default is the safe, read-only view
}

main().catch(err => { console.error(err && err.message || err); process.exit(1); });
