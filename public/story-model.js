// Pure layout derivations for /story, on top of the digest (public/digest.js).
// buildDigest gives the facts — chapters + idle gaps; this module decides the
// page's SEQUENCE: which chapters collapse into beat runs, where the "⏸ idle"
// separators sit, and where a new local day starts. No DOM, no Date.now — every
// timestamp is a recorded fact, so the same tape always yields the same blocks
// (scrubber parity with the board).

export const SEPARATOR_GAP_MS = 30 * 60 * 1000; // idle worth a visible pause line

// Local calendar day of a recorded timestamp. Deterministic given the viewer's
// timezone — the same convention as lanes-model.dayBoundaries, so /story and
// /lanes never disagree about which midnight a chapter crossed.
export function dayKey(t) {
  const d = new Date(t);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// The wall-clock strip's fill: the complement of the idle gaps within
// [startT, endT]. Each segment is a burst of producer activity; gaps are
// assumed sorted and non-overlapping (digest builds them from sorted events).
export function activeSegments(startT, endT, gaps = []) {
  const segs = [];
  let cur = startT;
  for (const g of gaps) {
    if (g.fromT > cur) segs.push({ fromT: cur, toT: g.fromT });
    if (g.toT > cur) cur = g.toT;
  }
  if (endT > cur) segs.push({ fromT: cur, toT: endT });
  return segs;
}

// Fold digest chapters + gaps into the render sequence. Returns blocks in page
// order, each one of:
//   { kind: 'day',     t }                        — a chapter starts a new local day
//   { kind: 'gap',     fromT, toT, ms, count }    — ≥30min of idle (count = merged gaps)
//   { kind: 'episode', chapter }                  — a full chapter card
//   { kind: 'beats',   chapters: [...] }          — a run of consecutive beat chapters
//
// Gap placement: a chapter's window runs to the NEXT prompt, so the silence
// before that prompt — and any stray reconcile events after it — land INSIDE the
// previous chapter's window. Seam math (next.startT − prev.endT) therefore hides
// most real idle (on the reference tape: 11 of 13 big gaps). Instead each big
// gap is attributed to the chapter whose span it BEGAN in and rendered after
// that chapter's card: "worked… ⏸ 9.1h idle… next prompt", which is the honest
// narrative order. Multiple big gaps inside one chapter merge into one
// separator (summed, count carries how many).
export function buildStoryBlocks(chapters, gaps = [], gapMs = SEPARATOR_GAP_MS) {
  const blocks = [];
  if (!chapters || !chapters.length) return blocks;

  // afterGap.get(i) = the merged idle separator to render after chapters[i]
  // (i === -1 → before the first chapter; defensive, digest shouldn't produce it).
  const afterGap = new Map();
  for (const g of gaps) {
    if (!(g.ms >= gapMs)) continue;
    let i = -1;
    while (i + 1 < chapters.length && chapters[i + 1].startT <= g.fromT) i++;
    const cur = afterGap.get(i);
    if (cur) {
      cur.ms += g.ms;
      cur.toT = Math.max(cur.toT, g.toT);
      cur.count++;
    } else {
      afterGap.set(i, { fromT: g.fromT, toT: g.toT, ms: g.ms, count: 1 });
    }
  }

  // A day rule marks every chapter that starts on a new local day; on a
  // multi-day tape the FIRST chapter gets one too, so day 1 isn't the only
  // unlabeled day on the page.
  const multiDay = chapters.some(ch => dayKey(ch.startT) !== dayKey(chapters[0].startT));

  let run = null;      // the open beat run, if any — separators close it
  let prevDay = null;
  const pushGap = i => {
    const g = afterGap.get(i);
    if (g) { blocks.push({ kind: 'gap', ...g }); run = null; }
  };

  pushGap(-1);
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const day = dayKey(ch.startT);
    if ((prevDay == null && multiDay) || (prevDay != null && day !== prevDay)) {
      blocks.push({ kind: 'day', t: ch.startT });
      run = null;
    }
    prevDay = day;
    if (ch.kind === 'beat') {
      if (!run) { run = { kind: 'beats', chapters: [] }; blocks.push(run); }
      run.chapters.push(ch);
    } else {
      run = null;
      blocks.push({ kind: 'episode', chapter: ch });
    }
    pushGap(i);
  }
  return blocks;
}
