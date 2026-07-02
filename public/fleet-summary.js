// Fleet summary builder — folds ONE tape into the row Fleet home shows.
//
// It reuses public/reducer.js's fold (so every number matches the board exactly)
// and public/session-label.js's sessionLabel (so a tape has the same name on the
// picker and on Fleet home). Imported by:
//   - test/fleet-summary.test.mjs (direct, ESM)
//   - server.js (dynamic import — the CommonJS board server serves /api/fleet)
//
// PURE: no I/O, no Date.now(). The expensive fold is time-independent and lives
// in summarizeBase() (cacheable by the server); the two facts that depend on the
// wall clock — freshness and "merged in the last 24h" — are applied cheaply by
// applyNow(base, now). That split is what lets the server cache a fold by
// (size, mtime) yet still flip a tape from live→stale as time passes with no new
// events (a dead recorder writes nothing, so its file never changes).

import { fold, prList } from './reducer.js';
import { sessionLabel, freshness } from './session-label.js';

const DAY_MS = 24 * 3600e3;
const SAY_CAP = 240; // keep the lastSay snippet payload small; CSS clamps display

// The time-independent half: the fold and everything derived from it. Returns a
// `mergedAts` array (internal) that applyNow() turns into a 24h count.
export function summarizeBase(events, { id } = {}) {
  // Fold time-ordered even if the tape was recorded out of order (equal t keeps
  // file order — Array.sort is stable), matching the board's own load path.
  const evs = events.slice().sort((a, b) => (a.t || 0) - (b.t || 0));
  const state = fold(evs);
  const s = state.session;

  const firstT = evs.length ? evs[0].t : 0;
  const lastEventAt = evs.length ? evs[evs.length - 1].t : 0;
  const startedAt = s.startedAt ?? firstT;

  let cardsDoing = 0, cardsDone = 0;
  for (const it of state.items.values()) {
    if (it.status === 'doing') cardsDoing++;
    else if (it.status === 'done') cardsDone++;
  }

  let openPRs = 0, mergedPRs = 0, failingCI = 0;
  const mergedAts = [];
  for (const pr of prList(state)) {
    if (pr.state === 'open') openPRs++;
    else if (pr.state === 'merged') {
      mergedPRs++;
      if (pr.mergedAt != null) mergedAts.push(pr.mergedAt);
    }
    if (pr.ci === 'fail') failingCI++;
  }

  // needsInput: an `attention` phase that was never resolved by the tape's end.
  // The reducer clears attention on any subsequent activity (awake()), so a
  // trailing `attention` phase means the agent is genuinely still blocked on you.
  const needsInput = s.phase === 'attention';
  const lastSay = s.lastSay ? String(s.lastSay).slice(0, SAY_CAP) : null;

  return {
    id,
    label: sessionLabel({ id, cwd: s.cwd, title: s.title }),
    title: s.title || null,
    agent: s.agent || null,
    cwd: s.cwd || null,
    phase: s.phase || null,
    lastEventAt,
    span: Math.max(0, lastEventAt - startedAt),
    needsInput,
    needsInputText: needsInput ? (s.attentionText || '') : null,
    lastSay,
    openPRs,
    mergedPRs,
    failingCI,
    cardsDoing,
    cardsDone,
    cost: state.totals.cost,
    events: state.totals.events,
    mergedAts, // internal — dropped by applyNow
  };
}

// The wall-clock half: freshness tier + merged-in-last-24h, applied per request.
export function applyNow(base, now = Date.now()) {
  const { mergedAts = [], ...rest } = base;
  return {
    ...rest,
    freshness: freshness(base.lastEventAt, now),
    mergedRecent: mergedAts.filter(t => now - t <= DAY_MS).length,
  };
}

// Convenience for tests / one-shot callers: fold + apply in one step.
export function summarize(events, opts = {}) {
  return applyNow(summarizeBase(events, opts), opts.now);
}
