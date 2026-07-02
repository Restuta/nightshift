// Shared session labeling + freshness tiers. Extracted verbatim from app.js's
// sessionLabel so the board picker, the Fleet home page, and the server-side
// Fleet summary all name a tape the same way and agree on how fresh it is.
//
// Consumers:
//   - public/app.js         — the board's session picker (import swap)
//   - public/fleet.js       — the Fleet home rows
//   - public/fleet-summary.js — the server-side summary (dynamic-imported by
//                               the CommonJS server; folds each tape)

// What distinguishes a repo's parallel sessions is the WORKTREE — and that lives
// in the tape's filename (slug), NOT in the recorded cwd or title. A fleet of
// Codex agents all record cwd = the main repo and often share a generic title
// ("context-restore."), so labeling by title·cwd renders 15 identical rows.
// Label by the worktree suffix baked into the slug; append the title only when
// there's no worktree to tell tapes apart.
export function sessionLabel(s) {
  const slug = s.id.replace(/^Users-[^-]+-Projects-/, '') || s.id;
  const repo = s.cwd ? s.cwd.split('/').filter(Boolean).pop() : '';
  let label = slug;
  if (repo) {
    const i = slug.lastIndexOf(repo + '-');
    if (i >= 0) label = slug.slice(i + repo.length + 1); // the worktree tail
    else if (slug.endsWith(repo)) label = repo;          // the bare repo tape
  }
  const t = (s.title || '').trim();
  return (label === repo && t && t !== repo) ? `${repo} · ${t}` : label;
}

// live (<90s) / recent (<30m) / stale — the SAME thresholds as the board
// picker's dot (see app.js sessionMark). Kept here so the Fleet honesty dot and
// the picker dot never drift apart.
export const FRESH_LIVE_MS = 90e3;
export const FRESH_RECENT_MS = 30 * 60e3;

export function freshness(lastT, now) {
  const age = now - (lastT || 0);
  if (age < FRESH_LIVE_MS) return 'live';
  if (age < FRESH_RECENT_MS) return 'recent';
  return 'stale';
}
