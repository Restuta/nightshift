#!/usr/bin/env node
// Record PR/CI facts as events — never fetched at render time, per the core rule
// in docs/EVENTS.md: replaying yesterday's session must show yesterday's CI.
//   node tools/poll-github.js --once [--limit <prs>=100]
//     [--repo owner/name] [--log <file>] [--known]
//
// This is the SINGLE writer of pr/ci events (plan 1.4). The hook and codex-tail no
// longer write pr state — they emit `pr_ref` sightings, which this poller harvests
// (alongside the legacy text-scan for old tapes) to learn which PRs a session
// touched. Each pr event carries `repo` (owner/name) and gh's real `occurredAt`/
// `createdAt`, so the board keys panel rows by repo#number and replays true history.
//
// CI/review status comes from toast review-ci (Orba's CI — fast, authoritative)
// when available, falling back to the gh CLI's check rollup otherwise. PR
// metadata (title/url/state) comes from gh. Zero deps. Stateless across restarts:
// known pr/ci state is folded out of the log itself, and each tick appends only
// what changed — safe to restart, safe to run alongside hooks, idempotent.
//
// This executable is deliberately one-shot. The durable board supervisor owns
// cadence, retention, concurrency, and leasing; accepting a resident mode here
// would recreate a competing writer.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { randomUUID } = require('node:crypto');

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--once') flags.once = true;
  else if (argv[i] === '--limit') flags.limit = Number(argv[++i]);
  else if (argv[i] === '--repo') flags.repo = argv[++i];
  else if (argv[i] === '--log') flags.log = argv[++i];
  else if (argv[i] === '--known') flags.known = true;
}
const posInt = (n, dflt) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt);
const LOG = path.resolve(flags.log || path.join('.nightshift', 'events.jsonl'));
const LIMIT = posInt(flags.limit, 100);

if (!flags.once) {
  process.stderr.write('poll-github: resident polling is owned by the server supervisor; use --once\n');
  process.exit(2);
}

// Do no work until the supervisor has bound this pid into both durable lease
// generations. EOF means the supervisor died before ownership became durable.
if (process.env.NIGHTSHIFT_PR_START_FD) {
  const gate = Buffer.alloc(1);
  try {
    const read = fs.readSync(Number(process.env.NIGHTSHIFT_PR_START_FD), gate, 0, 1, null);
    if (read !== 1 || gate[0] !== 103) process.exit(75);
  } catch { process.exit(75); }
}

// Repo identity stamped on every emitted pr/ci event (plan 1.4): the reducer keys
// state.prs by repo#number when repo is present, so two repos' PR #1 no longer
// collide into one panel row. Resolved once per run and cached — cheap. In --known
// mode flags.repo is already resolved above; otherwise fall back to the cwd's repo.
let REPO = flags.repo || null;
let repoResolutionError = null;
if (flags.known && !REPO) {
  try {
    REPO = JSON.parse(execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], { encoding: 'utf8' })).nameWithOwner;
    flags.repo = REPO;
  } catch (error) {
    const detail = String(error && (error.stderr || error.stdout || error.message) || error).trim();
    repoResolutionError = new Error(detail || 'could not resolve the current GitHub repository');
  }
} else if (!REPO) {
  try { REPO = JSON.parse(execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], { encoding: 'utf8' })).nameWithOwner; }
  catch { /* unknown → events omit repo (v1-style bare-number keys) */ }
}

// gh's real fact-times (createdAt/mergedAt/closedAt) ride along so the reducer can
// record occurredAt — replay then shows the 2am merge at 2am, not at poll time.
// baseRefName lets us resolve the stacked-PR chain: if a PR's base branch is itself
// another PR's head in this repo, that other PR is its base (see resolveBase).
// additions/deletions are the PR's diff size — recorded facts (add/del) the /graph
// view renders as a compact chip, so "size of work at a glance" survives replay.
const PR_FIELDS = 'number,title,url,state,mergedAt,closedAt,createdAt,baseRefName,statusCheckRollup,additions,deletions';

// head branch → PR number, for the whole repo, fetched once per run and cached.
// A PR whose baseRefName matches one of these heads is stacked on that PR — the
// `base` field the /graph view draws the chain from. Lazy + best-effort: if gh
// fails, base stays unresolved and no chain edge is drawn (old-tape behavior).
let headMap = null;
function headNumberMap() {
  if (headMap) return headMap;
  headMap = new Map();
  try {
    const args = ['pr', 'list', '--state', 'all', '--limit', String(LIMIT), '--json', 'number,headRefName'];
    if (flags.repo) args.push('--repo', flags.repo);
    for (const p of JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }))) {
      if (p.headRefName != null) headMap.set(p.headRefName, p.number);
    }
  } catch { /* leave empty → base unresolved */ }
  return headMap;
}

// The PR number a PR is stacked on: its base branch resolved to that branch's own
// PR, when one exists in the known set. null when the base is a plain branch
// (e.g. main) or unresolvable — the reducer then stores no base and draws no edge.
function resolveBase(pr) {
  const ref = pr && pr.baseRefName;
  if (!ref) return null;
  const n = headNumberMap().get(ref);
  return n != null && n !== pr.number ? n : null;
}

function ghPrs() {
  const args = ['pr', 'list', '--state', 'all', '--limit', String(LIMIT), '--json', PR_FIELDS];
  if (flags.repo) args.push('--repo', flags.repo);
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
}

// One PR by number — used in --known mode so we touch only the PRs this session
// surfaced, never the repo's hundreds. Returns null if it's not a PR / no access.
function ghPr(n) {
  const args = ['pr', 'view', String(n), '--json', PR_FIELDS];
  if (flags.repo) args.push('--repo', flags.repo);
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 0) return JSON.parse(result.stdout || '');
  const detail = String(result.stderr || result.stdout || '').trim();
  if (/could not resolve to a pullrequest|no pull requests found|pull request .* not found|http 404/i.test(detail)) return null;
  throw new Error(detail || `gh pr view ${n} exited ${result.status}`);
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
function toastInfo(n) {
  if (toastOk === false || !flags.repo) return null;
  // spawnSync, not execFileSync: toast exits non-zero when action is required
  // (a blocked/needs-fix PR exits 1) yet still prints valid JSON to stdout — we
  // must read that stdout regardless of exit code.
  const r = spawnSync('toast', ['review-ci', 'status', '--repo', flags.repo, '--pr', String(n), '--json'],
    { encoding: 'utf8', timeout: 15000 });
  if (r.error) { if (r.error.code === 'ENOENT') toastOk = false; return null; } // not installed → gh
  toastOk = true;
  try { const d = JSON.parse(r.stdout || ''); return d && typeof d === 'object' ? d : null; }
  catch { return null; } // exit 2 / no JSON → fall back to gh
}

// Map a toast review-ci result to the board's ci vocabulary. Classify on the base
// status word (toast uses `base:sub_status` forms like degraded:stale). toast is a
// GATING tool, so any action-required state (draft, unknown_reviewer, *_blocked,
// needs_fix, degraded…) is `fail`, NOT a gh fallback — else a draft/blocked PR with
// green checks would show ready. For an unrecognized word, a positive blocking
// count still means fail; only genuinely indeterminate states return null (→ gh).
function toastCi(d) {
  const base = (((d && d.status) || '') + '').toLowerCase().split(':')[0];
  if (/^(ready|pass|passing|clean|merged|acknowledged)$/.test(base)) return 'pass';
  if (/^(pending|in_progress|active|running|blocking|awaiting_review|head_changed)$/.test(base)) return 'pending';
  if (/^(needs_fix|blocked|github_blocked|draft|unknown_reviewer|degraded|conflicting|dirty|unstable|fail|failing|error|action_required)$/.test(base)) return 'fail';
  if (d && d.counts && d.counts.blocking_items > 0) return 'fail'; // unknown word but explicitly blocking
  return null; // closed / indeterminate → let gh decide
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
    // pr_ref sightings (plan 1.4) are the PRIMARY harvest now — the hook/tailer emit
    // these instead of pr, so the poller learns which PRs this session touched. Its
    // url (when present) carries the repo; a repo-less ref is a current-repo number.
    if (ev.type === 'pr_ref' && ev.number != null && sameRepo(urlRepo(ev.url))) set.add(Number(ev.number));
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
let eventSeq = 0;

function refreshKnown() {
  let fd;
  try { fd = fs.openSync(LOG, 'r'); } catch { return; } // no log yet
  try {
    const size = fs.fstatSync(fd).size;
    if (size < offset) { known.clear(); offset = 0; eventSeq = 0; } // log truncated/replaced → fresh tape
    if (size === offset) return;
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const chunk = buf.toString('utf8');
    const complete = chunk.lastIndexOf('\n');
    if (complete < 0) return;
    offset += Buffer.byteLength(chunk.slice(0, complete + 1));
    // Only fold events belonging to THIS repo (or repo-less legacy ones): `known`
    // is number-keyed, so a same-numbered PR from another repo in the same tape
    // must not pollute this run's dedupe (plan 1.4 keys panel rows by repo#number).
    const mine = ev => !ev.repo || !REPO || ev.repo === REPO;
    for (const line of chunk.slice(0, complete).split('\n').filter(Boolean)) {
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      eventSeq++;
      if (ev.type === 'pr' && ev.number != null && mine(ev)) {
        const prev = known.get(ev.number) || {};
        known.set(ev.number, { ...prev, state: ev.state, base: ev.base != null ? ev.base : prev.base, prSeq: eventSeq });
      } else if (ev.type === 'ci' && ev.pr != null && mine(ev)) {
        known.set(ev.pr, { ...(known.get(ev.pr) || {}), ci: ev.status });
      } else if (ev.type === 'pr_ref' && ev.number != null && mine(ev)) {
        known.set(ev.number, { ...(known.get(ev.number) || {}), refSeq: eventSeq });
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function append(ev) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), id: randomUUID(), source: 'poll-github', v: 2, ...ev }) + '\n');
  console.log(JSON.stringify(ev));
}

// Parse a gh ISO timestamp to epoch ms, or null. gh's real fact-time (plan 1.4).
const tsMs = s => { const ms = s ? Date.parse(s) : NaN; return Number.isFinite(ms) ? ms : null; };
// The real time of the transition we're recording, from gh (falls back to open time).
function occurredMs(pr, state) {
  if (state === 'merged') return tsMs(pr.mergedAt) ?? tsMs(pr.createdAt);
  if (state === 'closed') return tsMs(pr.closedAt) ?? tsMs(pr.createdAt);
  return tsMs(pr.createdAt); // open
}

// Emit pr/ci deltas for one PR's current state (folded `known` suppresses no-ops).
// pr/ci events carry `repo` (owner/name) so the reducer keys the panel by
// repo#number, and pr events carry gh's real `occurredAt`/`createdAt` so replay
// shows true history — this poller is the SINGLE writer of pr/ci (plan 1.4).
function emitPr(pr, { force = false } = {}) {
  let state = pr.state.toLowerCase(); // open | merged | closed (from gh)
  // CI/review status from toast when available (session-scoped polling only),
  // else gh's check rollup. If toast returns a status we don't map (closed,
  // acknowledged, a new taxonomy word…), fall back to gh rather than dropping CI.
  // Toast also reports 'merged', corroborating gh's state.
  const td = flags.known ? toastInfo(pr.number) : null;
  const ci = (td && toastCi(td)) || rollupCi(pr.statusCheckRollup);
  const tbase = td && (((td.status || '') + '').toLowerCase().split(':')[0]);
  if (tbase === 'merged' && state === 'open') state = 'merged';
  const base = resolveBase(pr); // stacked-PR chain target, or null
  const k = known.get(pr.number) || {};
  if (force || k.state !== state) {
    const ev = { type: 'pr', number: pr.number, title: pr.title, url: pr.url, state };
    if (REPO) ev.repo = REPO;
    if (base != null) ev.base = base;
    // Diff size (add/del) — stamped only when gh reports it, so old-tape replays and
    // metadata-thin events stay untouched. The reducer stores these sticky on the PR.
    if (pr.additions != null) ev.add = pr.additions;
    if (pr.deletions != null) ev.del = pr.deletions;
    const created = tsMs(pr.createdAt);
    if (created != null) ev.createdAt = created;
    const occ = occurredMs(pr, state);
    if (occ != null) ev.occurredAt = occ;
    append(ev);
    known.set(pr.number, { ...known.get(pr.number), state, base: base != null ? base : k.base, prSeq: ++eventSeq });
  } else if (base != null && k.base == null) {
    // State unchanged but the base chain just resolved (the base PR was opened
    // after this one) — record the link so the graph can draw the chain. A bare
    // state-echo the reducer merges base onto; it moves no card.
    const ev = { type: 'pr', number: pr.number, state, base };
    if (REPO) ev.repo = REPO;
    append(ev);
    known.set(pr.number, { ...known.get(pr.number), base });
  }
  if (ci != null && k.ci !== ci) {
    const ev = { type: 'ci', pr: pr.number, status: ci };
    if (REPO) ev.repo = REPO;
    append(ev);
    known.set(pr.number, { ...known.get(pr.number), ci });
  }
}

// One poll. Returns the number of session PRs still OPEN. Repo-wide mode returns 0.
function tick() {
  refreshKnown();
  if (flags.known) {
    // Session-scoped: refresh ONLY the PRs this tape surfaced (no repo-wide list,
    // so a repo with hundreds of open PRs can't flood a board) AND only those not
    // already terminal. A merged/closed PR never changes again, so re-polling it
    // is pure waste — and over a long session the surfaced set grows to dozens,
    // which made a full reconcile take minutes (one gh + toast call each). Poll
    // just the open / not-yet-seen ones; terminal PRs stay as the log recorded.
    const forced = n => { const k = known.get(n); return !!(k && /^(merged|closed)$/.test(k.state || '') && (k.refSeq || 0) > (k.prSeq || 0)); };
    const live = n => { const k = known.get(n); return !k || !/^(merged|closed)$/.test(k.state || '') || forced(n); };
    const nums = [...sessionPrNumbers()].filter(live);
    for (const n of nums) { const pr = ghPr(n); if (pr) emitPr(pr, { force: forced(n) }); }
    return nums.filter(live).length;
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

try {
  if (repoResolutionError) throw repoResolutionError;
  tick();
}
catch (error) {
  process.stderr.write(`poll-github: ${String(error && error.message || error).split('\n')[0]}\n`);
  process.exitCode = 1;
}
