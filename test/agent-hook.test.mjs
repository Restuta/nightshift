// Hook-side coverage for namespaced turn ids (plan 1.3). Drives hooks/agent-hook.js
// end-to-end — a JSON payload on stdin, a scoped sandbox env, an explicit
// $NIGHTSHIFT_LOG — so the real ~/.nightshift is never read or written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sid8 } from '../public/turn-id.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, '..', 'hooks', 'agent-hook.js');
const A = '019f0a00-0000-7000-8000-000000000001';

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hook-'));
  const ns = path.join(root, 'ns');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(ns, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  return { root, ns, proj, log: path.join(ns, 'events.jsonl'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// Fire one hook event: JSON payload on stdin, scoped env, explicit --log. Recording
// is forced on via $NIGHTSHIFT_LOG (resolveLog returns it; recording() sees a
// non-central log and opts in), and CLAUDE_PROJECT_DIR is cleared so SELF is false
// (the nightshift repo self-curates; every other session gets card synthesis).
function fire(payload, sb) {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR; delete env.NIGHTSHIFT; delete env.CLAUDE_CODE_SESSION_ID; delete env.CODEX_THREAD_ID;
  env.HOME = sb.root; env.NIGHTSHIFT_HOME = sb.ns; env.NIGHTSHIFT_LOG = sb.log;
  return spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env });
}
const items = log => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.type === 'item') : []);
const prompt = (extra = {}) => ({ hook_event_name: 'UserPromptSubmit', session_id: A, cwd: '/tmp/proj', prompt: 'do the thing', transcript_path: '/x/.claude/y.jsonl', ...extra });

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
