// Hook-side coverage for namespaced turn ids (plan 1.3). Drives hooks/agent-hook.js
// end-to-end — a JSON payload on stdin, a scoped sandbox env, an explicit
// $NIGHTSHIFT_LOG — so the real ~/.nightshift is never read or written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { sid8 } from '../public/turn-id.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const HOOK = path.join(here, '..', 'hooks', 'agent-hook.js');
const ATTACHMENT = path.join(here, '..', 'tools', 'turn-attachment.js');
const SKILL = path.join(here, '..', 'skills', 'nightshift', 'SKILL.md');
const attachmentApi = require(ATTACHMENT);
const A = '019f0a00-0000-7000-8000-000000000001';

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hook-'));
  const ns = path.join(root, 'ns');
  const proj = path.join(root, 'proj');
  const transcript = path.join(root, '.claude', 'transcript.jsonl');
  fs.mkdirSync(ns, { recursive: true });
  fs.mkdirSync(path.join(ns, 'attachments'), { recursive: true });
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  return { root, ns, proj, transcript, log: path.join(ns, 'events.jsonl'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function envFor(sb) {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR; delete env.NIGHTSHIFT; delete env.CLAUDE_CODE_SESSION_ID; delete env.CODEX_THREAD_ID;
  env.HOME = sb.root; env.NIGHTSHIFT_HOME = sb.ns; env.NIGHTSHIFT_LOG = sb.log;
  return env;
}

// Fire one hook event: JSON payload on stdin, scoped env, explicit --log. Recording
// is forced on via $NIGHTSHIFT_LOG (resolveLog returns it; recording() sees a
// non-central log and opts in), and CLAUDE_PROJECT_DIR is cleared so SELF is false
// (the nightshift repo self-curates; every other session gets card synthesis).
function fire(payload, sb) {
  return spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env: envFor(sb) });
}
function fireAsync(payload, sb) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [HOOK], { env: envFor(sb), stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}
function requestAttachment(sb, envOverrides = {}) {
  return spawnSync(process.execPath, [
    ATTACHMENT, 'request', '--sid', A, '--log', sb.log,
    '--transcript', sb.transcript, '--activated-at', String(Date.parse('2026-07-14T02:00:01.000Z')),
  ], { encoding: 'utf8', env: { ...envFor(sb), ...envOverrides } });
}
function writeTranscript(sb, records, tail = '') {
  fs.writeFileSync(sb.transcript, records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '') + tail);
}
const human = (content = '<command-name>/nightshift</command-name>\n<command-args>on</command-args>', timestamp = '2026-07-14T02:00:00.000Z') => ({
  type: 'user', isMeta: false, timestamp, message: { role: 'user', content },
});
const post = (extra = {}) => ({
  hook_event_name: 'PostToolUse', session_id: A, cwd: '/tmp/proj',
  transcript_path: extra.transcript_path || extra.transcriptPath,
  tool_name: 'Bash', tool_input: { command: 'pwd' }, tool_response: '/tmp/proj', ...extra,
});
const items = log => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.type === 'item') : []);
const events = log => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const prompt = (extra = {}) => ({ hook_event_name: 'UserPromptSubmit', session_id: A, cwd: '/tmp/proj', prompt: 'do the thing', transcript_path: '/x/.claude/y.jsonl', ...extra });
const attachmentState = sb => JSON.parse(fs.readFileSync(path.join(sb.ns, 'attachments', `${A}.json`), 'utf8'));
function appendReservedItem(sb, title = 'helper appended before crash') {
  const reservation = attachmentState(sb);
  fs.writeFileSync(sb.log, JSON.stringify({
    t: Date.parse('2026-07-14T02:00:00.000Z'), source: 'hook', v: 2,
    type: 'item', id: reservation.turnId, title, status: 'doing',
  }) + '\n');
  return reservation.turnId;
}

test('UserPromptSubmit mints a namespaced turn card (turn-<sid8>-<n>)', () => {
  const sb = sandbox();
  try {
    const r = fire(prompt(), sb);
    assert.equal(r.status, 0, r.stderr);
    const card = items(sb.log).find(e => e.status === 'doing');
    assert.ok(card, 'a doing card was minted');
    assert.equal(card.id, `turn-${sid8(A)}-1`, 'the card id is namespaced by session');
  } finally { sb.cleanup(); }
});

test('a lost per-sid counter resumes numbering from the log (no re-collision)', () => {
  const sb = sandbox();
  try {
    const a8 = sid8(A);
    // The tape already holds this session's card 5, but the per-sid counter file is
    // gone (never written in this sandbox) — a lost checkpoint.
    fs.writeFileSync(sb.log, JSON.stringify({ t: 1, source: 'hook', v: 2, type: 'item', id: `turn-${a8}-5`, title: 'earlier work', status: 'doing' }) + '\n');
    const r = fire(prompt({ prompt: 'next turn' }), sb);
    assert.equal(r.status, 0, r.stderr);
    const minted = items(sb.log).find(e => e.status === 'doing' && e.title === 'next turn');
    assert.ok(minted, 'a new card was minted');
    assert.equal(minted.id, `turn-${a8}-6`, 'numbering continued from the log, not restarted at 1');
  } finally { sb.cleanup(); }
});

test('PostToolUse recovers the human prompt that enabled recording mid-turn', () => {
  const sb = sandbox();
  try {
    writeTranscript(sb, [human()]);
    const requested = requestAttachment(sb);
    assert.equal(requested.status, 0, requested.stderr);
    fs.mkdirSync(path.join(sb.ns, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(sb.ns, 'tasks', `${A}.json`), JSON.stringify({
      tasks: [{ id: '1', subject: 'Recover this turn', status: 'in_progress' }],
      pending: {}, offset: fs.statSync(sb.transcript).size,
    }));

    const r = fire(post({ transcript_path: sb.transcript }), sb);
    assert.equal(r.status, 0, r.stderr);
    const doing = items(sb.log).filter(e => e.status === 'doing');
    assert.equal(doing.length, 1);
    assert.equal(doing[0].id, `turn-${sid8(A)}-1`);
    assert.equal(doing[0].title, '/nightshift on');
    assert.equal(doing[0].t, Date.parse('2026-07-14T02:00:00.000Z'));
    assert.ok(events(sb.log).some(e => e.type === 'todos' && e.item === doing[0].id && e.todos[0].text === 'Recover this turn'));
    assert.ok(events(sb.log).some(e => e.type === 'tool' && e.item === doing[0].id));
  } finally { sb.cleanup(); }
});

test('duplicate and concurrent PostToolUse claims mint exactly one reserved item', async () => {
  const sb = sandbox();
  try {
    writeTranscript(sb, [human('recover concurrent work')]);
    const requested = requestAttachment(sb);
    assert.equal(requested.status, 0, requested.stderr);
    const payload = post({ transcript_path: sb.transcript });
    const results = await Promise.all([fireAsync(payload, sb), fireAsync(payload, sb)]);
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    const duplicate = fire(payload, sb);
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.equal(items(sb.log).filter(e => e.id === `turn-${sid8(A)}-1` && e.status === 'doing').length, 1);
  } finally { sb.cleanup(); }
});

test('a crash after reserved item append repairs turn state without duplicating it', () => {
  const sb = sandbox();
  try {
    writeTranscript(sb, [human('recover after append')]);
    const requested = requestAttachment(sb);
    assert.equal(requested.status, 0, requested.stderr);
    const reservation = JSON.parse(fs.readFileSync(path.join(sb.ns, 'attachments', `${A}.json`), 'utf8'));
    fs.writeFileSync(sb.log, JSON.stringify({
      t: Date.parse('2026-07-14T02:00:00.000Z'), source: 'hook', v: 2,
      type: 'item', id: reservation.turnId, title: 'recover after append', status: 'doing',
    }) + '\n');

    const r = fire(post({ transcript_path: sb.transcript }), sb);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(items(sb.log).filter(e => e.id === reservation.turnId && e.status === 'doing').length, 1);
    const turn = JSON.parse(fs.readFileSync(path.join(sb.ns, 'turns', `${A}.json`), 'utf8'));
    assert.equal(turn.card, reservation.turnId);
    assert.ok(events(sb.log).some(e => e.type === 'tool' && e.item === reservation.turnId));
  } finally { sb.cleanup(); }
});

test('meta-only or truncated transcript remains retryable until a human prompt is complete', () => {
  const sb = sandbox();
  try {
    writeTranscript(sb, [{
      type: 'user', isMeta: true, timestamp: '2026-07-14T02:00:00.100Z',
      message: { role: 'user', content: '<system-reminder>not human</system-reminder>' },
    }], '{"type":"user","message":');
    const requested = requestAttachment(sb);
    assert.equal(requested.status, 0, requested.stderr);
    let r = fire(post({ transcript_path: sb.transcript }), sb);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(items(sb.log).length, 0);
    let reservation = JSON.parse(fs.readFileSync(path.join(sb.ns, 'attachments', `${A}.json`), 'utf8'));
    assert.equal(reservation.status, 'requested');

    writeTranscript(sb, [human('the complete human prompt')]);
    r = fire(post({ transcript_path: sb.transcript }), sb);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(items(sb.log).filter(e => e.status === 'doing').length, 1);
  } finally { sb.cleanup(); }
});

test('claim ignores external tool results, task notices, reminders, queued commands, and local output', () => {
  const sb = sandbox();
  try {
    writeTranscript(sb, [
      human('the real human request'),
      { type: 'queue-operation', operation: 'enqueue', content: 'queued but not submitted', timestamp: '2026-07-14T02:00:00.100Z' },
      { type: 'user', timestamp: '2026-07-14T02:00:00.200Z', message: { role: 'user', content: '<task-notification>background result</task-notification>' } },
      { type: 'user', isMeta: true, timestamp: '2026-07-14T02:00:00.300Z', message: { role: 'user', content: '<system-reminder>injected</system-reminder>' } },
      { type: 'user', timestamp: '2026-07-14T02:00:00.400Z', message: { role: 'user', content: '<local-command-stdout>local output</local-command-stdout>' } },
      { type: 'user', timestamp: '2026-07-14T02:00:00.500Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'external result' }] } },
    ]);
    const requested = requestAttachment(sb);
    assert.equal(requested.status, 0, requested.stderr);
    const r = fire(post({ transcript_path: sb.transcript }), sb);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(items(sb.log).find(e => e.status === 'doing').title, 'the real human request');
  } finally { sb.cleanup(); }
});

test('an existing open card is adopted instead of minting a second turn', () => {
  const sb = sandbox();
  try {
    let r = fire(prompt({ prompt: 'already open' }), sb);
    assert.equal(r.status, 0, r.stderr);
    writeTranscript(sb, [human('do not mint me')]);
    const requested = requestAttachment(sb);
    assert.equal(requested.status, 0, requested.stderr);
    r = fire(post({ transcript_path: sb.transcript }), sb);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(items(sb.log).filter(e => e.status === 'doing').length, 1);
    assert.ok(events(sb.log).some(e => e.type === 'tool' && e.item === `turn-${sid8(A)}-1`));
  } finally { sb.cleanup(); }
});

test('the next normal UserPromptSubmit cancels an unused attachment reservation', () => {
  const sb = sandbox();
  try {
    writeTranscript(sb, [human('stale mid-turn prompt')]);
    const requested = requestAttachment(sb);
    assert.equal(requested.status, 0, requested.stderr);
    let r = fire(prompt({ prompt: 'the next real turn', transcript_path: sb.transcript }), sb);
    assert.equal(r.status, 0, r.stderr);
    r = fire(post({ transcript_path: sb.transcript }), sb);
    assert.equal(r.status, 0, r.stderr);
    const doing = items(sb.log).filter(e => e.status === 'doing');
    assert.equal(doing.length, 1);
    assert.equal(doing[0].title, 'the next real turn');
    const reservation = JSON.parse(fs.readFileSync(path.join(sb.ns, 'attachments', `${A}.json`), 'utf8'));
    assert.equal(reservation.status, 'cancelled_by_next_prompt');
  } finally { sb.cleanup(); }
});

test('Stop closes a recovered conversational turn', () => {
  const sb = sandbox();
  try {
    writeTranscript(sb, [human('recover then stop')]);
    const requested = requestAttachment(sb);
    assert.equal(requested.status, 0, requested.stderr);
    let r = fire(post({ transcript_path: sb.transcript }), sb);
    assert.equal(r.status, 0, r.stderr);
    r = fire({ hook_event_name: 'Stop', session_id: A, cwd: '/tmp/proj', transcript_path: sb.transcript }, sb);
    assert.equal(r.status, 0, r.stderr);
    const cardEvents = items(sb.log).filter(e => e.id === `turn-${sid8(A)}-1`);
    assert.deepEqual(cardEvents.map(e => e.status), ['doing', 'done']);
  } finally { sb.cleanup(); }
});

test('an acknowledged recovery is single-use and later PostToolUse stays on the new turn', () => {
  const sb = sandbox();
  try {
    writeTranscript(sb, [human('recover turn one')]);
    let r = requestAttachment(sb);
    assert.equal(r.status, 0, r.stderr);
    r = fire(post({ transcript_path: sb.transcript }), sb);
    assert.equal(r.status, 0, r.stderr);
    r = fire({ hook_event_name: 'Stop', session_id: A, cwd: '/tmp/proj', transcript_path: sb.transcript }, sb);
    assert.equal(r.status, 0, r.stderr);

    r = fire(prompt({ prompt: 'turn two', transcript_path: sb.transcript }), sb);
    assert.equal(r.status, 0, r.stderr);
    r = fire(post({ transcript_path: sb.transcript, tool_input: { command: 'echo turn-two-tool' } }), sb);
    assert.equal(r.status, 0, r.stderr);

    const turnOne = `turn-${sid8(A)}-1`;
    const turnTwo = `turn-${sid8(A)}-2`;
    assert.deepEqual(items(sb.log).filter(e => e.id === turnOne).map(e => e.status), ['doing', 'done']);
    assert.deepEqual(items(sb.log).filter(e => e.id === turnTwo).map(e => e.status), ['doing']);
    assert.ok(events(sb.log).some(e => e.type === 'tool' && e.text === 'echo turn-two-tool' && e.item === turnTwo));
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.ns, 'turns', `${A}.json`), 'utf8')).card, turnTwo);
  } finally { sb.cleanup(); }
});

test('Stop finalizes a helper-appended recovery even when hook turn state was never saved', () => {
  const sb = sandbox();
  try {
    writeTranscript(sb, [human('recover before stop')]);
    const requested = requestAttachment(sb);
    assert.equal(requested.status, 0, requested.stderr);
    const turnId = appendReservedItem(sb);

    const r = fire({ hook_event_name: 'Stop', session_id: A, cwd: '/tmp/proj', transcript_path: sb.transcript }, sb);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(items(sb.log).filter(e => e.id === turnId).map(e => e.status), ['doing', 'done']);
    assert.equal(attachmentState(sb).status, 'consumed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.ns, 'turns', `${A}.json`), 'utf8')).card, null);
  } finally { sb.cleanup(); }
});

test('next UserPromptSubmit finalizes a helper-appended recovery before opening the next turn', () => {
  const sb = sandbox();
  try {
    writeTranscript(sb, [human('recover before next prompt')]);
    const requested = requestAttachment(sb);
    assert.equal(requested.status, 0, requested.stderr);
    const recovered = appendReservedItem(sb);

    const r = fire(prompt({ prompt: 'next after helper crash', transcript_path: sb.transcript }), sb);
    assert.equal(r.status, 0, r.stderr);
    const next = `turn-${sid8(A)}-2`;
    assert.deepEqual(items(sb.log).filter(e => e.id === recovered).map(e => e.status), ['doing', 'done']);
    assert.deepEqual(items(sb.log).filter(e => e.id === next).map(e => e.status), ['doing']);
    assert.equal(attachmentState(sb).status, 'consumed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.ns, 'turns', `${A}.json`), 'utf8')).card, next);
  } finally { sb.cleanup(); }
});

test('request recovers an empty stale lease using its filesystem mtime', () => {
  const sb = sandbox();
  try {
    const lease = path.join(sb.ns, 'attachments', `${A}.lease`);
    fs.writeFileSync(lease, '');
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(lease, old, old);
    const r = requestAttachment(sb, {
      NIGHTSHIFT_ATTACHMENT_LEASE_STALE_MS: '5',
      NIGHTSHIFT_ATTACHMENT_LEASE_WAIT_MS: '25',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(attachmentState(sb).status, 'requested');
    assert.equal(fs.existsSync(lease), false, 'the successful request released its replacement lease');
  } finally { sb.cleanup(); }
});

test('CLI request reports a fresh malformed lease failure instead of silent success', () => {
  const sb = sandbox();
  try {
    const lease = path.join(sb.ns, 'attachments', `${A}.lease`);
    fs.writeFileSync(lease, '');
    const r = requestAttachment(sb, {
      NIGHTSHIFT_ATTACHMENT_LEASE_STALE_MS: '60000',
      NIGHTSHIFT_ATTACHMENT_LEASE_WAIT_MS: '10',
    });
    assert.notEqual(r.status, 0);
    const error = JSON.parse(r.stderr.trim());
    assert.equal(error.status, 'error');
    assert.equal(error.code, 'attachment_lease_unavailable');
    assert.equal(fs.existsSync(path.join(sb.ns, 'attachments', `${A}.json`)), false);
  } finally { sb.cleanup(); }
});

test('SELF PostToolUse does not claim or open an automatic recovered card', () => {
  const sb = sandbox();
  try {
    writeTranscript(sb, [human('self uses hand-curated items')]);
    const requested = requestAttachment(sb);
    assert.equal(requested.status, 0, requested.stderr);
    const repoRoot = path.join(here, '..');
    const r = fire(post({ cwd: repoRoot, transcript_path: sb.transcript }), sb);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(items(sb.log).length, 0);
    assert.equal(attachmentState(sb).status, 'requested');
  } finally { sb.cleanup(); }
});

test('UserPrompt boundary wins before a delayed PostToolUse can claim the reservation', async () => {
  const sb = sandbox();
  try {
    writeTranscript(sb, [human('unused before next prompt')]);
    const requested = requestAttachment(sb);
    assert.equal(requested.status, 0, requested.stderr);

    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const delayedPost = (async () => { await gate; return fireAsync(post({ transcript_path: sb.transcript }), sb); })();
    const boundary = fire(prompt({ prompt: 'boundary turn', transcript_path: sb.transcript }), sb);
    assert.equal(boundary.status, 0, boundary.stderr);
    release();
    const delayed = await delayedPost;
    assert.equal(delayed.status, 0, delayed.stderr);

    const turn = `turn-${sid8(A)}-1`;
    assert.deepEqual(items(sb.log).filter(e => e.id === turn).map(e => e.status), ['doing']);
    assert.ok(events(sb.log).some(e => e.type === 'tool' && e.item === turn));
    assert.equal(attachmentState(sb).status, 'cancelled_by_next_prompt');
    assert.equal(attachmentState(sb).boundaryReason, 'next_prompt');
  } finally { sb.cleanup(); }
});

test('Stop boundary wins before a delayed PostToolUse can claim the reservation', async () => {
  const sb = sandbox();
  try {
    writeTranscript(sb, [human('unused before stop')]);
    const requested = requestAttachment(sb);
    assert.equal(requested.status, 0, requested.stderr);

    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const delayedPost = (async () => { await gate; return fireAsync(post({ transcript_path: sb.transcript }), sb); })();
    const boundary = fire({ hook_event_name: 'Stop', session_id: A, cwd: '/tmp/proj', transcript_path: sb.transcript }, sb);
    assert.equal(boundary.status, 0, boundary.stderr);
    release();
    const delayed = await delayedPost;
    assert.equal(delayed.status, 0, delayed.stderr);

    assert.equal(items(sb.log).length, 0, 'the delayed tool cannot mint work after idle');
    assert.equal(attachmentState(sb).status, 'cancelled_by_next_prompt');
    assert.equal(attachmentState(sb).boundaryReason, 'stop');
  } finally { sb.cleanup(); }
});

test('nightshift skill guards request and cancel before later Start/reset/off mutations', () => {
  const skill = fs.readFileSync(SKILL, 'utf8');
  const reset = skill.slice(skill.indexOf('### Reset (archive the old tape)'), skill.indexOf('### Start'));
  const start = skill.slice(skill.indexOf('### Start'), skill.indexOf('### Open the board'));
  const off = skill.slice(skill.indexOf('## `/nightshift off`'), skill.indexOf('## `/nightshift watch`'));

  assert.match(start, /if ! node "\$REPO\/tools\/turn-attachment\.js" request[^\n]+; then[\s\S]+failed to reserve[\s\S]+exit 1[\s\S]+fi/);
  assert.ok(start.indexOf('if ! node "$REPO/tools/turn-attachment.js" request') < start.indexOf('node "$REPO/tools/emit.js" session'));
  assert.ok(start.indexOf('exit 1') < start.indexOf('node "$REPO/tools/emit.js" session'));

  assert.match(reset, /if ! node "\$REPO\/tools\/turn-attachment\.js" cancel[^\n]+--reason reset; then[\s\S]+failed to cancel[\s\S]+exit 1[\s\S]+fi/);
  assert.ok(reset.indexOf('if ! node "$REPO/tools/turn-attachment.js" cancel') < reset.indexOf('mv "$LOG"'));

  assert.match(off, /if ! node "\$REPO\/tools\/turn-attachment\.js" cancel[^\n]+--reason off; then[\s\S]+failed to cancel[\s\S]+exit 1[\s\S]+fi/);
  assert.ok(off.indexOf('if ! node "$REPO/tools/turn-attachment.js" cancel') < off.indexOf('rm -f ~/.nightshift/active/'));
});

test('attachment acknowledgement serializes adoption against a winning boundary', () => {
  const sb = sandbox();
  const previousHome = process.env.NIGHTSHIFT_HOME;
  try {
    process.env.NIGHTSHIFT_HOME = sb.ns;
    writeTranscript(sb, [human('first atomic adoption')]);
    attachmentApi.requestAttachment({
      sid: A, log: sb.log, transcriptPath: sb.transcript,
      activatedAt: Date.parse('2026-07-14T02:00:01.000Z'),
    });
    const first = attachmentApi.claimAttachment({ sid: A, log: sb.log, transcriptPath: sb.transcript });
    let adopted = false;
    attachmentApi.ackAttachment({ sid: A, turnId: first.turnId, adopt: () => { adopted = true; } });
    assert.equal(adopted, true, 'an uncontested pending claim runs its adoption before acknowledgement');

    fs.appendFileSync(sb.log, JSON.stringify({ type: 'item', id: first.turnId, status: 'done' }) + '\n');
    writeTranscript(sb, [human('second stale claim')]);
    attachmentApi.requestAttachment({
      sid: A, log: sb.log, transcriptPath: sb.transcript,
      activatedAt: Date.parse('2026-07-14T02:00:01.000Z'),
    });
    const stale = attachmentApi.claimAttachment({ sid: A, log: sb.log, transcriptPath: sb.transcript });
    const boundary = attachmentApi.boundaryAttachment({ sid: A, log: sb.log, reason: 'stop' });
    assert.equal(boundary.turnId, stale.turnId);
    let reopened = false;
    attachmentApi.ackAttachment({ sid: A, turnId: stale.turnId, adopt: () => { reopened = true; } });
    assert.equal(reopened, false, 'a boundary that consumed the pending claim suppresses stale adoption');
  } finally {
    if (previousHome === undefined) delete process.env.NIGHTSHIFT_HOME;
    else process.env.NIGHTSHIFT_HOME = previousHome;
    sb.cleanup();
  }
});

test('boundary_pending survives crashes before done or boundary ack and repairs idempotently', () => {
  const previousHome = process.env.NIGHTSHIFT_HOME;
  try {
    for (const scenario of ['stop-before-done', 'prompt-after-done']) {
      const sb = sandbox();
      try {
        process.env.NIGHTSHIFT_HOME = sb.ns;
        writeTranscript(sb, [human(`recover ${scenario}`)]);
        attachmentApi.requestAttachment({
          sid: A, log: sb.log, transcriptPath: sb.transcript,
          activatedAt: Date.parse('2026-07-14T02:00:01.000Z'),
        });
        const turnId = appendReservedItem(sb, scenario);
        const interrupted = attachmentApi.boundaryAttachment({ sid: A, log: sb.log, reason: scenario });
        assert.equal(interrupted.turnId, turnId);
        assert.equal(attachmentState(sb).status, 'boundary_pending');
        assert.equal(attachmentState(sb).boundaryTurnId, turnId);
        const delayedClaim = attachmentApi.claimAttachment({ sid: A, log: sb.log, transcriptPath: sb.transcript });
        assert.equal(delayedClaim.turnId, null, 'boundary_pending is non-claimable');

        if (scenario === 'prompt-after-done') {
          // Simulate a second crash after the hook appended done and persisted turn
          // state, but before it acknowledged the boundary state.
          fs.appendFileSync(sb.log, JSON.stringify({ type: 'item', id: turnId, status: 'done' }) + '\n');
          fs.mkdirSync(path.join(sb.ns, 'turns'), { recursive: true });
          fs.writeFileSync(path.join(sb.ns, 'turns', `${A}.json`), JSON.stringify({ turnN: 1, card: null }));
          const r = fire(prompt({ prompt: 'repair then open next', transcript_path: sb.transcript }), sb);
          assert.equal(r.status, 0, r.stderr);
          assert.deepEqual(items(sb.log).filter(e => e.id === turnId).map(e => e.status), ['doing', 'done']);
          assert.deepEqual(items(sb.log).filter(e => e.id === `turn-${sid8(A)}-2`).map(e => e.status), ['doing']);
        } else {
          const r = fire({ hook_event_name: 'Stop', session_id: A, cwd: '/tmp/proj', transcript_path: sb.transcript }, sb);
          assert.equal(r.status, 0, r.stderr);
          assert.deepEqual(items(sb.log).filter(e => e.id === turnId).map(e => e.status), ['doing', 'done']);
        }

        const repaired = attachmentState(sb);
        assert.equal(repaired.status, 'consumed');
        assert.equal(repaired.boundaryTurnId, undefined);
        const repeated = attachmentApi.boundaryAttachment({ sid: A, log: sb.log, reason: 'repeat' });
        assert.equal(repeated.turnId, null);
      } finally {
        sb.cleanup();
      }
    }
  } finally {
    if (previousHome === undefined) delete process.env.NIGHTSHIFT_HOME;
    else process.env.NIGHTSHIFT_HOME = previousHome;
  }
});
