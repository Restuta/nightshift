// Pure layout derivations for /story, on top of the digest (public/digest.js).
// buildDigest gives the facts — chapters + idle gaps; this module decides the
// page's SEQUENCE: which chapters collapse into beat runs, where the "⏸ idle"
// separators sit, and where a new local day starts. No DOM, no Date.now — every
// timestamp is a recorded fact, so the same tape always yields the same blocks
// (scrubber parity with the board).

import { buildSessionDisposition } from './session-disposition.js';

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

const PHASE_CATEGORIES = ['coding', 'testing', 'preflight', 'other', 'waiting', 'idle', 'unknown'];

function effectivePrState(pr) {
  return pr.current?.state ?? pr.recorded?.state ?? 'unknown';
}

function titleForPr(pr) {
  return pr.current?.title ?? pr.recorded?.title ?? pr.title ?? '';
}

function milestoneForPr(pr, recordedMilestone = null) {
  const explicit = recordedMilestone ?? pr.recorded?.milestone ?? pr.discovery?.milestone ?? pr.milestone;
  if (typeof explicit !== 'string' || !explicit.trim()) {
    return {
      label: 'Unassigned',
      classification: 'unassigned',
      confidence: 'No explicit milestone attribution recorded; title is not treated as authority',
    };
  }
  const label = explicit.trim();
  return {
    label,
    classification: /^plan$/i.test(label) ? 'plan' : 'feature',
    confidence: 'Explicit recorded milestone attribution',
  };
}

function truthLine(label, truth) {
  if (!truth) return `${label}: unavailable`;
  const parts = [truth.state ?? 'state unknown', `gates ${truth.validation ?? 'unknown'}`];
  if ((truth.advisoryRunning ?? 0) > 0) {
    const count = truth.advisoryRunning;
    parts.push(`${count} ${count === 1 ? 'advisory' : 'advisories'} running`);
  }
  return `${label}: ${parts.join(' · ')}`;
}

function topologyLine(label, truth) {
  if (!truth) return `${label} parent: unavailable`;
  return `${label} parent: ${Number.isFinite(truth.base) ? `#${truth.base}` : 'root'}`;
}

function snapshotChanged(pr) {
  if (!pr.recorded || !pr.current) return pr.recorded !== pr.current;
  return ['state', 'validation', 'advisoryRunning', 'base']
    .some(field => pr.recorded[field] !== pr.current[field]);
}

function provenanceForPr(pr) {
  const discovery = pr.discovery ?? {};
  if (discovery.kind === 'recovered') {
    const origin = discovery.recovery === 'transcript' ? 'transcript' : (discovery.recovery ?? 'recovery evidence');
    return `Recovered from ${origin}${pr.current ? ' · current GitHub reconciled' : ''}`;
  }
  if (discovery.kind === 'authoritative') {
    return `Authoritative discovery via ${discovery.source ?? 'GitHub'}${pr.current ? ' · recorded tape and current GitHub' : ' · recorded tape'}`;
  }
  return `Observed reference via ${discovery.source ?? 'recorded tape'}`;
}

function buildPrReport(pr, recordedMilestone) {
  const milestone = milestoneForPr(pr, recordedMilestone);
  return {
    key: pr.key,
    number: pr.number,
    title: titleForPr(pr),
    url: pr.current?.url ?? pr.recorded?.url ?? pr.url ?? null,
    milestone: milestone.label,
    milestoneClassification: milestone.classification,
    milestoneConfidence: milestone.confidence,
    progress: milestone.classification === 'unassigned'
      ? 'PR contribution not explicitly attributed'
      : 'Explicit milestone attribution recorded',
    state: effectivePrState(pr),
    recordedTruth: truthLine('Recorded', pr.recorded),
    currentTruth: truthLine('Current', pr.current),
    recordedTopology: topologyLine('Recorded', pr.recorded),
    currentTopology: topologyLine('Current', pr.current),
    changedSinceRecording: snapshotChanged(pr),
    provenance: provenanceForPr(pr),
    confidence: pr.discovery?.kind === 'recovered'
      ? 'Recovered reference; current state authoritative when available'
      : 'Authoritative GitHub facts',
    occurredAt: pr.recorded?.occurredAt ?? pr.recorded?.createdAt
      ?? pr.current?.occurredAt ?? pr.current?.createdAt ?? null,
    observedAt: pr.discovery?.observedAt ?? null,
    recordedAt: pr.discovery?.recordedAt ?? null,
    recordedPrAt: pr.recorded?.prAt ?? null,
    currentPrAt: pr.current?.prAt ?? null,
    currentFetchedAt: pr.current?.fetchedAt ?? null,
    replayT: pr.discovery?.observedAt ?? pr.recorded?.prAt ?? pr.current?.prAt ?? null,
    evidenceEventIds: [...new Set(pr.evidenceEventIds ?? [])],
  };
}

function roadmapMilestones(assessmentText) {
  const text = String(assessmentText ?? '');
  return [
    { label: 'M1', progress: /milestone 1 complete/i.test(text) ? 'complete' : 'not assessed' },
    { label: 'M2', progress: /first slices? of milestones? 2 and 3 complete/i.test(text) ? 'first slice complete' : 'not assessed' },
    { label: 'M3', progress: /first slices? of milestones? 2 and 3 complete/i.test(text) ? 'first slice complete' : 'not assessed' },
    { label: 'M4–M7', progress: /milestones? 4 through 7 not started/i.test(text) ? 'not started' : 'not assessed' },
  ];
}

function phaseReports(insights) {
  return PHASE_CATEGORIES.map(category => {
    const spans = (insights.phases ?? []).filter(span => span.wallCategory === category);
    const confidenceCounts = { explicit: 0, strong: 0, heuristic: 0 };
    for (const span of spans) {
      if (confidenceCounts[span.confidence] != null) confidenceCounts[span.confidence] += 1;
    }
    const confidenceText = Object.entries(confidenceCounts)
      .filter(([, count]) => count > 0)
      .map(([confidence, count]) => `${count} ${confidence}`)
      .join(' · ') || 'No span evidence';
    return {
      category,
      durationMs: insights.phaseTotals?.byWallCategory?.[category] ?? 0,
      percent: insights.phaseTotals?.percentages?.[category] ?? 0,
      confidenceText,
      evidenceEventIds: [...new Set(spans.flatMap(span => span.evidenceEventIds ?? []))],
    };
  });
}

function longestIntervals(insights) {
  return ['waiting', 'unknown'].flatMap(category => {
    const longest = (insights.phases ?? [])
      .filter(span => span.wallCategory === category)
      .sort((a, b) => (b.endT - b.startT) - (a.endT - a.startT))[0];
    return longest ? [{
      category,
      label: `Longest ${category} interval`,
      startT: longest.startT,
      endT: longest.endT,
      durationMs: longest.endT - longest.startT,
      confidence: longest.confidence,
      evidenceEventIds: [...new Set(longest.evidenceEventIds ?? [])],
    }] : [];
  });
}

function recordedMilestoneForPr(pr, insights) {
  const recordedEnd = insights?.bounds?.recordedEnd;
  const evidenceIds = new Set([
    ...(pr.evidenceEventIds ?? []),
    ...(pr.discovery?.evidenceEventIds ?? []),
  ]);
  const matches = (insights?.visiblePrefix ?? []).filter(event => {
    if (!Number.isFinite(recordedEnd) || event.t > recordedEnd) return false;
    if (typeof event.milestone !== 'string' || !event.milestone.trim()) return false;
    if (event.id != null && evidenceIds.has(event.id)) return true;
    const number = event.number ?? event.pr ?? event.prNumber;
    return number === pr.number && event.repo != null && event.repo === pr.repo;
  });
  return matches.at(-1)?.milestone ?? null;
}

export function buildStoryReport(insights) {
  const roadmap = insights.roadmap ?? {};
  const prs = (insights.prStack?.prs ?? [])
    .map(pr => buildPrReport(pr, recordedMilestoneForPr(pr, insights)));
  const merged = prs.filter(pr => pr.state === 'merged').length;
  const prClassifications = {
    plan: prs.filter(pr => pr.milestoneClassification === 'plan').length,
    feature: prs.filter(pr => pr.milestoneClassification === 'feature').length,
    unassigned: prs.filter(pr => pr.milestoneClassification === 'unassigned').length,
  };
  const remaining = (roadmap.todos ?? [])
    .filter(todo => todo.done !== true && todo.status !== 'completed')
    .map(todo => todo.text)
    .filter(Boolean);
  const roadmapEvidence = [
    ...(roadmap.snapshot?.evidenceEventIds ?? []),
    roadmap.assessment?.id,
    ...(roadmap.staleEvidenceEventIds ?? []),
  ].filter(Boolean);
  const assessmentSource = roadmap.assessment?.source === 'recovery' ? 'recovered evidence' : 'recorded evidence';
  const classifiedCopy = [
    prClassifications.feature ? `${prClassifications.feature} feature ${prClassifications.feature === 1 ? 'slice' : 'slices'}` : null,
    prClassifications.plan ? `${prClassifications.plan} ${prClassifications.plan === 1 ? 'plan PR' : 'plan PRs'}` : null,
    prClassifications.unassigned ? `${prClassifications.unassigned} without explicit milestone attribution` : null,
  ].filter(Boolean).join(' · ');

  return {
    headline: `${prs.length} PRs opened · ${merged} merged${classifiedCopy ? ` · ${classifiedCopy}` : ''}`,
    prClassifications,
    checklist: {
      label: `Session checklist: ${roadmap.completed ?? 0}/${roadmap.total ?? 0}`,
      remaining,
      evidenceEventIds: [...new Set(roadmap.snapshot?.evidenceEventIds ?? [])],
    },
    roadmap: {
      label: `Product roadmap: ${roadmap.assessment?.value ?? 'not assessed'}`,
      milestones: roadmapMilestones(roadmap.assessment?.text),
      assessmentText: roadmap.assessment?.text ?? 'No explicit roadmap assessment recorded',
      assessmentConfidence: `Agent assessment · ${assessmentSource}`,
      staleSnapshot: roadmap.staleSnapshot === true,
      staleWarning: roadmap.staleSnapshot
        ? 'The checklist snapshot is stale: a later agent assessment supersedes its capture time without rewriting the recorded checklist.'
        : null,
      evidenceEventIds: [...new Set(roadmapEvidence)],
    },
    disposition: buildSessionDisposition(insights),
    phases: phaseReports(insights),
    intervals: longestIntervals(insights),
    prs,
  };
}

export function buildStoryNarrativeEvents(insights) {
  const recordedEnd = insights?.bounds?.recordedEnd;
  if (!Number.isFinite(recordedEnd)) return [];
  return (insights.visiblePrefix ?? []).filter(event => event.t <= recordedEnd);
}

function unattachedBlock(insights) {
  const gaps = insights?.attributionGaps ?? [];
  if (!gaps.length) return null;
  const canonicalPrs = new Map((insights.prStack?.prs ?? []).map(pr => [pr.key, pr]));
  const prs = gaps.filter(gap => gap.kind === 'pr').map(gap => canonicalPrs.get(gap.key)).filter(Boolean)
    .map(pr => ({
      key: pr.key,
      number: pr.number,
      title: pr.recorded?.title ?? (pr.discovery?.kind === 'recovered' ? 'Recovered pull request' : 'Untitled pull request'),
      url: pr.recorded?.url ?? pr.url ?? null,
      state: pr.recorded?.state ?? 'observed',
      replayT: pr.discovery?.observedAt ?? pr.recorded?.prAt ?? null,
      provenance: provenanceForPr({ ...pr, current: null }),
      confidence: pr.discovery?.kind === 'recovered' ? 'Recovered reference' : 'Recorded artifact',
      evidenceEventIds: [...new Set([
        ...(pr.discovery?.evidenceEventIds ?? []),
        ...(pr.recorded?.evidenceEventIds ?? []),
      ])],
    }));
  const activity = gaps.filter(gap => gap.kind === 'producer').map(gap => ({ ...gap }));
  return {
    kind: 'unattached',
    title: 'Unattached activity',
    prs,
    activity,
    confidence: 'Recorded artifacts · chapter attribution unavailable',
    evidenceEventIds: [...new Set(gaps.flatMap(gap => gap.evidenceEventIds ?? []))],
  };
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
export function buildStoryBlocks(chapters, gaps = [], insights = null, gapMs = SEPARATOR_GAP_MS) {
  const blocks = [];
  if (!chapters || !chapters.length) {
    const unattached = unattachedBlock(insights);
    return unattached ? [unattached] : blocks;
  }

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
  const unattached = unattachedBlock(insights);
  if (unattached) blocks.push(unattached);
  return blocks;
}
