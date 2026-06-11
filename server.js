#!/usr/bin/env node
// traceboard server — zero-dep static + SSE event-log tail.
// Usage: node server.js [--log path/to/events.jsonl] [--port 4173]

const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const PORT = Number(flag('port', process.env.PORT || 4173));
const LOG = path.resolve(flag('log', path.join('.traceboard', 'events.jsonl')));
const PUBLIC = path.join(__dirname, 'public');

fs.mkdirSync(path.dirname(LOG), { recursive: true });
if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, '');

// ---------------------------------------------------------------- log tailing
// Track a byte offset into the log; on growth, emit complete new lines.
// fs.watch is fast but unreliable across editors/filesystems, so a slow
// polling fallback runs alongside it.

let offset = fs.statSync(LOG).size;
let partial = '';
const clients = new Set();

function drain() {
  let size;
  try { size = fs.statSync(LOG).size; } catch { return; }
  if (size < offset) { offset = 0; partial = ''; } // log truncated/rotated
  if (size === offset) return;
  const stream = fs.createReadStream(LOG, { start: offset, end: size - 1, encoding: 'utf8' });
  offset = size;
  stream.on('data', chunk => {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      for (const res of clients) res.write(`data: ${line}\n\n`);
    }
  });
}

try { fs.watch(LOG, drain); } catch { /* polling covers it */ }
setInterval(drain, 300).unref();

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
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/sse')) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    // Replay full history, then a ready marker, then live tail.
    const history = fs.readFileSync(LOG, 'utf8');
    for (const line of history.split('\n')) {
      if (line.trim()) res.write(`data: ${line}\n\n`);
    }
    res.write('event: ready\ndata: {}\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => clearInterval(ping));
    return;
  }

  if (req.url === '/event' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try {
        const ev = JSON.parse(body);
        if (typeof ev.type !== 'string') throw new Error('missing type');
        if (typeof ev.t !== 'number') ev.t = Date.now();
        fs.appendFileSync(LOG, JSON.stringify(ev) + '\n');
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
  console.log(`traceboard  http://localhost:${PORT}`);
  console.log(`tailing     ${LOG}`);
});
