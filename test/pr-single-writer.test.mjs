// Plan 1.4 — PR truth has exactly ONE writer. Zero-dep, hermetic (node:test +
// node:assert; a stub `gh` on PATH, no network). These lock in:
//   - pr_ref is a SIGHTING: it links a card + registers relevance but conjures no
//     PR-panel row (that killed the 17+ title-less phantom rows);
//   - poll-github is the sole authority for pr STATE — a v2 pr from any other
//     source is ignored, v1 stays honored;
//   - occurredAt (gh's real mergedAt/createdAt) drives the displayed times, so
//     replay shows the 2am merge at 2am even when it was recorded at 9am;
//   - pr events are keyed by repo#number, so two repos' #1 don't collide.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initialState, reduce, fold, prList } from '../public/reducer.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Monotonic event stream over a fresh state.
function stream() {
  const s = initialState();
  let t = 1000;
  return {
    state: s,
    emit(o) { reduce(s, { t: (t += 1000), ...o }); return s; },
    item: id => s.items.get(id),
  };
}

// --- pr_ref is a sighting, not a panel row -----------------------------------
test('pr_ref links the card and registers relevance but conjures NO panel row', () => {
  const x = stream();
  x.emit({ type: 'item', id: 'turn-1', title: 'ship', status: 'doing' });
  x.emit({ source: 'hook', v: 2, type: 'pr_ref', number: 4, url: 'https://github.com/o/r/pull/4', title: 'the work', item: 'turn-1' });

  assert.equal(prList(x.state).length, 0, 'a sighting must not create a PR-panel row');
  assert.ok(x.state.prRefs.has(4), 'the number is registered session-relevant (for the poller)');
  const it = x.item('turn-1');
  assert.equal(it.pr.number, 4, 'the card is linked to the PR number');
  assert.equal(it.status, 'doing', 'a sighting carries no state → no column move');
});

test('a turn-boundary done parks a pr_ref-linked card in pr; the poller merge finishes it', () => {
  const x = stream();
  x.emit({ type: 'item', id: 'turn-1', status: 'doing' });
  x.emit({ source: 'codex-tail', v: 2, type: 'pr_ref', number: 9, item: 'turn-1' });
  x.emit({ type: 'item', id: 'turn-1', status: 'done' });
  assert.equal(x.item('turn-1').status, 'pr', 'the sighting keeps the card out of Done until gh confirms');

  x.emit({ source: 'poll-github', v: 2, type: 'pr', number: 9, state: 'open' });
  assert.equal(prList(x.state).length, 1, 'the poller pr event is what creates the panel row');
  assert.equal(x.item('turn-1').status, 'pr');

  x.emit({ source: 'poll-github', v: 2, type: 'pr', number: 9, state: 'merged' });
  assert.equal(x.item('turn-1').status, 'done', 'the poller merge carries the linked card to done');
});

// --- single-writer authority -------------------------------------------------
test('a v2 pr state event from a non-authoritative source is ignored; v1 stays honored', () => {
  // v2 hook pr → ignored: no panel row, no card move (defense-in-depth).
  const a = stream();
  a.emit({ type: 'item', id: 'wi', status: 'doing' });
  a.emit({ source: 'hook', v: 2, type: 'pr', number: 3, state: 'merged' });
  assert.equal(prList(a.state).length, 0, 'a v2 hook pr must not write panel state');
  assert.equal(a.item('wi').status, 'doing', 'a v2 hook pr must not move a card');

  // v2 codex-tail pr → also ignored (the other demoted producer).
  const b = stream();
  b.emit({ source: 'codex-tail', v: 2, type: 'pr', number: 3, state: 'open' });
  assert.equal(prList(b.state).length, 0, 'a v2 codex-tail pr is ignored too');

  // v1 pr (no source/v) → honored, so old tapes fold unchanged.
  const c = stream();
  c.emit({ type: 'pr', number: 3, state: 'open' });
  assert.equal(prList(c.state).length, 1, 'a v1 pr event still folds (back-compat forever)');

  // the offline synthesizers (demo/import) + the manual CLI (emit) stay authoritative.
  for (const source of ['poll-github', 'emit', 'import', 'demo']) {
    const d = stream();
    d.emit({ source, v: 2, type: 'pr', number: 1, state: 'open' });
    assert.equal(prList(d.state).length, 1, `${source} is authoritative for pr state`);
  }
});

// --- occurredAt drives the displayed history ---------------------------------
test('occurredAt drives mergedAt — replay shows the 2am merge at 2am, not at poll time', () => {
  const merge2am = Date.parse('2026-07-02T02:00:00Z');
  const created6pm = Date.parse('2026-07-01T18:00:00Z');
  const recorded9am = Date.parse('2026-07-02T09:00:00Z'); // the poller only NOTICED it at 9am
  const evs = [
    { t: created6pm, source: 'hook', v: 2, type: 'item', id: 'wi', status: 'doing' },
    { t: recorded9am, source: 'poll-github', v: 2, type: 'pr', number: 5, repo: 'o/r',
      state: 'merged', occurredAt: merge2am, createdAt: created6pm },
  ];
  const pr = prList(fold(evs))[0];
  assert.equal(pr.mergedAt, merge2am, 'mergedAt is gh’s real merge time, not the record time t');
  assert.equal(pr.openedAt, created6pm, 'openedAt is gh’s real create time');
  assert.notEqual(pr.mergedAt, recorded9am, 'the fabricated 9am history is gone');
});

// --- repo identity kills cross-repo collisions -------------------------------
test('two repos sharing PR #1 produce two distinct panel rows (repo#number keys)', () => {
  const s = fold([
    { t: 1, source: 'poll-github', v: 2, type: 'pr', number: 1, repo: 'org/alpha', state: 'open', title: 'Alpha work' },
    { t: 2, source: 'poll-github', v: 2, type: 'pr', number: 1, repo: 'org/beta', state: 'merged', title: 'Beta work' },
  ]);
  const rows = prList(s);
  assert.equal(rows.length, 2, 'a bare-number key collided them into one row; repo#number keeps them apart');
  assert.equal(rows.find(p => p.repo === 'org/alpha').state, 'open');
  assert.equal(rows.find(p => p.repo === 'org/beta').state, 'merged', 'beta merging never overwrites alpha');
});

test('a repo-scoped poller merge does not hijack a same-numbered card from another repo', () => {
  const x = stream();
  x.emit({ type: 'item', id: 'card-a', status: 'doing' });
  x.emit({ type: 'item', id: 'card-b', status: 'doing' });
  x.emit({ source: 'poll-github', v: 2, type: 'pr', number: 1, repo: 'org/alpha', state: 'open', item: 'card-a' });
  x.emit({ source: 'poll-github', v: 2, type: 'pr', number: 1, repo: 'org/beta', state: 'open', item: 'card-b' });
  // alpha's #1 merges (no item on the merge) — must reach card-a only.
  x.emit({ source: 'poll-github', v: 2, type: 'pr', number: 1, repo: 'org/alpha', state: 'merged' });
  assert.equal(x.item('card-a').status, 'done', 'alpha card finishes');
  assert.equal(x.item('card-b').pr.state, 'open', 'beta card is untouched by alpha’s merge');
  assert.equal(x.item('card-b').status, 'pr', 'beta card stays in flight');
});

// --- end-to-end: poll-github is the single writer (hermetic, stub gh) ---------
test('poll-github harvests a pr_ref and emits pr with repo + real occurredAt/createdAt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-poll-'));
  try {
    // A fake `gh` on PATH — the shebang points at THIS node so the test needs no
    // node on PATH, letting us restrict PATH to binDir (so `toast` is absent →
    // ENOENT → gh-rollup fallback, and no real gh/toast/network is ever touched).
    const binDir = path.join(dir, 'bin');
    fs.mkdirSync(binDir);
    const gh = path.join(binDir, 'gh');
    fs.writeFileSync(gh, [
      '#!' + process.execPath,
      'const a = process.argv.slice(2);',
      'if (a[0] === "pr" && a[1] === "view") {',
      '  const n = Number(a[2]);',
      '  process.stdout.write(JSON.stringify({ number: n, title: "The Work",',
      '    url: "https://github.com/o/r/pull/" + n, state: "MERGED",',
      '    mergedAt: "2026-07-02T02:00:00Z", closedAt: "2026-07-02T02:00:00Z",',
      '    createdAt: "2026-07-01T18:00:00Z", statusCheckRollup: [] }));',
      '  process.exit(0);',
      '}',
      'process.exit(1);',
    ].join('\n'));
    fs.chmodSync(gh, 0o755);

    // Seed: a session + card + a pr_ref sighting from the hook (no pr state yet).
    const log = path.join(dir, 'events.jsonl');
    const seed = [
      { t: 1, source: 'hook', v: 2, type: 'session', phase: 'start', cwd: dir, title: 't' },
      { t: 2, source: 'hook', v: 2, type: 'item', id: 'turn-1', status: 'doing' },
      { t: 3, source: 'hook', v: 2, type: 'pr_ref', number: 1, url: 'https://github.com/o/r/pull/1', item: 'turn-1' },
    ];
    fs.writeFileSync(log, seed.map(e => JSON.stringify(e)).join('\n') + '\n');

    const POLLER = path.join(here, '..', 'tools', 'poll-github.js');
    execFileSync(process.execPath, [POLLER, '--once', '--known', '--repo', 'o/r', '--log', log], {
      env: { PATH: binDir, NIGHTSHIFT_HOME: dir, HOME: dir }, encoding: 'utf8',
    });

    const evs = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const prEv = evs.find(e => e.type === 'pr' && e.source === 'poll-github');
    assert.ok(prEv, 'the poller wrote a pr event harvested from the pr_ref sighting');
    assert.equal(prEv.repo, 'o/r', 'the pr event carries repo identity');
    assert.equal(prEv.state, 'merged');
    assert.equal(prEv.occurredAt, Date.parse('2026-07-02T02:00:00Z'), 'occurredAt is gh’s real mergedAt');
    assert.equal(prEv.createdAt, Date.parse('2026-07-01T18:00:00Z'));

    // And the folded board shows the true merge time on a repo-keyed row, and the
    // linked card is carried to done by the poller's authoritative merge.
    const s = fold(evs);
    const pr = prList(s)[0];
    assert.equal(pr.repo, 'o/r');
    assert.equal(pr.mergedAt, Date.parse('2026-07-02T02:00:00Z'));
    assert.equal(s.items.get('turn-1').status, 'done', 'the poller merge finished the pr_ref-linked card');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
