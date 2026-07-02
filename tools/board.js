#!/usr/bin/env node
// Ensure ONE nightshift board server is running (serving ~/.nightshift/sessions)
// and print its URL; with --open, open it in the browser. Reused across
// sessions: the first /nightshift starts it detached, the rest find it alive
// and just hand back (and re-open) the URL.
//
//   node tools/board.js [--open] [--session <slug>] [--port <preferred>]

const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const nsHome = process.env.NIGHTSHIFT_HOME || path.join(os.homedir(), '.nightshift');
const sessionsDir = path.join(nsHome, 'sessions');
const stateFile = path.join(nsHome, 'board.json');
const serverJs = path.join(__dirname, '..', 'server.js');
const session = val('--session');

// Is a process still running? (pid 0-signal probe — the same check the pollers
// and codex-tail use.) Used with /whoami below to detect a live board robustly.
const alivePid = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Is OUR global board (serving `sessionsDir`) answering on this port? /whoami
// distinguishes it from another nightshift server on the same port — e.g. a
// `npm run demo` (single --log), which must NOT be reused.
function isBoard(port, cb) {
  const req = http.get({ host: '127.0.0.1', port, path: '/whoami', timeout: 600 }, res => {
    let b = '';
    res.on('data', d => (b += d));
    res.on('end', () => {
      try { const j = JSON.parse(b); cb(!!(j.nightshift && j.dir === sessionsDir)); }
      catch { cb(false); }
    });
  });
  req.on('error', () => cb(false));
  req.on('timeout', () => { req.destroy(); cb(false); });
}

// First port >= start that nothing is listening on (so we never hijack, e.g., a
// project board already on 4173).
function freePort(start, cb) {
  const s = net.createServer();
  s.once('error', () => freePort(start + 1, cb));
  s.once('listening', () => s.close(() => cb(start)));
  s.listen(start, '127.0.0.1');
}

function openUrl(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const a = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { execFile(cmd, a, () => {}); } catch { /* best effort */ }
}

// Prefer a pretty, no-port-to-type URL when one is available, in order:
//   1. Portless (the .localhost HTTPS proxy) has a static alias for our port —
//      read straight from its state files, no CLI. This is the macOS norm here.
//   2. `sudo node tools/install-host.js` installed our own host → daemon forwards
//      :80 to the board (install.json.host).
//   3. plain http://localhost:<port>.
function portlessUrl(port) {
  try {
    const pl = path.join(os.homedir(), '.portless');
    const routes = JSON.parse(fs.readFileSync(path.join(pl, 'routes.json'), 'utf8'));
    const route = routes.find(r => r.port === port && /(^|\.)nightshift\.localhost$/.test(r.hostname));
    if (!route) return null;
    const pport = fs.readFileSync(path.join(pl, 'proxy.port'), 'utf8').trim();
    const tls = fs.readFileSync(path.join(pl, 'proxy.tls'), 'utf8').trim() === '1';
    const scheme = tls ? 'https' : 'http';
    const bare = (tls && pport === '443') || (!tls && pport === '80');
    return `${scheme}://${route.hostname}${bare ? '' : ':' + pport}/`;
  } catch { return null; }
}

function installedHost() {
  try { return JSON.parse(fs.readFileSync(path.join(nsHome, 'install.json'), 'utf8')).host || null; }
  catch { return null; }
}

function urlFor(port) {
  const host = installedHost();
  const base = portlessUrl(port) || (host ? `http://${host}/` : `http://localhost:${port}/`);
  return base + (session ? `?session=${encodeURIComponent(session)}` : '');
}

function done(port) {
  const url = urlFor(port);
  process.stdout.write(url + '\n');
  if (has('--open')) openUrl(url);
}

// Start our global board on the first free port >= preferred, then confirm via
// /whoami that the port is actually serving OUR sessions dir. If something else
// owns it (lost a race, or a foreign server squats the port), advance and retry
// — never hand back a URL to a server that isn't ours.
function start(preferred, attemptsLeft) {
  if (attemptsLeft <= 0) { process.stderr.write('could not start board\n'); return done(preferred); }
  // Before claiming a port, make sure OUR board isn't already answering there —
  // a supervised (launchd) board is pinned to 4173 and writes its own
  // board.json, but if we got here with a missing/stale board.json we must still
  // reuse it, never spawn a second board on 4174.
  isBoard(preferred, mine => {
    if (mine) return done(preferred);
    startFresh(preferred, attemptsLeft);
  });
}

function startFresh(preferred, attemptsLeft) {
  freePort(preferred, port => {
    fs.mkdirSync(sessionsDir, { recursive: true });
    const out = fs.openSync(path.join(nsHome, 'board.log'), 'a');
    const child = spawn(process.execPath, [serverJs, '--dir', sessionsDir, '--port', String(port)],
      { detached: true, stdio: ['ignore', out, out] });
    child.unref();
    let tries = 0;
    const wait = () => isBoard(port, ok => {
      if (ok) { fs.writeFileSync(stateFile, JSON.stringify({ port, pid: child.pid }) + '\n'); return done(port); }
      if (tries++ > 25) return start(port + 1, attemptsLeft - 1); // ours never came up here
      setTimeout(wait, 100);
    });
    setTimeout(wait, 150);
  });
}

const preferred = Number(val('--port')) || 4173;
// Reuse a board we already know about — the supervised (launchd) one or a
// previous detached spawn — only if it's genuinely alive: its recorded pid is
// running AND /whoami confirms OUR sessions board on that port. The supervised
// server writes {port, pid, managed} to board.json itself, so this same check
// detects it and we never spawn a second one. (pid absent → older format, fall
// back to the /whoami check alone.)
function reuse(prev, cb) {
  if (!prev || !prev.port) return cb(false);
  if (prev.pid != null && !alivePid(prev.pid)) return cb(false); // stale record — process gone
  isBoard(prev.port, cb);
}

let prev = null;
try { prev = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* none yet */ }
reuse(prev, ok => (ok ? done(prev.port) : start(preferred, 12)));
