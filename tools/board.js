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

// If `sudo node tools/install-host.js` set up the portless host, a root daemon
// forwards :80 → this board, so open the pretty URL with no port. Otherwise fall
// back to localhost:<port>.
function installedHost() {
  try { return JSON.parse(fs.readFileSync(path.join(nsHome, 'install.json'), 'utf8')).host || null; }
  catch { return null; }
}

function urlFor(port) {
  const host = installedHost();
  const base = host ? `http://${host}/` : `http://localhost:${port}/`;
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
// Reuse the board we started before only if it's still OUR sessions board.
let prev = null;
try { prev = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* none yet */ }
if (prev && prev.port) isBoard(prev.port, ok => (ok ? done(prev.port) : start(preferred, 12)));
else start(preferred, 12);
