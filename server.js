#!/usr/bin/env node
// nightshift server — zero-dep static + SSE event-log tail.
// Usage: node server.js [--log <file>]... [--dir <folder>] [--port 4173]
//
// One server, many tapes: pass --log repeatedly and/or --dir to scan a folder
// for *.jsonl. The masthead shows a session switcher when more than one tape
// is served. A single --log (the default) behaves exactly as before.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const PORT = Number(flag('port', process.env.PORT || 4173));
const PUBLIC = path.join(__dirname, 'public');

// --managed: run supervised (a LaunchAgent keeps us up in the FOREGROUND, since
// KeepAlive needs a process that stays alive — see tools/install-launchd.js).
// In this mode the server OWNS ~/.nightshift/board.json: it writes it atomically
// on boot and refreshes it, so tools/board.js and the /nightshift skill detect
// the supervised board (pid alive + /whoami) and never spawn a second one on
// another port. Unmanaged, board.json is written by whoever spawned us
// (tools/board.js) — unchanged.
const MANAGED = args.includes('--managed');
const NS_HOME = process.env.NIGHTSHIFT_HOME || path.join(os.homedir(), '.nightshift');
const BOARD_JSON = path.join(NS_HOME, 'board.json');

function writeBoardJson(port) {
  const tmp = `${BOARD_JSON}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(NS_HOME, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ port, pid: process.pid, managed: true, at: Date.now() }) + '\n');
    fs.renameSync(tmp, BOARD_JSON); // atomic replace — a reader never sees a half file
  } catch { /* best effort: if we can't claim board.json, board.js just spawns its own */ }
}

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

const sessions = new Map(); // id → {id, file, offset, partial, clients, seen}
const usedIds = new Set();
function addSession(file) {
  if ([...sessions.values()].some(s => s.file === file)) return null; // already served
  let id = path.basename(file).replace(/\.jsonl$/, '') || 'session';
  let n = 2;
  while (usedIds.has(id)) id = `${path.basename(file).replace(/\.jsonl$/, '')}-${n++}`;
  usedIds.add(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  // `seen`: envelope ids we've observed being appended to this log while the
  // board is up (populated by drain() below + accepted POSTs). The POST /event
  // dedupe guard consults it so a client re-posting the same event id is acked
  // but not appended again — killing the "same event twice" class at the door.
  const s = { id, file, offset: fs.statSync(file).size, partial: '', clients: new Set(), seen: new Set() };
  sessions.set(id, s);
  try { fs.watch(s.file, () => drain(s)); } catch { /* polling covers it */ }
  return s;
}
for (const file of logPaths) addSession(file);

const defaultSession = sessions.keys().next().value;

// A persistent --dir board should surface projects recorded after it started,
// so rescan the folder for new *.jsonl (open pages see them on refresh) — and
// reconcile removals: a tape archived/deleted by prune-sessions.js is dropped
// from the list within a few seconds, so cleanup reflects live without a restart.
// The default session is never dropped, so the board always has a fallback.
if (servedDir) {
  setInterval(() => {
    let files = [];
    try { files = fs.readdirSync(servedDir); } catch { return; }
    const present = new Set(files.filter(f => f.endsWith('.jsonl')).map(f => path.join(servedDir, f)));
    for (const f of present) addSession(f);
    for (const [id, s] of sessions) {
      if (id !== defaultSession && s.file.startsWith(servedDir + path.sep) && !present.has(s.file)) {
        sessions.delete(id);
        usedIds.delete(id);
      }
    }
  }, 3000).unref();
}

// A cheap scan for the switcher: title, agent, event count, last activity,
// and the latest session phase. Parses lines but folds nothing heavy.
function scanMeta(s) {
  let title = null, agent = null, cwd = null, phase = null, count = 0, lastT = 0;
  let raw = '';
  try { raw = fs.readFileSync(s.file, 'utf8'); } catch { /* gone */ }
  // Sort by t so the latest session phase/title wins by time, not by file
  // position — an out-of-order tape must not report a stale phase (stable sort
  // keeps file order among equal t).
  const evs = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    evs.push(ev);
  }
  evs.sort((a, b) => (a.t || 0) - (b.t || 0));
  for (const ev of evs) {
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
      // Record each appended event's id so a later duplicate POST is caught. Any
      // writer's appends flow through here (hooks, tailers, our own POST), so the
      // guard sees them all. Direct file-writers still can't be deduped at write
      // time — that's Phase 1's single-recorder lock; tape-doctor --dedupe is the
      // offline cure for already-doubled tapes.
      try { const ev = JSON.parse(line); if (ev && ev.id != null) s.seen.add(ev.id); } catch { /* keep streaming */ }
      for (const res of s.clients) res.write(`data: ${line}\n\n`);
    }
  });
}

// addSession() sets up each file's watch; a poll backs them up.
setInterval(() => { for (const s of sessions.values()) drain(s); }, 300).unref();

// --------------------------------------------------- PR state reconciliation
// PR/CI freshness used to depend on a separate detached poller staying alive —
// and it didn't: a laptop restart, a crash, or its own retirement froze PR
// state, so a merged PR showed "open" forever (nothing emitted the merge). The
// board server is the ONE process that must be alive for anyone to see the
// board, so it owns reconciliation now. For any session a viewer is actually
// looking at that still has an open PR, it runs poll-github (--once, session-
// scoped), which queries gh (authoritative) and appends only merge/close/ci
// deltas. Those flow back through the normal tail → SSE. The reducer stays pure
// (the server records events, it never renders fetched state); there's no daemon
// to die — reconciliation's lifecycle is the board's own. See docs/EVENTS.md.
const POLLER = path.join(__dirname, 'tools', 'poll-github.js');
const RECONCILE_MS = 30000; // re-poll a watched session at most this often
// A board relaunched on login can inherit a minimal PATH, leaving the reconciler
// unable to find gh/toast. Augment with the usual tool dirs (+ node's own).
const TOOL_PATH = [
  path.dirname(process.execPath),
  process.env.HOME && path.join(process.env.HOME, '.volta/bin'),
  process.env.HOME && path.join(process.env.HOME, '.local/bin'),
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  process.env.PATH,
].filter(Boolean).join(':');

// Fold just PR state + the cwd out of a log — cheap enough at viewer cadence.
// We only need: does this session have an OPEN PR, and which repo dir is it.
function prScan(s) {
  let raw = '';
  try { raw = fs.readFileSync(s.file, 'utf8'); } catch { return { cwd: null, open: 0 }; }
  let cwd = null;
  const st = new Map();
  // Sort by t first: pr state is last-write-wins, so on an out-of-order tape the
  // latest state by time must win, not the last line in the file.
  const evs = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    evs.push(ev);
  }
  evs.sort((a, b) => (a.t || 0) - (b.t || 0));
  for (const ev of evs) {
    if (ev.type === 'session' && ev.cwd) cwd = ev.cwd;
    else if (ev.type === 'pr' && ev.number != null && ev.state) st.set(ev.number, ev.state);
    // A pr_ref sighting with no confirmed pr state yet still needs a poll — the
    // hook/tailer emit these instead of pr now (plan 1.4), so bootstrap the poller
    // from them, else a freshly created PR would never get its first pr event.
    else if (ev.type === 'pr_ref' && ev.number != null && !st.has(ev.number)) st.set(ev.number, 'open');
  }
  let open = 0;
  for (const v of st.values()) if (v === 'open') open++;
  return { cwd, open };
}

// Reconcile one session's PRs against gh, if it's worth it. Spawns the poller
// detached (its appends arrive via drain()); never blocks the request loop.
function reconcilePRs(s) {
  if (s._polling) return;                                       // a poll's in flight
  if (Date.now() - (s._lastPoll || 0) < RECONCILE_MS) return;  // throttled
  const { cwd, open } = prScan(s);
  if (!cwd || open === 0) return;                               // nothing to reconcile
  if (!fs.existsSync(cwd)) return;                              // repo dir gone (worktree removed)
  s._lastPoll = Date.now();
  s._polling = true;
  const child = spawn(process.execPath, [POLLER, '--once', '--known', '--log', s.file], {
    cwd,                                                        // so `gh repo view`/refs resolve to this repo
    env: { ...process.env, PATH: TOOL_PATH },
    stdio: 'ignore',                                            // its appends arrive via drain()→SSE
  });
  child.on('error', () => { s._polling = false; });
  child.on('exit', () => { s._polling = false; });
}

// Keep watched sessions fresh while someone's looking — the board IS the poller.
// Gated on having a viewer AND an open PR, so historical/all-merged sessions
// never spawn a thing.
setInterval(() => {
  for (const s of sessions.values()) if (s.clients.size) reconcilePRs(s);
}, RECONCILE_MS).unref();

// ------------------------------------------------------------------- fleet
// Fleet home (/fleet page + /api/fleet data): one folded row per session — the
// aggregate view an overnight run needs. Folding every tape on every ~15s poll
// would re-parse tens of MB per request (the scanMeta pattern above re-reads the
// whole file each call — deliberately NOT copied here). So each tape's fold is
// CACHED by (size, mtime): a tape only re-folds when it actually grows. The
// summary builder is the SAME pure fold the board uses (public/reducer.js via
// public/fleet-summary.js), so Fleet numbers match the board. It's ESM and this
// server is CommonJS, so it's brought in via dynamic import at boot.
let fleetMod = null;
const fleetReady = import(pathToFileURL(path.join(__dirname, 'public', 'fleet-summary.js')).href)
  .then(m => { fleetMod = m; })
  .catch(err => { console.error('fleet-summary failed to load:', err); });

const fleetCache = new Map(); // file → { size, mtimeMs, id, base }

// The cached half is time-INDEPENDENT (the expensive fold); freshness and the
// 24h merge count are applied per request with the current clock, so a tape with
// no new events still ages from live→stale without a re-fold.
function fleetBase(s) {
  let st;
  try { st = fs.statSync(s.file); } catch { return null; }
  const hit = fleetCache.get(s.file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.id === s.id) return hit.base;
  let raw = '';
  try { raw = fs.readFileSync(s.file, 'utf8'); } catch { return null; }
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    events.push(ev);
  }
  const base = fleetMod.summarizeBase(events, { id: s.id });
  fleetCache.set(s.file, { size: st.size, mtimeMs: st.mtimeMs, id: s.id, base });
  return base;
}

async function serveFleetApi(res) {
  await fleetReady;
  if (!fleetMod) { res.writeHead(503); return res.end('fleet summary unavailable'); }
  const now = Date.now();
  const out = [];
  for (const s of sessions.values()) {
    let row = null;
    try { const base = fleetBase(s); if (base) row = fleetMod.applyNow(base, now); }
    catch { /* one bad tape must not sink the whole fleet view */ }
    if (row) out.push(row);
  }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(out));
}

// ----------------------------------------------------------------- http bits
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2',
};

// ----------------------------------------------------------- shift report
// GET /report?session=<id>&since=<ISO|epoch-ms|Nh> — the morning answer, a pure
// server-side fold of the tape(s) (tools/report-model.mjs) rendered to static
// HTML. Session omitted = aggregate across all served sessions. The heavy work
// (fold → model) is cached per (file, mtime, since); render is cheap and fresh.
const REPORT_MODEL_URL = pathToFileURL(path.join(__dirname, 'tools', 'report-model.mjs')).href;
const reportCache = new Map(); // `${file}\0${mtime}\0${since}` → model

// since accepts an ISO date, an epoch-ms number, or the shorthand Nh/Nd/Nm/Nw
// (also `0` for "all time"). Default: 24h ago.
function parseSince(param, now) {
  const s = (param || '').trim();
  if (!s) return now - 24 * 3600e3;
  const m = /^(\d+)\s*([hdmw])$/i.exec(s);
  if (m) {
    const unit = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2].toLowerCase()];
    return now - Number(m[1]) * unit;
  }
  if (/^\d+$/.test(s)) return Number(s);            // epoch ms (0 = all)
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? now - 24 * 3600e3 : parsed;
}

function readEvents(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const evs = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { evs.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return evs;
}

function sessionModel(s, buildReportModel, sinceParam, now) {
  let mtime = 0;
  try { mtime = fs.statSync(s.file).mtimeMs; } catch { /* gone */ }
  const key = `${s.file}\0${mtime}\0${sinceParam}`;
  const hit = reportCache.get(key);
  if (hit) return hit;
  const model = buildReportModel(readEvents(s.file), parseSince(sinceParam, now), { now });
  reportCache.set(key, model);
  if (reportCache.size > 200) reportCache.delete(reportCache.keys().next().value);
  return model;
}

async function handleReport(req, res, url) {
  let buildReportModel, renderReportHTML;
  try {
    ({ buildReportModel, renderReportHTML } = await import(REPORT_MODEL_URL));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('report module failed to load: ' + (e && e.message));
    return;
  }
  const wantId = url.searchParams.get('session');
  let targets;
  if (wantId) {
    const s = sessions.get(wantId);
    if (!s) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end(`unknown session: ${wantId}`); return; }
    targets = [s];
  } else {
    targets = [...sessions.values()];
  }
  const sinceParam = (url.searchParams.get('since') || '').trim() || '24h';
  const now = Date.now();
  const built = targets.map(s => ({ id: s.id, model: sessionModel(s, buildReportModel, sinceParam, now) }));
  const html = renderReportHTML({ sessions: built, sinceParam });
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

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

  if (url.pathname === '/api/fleet') { serveFleetApi(res); return; }

  if (url.pathname === '/fleet') {
    // The Fleet home page. Served explicitly (not via serveStatic, which would
    // 404 an extensionless path) so the URL stays clean — /fleet, not /fleet.html.
    fs.readFile(path.join(PUBLIC, 'fleet.html'), (err, body) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(body);
    });
    return;
  }

  if (url.pathname === '/events') {
    // Whole-tape snapshot as newline-delimited JSON — a plain one-shot GET for
    // consumers that fold the tape once and don't need the live SSE stream (the
    // lane timeline). Same bytes SSE replays on connect, minus the framing.
    const s = sessionFromQuery(url);
    let raw = '';
    try { raw = fs.readFileSync(s.file, 'utf8'); } catch { /* empty/gone → '' */ }
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    res.end(raw);
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
    reconcilePRs(s); // heal stale PR state the moment someone opens the board
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
        // Envelope v2: stamp id + source + v only if missing, so a client that
        // already stamped (the board UI) keeps its own, and an item event keeps
        // its work-item id as its identity.
        if (ev.id == null) ev.id = randomUUID();
        if (ev.source == null) ev.source = 'ui';
        if (ev.v == null) ev.v = 2;
        // Dedupe guard: an id we've already appended this session is acked but
        // not written again (add to `seen` synchronously so two racing POSTs with
        // the same id can't both slip through before drain() catches up).
        if (s.seen.has(ev.id)) { res.writeHead(204); res.end(); return; }
        s.seen.add(ev.id);
        fs.appendFileSync(s.file, JSON.stringify(ev) + '\n');
        res.writeHead(204); res.end();
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return;
  }

  if (url.pathname === '/report') {
    handleReport(req, res, url).catch(e => {
      if (res.headersSent) return;
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('report error: ' + (e && e.message));
    });
    return;
  }

  // /lanes?session= is the lane-timeline page (a clean URL for the ?t= deep link
  // target); the query is read client-side, so serve the static HTML as-is.
  if (url.pathname === '/lanes') { req.url = '/lanes.html'; return serveStatic(req, res); }

  serveStatic(req, res);
});

// A supervised board is pinned to its port (board.js and the portless proxy
// expect it there). If the port is already taken — most often by an old
// unmanaged board that hasn't exited yet — fail fast; launchd's KeepAlive retries
// and takes over once the squatter exits. Unmanaged, this just surfaces the
// clash instead of crashing with a stack trace.
server.on('error', err => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use — another server owns it.` +
      (MANAGED ? ' KeepAlive will retry and take over once it exits.' : ''));
  } else {
    console.error('server error:', (err && err.message) || err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  const port = server.address().port; // the real bound port (PORT may be 0 = ephemeral)
  console.log(`nightshift  http://localhost:${port}`);
  if (sessions.size === 1) console.log(`tailing     ${sessions.get(defaultSession).file}`);
  else {
    console.log(`serving     ${sessions.size} sessions:`);
    for (const s of sessions.values()) console.log(`  ${s.id}  ${s.file}`);
  }
  if (MANAGED) {
    writeBoardJson(port); // claim board.json now…
    setInterval(() => writeBoardJson(port), 15000).unref(); // …and keep it fresh
  }
});
