// Shift Report model tests — hermetic, zero-dep (node:test + node:assert).
// Run: npm test
//
// These assert the pure MODEL (tools/report-model.mjs) over a small in-repo golden
// tape, never HTML strings — the report is a deterministic fold, so its answers
// are what we lock in: the shipped list, needs-you detection, chapter segmentation,
// windowing, and the header's window aggregates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReportModel } from '../tools/report-model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TAPES = path.join(here, 'tapes');
const readTape = f => fs.readFileSync(path.join(TAPES, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

const tape = readTape('report-shift.jsonl');

test('shipped: lists PRs merged in window at their REAL merge time', () => {
  const m = buildReportModel(tape, 0);
  assert.equal(m.shipped.length, 1);
  assert.equal(m.shipped[0].number, 1);
  assert.equal(m.shipped[0].title, 'Feature A');
  assert.equal(m.shipped[0].url, 'https://github.com/o/r/pull/1');
  // occurredAt (gh's real merge time) wins over the recorded t (+540000).
  assert.equal(m.shipped[0].mergedAt, 1700000500000);
});

test('needs-you: attention, CI-blocked PR, abandoned doing card, last word', () => {
  const m = buildReportModel(tape, 0);
  const kinds = m.needsYou.map(n => n.kind).sort();
  assert.deepEqual(kinds, ['abandoned', 'attention', 'blocked-pr', 'lastword']);

  const attn = m.needsYou.find(n => n.kind === 'attention');
  assert.match(attn.text, /force-merge/);

  const blocked = m.needsYou.find(n => n.kind === 'blocked-pr');
  assert.equal(blocked.number, 2);
  assert.equal(blocked.ci, 'fail');

  const abandoned = m.needsYou.find(n => n.kind === 'abandoned');
  assert.equal(abandoned.id, 'wi-3', 'the card left in `doing`, not the one that reached `pr`');

  const last = m.needsYou.find(n => n.kind === 'lastword');
  assert.match(last.text, /need a hand/);
});

test('empty needs-you renders as an intentional empty state', () => {
  // A healthy, fully-merged, idle-clean tape: nothing should need you.
  const healthy = readTape('healthy.jsonl');
  const m = buildReportModel(healthy, 0);
  const actionable = m.needsYou.filter(n => n.kind !== 'lastword');
  assert.equal(actionable.length, 0, 'no attention / blocked PR / abandoned card');
});

test('chapters: split on silent gaps > 30min', () => {
  const m = buildReportModel(tape, 0);
  assert.equal(m.story.length, 2);
  const [c1, c2] = m.story;
  assert.deepEqual(c1.cards, ['Build feature A']);
  assert.equal(c1.commits, 1);
  assert.deepEqual(c1.prsMerged, [1]);
  assert.deepEqual(c1.prsOpened, [1]);
  assert.deepEqual(c1.files, ['foo.js']);
  assert.equal(c1.firstSay, 'opening PR for feature A');
  assert.ok(c2.cards.includes('Build feature B') && c2.cards.includes('Refactor C'));
  assert.equal(c2.commits, 1);
  assert.deepEqual(c2.prsOpened, [2]);
});

test('header: window aggregates are the reducer’s own deltas', () => {
  const m = buildReportModel(tape, 0);
  assert.equal(m.header.commits, 2);
  assert.equal(m.header.add, 35);
  assert.equal(m.header.del, 4);
  assert.ok(m.header.cost > 0, 'cost accrues from the usage event');
  assert.equal(m.header.agent, 'claude');
  assert.equal(m.header.title, 'Report test');
  assert.ok(m.header.activeMs > 0);
});

test('still open: open PR with CI + unfinished plan item', () => {
  const m = buildReportModel(tape, 0);
  assert.equal(m.stillOpen.prs.length, 1);
  assert.equal(m.stillOpen.prs[0].number, 2);
  assert.equal(m.stillOpen.prs[0].ci, 'fail');
  assert.ok(m.stillOpen.prs[0].ageMs > 0);
  assert.deepEqual(m.stillOpen.todos.map(t => t.text), ['ship A']);
});

test('windowing: a later `since` excludes the first chapter and its ship', () => {
  const since2 = 1700003300000; // start of chapter 2
  const m = buildReportModel(tape, since2);
  assert.equal(m.shipped.length, 0, '#1 merged before the window');
  assert.equal(m.story.length, 1, 'only chapter 2 is in the window');
  assert.equal(m.header.commits, 1, 'only the chapter-2 commit counts');
  assert.equal(m.header.add, 15);
});

test('usage footer present when usage events exist', () => {
  const m = buildReportModel(tape, 0);
  assert.ok(m.usage);
  assert.equal(m.usage.tokIn, 2000);
  assert.equal(m.usage.tokOut, 400);
  assert.equal(m.usage.cacheTok, 1000);
});

test('retracted junk never enters the report', () => {
  // The junk-cards fixture retracts harness-injected cards; they must not appear
  // as abandoned/needs-you or in any chapter's card list.
  const junk = readTape('junk-cards.jsonl');
  const m = buildReportModel(junk, 0);
  const titles = m.story.flatMap(c => c.cards);
  for (const bad of ['junk-1', 'junk-2', 'junk-3', 'junk-4']) {
    assert.ok(!titles.includes(bad), `${bad} must not appear in the story`);
    assert.ok(!m.needsYou.some(n => n.id === bad), `${bad} must not be a needs-you item`);
  }
});
