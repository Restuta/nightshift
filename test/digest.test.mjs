// Digest model tests — hermetic, zero-dep (node:test + node:assert). The digest
// is a pure narrative projection over the same tape as the reducer and lanes
// model: ledger totals, prompt chapters, PR lifecycle attribution, and closers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest, EPISODE_MIN_EDITS, GAP_MS } from '../public/digest.js';

const H = 60 * 60 * 1000;
const M = 60 * 1000;

test('buildDigest returns the zero shape for empty and producer-less tapes', () => {
  const zero = {
    startT: null,
    endT: null,
    wallMs: 0,
    activeMs: 0,
    idleMs: 0,
    gaps: [],
    totals: {
      prompts: 0,
      episodes: 0,
      beats: 0,
      prsOpened: 0,
      prsMerged: 0,
      commits: 0,
      says: 0,
      edits: 0,
      tools: 0,
    },
    chapters: [],
  };
  assert.deepEqual(buildDigest([]), zero);
  assert.deepEqual(buildDigest([
    { t: 1000, type: 'session', phase: 'start' },
    { t: 2000, type: 'alive' },
    { t: 3000, type: 'usage', input: 10, output: 1 },
  ]), zero);
});

test('one turn with commit, PR open→merged, and closing narration is an episode', () => {
  const evs = [
    { t: 0, type: 'item', id: 'turn-abc12345-1', title: 'Ship digest', status: 'doing' },
    { t: 1000, type: 'say', text: 'I am starting.' },
    { t: 2000, type: 'edit', path: 'public/digest.js' },
    { t: 3000, type: 'commit', sha: 'abc1234', message: 'Add digest', add: 40, del: 2 },
    { t: 4000, type: 'pr', number: 7, state: 'open', title: 'Digest PR' },
    { t: 5000, type: 'pr', number: 7, state: 'merged' },
    { t: 6000, type: 'say', text: 'Merged and ready.' },
  ];
  const d = buildDigest(evs);
  assert.equal(d.totals.prompts, 1);
  assert.equal(d.totals.episodes, 1);
  assert.equal(d.totals.beats, 0);
  assert.equal(d.totals.commits, 1);
  assert.equal(d.totals.edits, 1);
  assert.equal(d.totals.says, 2);
  assert.equal(d.totals.prsOpened, 1);
  assert.equal(d.totals.prsMerged, 1);
  assert.equal(d.chapters.length, 1);
  const ch = d.chapters[0];
  assert.equal(ch.id, 'turn-abc12345-1');
  assert.equal(ch.label, 'turn 1');
  assert.equal(ch.title, 'Ship digest');
  assert.equal(ch.kind, 'episode');
  assert.deepEqual(ch.counts, { commits: 1, edits: 1, says: 2, tools: 0 });
  assert.deepEqual(ch.commits, [{ t: 3000, sha: 'abc1234', message: 'Add digest', add: 40, del: 2 }]);
  assert.deepEqual(ch.prs, [{
    number: 7,
    title: 'Digest PR',
    openedT: 4000,
    mergedT: 5000,
    closedT: null,
    state: 'merged',
  }]);
  assert.deepEqual(ch.closer, { t: 6000, text: 'Merged and ready.' });
});

test('a turn with one say and nothing else is a beat', () => {
  const d = buildDigest([
    { t: 0, type: 'item', id: 'turn-1', title: 'what next?', status: 'doing' },
    { t: 1000, type: 'say', text: 'Next is the digest.' },
  ]);
  assert.equal(d.chapters.length, 1);
  assert.equal(d.chapters[0].kind, 'beat');
  assert.equal(d.totals.beats, 1);
  assert.equal(d.totals.episodes, 0);
});

test('gap accounting excludes a 2h silence from active time inside one chapter', () => {
  const evs = [
    { t: 0, type: 'item', id: 'turn-1', title: 'long run', status: 'doing' },
    { t: 5 * M, type: 'edit', path: 'a' },
    { t: 2 * H + 5 * M, type: 'tool', name: 'test' },
    { t: 2 * H + 10 * M, type: 'say', text: 'done' },
  ];
  const d = buildDigest(evs);
  assert.equal(d.gaps.length, 1);
  assert.deepEqual(d.gaps[0], { fromT: 5 * M, toT: 2 * H + 5 * M, ms: 2 * H });
  assert.equal(d.idleMs + d.activeMs, d.wallMs);
  const ch = d.chapters[0];
  assert.equal(ch.gaps.length, 1);
  assert.equal(ch.activeMs, 10 * M);
  assert.equal(ch.wallMs, 2 * H + 10 * M);
});

test('alive events during silence do not mask idle gaps', () => {
  const d = buildDigest([
    { t: 0, type: 'item', id: 'turn-1', title: 'quiet work', status: 'doing' },
    { t: 5 * M, type: 'edit', path: 'a' },
    { t: 30 * M, type: 'alive' },
    { t: 60 * M, type: 'alive' },
    { t: 2 * H + 5 * M, type: 'say', text: 'back' },
  ]);
  assert.equal(d.gaps.length, 1);
  assert.deepEqual(d.gaps[0], { fromT: 5 * M, toT: 2 * H + 5 * M, ms: 2 * H });
});

test('a PR opened in chapter A and merged in chapter B is listed once under A', () => {
  const d = buildDigest([
    { t: 0, type: 'item', id: 'turn-1', title: 'open pr', status: 'doing' },
    { t: 1000, type: 'pr', number: 11, state: 'open', title: 'Carry work' },
    { t: 2000, type: 'item', id: 'turn-2', title: 'merge pr', status: 'doing' },
    { t: 3000, type: 'pr', number: 11, state: 'merged' },
    { t: 4000, type: 'say', text: 'merged' },
  ]);
  assert.equal(d.totals.prsMerged, 1);
  assert.equal(d.chapters.length, 2);
  assert.equal(d.chapters[0].prs.length, 1);
  assert.deepEqual(d.chapters[0].prs[0], {
    number: 11,
    title: 'Carry work',
    openedT: 1000,
    mergedT: 3000,
    closedT: null,
    state: 'merged',
  });
  assert.equal(d.chapters[1].prs.length, 0);
});

test('untilT matches truncating the tape and prevents PR lifecycle lookahead', () => {
  const evs = [
    { t: 0, type: 'item', id: 'turn-1', title: 'scrub', status: 'doing' },
    { t: 1000, type: 'pr', number: 5, state: 'open', title: 'Scrub PR' },
    { t: 2000, type: 'say', text: 'opened' },
    { t: 3000, type: 'pr', number: 5, state: 'merged' },
    { t: 4000, type: 'say', text: 'merged' },
  ];
  const midT = 2000;
  const atMid = buildDigest(evs, midT);
  assert.deepEqual(atMid, buildDigest(evs.filter(e => e.t <= midT)));
  assert.deepEqual(atMid.chapters[0].prs[0], {
    number: 5,
    title: 'Scrub PR',
    openedT: 1000,
    mergedT: null,
    closedT: null,
    state: 'open',
  });
});

test('retraction removes an item and its attributed events from counts and chapters', () => {
  const d = buildDigest([
    { t: 0, type: 'item', id: 'turn-1', title: 'junk', status: 'doing' },
    { t: 1000, type: 'edit', item: 'turn-1', path: 'bad' },
    { t: 2000, type: 'say', item: 'turn-1', text: 'bad' },
    { t: 3000, type: 'retract', target: { item: 'turn-1' }, reason: 'recording bug' },
    { t: 4000, type: 'item', id: 'turn-2', title: 'real', status: 'doing' },
    { t: 5000, type: 'say', text: 'real' },
  ]);
  assert.equal(d.totals.prompts, 1);
  assert.equal(d.totals.edits, 0);
  assert.equal(d.totals.says, 1);
  assert.deepEqual(d.chapters.map(ch => ch.id), ['turn-2']);
  assert.equal(d.chapters[0].closer.text, 'real');
});

test('preamble producer events before the first turn land in an id:null chapter', () => {
  const withPreamble = buildDigest([
    { t: 0, type: 'say', text: 'booting' },
    { t: 1000, type: 'item', id: 'turn-1', title: 'prompt', status: 'doing' },
    { t: 2000, type: 'say', text: 'answer' },
  ]);
  assert.equal(withPreamble.chapters.length, 2);
  assert.equal(withPreamble.chapters[0].id, null);
  assert.equal(withPreamble.chapters[0].label, '');
  assert.equal(withPreamble.chapters[0].title, '(before first prompt)');
  assert.deepEqual(withPreamble.chapters[0].closer, { t: 0, text: 'booting' });

  const noPreamble = buildDigest([
    { t: 0, type: 'item', id: 'turn-1', title: 'prompt', status: 'doing' },
    { t: 1000, type: 'say', text: 'answer' },
  ]);
  assert.deepEqual(noPreamble.chapters.map(ch => ch.id), ['turn-1']);
});

test('producer-only tapes with no turn cards still get a preamble chapter', () => {
  const d = buildDigest([
    { t: 1000, type: 'say', text: 'imported narration' },
    { t: 2000, type: 'commit', sha: 'abc1234', message: 'old work', add: 2, del: 1 },
  ]);
  assert.equal(d.totals.prompts, 0);
  assert.equal(d.chapters.length, 1);
  assert.equal(d.chapters[0].id, null);
  assert.equal(d.chapters[0].title, '(before first prompt)');
  assert.equal(d.chapters[0].kind, 'episode');
  assert.deepEqual(d.chapters[0].closer, { t: 1000, text: 'imported narration' });
});

test('prompt, episode, and beat totals match the chapter list', () => {
  const evs = [
    { t: 0, type: 'item', id: 'turn-1', title: 'beat', status: 'doing' },
    { t: 1000, type: 'say', text: 'ok' },
    { t: 2000, type: 'item', id: 'turn-2', title: 'edit episode', status: 'doing' },
    ...Array.from({ length: EPISODE_MIN_EDITS }, (_, i) =>
      ({ t: 3000 + i, type: 'edit', path: `f${i}` })),
    { t: 4000, type: 'item', id: 'turn-3', title: 'commit episode', status: 'doing' },
    { t: 5000, type: 'commit', sha: 'c0ffee0', message: 'done', add: 1, del: 0 },
  ];
  const d = buildDigest(evs);
  assert.equal(d.totals.prompts, 3);
  assert.equal(d.totals.episodes, d.chapters.filter(ch => ch.kind === 'episode').length);
  assert.equal(d.totals.beats, d.chapters.filter(ch => ch.kind === 'beat').length);
  assert.equal(d.totals.episodes, 2);
  assert.equal(d.totals.beats, 1);
  assert.equal(d.totals.prompts, d.chapters.filter(ch => ch.id != null).length);
});

test('a gap exactly equal to GAP_MS is active continuity, not idle', () => {
  const d = buildDigest([
    { t: 0, type: 'item', id: 'turn-1', title: 'threshold', status: 'doing' },
    { t: GAP_MS, type: 'say', text: 'still one burst' },
  ]);
  assert.deepEqual(d.gaps, []);
  assert.equal(d.activeMs, d.wallMs);
  assert.equal(d.chapters[0].activeMs, d.chapters[0].wallMs);
});
