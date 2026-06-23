#!/usr/bin/env node
// Record PR/CI facts as events — never fetched at render time, per the core rule
// in docs/EVENTS.md: replaying yesterday's session must show yesterday's CI.
//   node tools/poll-github.js [--once] [--interval <sec>=30] [--limit <prs>=100]
//     [--repo owner/name] [--log <file>] [--known]
//   node tools/poll-github.js --known --repo o/r --log L   # self-detach a realtime worker
//   node tools/poll-github.js --stop   [--log L]           # stop the worker
//   node tools/poll-github.js --status [--log L]           # live | off
//
// CI/review status comes from toast review-ci (Orba's CI — fast, authoritative)
// when available, falling back to the gh CLI's check rollup otherwise. PR
// metadata (title/url/state) comes from gh. Zero deps. Stateless across restarts:
// known pr/ci state is folded out of the log itself, and each tick appends only
// what changed — safe to restart, safe to run alongside hooks, idempotent.
//
// In --known mode (session-scoped) a bare invocation self-detaches ONE background
// worker that polls on --interval, so the board updates in near-realtime; it
// exits on its own once every surfaced PR is merged/closed, or on --stop.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync, spawn } = require('child_process');

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--once') flags.once = true;
  else if (argv[i] === '--interval') flags.interval = Number(argv[++i]);
  else if (argv[i] === '--limit') flags.limit = Number(argv[++i]);
  else if (argv[i] === '--repo') flags.repo = argv[++i];
  else if (argv[i] === '--log') flags.log = argv[++i];
  else if (argv[i] === '--known') flags.known = true;
  else if (argv[i] === '--stop') flags.stop = true;
  else if (argv[i] === '--status') flags.status = true;
  else if (argv[i] === '--worker') flags.worker = true;
}
const posInt = (n, dflt) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt);
const LOG = flags.log || path.join('.nightshift', 'events.jsonl');
const INTERVAL = posInt(flags.interval, 30) * 1000;
const LIMIT = posInt(flags.limit, 100);

// Worker registry (one realtime poller per log), mirroring codex-tail's model.
const NS_HOME = process.env.NIGHTSHIFT_HOME || path.join(os.homedir(), '.nightshift');
const stateFile = path.join(NS_HOME, 'pr-pollers.json');
const alivePid = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const writeState = s => { fs.mkdirSync(NS_HOME, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s) + '\n'); };

if (flags.status) { const e = readState()[LOG]; process.stdout.write(e && e.pid && alivePid(e.pid) ? 'live\n' : 'off\n'); process.exit(0); }
if (flags.stop) {
  const s = readState();
  for (const [key, e] of Object.entries(s)) {
    if (flags.log && key !== LOG) continue;
    if (e && e.pid && alivePid(e.pid)) { try { process.kill(e.pid); } catch { /* gone */ } }
    delete s[key];
  }
  writeState(s);
  process.exit(0);
}

// --known scopes refs to a repo. Resolve the cwd's repo when --repo wasn't given,
// so `gh pr view <n>` and the repo filter agree. If it can't be resolved, repo-
// qualified refs (URLs, -R commands) are skipped rather than assumed current —
// recording another repo's PR #n as ours would corrupt the tape.
if (flags.known && !flags.repo) {
  try { flags.repo = JSON.parse(execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], { encoding: 'utf8' })).nameWithOwner; }
  catch { /* leave unset → repo-qualified refs are skipped below */ }
}

function ghPrs() {
  const args = ['pr', 'list', '--state', 'all', '--limit', String(LIMIT),
    '--json', 'number,title,url,state,statusCheckRollup'];
  if (flags.repo) args.push('--repo', flags.repo);
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
}

// One PR by number — used in --known mode so we touch only the PRs this session
// surfaced, never the repo's hundreds. Returns null if it's not a PR / no access.
function ghPr(n) {
  const args = ['pr', 'view', String(n), '--json', 'number,title,url,state,statusCheckRollup'];
  if (flags.repo) args.push('--repo', flags.repo);
  try { return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { return null; }
}

// owner/repo for a github PR URL, or null.
function urlRepo(s) {
  const m = (s || '').match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/);
  return m ? m[1] : null;
}

// toast review-ci (Orba's CI) is the authoritative, fast PR status — prefer it
// over gh's raw checks. `toast review-ci status --json` → { status, ... }. Returns
// the lowercased status, or null when toast isn't installed (→ gh fallback) or the
// call fails. ENOENT is cached so we don't re-spawn a missing binary every tick.
let toastOk = null;
function toastStatus(n) {
  if (toastOk === false || !flags.repo) return null;
  // spawnSync, not execFileSync: toast exits non-zero when action is required
  // (a blocked/needs-fix PR exits 1) yet still prints valid JSON to stdout — we
  // must read that stdout regardless of exit code.
  const r = spawnSync('toast', ['review-ci', 'status', '--repo', flags.repo, '--pr', String(n), '--json'],
    { encoding: 'utf8', timeout: 15000 });
  if (r.error) { if (r.error.code === 'ENOENT') toastOk = false; return null; } // not installed → gh
  toastOk = true;
  try { return (((JSON.parse(r.stdout || '') || {}).status || '') + '').toLowerCase() || null; }
  catch { return null; } // exit 2 / no JSON → fall back to gh
}

// Map a toast review-ci status to the board's ci vocabulary (same words the Codex
// meter maps from the rollout): ready/merged = pass, *_blocked/needs_fix = fail,
// pending/running = pending.
function toastCi(status) {
  if (/^(ready|pass|passing|clean|merged)$/.test(status)) return 'pass';
  if (/^(needs_fix|blocked|github_blocked|fail|failing|error)$/.test(status)) return 'fail';
  if (/^(pending|in_progress|active|running|blocking)$/.test(status)) return 'pending';
  return null;
}

// Boolean (value-less) flags for the gh pr verbs below. Every other `--flag`
// consumes the next token as its value, so we skip that token — otherwise a
// numeric value like `--interval 10` would be mistaken for the PR positional.
const GH_BOOL = new Set([
  '-w', '--web', '--watch', '--fail-fast', '--required', '--comments', '--name-only',
  '--patch', '--auto', '--disable-auto', '-m', '--merge', '-r', '--rebase', '-s',
  '--squash', '-d', '--delete-branch', '--admin', '--undo', '--draft', '--dry-run',
  '-a', '--approve', '-c', '--comment', '--request-changes', // gh pr review actions
]);

// The PR number a `gh pr <verb> … N` command targets — the first positional PR
// ref (number, #N, or PR URL) after the verb. Only verbs that take a PR argument
// (not list/create/status). Flags between the verb and the positional are skipped
// along with their values, so `gh pr view --json … 123` finds 123 while
// `gh pr checks --interval 10` (no PR) and `gh pr list --limit 100` find nothing.
function ghCmdPr(cmd) {
  const toks = (cmd || '').split(/\s+/);
  // a flag that consumes the next token as its value (separate-token form)
  const valueFlag = (f, next) => !f.includes('=') && !GH_BOOL.has(f) && next != null && !next.startsWith('-');
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] !== 'gh') continue;
    // skip gh's global flags (e.g. `gh -R owner/repo pr view N`) to reach `pr`
    let j = i + 1;
    while (j < toks.length && toks[j].startsWith('-')) { if (valueFlag(toks[j], toks[j + 1])) j++; j++; }
    if (toks[j] !== 'pr') continue;
    // skip flags between `pr` and the verb too (`gh pr -R owner/repo view N`)
    let v = j + 1;
    while (v < toks.length && toks[v].startsWith('-')) { if (valueFlag(toks[v], toks[v + 1])) v++; v++; }
    const verb = toks[v];
    if (!/^(view|checks|checkout|merge|close|reopen|ready|edit|diff|comment|review)$/.test(verb || '')) continue;
    for (let k = v + 1; k < toks.length; k++) {
      const t = toks[k];
      if (t.startsWith('-')) {
        if (valueFlag(t, toks[k + 1])) k++;
        continue; // skip the flag (and its value, consumed above)
      }
      // First positional decides. A bare number is current-repo (the caller's
      // --repo/-R check covers that); a PR URL carries its own repo, so drop it
      // when it points at a different repo than --repo. A branch name → no number.
      const num = t.match(/^#?(\d+)$/);
      if (num) return Number(num[1]);
      const u = t.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/);
      if (u) return (flags.repo && u[1].toLowerCase() === flags.repo.toLowerCase()) ? Number(u[2]) : null;
      return null;
    }
  }
  return null;
}

// The PR numbers THIS session actually surfaced, harvested from its own tape:
// pr/ci events, PR URLs, `gh pr <verb> #N` commands, and #N in card titles.
// Deliberately conservative — no bare numbers (branch/ticket ids like "orba-768"
// would pull unrelated PRs). A PR number is repo-relative, so a URL (or a pr
// event with a URL) only counts when its owner/repo matches --repo; otherwise
// `gh pr view <n> --repo current` would record the WRONG repo's PR #n. Bare #N /
// command numbers carry no repo, so they're taken as the current repo.
function sessionPrNumbers() {
  const set = new Set();
  let data; try { data = fs.readFileSync(LOG, 'utf8'); } catch { return set; }
  // A repo-less ref (bare #N / number) is current-repo. A repo-qualified ref
  // counts only if it matches --repo (case-insensitively — GitHub repo paths are);
  // if the repo is unknown we can't verify, so it's skipped (never assumed current).
  const lc = s => (s || '').toLowerCase();
  const sameRepo = r => r == null ? true : (flags.repo ? lc(r) === lc(flags.repo) : false);
  const cmdRepo = s => { const m = (s || '').match(/(?:--repo|-R)[=\s]+["']?([\w.-]+\/[\w.-]+)/); return m ? m[1] : null; };
  const URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
  const HASH = /#(\d{1,6})\b/g; // single-digit PR refs (#4) are valid on new repos
  for (const line of data.split('\n')) {
    if (!line) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'pr' && ev.number != null && sameRepo(urlRepo(ev.url))) set.add(Number(ev.number));
    if (ev.type === 'ci' && ev.pr != null) set.add(Number(ev.pr));
    // PR URLs (repo-scoped) anywhere, incl. card titles like
    // "Review https://github.com/o/r/pull/123".
    const text = [ev.text, ev.command, ev.message, ev.title].filter(Boolean).join(' ');
    let m; while ((m = URL.exec(text))) { if (sameRepo(m[1])) set.add(Number(m[2])); }
    // `gh pr <verb> N` commands — skip a command aimed at another repo via
    // --repo/-R, else its number would be re-scoped to the current repo. Prefer
    // ev.cmd (the full, untruncated command the hook stores for gh pr lines) so a
    // PR ref past the 120-char display truncation in ev.text isn't lost.
    for (const field of [ev.command, ev.cmd, ev.text]) {
      if (!field || !sameRepo(cmdRepo(field))) continue;
      const n = ghCmdPr(field); if (n != null) set.add(n);
    }
    // Bare #N in a human card title is a current-repo ref.
    if (ev.type === 'item' && ev.title) { while ((m = HASH.exec(ev.title))) set.add(Number(m[1])); }
  }
  return set;
}

// Collapse a statusCheckRollup array to one ci status; null when there are no
// checks (a ci event with nothing behind it would be noise).
function rollupCi(checks) {
  if (!Array.isArray(checks) || !checks.length) return null;
  let pending = false;
  for (const c of checks) {
    const conclusion = c.conclusion || '';
    if (/FAILURE|TIMED_OUT|STARTUP_FAILURE|ACTION_REQUIRED/.test(conclusion)) return 'fail';
    if (c.status && c.status !== 'COMPLETED') pending = true;
  }
  return pending ? 'pending' : 'pass';
}

// What the log already knows, folded incrementally: full read on the first
// call, then only the bytes appended since. The offset only advances past
// complete lines, so a concurrent writer's half-flushed line is re-read whole
// on the next tick instead of being lost.
const known = new Map(); // number → {state, ci}
let offset = 0;

function refreshKnown() {
  let fd;
  try { fd = fs.openSync(LOG, 'r'); } catch { return; } // no log yet
  try {
    const size = fs.fstatSync(fd).size;
    if (size < offset) { known.clear(); offset = 0; } // log truncated/replaced
    if (size === offset) return;
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const chunk = buf.toString('utf8');
    const complete = chunk.lastIndexOf('\n');
    if (complete < 0) return;
    offset += Buffer.byteLength(chunk.slice(0, complete + 1));
    for (const line of chunk.slice(0, complete).split('\n').filter(Boolean)) {
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'pr' && ev.number != null) {
        known.set(ev.number, { ...(known.get(ev.number) || {}), state: ev.state });
      } else if (ev.type === 'ci' && ev.pr != null) {
        known.set(ev.pr, { ...(known.get(ev.pr) || {}), ci: ev.status });
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function append(ev) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...ev }) + '\n');
  console.log(JSON.stringify(ev));
}

// Emit pr/ci deltas for one PR's current state (folded `known` suppresses no-ops).
function emitPr(pr) {
  let state = pr.state.toLowerCase(); // open | merged | closed (from gh)
  // CI/review status from toast when available (session-scoped polling only),
  // else gh's check rollup. Toast also reports 'merged', corroborating gh's state.
  const ts = flags.known ? toastStatus(pr.number) : null;
  const ci = ts ? toastCi(ts) : rollupCi(pr.statusCheckRollup);
  if (ts === 'merged' && state === 'open') state = 'merged';
  const k = known.get(pr.number) || {};
  if (k.state !== state) {
    append({ type: 'pr', number: pr.number, title: pr.title, url: pr.url, state });
    known.set(pr.number, { ...known.get(pr.number), state });
  }
  if (ci != null && k.ci !== ci) {
    append({ type: 'ci', pr: pr.number, status: ci });
    known.set(pr.number, { ...known.get(pr.number), ci });
  }
}

// One poll. Returns the number of session PRs still OPEN (so a realtime worker can
// retire itself once every surfaced PR is merged/closed). Repo-wide mode returns 0.
function tick() {
  refreshKnown();
  if (flags.known) {
    // Session-scoped: refresh ONLY the PRs this tape surfaced. No repo-wide list,
    // so a repo with hundreds of open PRs can't flood a single session's board.
    const nums = [...sessionPrNumbers()];
    for (const n of nums) { const pr = ghPr(n); if (pr) emitPr(pr); }
    return nums.filter(n => { const k = known.get(n); return !k || !/^(merged|closed)$/.test(k.state || ''); }).length;
  }
  let prs;
  try { prs = ghPrs(); } catch (err) {
    console.error(`gh failed: ${String(err.message || err).split('\n')[0]}`);
    if (flags.once) process.exit(1);
    return 0;
  }
  for (const pr of prs) emitPr(pr);
  return 0;
}

// One-shot (tests / immediate seed): poll once and exit.
if (flags.once) { tick(); process.exit(0); }

// Session-scoped realtime: self-detach ONE background worker per log (idempotent),
// so the board updates without blocking /nightshift. The worker does an immediate
// first tick (seeds now) then polls on --interval.
if (flags.known && !flags.worker) {
  const s = readState();
  const cur = s[LOG];
  if (cur && cur.pid && alivePid(cur.pid)) process.exit(0); // already polling this log
  fs.mkdirSync(NS_HOME, { recursive: true });
  const out = fs.openSync(path.join(NS_HOME, 'pr-poller.log'), 'a');
  const child = spawn(process.execPath, [__filename, '--worker', '--known', '--log', LOG,
    ...(flags.repo ? ['--repo', flags.repo] : []), '--interval', String(Math.round(INTERVAL / 1000))],
    { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  s[LOG] = { pid: child.pid, repo: flags.repo || null };
  writeState(s);
  process.exit(0);
}

// Worker / foreground interval loop.
if (flags.worker) {
  const cleanup = () => { const s = readState(); if (s[LOG] && s[LOG].pid === process.pid) { delete s[LOG]; writeState(s); } };
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('exit', cleanup);
}
tick();
console.error(`polling every ${INTERVAL / 1000}s${flags.known ? ' (session PRs only)' : ` (limit ${LIMIT} PRs)`} → ${LOG}`);
let emptyTicks = 0;
const timer = setInterval(() => {
  const openCount = tick();
  // A realtime worker retires itself once nothing is left to watch (all surfaced
  // PRs merged/closed, or none yet) for several ticks — /nightshift off also stops it.
  if (flags.worker && flags.known) {
    emptyTicks = openCount > 0 ? 0 : emptyTicks + 1;
    if (emptyTicks >= 6) { clearInterval(timer); process.exit(0); }
  }
}, INTERVAL);
