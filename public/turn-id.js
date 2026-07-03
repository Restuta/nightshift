// Shared, zero-dep helpers for turn-card ids — the board (app.js), the graph
// (graph-model.js node-exclusion + graph.js tooltips), and the tests all read from
// here. No DOM and no imports, so it is equally safe in a browser module and a
// Node test.
//
// Turn cards are synthesized one-per-prompt by the recorders (hooks/agent-hook.js
// and tools/codex-tail.js full mode). Their ids are NAMESPACED by the producing
// session — `turn-<sid8>-<n>`, where sid8 = the first 8 hex chars of that session's
// id — so two recorders legitimately sharing one tape (two rollouts of one
// project, allowed by the rollout-keyed lock) mint distinct ids and never collide
// on `turn-3` (one worker's retire closing the other's live card). The counter `n`
// stays per-session; the sid8 namespace is what makes the collision impossible.
// Legacy tapes carry un-namespaced `turn-<n>` ids; those stay valid forever and
// render unchanged. (The producers inline the same `sid8` one-liner — they are
// CommonJS and can't import this ES module without a build step.)

// sid8 for a session id: its first 8 hex chars, lowercased. The namespace the
// producers stamp into every turn-card id.
export function sid8(sessionId) {
  return String(sessionId || '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 8);
}

// Matches BOTH turn-card id shapes — legacy `turn-<n>` and namespaced
// `turn-<sid8>-<n>` — so the /graph view keeps chat-turn cards OUT of its node
// canvas (they are prompts, never entities) for old and new tapes alike.
export const TURN_RE = /^turn-(?:[0-9a-f]{8}-)?\d+$/;

// True for any turn-card id (namespaced or legacy).
export function isTurnId(id) { return TURN_RE.test(id || ''); }

// Short human label for a turn-card id. A namespaced `turn-<sid8>-<n>` renders as
// `turn <n>` — the sid8 is plumbing (collision avoidance), noise to a reader. A
// legacy `turn-<n>`, and any non-turn id, is returned UNCHANGED so old tapes and
// real work-item ids look exactly as before.
const NS_TURN_RE = /^turn-[0-9a-f]{8}-(\d+)$/;
export function turnLabel(id) {
  const m = NS_TURN_RE.exec(id || '');
  return m ? `turn ${m[1]}` : (id || '');
}
