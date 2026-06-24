#!/usr/bin/env node
// nightshift server — zero-dep static + SSE event-log tail.
// Usage: node server.js [--log <file>]... [--dir <folder>] [--port 4173]
//
// One server, many tapes: pass --log repeatedly and/or --dir to scan a folder
// for *.jsonl. The masthead shows a session switcher when more than one tape
// is served. A single --log (the default) behaves exactly as before.

const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const PORT = Number(flag('port', process.env.PORT || 4173));
const PUBLIC = path.join(__dirname, 'public');

// ---------------------------------------------------------------- sessions
// Collect log files from repeated --log and/or a scanned --dir, preserving
// order. Each becomes a session with its own tail offset and SSE client set.

const logPaths = [];
let servedDir = null; // the --dir, if any — reported by /whoami and rescanned
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--log' && args[i + 1]) logPaths.push(path.resolve(args[++i]));
  else if (args[i] === '--dir' && args[i + 1]) {
    servedDir = path.resolve(args[++i]);
    try {
      for (const f of fs.readdirSync(servedDir).sort()) {
        if (f.endsWith('.jsonl')) logPaths.push(path.join(servedDir, f));
      }
    } catch { console.error(`--dir: cannot read ${servedDir}`); }
  }
}
if (!logPaths.length) logPaths.push(path.resolve(path.join('.nightshift', 'events.jsonl')));

const sessions = new Map(); // id → {id, file, offset, partial, clients}
const usedIds = new Set();
function addSession(file) {
  if ([...sessions.values()].some(s => s.file === file)) return null; // already served
  let id = path.basename(file).replace(/\.jsonl$/, '') || 'session';
  let n = 2;
  while (usedIds.has(id)) id = `${path.basename(file).replace(/\.jsonl$/, '')}-${n++}`;
  usedIds.add(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  const s = { id, file, offset: fs.statSync(file).size, partial: '', clients: new Set() };
  sessions.set(id, s);
  try { fs.watch(s.file, () => drain(s)); } catch { /* polling covers it */ }
  return s;
}
for (const file of logPaths) addSession(file);

// A persistent --dir board should surface projects recorded after it started,
// so rescan the folder for new *.jsonl. (Open pages see them on refresh.)
if (servedDir) {
  setInterval(() => {
    let files = [];
    try { files = fs.readdirSync(servedDir); } catch { return; }
    for (const f of files) if (f.endsWith('.jsonl')) addSession(path.join(servedDir, f));
  }, 3000).unref();
}
const defaultSession = sessions.keys().next().value;

// A cheap scan for the switcher: title, agent, event count, last activity,
// and the latest session phase. Parses lines but folds nothing heavy.
function scanMeta(s) {
  let title = null, agent = null, cwd = null, phase = null, count = 0, lastT = 0;
  let raw = '';
  try { raw = fs.readFileSync(s.file, 'utf8'); } catch { /* gone */ }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    count++;
    if (typeof ev.t === 'number') lastT = ev.t;
    if (ev.type === 'session') {
      if (ev.title != null) title = ev.title;
      if (ev.agent != null) agent = ev.agent;
      if (ev.cwd != null) cwd = ev.cwd;
      if (ev.phase === 'start' || ev.phase === 'resume') phase = 'working';
      else if (ev.phase === 'idle') phase = 'idle';
      else if (ev.phase === 'attention') phase = 'attention';
      else if (ev.phase === 'end') phase = 'ended';
    }
  }
  return {
    id: s.id, title: title || (cwd ? path.basename(cwd) : s.id),
    cwd, agent, phase, events: count, lastT,
  };
}

// ---------------------------------------------------------------- tailing
// Track a byte offset per session; on growth, push complete new lines to that
// session's SSE clients. fs.watch is fast but flaky, so polling backs it up.

function drain(s) {
  let size;
  try { size = fs.statSync(s.file).size; } catch { return; }
  if (size < s.offset) { s.offset = 0; s.partial = ''; } // truncated/rotated
  if (size === s.offset) return;
  const stream = fs.createReadStream(s.file, { start: s.offset, end: size - 1, encoding: 'utf8' });
  s.offset = size;
  stream.on('data', chunk => {
    const lines = (s.partial + chunk).split('\n');
    s.partial = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      for (const res of s.clients) res.write(`data: ${line}\n\n`);
    }
  });
}

// addSession() sets up each file's watch; a poll backs them up.
setInterval(() => { for (const s of sessions.values()) drain(s); }, 300).unref();

// ----------------------------------------------------------------- http bits
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    // The board is a live dev tool on localhost with tiny assets — never let the
    // browser cache app code, or a reducer/UI fix silently fails to show up on a
    // plain refresh (the "board looks outdated after a fix" trap).
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  });
}

function sessionFromQuery(url) {
  const id = url.searchParams.get('session');
  return (id && sessions.get(id)) || sessions.get(defaultSession);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/whoami') {
    // Lets tools/board.js confirm it's talking to the GLOBAL sessions board
    // (serving servedDir) and not, say, a `npm run demo` on the same port.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ nightshift: true, dir: servedDir, port: PORT }));
    return;
  }

  if (url.pathname === '/sessions') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([...sessions.values()].map(scanMeta)));
    return;
  }

  if (url.pathname === '/sse') {
    const s = sessionFromQuery(url);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    // Replay full history, then a ready marker, then live tail.
    const history = fs.readFileSync(s.file, 'utf8');
    for (const line of history.split('\n')) {
      if (line.trim()) res.write(`data: ${line}\n\n`);
    }
    res.write('event: ready\ndata: {}\n\n');
    s.clients.add(res);
    // Real `ping` event (not a `:` comment) so the client can observe liveness
    // and detect a wedged socket — a comment fires no handler, so a board left
    // running through a laptop sleep can't tell its stream died.
    const ping = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 25000);
    req.on('close', () => { s.clients.delete(res); clearInterval(ping); });
    return;
  }

  if (url.pathname === '/event' && req.method === 'POST') {
    const s = sessionFromQuery(url);
    let body = '';
    req.on('data', c => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try {
        const ev = JSON.parse(body);
        if (typeof ev.type !== 'string') throw new Error('missing type');
        if (typeof ev.t !== 'number') ev.t = Date.now();
        fs.appendFileSync(s.file, JSON.stringify(ev) + '\n');
        res.writeHead(204); res.end();
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`nightshift  http://localhost:${PORT}`);
  if (sessions.size === 1) console.log(`tailing     ${sessions.get(defaultSession).file}`);
  else {
    console.log(`serving     ${sessions.size} sessions:`);
    for (const s of sessions.values()) console.log(`  ${s.id}  ${s.file}`);
  }
});
