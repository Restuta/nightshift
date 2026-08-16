// Pure projection: /preflight runs derived from the tape. No new event type and
// no new producer — a preflight run already leaves deterministic traces:
//
//   1. a turn card titled "/preflight …" (promptTitle extracts the slash command
//      for Claude; Codex prompts carry the literal text), or an explicit
//      `work_phase {phase:"preflight"}` lane when a producer emits one;
//   2. `todos` snapshots whose steps are the skill's own task list — subjects
//      tagged "Phase N: …" (the canonical 7-phase pipeline);
//   3. `pr_ref`/`pr`/`ci` events attributed to the run's card.
//
// Because it is a pure function of (events, untilT), old tapes gain the panel
// retroactively and replay scrubs through a run's phases honestly.

// Exactly /preflight — prefixed cousins (/design-preflight, …) are different
// skills with different stages; opening a run for them would report a phase-less
// "incomplete" verdict on a gate this model doesn't understand.
const RUN_TITLE = /(^|\s)\/preflight\b/i;
const PHASE_STEP = /^Phase\s+(\d+)\s*[:.\-]\s*(.*)$/i;

export const PREFLIGHT_PHASES = 7; // the canonical pipeline depth (PF-00..PF-63)

function newRun(id, t, source) {
  return {
    id,                 // the owning item id (turn card) or work_phase runId
    source,             // 'item' | 'work_phase'
    startT: t,
    endT: null,
    status: 'running',  // running | done | abandoned
    outcome: null,      // pass | incomplete | null (unknown)
    phases: new Map(),  // phase number → {n, steps: Map(text → {status, at})}
    stepCount: 0,
    pr: null,           // linked PR number
    ci: null,           // latest ci status seen during the run
    lastAt: t,
  };
}

function phaseOf(run, n) {
  let ph = run.phases.get(n);
  if (!ph) { ph = { n, steps: new Map() }; run.phases.set(n, ph); }
  return ph;
}

function foldSteps(run, ev) {
  for (const td of ev.todos || []) {
    const m = PHASE_STEP.exec(String(td.text || '').trim());
    if (!m) continue;
    const n = Number(m[1]);
    if (!(n >= 1 && n <= 12)) continue; // sanity: phase numbers, not years
    const status = td.status || (td.done ? 'completed' : 'pending');
    const ph = phaseOf(run, n);
    const prev = ph.steps.get(m[2]);
    if (!prev || prev.status !== status) ph.steps.set(m[2], { status, at: ev.t });
    run.lastAt = ev.t;
  }
  run.stepCount = [...run.phases.values()].reduce((sum, ph) => sum + ph.steps.size, 0);
}

// A phase's status folds from its steps: completed when every step is, active
// when any is in_progress, else pending (partially-completed counts active —
// work in the phase has begun).
function phaseStatus(ph) {
  const steps = [...ph.steps.values()];
  if (steps.length && steps.every(s => s.status === 'completed')) return 'completed';
  if (steps.some(s => s.status === 'in_progress')) return 'active';
  if (steps.some(s => s.status === 'completed')) return 'active';
  return 'pending';
}

function closeRun(run, t) {
  if (run.status !== 'running') return;
  run.status = 'done';
  run.endT = t;
  const phases = [...run.phases.values()];
  run.outcome = phases.length && phases.every(ph => phaseStatus(ph) === 'completed')
    ? 'pass' : 'incomplete';
}

// The public shape: plain data, render-ready, no Maps.
function publicRun(run, seq) {
  const phases = [...run.phases.values()].sort((a, b) => a.n - b.n).map(ph => ({
    n: ph.n,
    status: phaseStatus(ph),
    steps: [...ph.steps.entries()].map(([text, s]) => ({ text, status: s.status })),
  }));
  const active = phases.find(ph => ph.status === 'active');
  const completed = phases.filter(ph => ph.status === 'completed').length;
  return {
    id: run.id,
    seq,                              // 1-based run number within the session
    startT: run.startT,
    endT: run.endT,
    status: run.status,
    outcome: run.outcome,
    phases,
    phaseTotal: Math.max(PREFLIGHT_PHASES, phases.length ? phases[phases.length - 1].n : 0),
    phasesCompleted: completed,
    activePhase: active ? active.n : null,
    activeStep: active
      ? (active.steps.find(s => s.status === 'in_progress') || active.steps.find(s => s.status !== 'completed') || null)
      : null,
    pr: run.pr,
    ci: run.ci,
    durMs: (run.endT != null ? run.endT : run.lastAt) - run.startT,
  };
}

// Derive every preflight run visible in `events` up to `untilT`. Consumers get
// runs oldest-first; the last one is the current/latest.
export function preflightRuns(events, untilT = Infinity) {
  const runs = [];            // in start order
  const byItem = new Map();   // item id → run (open or closed)
  const openByRunId = new Map(); // work_phase runId → run

  const openFor = ev => {
    // an attributed event joins its card's run; an unattributed one joins the
    // single open run (preflight runs don't overlap within one session's tape)
    if (ev.item && byItem.has(ev.item)) return byItem.get(ev.item);
    if (ev.item) return null;
    return runs.find(r => r.status === 'running') || null;
  };

  for (const ev of events) {
    if (!ev || ev.t > untilT) continue;
    switch (ev.type) {
      case 'item': {
        if (!ev.id) break;
        const known = byItem.get(ev.id);
        if (!known && ev.title && RUN_TITLE.test(ev.title)) {
          const run = newRun(ev.id, ev.t, 'item');
          byItem.set(ev.id, run);
          runs.push(run);
          if (ev.status === 'done') closeRun(run, ev.t); // degenerate but honest
        } else if (known && ev.status === 'done') {
          closeRun(known, ev.t);
        } else if (known && ev.status === 'doing' && known.status !== 'running') {
          known.status = 'running'; known.endT = null; known.outcome = null; // reopened
        }
        break;
      }
      case 'work_phase': {
        if (ev.phase !== 'preflight' || !ev.runId) break;
        if (ev.state === 'start' && !openByRunId.has(ev.runId)) {
          const run = newRun(ev.runId, ev.t, 'work_phase');
          openByRunId.set(ev.runId, run);
          if (ev.item) byItem.set(ev.item, run);
          runs.push(run);
        } else if (ev.state === 'end' && openByRunId.has(ev.runId)) {
          const run = openByRunId.get(ev.runId);
          closeRun(run, ev.t);
          if (ev.outcome) run.outcome = ev.outcome;
        }
        break;
      }
      case 'todos': {
        const run = openFor(ev);
        if (run && run.status === 'running') foldSteps(run, ev);
        break;
      }
      case 'pr_ref': {
        const run = openFor(ev);
        if (run && run.pr == null && ev.number != null) { run.pr = Number(ev.number); run.lastAt = ev.t; }
        break;
      }
      case 'pr': {
        const run = ev.item && byItem.get(ev.item);
        if (run && run.pr == null && ev.number != null) run.pr = Number(ev.number);
        break;
      }
      case 'ci': {
        // ci events carry a PR number; attach to the run that owns that PR.
        const run = runs.find(r => r.pr != null && r.pr === ev.pr) || openFor(ev);
        if (run) { run.ci = ev.status; run.lastAt = ev.t; }
        break;
      }
      case 'session': {
        if (ev.phase === 'end') {
          for (const run of runs) {
            if (run.status === 'running') { run.status = 'abandoned'; run.endT = ev.t; }
          }
        }
        break;
      }
    }
  }
  return runs.map((run, i) => publicRun(run, i + 1));
}
