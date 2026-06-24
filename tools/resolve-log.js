#!/usr/bin/env node
// Print the events-log path claude-hook.js would use for the current project,
// so the /nightshift skill (and humans) can emit to / tail the right file.
// Mirrors the resolution in hooks/claude-hook.js.

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const home = process.env.NIGHTSHIFT_HOME || path.join(os.homedir(), '.nightshift');

// The nightshift repo recorded by a global install, or null if none.
function installRepo() {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'install.json'), 'utf8')).repo || null; }
  catch { return null; }
}

function resolve() {
  if (process.env.NIGHTSHIFT_LOG) return process.env.NIGHTSHIFT_LOG;
  const local = path.join(root, '.nightshift');
  // Under a global install, honor a local .nightshift/ ONLY for the nightshift
  // repo itself (where this script lives) — a stray one elsewhere would point the
  // board at a log it never serves. Without a global install, the local dir is the
  // attach.js use case. Mirrors resolveLog() in hooks/agent-hook.js.
  const self = path.resolve(root) === path.resolve(__dirname, '..');
  if (fs.existsSync(local) && (self || !installRepo())) {
    return path.join(local, 'events.jsonl');
  }
  const slug = root.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '-') || 'session';
  return path.join(home, 'sessions', `${slug}.jsonl`);
}

process.stdout.write(resolve() + '\n');
