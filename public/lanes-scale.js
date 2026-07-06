// A pure, invertible, piecewise-linear time axis for the /lanes timeline. The
// problem it solves: a real session spans ~64h wall but only ~11h of that is
// activity — long idle gaps eat most of a linear x-axis, so you can't see how the
// work progressed. This warps time into a "compressed" coordinate where active
// spans keep their real proportions (1 unit = 1 ms) and each idle gap collapses
// to a fixed, quiet sliver. Linear mode is just this same mapping with zero gaps,
// so the view has exactly ONE code path.
//
// Zero deps, no DOM: buildScale(gaps, t0, t1) returns { x(t), t(x), ... } — pure
// data + functions of its inputs, exactly like the reducer and lanes model. The
// returned units are "ms-equivalent": active time contributes its real ms, and a
// collapsed gap contributes a fixed `gapUnits` no matter how long it really was.

export const MIN_GAP_MS = 10 * 60 * 1000; // only silences wider than this collapse

// Target share of the full-fit axis a single collapsed gap occupies. Chosen so a
// gap reads as a quiet fixed-ish sliver (~24-32px on a wide plot) while the real
// active hours keep the rest of the pixels. It's a fraction (not raw px) so the
// module stays pure — it can't see the canvas width — yet renders consistently:
// gap width / active width is resolution-independent, so both scale together.
export const GAP_TARGET_FRAC = 0.018;

// Build the scale. `gaps` is a list of {fromT,toT} silences to consider collapsing
// (the digest's gaps, plus any tape-edge idle). Only gaps wider than the threshold
// actually collapse; the rest stay linear. t0/t1 are the axis bounds (the full
// tape span — the SAME in both modes, so linear mode looks exactly like today).
export function buildScale(gaps, t0, t1, opts = {}) {
  const minGapMs = opts.minGapMs != null ? opts.minGapMs : MIN_GAP_MS;
  const targetFrac = opts.gapFrac != null ? opts.gapFrac : GAP_TARGET_FRAC;
  const span = Math.max(0, t1 - t0);

  // 1) Normalize: clamp each gap into [t0,t1], drop ones at/under the threshold,
  //    sort by start, and union any overlaps so the segment list stays ordered
  //    and non-overlapping (digest gaps never overlap, but be defensive).
  const norm = [];
  for (const g of gaps || []) {
    if (!g) continue;
    const a = Math.max(t0, Math.min(t1, g.fromT));
    const b = Math.max(t0, Math.min(t1, g.toT));
    if (b - a > minGapMs) norm.push({ fromT: a, toT: b });
  }
  norm.sort((p, q) => p.fromT - q.fromT);
  const merged = [];
  for (const g of norm) {
    const last = merged[merged.length - 1];
    if (last && g.fromT <= last.toT) { if (g.toT > last.toT) last.toT = g.toT; }
    else merged.push({ fromT: g.fromT, toT: g.toT });
  }

  // 2) Real active time = the span minus the collapsed gaps' real durations.
  const gapRealMs = merged.reduce((s, g) => s + (g.toT - g.fromT), 0);
  const activeUnits = Math.max(0, span - gapRealMs);

  // 3) Per-gap slot in ms-equivalent units. Every collapsed gap gets the SAME slot
  //    regardless of its real length — that uniform width IS the "collapse". Sized
  //    from the active span + gap count so gaps take a bounded share of the axis
  //    (~targetFrac each) and the active hours dominate. Purely a function of the
  //    inputs, so round-tripping is deterministic.
  const n = merged.length;
  let gapUnits = 0;
  if (n > 0 && activeUnits > 0) {
    const denom = 1 - targetFrac * n;
    // Pathological gap count (denom too small) — cap total gap share at ~1/3.
    gapUnits = denom > 0.2 ? (targetFrac * activeUnits) / denom : (activeUnits * 0.5) / n;
  } else if (n > 0) {
    gapUnits = span / n; // all-gap tape: spread evenly, still finite & invertible
  }

  // 4) Walk t0→t1 laying down alternating active/gap segments in unit space.
  const segs = []; // {t0,t1,u0,u1,gap,ms}
  const renderGaps = [];
  let cursorT = t0, u = 0;
  const pushActive = (aT, bT) => {
    if (bT > aT) { segs.push({ t0: aT, t1: bT, u0: u, u1: u + (bT - aT), gap: false }); u += bT - aT; }
  };
  for (const g of merged) {
    pushActive(cursorT, g.fromT);
    const seg = { t0: g.fromT, t1: g.toT, u0: u, u1: u + gapUnits, gap: true, ms: g.toT - g.fromT };
    segs.push(seg); renderGaps.push(seg);
    u += gapUnits;
    cursorT = g.toT;
  }
  pushActive(cursorT, t1);
  if (!segs.length) segs.push({ t0, t1: t0, u0: 0, u1: 0, gap: false }); // t0 === t1
  const compressedSpan = u;

  // Binary search: the last segment starting at/before the query. Segments are
  // sorted and contiguous, so this is the one that contains it.
  const findByT = tt => {
    let lo = 0, hi = segs.length - 1, ans = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid].t0 <= tt) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return segs[ans];
  };
  const findByU = uu => {
    let lo = 0, hi = segs.length - 1, ans = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid].u0 <= uu) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return segs[ans];
  };

  // time → position (units). Clamped at the edges; linear within each segment.
  const x = tt => {
    if (tt <= t0) return 0;
    if (tt >= t1) return compressedSpan;
    const s = findByT(tt);
    if (s.t1 === s.t0) return s.u0;
    return s.u0 + ((tt - s.t0) / (s.t1 - s.t0)) * (s.u1 - s.u0);
  };
  // position (units) → time. Exact inverse of x inside every segment.
  const t = uu => {
    if (uu <= 0) return t0;
    if (uu >= compressedSpan) return t1;
    const s = findByU(uu);
    if (s.u1 === s.u0) return s.t0;
    return s.t0 + ((uu - s.u0) / (s.u1 - s.u0)) * (s.t1 - s.t0);
  };
  // The collapsed-gap segment covering a time, or null (used to skip grid ticks
  // that would pile up inside a sliver, and to place the "⏸" labels).
  const gapAt = tt => { const s = findByT(tt); return s && s.gap ? s : null; };

  return { x, t, gapAt, compressedSpan, gaps: renderGaps, segments: segs, t0, t1, gapUnits };
}
