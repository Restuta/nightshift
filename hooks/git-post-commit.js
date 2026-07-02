#!/usr/bin/env node
// Emits a `commit` event after every git commit. Installed via
// `npm run setup` (core.hooksPath=.githooks). Git-level on purpose: it fires
// no matter who made the commit — agent, human, or another tool.

const { execSync } = require('child_process');
const { randomUUID } = require('node:crypto');
const fs = require('fs');
const path = require('path');

function git(cmd) {
  return execSync(`git ${cmd}`, { encoding: 'utf8' }).trim();
}

try {
  const root = git('rev-parse --show-toplevel');
  const sha = git('log -1 --format=%h');
  const message = git('log -1 --format=%s');
  // --shortstat of the commit itself (empty for the very first commit's parent)
  let add = 0, del = 0, files = 0;
  const stat = git('show --shortstat --format= HEAD');
  const m = stat.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
  if (m) { files = +m[1]; add = +(m[2] || 0); del = +(m[3] || 0); }

  const log = path.join(root, '.nightshift', 'events.jsonl');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, JSON.stringify({ t: Date.now(), id: randomUUID(), source: 'hook', v: 2, type: 'commit', sha, message, add, del, files }) + '\n');
} catch { /* never block a commit */ }
