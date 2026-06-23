#!/usr/bin/env node
// Record GitHub PR/CI facts as events — never fetched at render time, per the
// core rule in docs/EVENTS.md: replaying yesterday's session must show
// yesterday's CI status.
//   node tools/poll-github.js [--once] [--interval <sec>=30] [--limit <prs>=100]
//     [--repo owner/name] [--log <file>]
//
// Uses the gh CLI (auth included), zero deps. Stateless across restarts: the
// known pr/ci state per PR number is folded out of the log itself — the full
// log on the first tick, then only newly appended bytes — and each tick
// appends only what changed. Safe to restart, safe to run alongside hooks,
// idempotent.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--once') flags.once = true;
  else if (argv[i] === '--interval') flags.interval = Number(argv[++i]);
  else if (argv[i] === '--limit') flags.limit = Number(argv[++i]);
  else if (argv[i] === '--repo') flags.repo = argv[++i];
  else if (argv[i] === '--log') flags.log = argv[++i];
  else if (argv[i] === '--known') flags.known = true;
}
const posInt = (n, dflt) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt);
const LOG = flags.log || path.join('.nightshift', 'events.jsonl');
const INTERVAL = posInt(flags.interval, 30) * 1000;
const LIMIT = posInt(flags.limit, 100);

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
  const state = pr.state.toLowerCase(); // open | merged | closed
  const ci = rollupCi(pr.statusCheckRollup);
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

function tick() {
  refreshKnown();
  if (flags.known) {
    // Session-scoped: refresh ONLY the PRs this tape surfaced. No repo-wide list,
    // so a repo with hundreds of open PRs can't flood a single session's board.
    const nums = [...sessionPrNumbers()];
    if (!nums.length) { if (flags.once) process.exit(0); return; }
    for (const n of nums) { const pr = ghPr(n); if (pr) emitPr(pr); }
    return;
  }
  let prs;
  try { prs = ghPrs(); } catch (err) {
    console.error(`gh failed: ${String(err.message || err).split('\n')[0]}`);
    if (flags.once) process.exit(1);
    return;
  }
  for (const pr of prs) emitPr(pr);
}

tick();
if (!flags.once) {
  console.error(`polling every ${INTERVAL / 1000}s${flags.known ? ' (session PRs only)' : ` (limit ${LIMIT} PRs)`} → ${LOG} (ctrl-c to stop)`);
  setInterval(tick, INTERVAL);
}
