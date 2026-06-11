#!/usr/bin/env node
// Synthesizes a realistic session log: traceboard building itself over ~48
// minutes, ending moments ago. Used by `npm run demo` and for UI work — the
// story exercises every event type, all four columns, a CI failure, and a
// mid-flight inbox card from the human.

const fs = require('fs');
const path = require('path');

const MIN = 60e3;
const TOTAL = 48 * MIN;
const base = Date.now() - TOTAL - 40e3; // tape ends ~40s ago

const events = [];
const e = (min, ev) => events.push({ t: Math.round(base + min * MIN), ...ev });

// --- t+0 — session opens, plan goes up
e(0.0, { type: 'session', phase: 'start', title: 'building traceboard', cwd: '/Users/restuta/Projects/ai/experiments/traceboard' });
e(0.4, { type: 'note', text: 'Plan: schema → server → UI → replay. Board watches itself from here.' });
e(0.6, { type: 'item', id: 'wi-schema', title: 'Event schema + pure reducer', status: 'doing' });
e(0.7, { type: 'item', id: 'wi-server', title: 'Zero-dep SSE tail server', status: 'inbox' });
e(0.8, { type: 'item', id: 'wi-ui', title: 'Kanban board UI', status: 'inbox' });
e(0.9, { type: 'item', id: 'wi-replay', title: 'Replay timeline + scrubber', status: 'inbox' });
e(1.0, { type: 'item', id: 'wi-import', title: 'Transcript importer — attach to any past session', status: 'inbox' });

// --- schema + reducer
e(1.4, { type: 'todos', todos: [
  { text: 'define event envelope + types', done: false },
  { text: 'attribution heuristic for unattributed events', done: false },
  { text: 'pure fold(events, t)', done: false },
] });
e(2.1, { type: 'edit', path: 'docs/EVENTS.md' });
e(4.3, { type: 'edit', path: 'docs/EVENTS.md' });
e(5.8, { type: 'commit', sha: 'a3f81c2', message: 'docs: event vocabulary v0', add: 96, del: 0, files: 1 });
e(6.0, { type: 'todos', todos: [
  { text: 'define event envelope + types', done: true },
  { text: 'attribution heuristic for unattributed events', done: false },
  { text: 'pure fold(events, t)', done: false },
] });
e(6.8, { type: 'edit', path: 'public/reducer.js' });
e(8.2, { type: 'edit', path: 'public/reducer.js' });
e(9.0, { type: 'commit', sha: 'b7d20e9', message: 'ui: pure reducer over event log', add: 214, del: 12, files: 2 });
e(9.2, { type: 'todos', todos: [
  { text: 'define event envelope + types', done: true },
  { text: 'attribution heuristic for unattributed events', done: true },
  { text: 'pure fold(events, t)', done: true },
] });
e(9.4, { type: 'item', id: 'wi-schema', status: 'done' });

// --- server
e(9.6, { type: 'item', id: 'wi-server', status: 'doing' });
e(9.8, { type: 'todos', todos: [
  { text: 'static serving + SSE endpoint', done: false },
  { text: 'tail log by byte offset', done: false },
  { text: 'POST /event append', done: false },
] });
e(10.5, { type: 'edit', path: 'server.js' });
e(12.1, { type: 'edit', path: 'server.js' });
e(13.6, { type: 'edit', path: 'server.js' });
e(14.0, { type: 'commit', sha: 'c91a4d7', message: 'server: zero-dep static + SSE tail', add: 187, del: 0, files: 1 });
e(15.2, { type: 'note', text: 'fs.watch unreliable across editors — added 300ms polling fallback alongside it.' });
e(15.9, { type: 'edit', path: 'server.js' });
e(16.3, { type: 'commit', sha: 'd44e0b1', message: 'server: polling fallback for fs.watch', add: 24, del: 6, files: 1 });
e(17.0, { type: 'pr', number: 1, title: 'foundation: schema, reducer, SSE server', state: 'open', url: 'https://github.com/Restuta/traceboard/pull/1' });
e(17.2, { type: 'ci', pr: 1, status: 'pending' });
e(19.1, { type: 'ci', pr: 1, status: 'pass' });
e(20.0, { type: 'pr', number: 1, state: 'merged' });

// --- the board itself
e(20.3, { type: 'item', id: 'wi-ui', status: 'doing' });
e(20.5, { type: 'todos', todos: [
  { text: 'masthead instruments + tickers', done: false },
  { text: 'four columns, keyed cards', done: false },
  { text: 'FLIP transitions between columns', done: false },
  { text: 'activity tape', done: false },
] });
e(21.4, { type: 'edit', path: 'public/index.html' });
e(22.8, { type: 'edit', path: 'public/style.css' });
e(24.0, { type: 'commit', sha: 'e58c3aa', message: 'ui: board columns + cards', add: 342, del: 18, files: 3 });
e(24.2, { type: 'todos', todos: [
  { text: 'masthead instruments + tickers', done: true },
  { text: 'four columns, keyed cards', done: true },
  { text: 'FLIP transitions between columns', done: false },
  { text: 'activity tape', done: false },
] });
e(25.5, { type: 'edit', path: 'public/app.js' });
e(27.1, { type: 'edit', path: 'public/app.js' });
e(28.0, { type: 'commit', sha: 'f02b9c4', message: 'ui: FLIP transitions + number tickers', add: 156, del: 41, files: 1 });
e(30.6, { type: 'note', text: 'FLIP: capture rects, mutate DOM, invert, play — 60fps with 50 cards.' });
e(31.5, { type: 'edit', path: 'public/style.css' });
e(32.2, { type: 'edit', path: 'public/app.js' });
e(33.0, { type: 'commit', sha: '0a17de8', message: 'ui: activity tape + instruments header', add: 203, del: 67, files: 2 });
e(33.2, { type: 'todos', todos: [
  { text: 'masthead instruments + tickers', done: true },
  { text: 'four columns, keyed cards', done: true },
  { text: 'FLIP transitions between columns', done: true },
  { text: 'activity tape', done: true },
] });
e(34.8, { type: 'pr', number: 2, title: 'kanban board UI', state: 'open', url: 'https://github.com/Restuta/traceboard/pull/2' });
e(35.0, { type: 'ci', pr: 2, status: 'pending' });
e(36.4, { type: 'ci', pr: 2, status: 'fail' });
e(36.6, { type: 'note', text: 'CI red: stylelint — custom property typo. Fixing.' });
e(37.6, { type: 'edit', path: 'public/style.css' });
e(38.0, { type: 'commit', sha: '1c93f5e', message: 'ui: fix custom property name', add: 4, del: 4, files: 1 });
e(38.2, { type: 'ci', pr: 2, status: 'pending' });
e(39.6, { type: 'ci', pr: 2, status: 'pass' });
e(40.8, { type: 'pr', number: 2, state: 'merged' });

// --- replay engine
e(41.0, { type: 'item', id: 'wi-replay', status: 'doing' });
e(41.2, { type: 'todos', todos: [
  { text: 'virtual clock + fold(log, t)', done: false },
  { text: 'timeline canvas, density buckets', done: false },
  { text: 'scrub + play at 1×/10×/60×', done: false },
] });
e(42.0, { type: 'edit', path: 'public/app.js' });
e(43.1, { type: 'edit', path: 'public/app.js' });
e(44.0, { type: 'commit', sha: '2ef66a0', message: 'ui: replay engine — fold log to t', add: 118, del: 9, files: 1 });
e(44.2, { type: 'todos', todos: [
  { text: 'virtual clock + fold(log, t)', done: true },
  { text: 'timeline canvas, density buckets', done: false },
  { text: 'scrub + play at 1×/10×/60×', done: false },
] });
e(45.0, { type: 'edit', path: 'public/app.js' });
e(45.9, { type: 'edit', path: 'public/style.css' });
e(46.3, { type: 'commit', sha: '3d05b77', message: 'ui: timeline canvas + scrubber', add: 176, del: 22, files: 2 });

// --- human drops a card mid-flight (the bidirectional moment)
e(46.8, { type: 'item', id: 'wi-churn', title: 'Churn heatmap — flag add/delete/re-add loops', status: 'inbox' });

e(47.3, { type: 'note', text: 'Replay at 60× reads like a time-lapse of the session. Demo-ready.' });
e(47.6, { type: 'todos', todos: [
  { text: 'virtual clock + fold(log, t)', done: true },
  { text: 'timeline canvas, density buckets', done: true },
  { text: 'scrub + play at 1×/10×/60×', done: true },
] });
e(47.8, { type: 'session', phase: 'idle' });

const out = path.join(__dirname, 'events.jsonl');
fs.writeFileSync(out, events.map(ev => JSON.stringify(ev)).join('\n') + '\n');
console.log(`wrote ${events.length} events → ${out}`);
