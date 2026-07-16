// Canonical, pure session semantics shared by Board, Story, Lanes, and Graph.

export const ACTIVE_GAP_MS = 10 * 60 * 1000;

const WALL = ['coding', 'testing', 'preflight', 'other', 'waiting', 'idle', 'unknown'];
const PRODUCER = new Set(['say', 'tool', 'tool_call', 'edit', 'commit', 'todos', 'item', 'work_phase']);
const PASSIVE = new Set(['alive', 'usage', 'pr', 'pr_ref', 'ci']);
const SESSION_CLOSURES = new Set(['idle', 'attention', 'end']);
const TOOL_TERMINALS = new Set(['success', 'failure', 'cancelled', 'unknown']);
const PR_AUTHORITY = new Set(['poll-github', 'emit', 'import', 'demo']);
const CONFIDENCE_PRIORITY = { heuristic: 1, strong: 2, explicit: 3 };
const PHASE_PRIORITY = { other: 1, testing: 2, coding: 3, preflight: 4 };
const KNOWLEDGE_FACT_TYPES = new Set(['pr', 'pr_ref', 'ci']);

function knowledgeT(event) {
  return Number.isFinite(event.recordedAt) ? event.recordedAt : event.t;
}

function visiblePrefix(events, untilT, knownByT = untilT) {
  const retractedEvents = new Set();
  const retractedItems = new Set();
  for (const e of events) {
    if (e.type !== 'retract') continue;
    if (e.target?.event) retractedEvents.add(e.target.event);
    if (e.target?.item) retractedItems.add(e.target.item);
  }
  return events.map((e, i) => ({ e, i }))
    .filter(({ e }) => Number.isFinite(e.t)
      && e.t <= untilT
      && knowledgeT(e) <= knownByT
      && e.type !== 'retract'
      && !retractedEvents.has(e.id)
      && !retractedItems.has(e.id)
      && !retractedItems.has(e.item))
    .sort((a, b) => a.e.t - b.e.t || a.i - b.i)
    .map(x => x.e);
}

function unionIntervals(intervals) {
  const sorted = intervals.filter(x => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const pair of sorted) {
    const last = out.at(-1);
    if (!last || pair[0] > last[1]) out.push([...pair]);
    else last[1] = Math.max(last[1], pair[1]);
  }
  return out;
}

function isPassive(e) {
  return PASSIVE.has(e.type) || e.source === 'poll-github' || e.source === 'server';
}

function isProducer(e) {
  return PRODUCER.has(e.type) && !isPassive(e);
}

function isNonResumingTerminal(e) {
  return (e.type === 'work_phase' && e.state === 'end')
    || (e.type === 'tool_call' && TOOL_TERMINALS.has(e.state));
}

function resumesDisposition(e) {
  return isProducer(e) && !isNonResumingTerminal(e);
}

function establishesRecordedBoundary(e) {
  return isProducer(e) || e.type === 'session' || e.type === 'notification';
}

function deriveBounds(prefix, displayNow) {
  const recorded = prefix.filter(establishesRecordedBoundary);
  const firstSession = prefix.find(e => e.type === 'session' && e.phase === 'start');
  const recordedStart = firstSession?.t ?? recorded[0]?.t ?? prefix[0]?.t ?? 0;
  const recordedEnd = Math.max(recordedStart, recorded.at(-1)?.t ?? recordedStart);
  const producers = prefix.filter(e => isProducer(e) && e.t >= recordedStart && e.t <= recordedEnd);
  return {
    recordedStart,
    recordedEnd,
    displayNow,
    producerStart: producers[0]?.t ?? null,
    producerEnd: producers.at(-1)?.t ?? null,
  };
}

function deriveLifecycle(prefix, bounds) {
  let session = 'open';
  let turn = 'complete';
  let nextActor = 'none';
  let inputRequest = 'none';
  let humanWaitStart = null;

  for (const e of prefix) {
    if (e.t < bounds.recordedStart || e.t > bounds.recordedEnd) continue;
    if (e.type === 'session') {
      if (e.phase === 'start' || e.phase === 'resume') {
        session = 'open';
        turn = 'working';
        nextActor = 'agent';
        inputRequest = 'none';
        humanWaitStart = null;
      } else if (e.phase === 'attention') {
        turn = 'complete';
        nextActor = 'human';
        inputRequest = 'question';
        humanWaitStart = e.t;
      } else if (e.phase === 'idle') {
        turn = 'complete';
        nextActor = 'none';
        inputRequest = 'none';
        humanWaitStart = null;
      } else if (e.phase === 'end') {
        session = 'ended';
        turn = 'complete';
        nextActor = 'none';
        inputRequest = 'none';
        humanWaitStart = null;
      }
      continue;
    }

    if (e.type === 'notification') {
      if (e.reason === 'permission' || e.reason === 'question') {
        turn = 'complete';
        nextActor = 'human';
        inputRequest = e.reason;
        humanWaitStart = e.t;
      } else if (e.reason === 'next_prompt') {
        turn = 'complete';
        nextActor = 'human';
        inputRequest = 'none';
        humanWaitStart = e.t;
      }
      continue;
    }

    if (resumesDisposition(e)) {
      turn = 'working';
      nextActor = 'agent';
      inputRequest = 'none';
      humanWaitStart = null;
    }
  }

  const freshnessT = bounds.producerEnd ?? bounds.recordedEnd;
  if (session === 'open' && turn === 'working' && bounds.displayNow - freshnessT > ACTIVE_GAP_MS) {
    session = 'recorder-stale';
  }

  return {
    session,
    turn,
    nextActor,
    inputRequest,
    humanWaitStart,
  };
}

function eventText(e) {
  return [
    e.text,
    e.title,
    e.message,
    e.command,
    e.skill,
    e.tool,
    e.input?.command,
    e.input?.text,
  ].filter(x => typeof x === 'string').join(' ').trim();
}

function isPreflightSkillRead(e, text) {
  return /(?:read|cat|sed|inspect|open|load)/i.test(text)
    && /(?:preflight|ship).*(?:skill\.md|skill)|(?:skill\.md|skill).*?(?:preflight|ship)/i.test(text);
}

function declaresPreflight(e, text) {
  if (e.declaredPhase === 'preflight' || e.intent === 'preflight' || e.phase === 'preflight') return true;
  if (isPreflightSkillRead(e, text)) return false;
  return /(?:^|\b)(?:run|running|start|starting|begin|beginning|execute|executing|perform|performing|invoke|invoking|enter|entering)\s+(?:the\s+)?\/?(?:[\w-]*preflight|ship)\b/i.test(text)
    || /^\s*\/(?:[\w-]*preflight|ship)(?:\s|$)/i.test(text);
}

function endsPreflight(text) {
  return /(?:preflight|ship)(?:\s+run)?\s+(?:complete|completed|done|finished|cancelled|failed)\b/i.test(text);
}

function isTestOrBuild(text) {
  return /(?:^|[\s:/_-])(?:test(?:s|ing)?|build|lint|typecheck|type-check|check-types|verify|validation)(?:\b|[\s:_-])/i.test(text)
    || /\b(?:npm|pnpm|yarn|bun|cargo|go)\s+(?:run\s+)?(?:test|build|lint|check)\b/i.test(text);
}

function isPrPublishing(text) {
  return /\bgh\s+pr\s+(?:create|edit)\b/i.test(text)
    || /\b(?:create|creating|open|opening|publish|publishing|write|writing|update|updating)\s+(?:the\s+)?(?:pull request|pr)(?:\s+description)?\b/i.test(text);
}

function preflightStage(text) {
  if (/\b(?:wait|waiting|await|awaiting)\b.*\b(?:ci|checks?|review|readiness)\b|\b(?:ci|checks?|review|readiness)\b.*\b(?:wait|waiting|pending)\b/i.test(text)) return 'readiness_wait';
  if (/\b(?:fix|fixing|repair|repairing|address|addressing)\b.*\b(?:ci|checks?|review|failure|readiness)\b/i.test(text)) return 'readiness_fix';
  if (/\b(?:visual(?:\s+qa)?|screenshot|browser\s+qa)\b/i.test(text)) return 'visual_qa';
  if (/\bself[- ]review\b/i.test(text)) return 'self_review';
  if (/\b(?:cross[- ]ai|second model|coderabbit|cross review|toast(?:\s+review)?)\b/i.test(text)) return 'cross_ai_review';
  if (isPrPublishing(text)) return 'publish_pr';
  if (isTestOrBuild(text)) return 'local_validation';
  return 'prepare';
}

function makeSpan(startT, endT, values) {
  return {
    startT,
    endT,
    phase: values.phase ?? 'other',
    stage: values.stage ?? null,
    disposition: values.disposition ?? 'active',
    wallCategory: values.wallCategory ?? values.phase ?? 'other',
    confidence: values.confidence ?? 'heuristic',
    source: values.source ?? 'inference',
    evidenceEventIds: [...new Set(values.evidenceEventIds ?? [])],
    _order: values._order ?? 0,
  };
}

function nextClosureT(prefix, after, recordedEnd) {
  for (let order = 0; order < prefix.length; order += 1) {
    const e = prefix[order];
    if (e.t < after.t || (e.t === after.t && order <= after.order)) continue;
    if ((e.type === 'session' && SESSION_CLOSURES.has(e.phase))
      || (e.type === 'notification' && ['next_prompt', 'permission', 'question'].includes(e.reason))) {
      return e.t;
    }
  }
  return recordedEnd;
}

function explicitWorkSpans(prefix, bounds) {
  const starts = new Map();
  const spans = [];
  prefix.forEach((e, order) => {
    if (e.type !== 'work_phase') return;
    if (e.state === 'start') {
      starts.set(e.runId, { e, order });
      return;
    }
    if (e.state !== 'end' || !starts.has(e.runId)) return;
    const start = starts.get(e.runId);
    starts.delete(e.runId);
    const closureT = nextClosureT(prefix, { t: start.e.t, order: start.order }, bounds.recordedEnd);
    spans.push(makeSpan(
      Math.max(bounds.recordedStart, start.e.t),
      Math.min(bounds.recordedEnd, e.t, closureT),
      {
        phase: start.e.phase,
        stage: start.e.stage,
        disposition: start.e.disposition === 'waiting' || start.e.stage === 'readiness_wait' ? 'waiting' : 'active',
        wallCategory: start.e.disposition === 'waiting' || start.e.stage === 'readiness_wait' ? 'waiting' : start.e.phase,
        confidence: 'explicit',
        source: 'work_phase',
        evidenceEventIds: [start.e.id, e.id].filter(Boolean),
        _order: start.order,
      },
    ));
  });

  for (const { e, order } of starts.values()) {
    const endT = Math.min(bounds.recordedEnd, nextClosureT(prefix, { t: e.t, order }, bounds.recordedEnd));
    spans.push(makeSpan(Math.max(bounds.recordedStart, e.t), endT, {
      phase: e.phase,
      stage: e.stage,
      disposition: e.disposition === 'waiting' || e.stage === 'readiness_wait' ? 'waiting' : 'active',
      wallCategory: e.disposition === 'waiting' || e.stage === 'readiness_wait' ? 'waiting' : e.phase,
      confidence: 'explicit',
      source: 'work_phase',
      evidenceEventIds: [e.id].filter(Boolean),
      _order: order,
    }));
  }
  return spans.filter(span => span.endT > span.startT);
}

function toolLifecycleSpans(prefix, bounds) {
  const starts = new Map();
  const spans = [];
  const terminalIds = new Set();
  prefix.forEach((e, order) => {
    if (e.type !== 'tool_call') return;
    const identity = [e.sessionId, e.agentId, e.toolUseId].join('\u0000');
    if (e.state === 'start') {
      starts.set(identity, { e, order });
      return;
    }
    const start = starts.get(identity);
    if (!start) return;
    starts.delete(identity);
    terminalIds.add(e);
    const text = eventText(start.e);
    const testing = isTestOrBuild(text);
    const closureT = nextClosureT(prefix, { t: start.e.t, order: start.order }, bounds.recordedEnd);
    spans.push(makeSpan(
      Math.max(bounds.recordedStart, start.e.t),
      Math.min(bounds.recordedEnd, e.t, closureT),
      {
        phase: testing ? 'testing' : 'other',
        confidence: testing ? 'strong' : 'heuristic',
        source: 'tool_call',
        evidenceEventIds: [start.e.id, e.id].filter(Boolean),
        _order: start.order,
      },
    ));
  });
  return { spans: spans.filter(span => span.endT > span.startT), terminalIds };
}

function inferredWorkSpans(prefix, bounds, terminalIds) {
  const candidates = prefix
    .map((e, order) => ({ e, order }))
    .filter(({ e }) => isProducer(e) && e.type !== 'work_phase' && !terminalIds.has(e)
      && e.t >= bounds.recordedStart && e.t <= bounds.recordedEnd);
  const spans = [];
  let declaredPreflight = false;
  let previousProducerT = null;

  for (let i = 0; i < candidates.length; i += 1) {
    const { e, order } = candidates[i];
    const text = eventText(e);
    if (previousProducerT != null && e.t - previousProducerT > ACTIVE_GAP_MS) declaredPreflight = false;
    if (declaresPreflight(e, text)) declaredPreflight = true;

    const nextProducerT = candidates[i + 1]?.e.t ?? bounds.recordedEnd;
    const endT = Math.min(
      bounds.recordedEnd,
      e.t + ACTIVE_GAP_MS,
      nextProducerT,
      nextClosureT(prefix, { t: e.t, order }, bounds.recordedEnd),
    );

    let phase = 'other';
    let stage = null;
    let confidence = 'heuristic';
    let source = 'producer';
    if (declaredPreflight) {
      phase = 'preflight';
      stage = preflightStage(text);
      confidence = 'strong';
      source = 'declared_preflight';
    } else if (e.type === 'edit' || e.type === 'commit') {
      phase = 'coding';
      source = e.type;
    } else if (isTestOrBuild(text)) {
      phase = 'testing';
      confidence = 'strong';
      source = 'command';
    }

    spans.push(makeSpan(e.t, endT, {
      phase,
      stage,
      confidence,
      source,
      evidenceEventIds: [e.id].filter(Boolean),
      _order: order,
    }));
    if (endsPreflight(text)) declaredPreflight = false;
    previousProducerT = e.t;
  }
  return spans.filter(span => span.endT > span.startT);
}

function dispositionSpans(prefix, bounds) {
  const spans = [];
  let current = null;
  let startT = bounds.recordedStart;
  let evidenceEventIds = [];
  let order = 0;

  function transition(next, t, e, eventOrder) {
    if (next === current) {
      if (e?.id) evidenceEventIds.push(e.id);
      return;
    }
    if (current && t > startT) {
      spans.push(makeSpan(startT, t, {
        phase: 'other',
        disposition: current,
        wallCategory: current,
        confidence: 'explicit',
        source: 'session_lifecycle',
        evidenceEventIds,
        _order: order,
      }));
    }
    current = next;
    startT = t;
    evidenceEventIds = e?.id ? [e.id] : [];
    order = eventOrder;
  }

  prefix.forEach((e, eventOrder) => {
    if (e.t < bounds.recordedStart || e.t > bounds.recordedEnd) return;
    if (e.type === 'session') {
      if (e.phase === 'attention') transition('waiting', e.t, e, eventOrder);
      else if (e.phase === 'idle' || e.phase === 'end') transition('idle', e.t, e, eventOrder);
      else if (e.phase === 'start' || e.phase === 'resume') transition(null, e.t, e, eventOrder);
      return;
    }
    if (e.type === 'notification') {
      if (e.reason === 'permission' || e.reason === 'question') transition('waiting', e.t, e, eventOrder);
      else if (e.reason === 'next_prompt' && current !== 'idle') transition('waiting', e.t, e, eventOrder);
      return;
    }
    if (resumesDisposition(e) && current) transition(null, e.t, e, eventOrder);
  });

  if (current && bounds.recordedEnd > startT) {
    spans.push(makeSpan(startT, bounds.recordedEnd, {
      phase: 'other',
      disposition: current,
      wallCategory: current,
      confidence: 'explicit',
      source: 'session_lifecycle',
      evidenceEventIds,
      _order: order,
    }));
  }
  return spans;
}

function deriveSemanticSpans(prefix, bounds) {
  const explicit = explicitWorkSpans(prefix, bounds);
  const toolCalls = toolLifecycleSpans(prefix, bounds);
  return [
    ...explicit,
    ...toolCalls.spans,
    ...inferredWorkSpans(prefix, bounds, toolCalls.terminalIds),
    ...dispositionSpans(prefix, bounds),
  ];
}

function spanPriority(span) {
  if (span.disposition === 'waiting') return 400;
  if (span.disposition === 'idle') return 390;
  if (span.disposition === 'unknown') return 380;
  return CONFIDENCE_PRIORITY[span.confidence] * 100 + PHASE_PRIORITY[span.phase] * 10 + span._order / 1e6;
}

function sameSemanticSpan(a, b) {
  return a.endT === b.startT
    && a.phase === b.phase
    && a.stage === b.stage
    && a.disposition === b.disposition
    && a.wallCategory === b.wallCategory
    && a.confidence === b.confidence
    && a.source === b.source;
}

function publicSpan(span) {
  const { _order, ...result } = span;
  return result;
}

function partitionWallTime(candidates, bounds) {
  if (bounds.recordedEnd <= bounds.recordedStart) return [];
  const boundaries = new Set([bounds.recordedStart, bounds.recordedEnd]);
  for (const span of candidates) {
    boundaries.add(Math.max(bounds.recordedStart, Math.min(bounds.recordedEnd, span.startT)));
    boundaries.add(Math.max(bounds.recordedStart, Math.min(bounds.recordedEnd, span.endT)));
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  const result = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const startT = sorted[i];
    const endT = sorted[i + 1];
    if (endT <= startT) continue;
    const winner = candidates
      .filter(span => span.startT <= startT && span.endT >= endT)
      .sort((a, b) => spanPriority(b) - spanPriority(a))[0];
    const selected = winner
      ? makeSpan(startT, endT, winner)
      : makeSpan(startT, endT, {
        phase: 'other',
        disposition: 'unknown',
        wallCategory: 'unknown',
        confidence: 'heuristic',
        source: 'unknown_silence',
        evidenceEventIds: [],
      });
    const last = result.at(-1);
    if (last && sameSemanticSpan(last, selected)) {
      last.endT = endT;
      last.evidenceEventIds = [...new Set([...last.evidenceEventIds, ...selected.evidenceEventIds])];
    } else {
      result.push(selected);
    }
  }
  return result.map(publicSpan);
}

function derivePhaseTotals(phases, recordedSessionMs) {
  const byWallCategory = Object.fromEntries(WALL.map(category => [category, 0]));
  for (const phase of phases) byWallCategory[phase.wallCategory] += phase.endT - phase.startT;
  const percentages = Object.fromEntries(WALL.map(category => [category, 0]));
  if (recordedSessionMs > 0) {
    let assigned = 0;
    let finalCategory = null;
    for (const category of WALL) {
      if (!byWallCategory[category]) continue;
      finalCategory = category;
      percentages[category] = byWallCategory[category] / recordedSessionMs * 100;
    }
    const populated = WALL.filter(category => byWallCategory[category]);
    for (const category of populated.slice(0, -1)) assigned += percentages[category];
    if (finalCategory) percentages[finalCategory] = 100 - assigned;
  }
  return { byWallCategory, percentages };
}

function deriveBlockers(prefix, phases, lifecycle) {
  const blockers = [];
  for (const e of prefix) {
    if (e.type === 'notification' && e.reason === 'permission') {
      blockers.push({ kind: 'permission_block', startT: e.t, endT: e.t, durationMs: 0, confidence: 'explicit', evidenceEventIds: [e.id].filter(Boolean) });
    } else if (e.type === 'notification' && e.reason === 'question') {
      blockers.push({ kind: 'human_input', startT: e.t, endT: e.t, durationMs: 0, confidence: 'explicit', evidenceEventIds: [e.id].filter(Boolean) });
    } else if (e.type === 'session' && e.phase === 'attention') {
      blockers.push({ kind: 'human_input', startT: e.t, endT: e.t, durationMs: 0, confidence: 'explicit', evidenceEventIds: [e.id].filter(Boolean) });
    }
  }
  for (const phase of phases) {
    if (phase.source === 'unknown_silence') {
      blockers.push({ kind: 'unknown_silence', startT: phase.startT, endT: phase.endT, durationMs: 0, confidence: 'heuristic', evidenceEventIds: [] });
    } else if (phase.phase === 'preflight'
      && phase.stage === 'readiness_wait'
      && (phase.source === 'work_phase' || phase.source === 'tool_call')) {
      blockers.push({ kind: 'ci_review_wait', startT: phase.startT, endT: phase.endT, durationMs: 0, confidence: phase.confidence, evidenceEventIds: phase.evidenceEventIds });
    }
  }
  if (lifecycle.session === 'recorder-stale') {
    blockers.push({ kind: 'recorder_gap', startT: phases.at(-1)?.endT ?? 0, endT: phases.at(-1)?.endT ?? 0, durationMs: 0, confidence: 'heuristic', evidenceEventIds: [] });
  }
  return blockers;
}

function deriveToolCalls(prefix) {
  const tools = new Map();
  const open = new Map();
  const pointObservations = [];
  const conflicts = [];
  let transcriptMetrics = null;
  for (const e of prefix) {
    if (e.type === 'tool') {
      pointObservations.push(e);
      continue;
    }
    if (e.type === 'transcript_metrics') {
      transcriptMetrics = e;
      continue;
    }
    if (e.type !== 'tool_call') continue;
    const key = [e.sessionId, e.agentId, e.toolUseId];
    const identity = key.join('\u0000');
    if (e.state === 'start') {
      if (tools.has(identity)) {
        conflicts.push({ reason: 'duplicate_start', key, eventId: e.id ?? null, t: e.t });
        continue;
      }
      const lifecycle = {
        key,
        startT: e.t,
        endT: null,
        tool: e.tool,
        outcome: 'unknown',
        evidenceEventIds: [e.id].filter(Boolean),
      };
      tools.set(identity, lifecycle);
      open.set(identity, lifecycle);
    } else if (TOOL_TERMINALS.has(e.state) && open.has(identity)) {
      const tool = open.get(identity);
      tool.endT = e.t;
      tool.outcome = e.state;
      tool.evidenceEventIds = [...tool.evidenceEventIds, e.id].filter(Boolean);
      open.delete(identity);
    } else if (TOOL_TERMINALS.has(e.state)) {
      conflicts.push({ reason: 'terminal_without_start', key, eventId: e.id ?? null, t: e.t });
    }
  }
  const lifecycles = [...tools.values()];
  return {
    lifecycles,
    pointObservations,
    matchedTranscriptPairs: transcriptMetrics?.matchedTranscriptPairs
      ?? transcriptMetrics?.matchedToolPairs
      ?? 0,
    tapeObservations: transcriptMetrics?.tapeObservations
      ?? transcriptMetrics?.tapeToolObservations
      ?? 0,
    missingOutcomeCount: lifecycles.filter(x => x.endT == null).length,
    metricsEvidenceEventIds: [transcriptMetrics?.id].filter(Boolean),
    conflicts,
  };
}

function repoFromUrl(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)\/pull\/\d+(?:[/?#]|$)/i);
  if (!match) return null;
  return `${match[1]}/${match[2].replace(/\.git$/i, '')}`;
}

function eventPrNumber(e) {
  const value = e.type === 'ci' ? e.pr : e.number;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isAuthoritativeGithubFact(e) {
  if (e.type !== 'pr' && e.type !== 'ci') return false;
  if (eventPrNumber(e) == null) return false;
  return !(e.v >= 2 && e.source && !PR_AUTHORITY.has(e.source));
}

function normalizedStatus(status) {
  const value = typeof status === 'string' ? status.toLowerCase() : 'unknown';
  if (['pass', 'passed', 'success', 'successful', 'neutral', 'skipped'].includes(value)) return 'pass';
  if (['fail', 'failed', 'failure', 'error', 'cancelled'].includes(value)) return 'fail';
  if (['pending', 'running', 'in_progress', 'queued', 'waiting'].includes(value)) return 'pending';
  return value || 'unknown';
}

function validationOf(ci) {
  if (Array.isArray(ci?.checks)) {
    const required = ci.checks.filter(check => check.required !== false);
    if (required.some(check => normalizedStatus(check.status) === 'fail')) return 'fail';
    if (required.some(check => normalizedStatus(check.status) === 'pending')) return 'pending';
    if (required.every(check => normalizedStatus(check.status) === 'pass')) return 'pass';
    return 'unknown';
  }
  return normalizedStatus(ci?.status);
}

function advisoryRunningOf(ci) {
  const checks = Array.isArray(ci?.checks) ? ci.checks : [];
  return checks.filter(check => check.required === false && normalizedStatus(check.status) === 'pending').length;
}

function derivePrStack(prefix, bounds) {
  function repoFor(e) {
    return e.repo || repoFromUrl(e.url) || 'unknown';
  }

  function keyFor(e) {
    return `${repoFor(e)}#${eventPrNumber(e)}`;
  }

  const registry = new Map();
  for (const e of prefix) {
    if ((e.type !== 'pr' && e.type !== 'pr_ref') || eventPrNumber(e) == null) continue;
    const key = keyFor(e);
    const repo = repoFor(e);
    let pr = registry.get(key);
    if (!pr) {
      const recovered = e.recovery != null || e.source === 'recovery';
      pr = {
        key,
        repo,
        number: eventPrNumber(e),
        title: e.title ?? null,
        url: e.url ?? null,
        items: [],
        discovery: {
          kind: recovered ? 'recovered' : (isAuthoritativeGithubFact(e) ? 'authoritative' : 'observed'),
          observedAt: e.t,
          recordedAt: e.recordedAt ?? e.t,
          source: e.source ?? null,
          recovery: e.recovery ?? null,
          evidenceRef: e.evidenceRef ?? null,
          evidenceEventIds: [e.id].filter(Boolean),
        },
        evidenceEventIds: [],
        recorded: null,
        current: null,
      };
      registry.set(key, pr);
    }
    if (e.title != null) pr.title = e.title;
    if (e.url != null) pr.url = e.url;
    if (e.item != null && !pr.items.includes(e.item)) pr.items.push(e.item);
    if (e.id != null && !pr.evidenceEventIds.includes(e.id)) pr.evidenceEventIds.push(e.id);
  }

  const factsByKey = new Map();
  for (const e of prefix) {
    if (!isAuthoritativeGithubFact(e)) continue;
    const key = keyFor(e);
    const pr = registry.get(key);
    if (!pr) continue;
    if (!factsByKey.has(key)) factsByKey.set(key, { recorded: [], current: [] });
    const axis = e.t <= bounds.recordedEnd ? 'recorded' : 'current';
    factsByKey.get(key)[axis].push(e);
    if (e.item != null && !pr.items.includes(e.item)) pr.items.push(e.item);
    if (e.id != null && !pr.evidenceEventIds.includes(e.id)) pr.evidenceEventIds.push(e.id);
  }

  function snapshotOf(facts) {
    if (!facts.length) return null;
    const prFacts = facts.filter(e => e.type === 'pr');
    const ciFacts = facts.filter(e => e.type === 'ci');
    const latestPr = prFacts.at(-1) ?? null;
    const latestCi = ciFacts.at(-1) ?? null;
    let base = null;
    let title = null;
    let url = null;
    let createdAt = null;
    let occurredAt = null;
    for (const fact of prFacts) {
      if (Number.isFinite(fact.base)) base = fact.base;
      if (fact.title != null) title = fact.title;
      if (fact.url != null) url = fact.url;
      if (Number.isFinite(fact.createdAt)) createdAt = fact.createdAt;
      if (Number.isFinite(fact.occurredAt)) occurredAt = fact.occurredAt;
    }
    const latest = facts.at(-1);
    return {
      state: latestPr?.state ?? null,
      validation: latestCi ? validationOf(latestCi) : 'unknown',
      advisoryRunning: latestCi ? advisoryRunningOf(latestCi) : 0,
      base,
      title,
      url,
      createdAt,
      occurredAt,
      at: latest.t,
      prAt: latestPr?.t ?? null,
      ciAt: latestCi?.t ?? null,
      fetchedAt: latestCi?.fetchedAt ?? null,
      source: latest.source ?? null,
      evidenceEventIds: facts.map(e => e.id).filter(Boolean),
    };
  }

  const prs = [...registry.values()]
    .sort((a, b) => a.discovery.observedAt - b.discovery.observedAt || a.key.localeCompare(b.key));
  for (const pr of prs) {
    const facts = factsByKey.get(pr.key) ?? { recorded: [], current: [] };
    pr.recorded = snapshotOf(facts.recorded);
    pr.current = snapshotOf(facts.current);
  }

  function topology(axis) {
    const nodes = prs.filter(pr => pr[axis]?.prAt != null);
    const keys = new Set(nodes.map(pr => pr.key));
    const childKeys = new Set();
    const edges = [];
    for (const pr of nodes) {
      const base = pr[axis].base;
      if (!Number.isFinite(base)) continue;
      const parent = `${pr.repo}#${base}`;
      if (!keys.has(parent)) continue;
      edges.push({ from: parent, to: pr.key });
      childKeys.add(pr.key);
    }
    return {
      roots: nodes.map(pr => pr.key).filter(key => !childKeys.has(key)),
      edges,
    };
  }

  const recordedTopology = topology('recorded');
  const currentTopology = topology('current');
  return {
    prs,
    recordedRoots: recordedTopology.roots,
    currentRoots: currentTopology.roots,
    recordedEdges: recordedTopology.edges,
    currentEdges: currentTopology.edges,
  };
}

function deriveRoadmap(prefix) {
  const snapshots = prefix.filter(e => e.type === 'todos' && Array.isArray(e.todos));
  const latest = snapshots.at(-1) ?? null;
  const todos = latest ? latest.todos.map(todo => ({ ...todo })) : [];
  const completed = todos.filter(todo => todo.done === true || todo.status === 'completed').length;
  const assessments = prefix.filter(e => e.type === 'assessment' && e.subject === 'roadmap');
  const handoffs = prefix.filter(e => e.type === 'handoff');
  const assessment = assessments.at(-1) ?? null;
  const handoff = handoffs.at(-1) ?? null;
  const staleEvidence = latest
    ? [...assessments, ...handoffs]
      .filter(e => e.t > latest.t)
      .sort((a, b) => a.t - b.t)
    : [];
  return {
    snapshot: latest ? {
      t: latest.t,
      item: latest.item ?? null,
      evidenceEventIds: [latest.id].filter(Boolean),
    } : null,
    todos,
    completed,
    total: todos.length,
    remaining: todos.length - completed,
    assessment,
    handoff,
    staleSnapshot: staleEvidence.length > 0,
    staleEvidenceEventIds: staleEvidence.map(e => e.id).filter(Boolean),
  };
}

function deriveAttributionGaps(prefix, prStack) {
  const gaps = [];
  for (const pr of prStack.prs) {
    if (pr.items.length) continue;
    gaps.push({
      kind: 'pr',
      key: pr.key,
      repo: pr.repo,
      number: pr.number,
      evidenceEventIds: pr.evidenceEventIds,
    });
  }
  for (const e of prefix) {
    if (!isProducer(e) || e.type === 'item' || e.item != null) continue;
    gaps.push({
      kind: 'producer',
      eventId: e.id ?? null,
      eventType: e.type,
      t: e.t,
      evidenceEventIds: [e.id].filter(Boolean),
    });
  }
  return gaps;
}

function workLifecycleConflicts(prefix) {
  const open = new Set();
  const conflicts = [];
  for (const e of prefix) {
    if (e.type !== 'work_phase') continue;
    if (e.state === 'start') {
      if (open.has(e.runId)) conflicts.push({ reason: 'duplicate_start', runId: e.runId, eventId: e.id ?? null, t: e.t });
      else open.add(e.runId);
    } else if (e.state === 'end') {
      if (!open.has(e.runId)) conflicts.push({ reason: 'terminal_without_start', runId: e.runId, eventId: e.id ?? null, t: e.t });
      else open.delete(e.runId);
    }
  }
  return conflicts;
}

function deriveDiagnostics(prefix, bounds, phases, prStack, toolCalls, factPrefix = prefix, knowledgeNow = bounds.displayNow) {
  const diagnostics = [];
  const recovered = prStack.prs.filter(pr => pr.discovery.kind === 'recovered');
  if (recovered.length) {
    diagnostics.push({
      kind: 'recovery',
      keys: recovered.map(pr => pr.key),
      evidenceEventIds: recovered.flatMap(pr => pr.discovery.evidenceEventIds),
    });
  }

  const unresolved = prStack.prs.filter(pr => pr.recorded == null && pr.current == null);
  if (unresolved.length) {
    diagnostics.push({
      kind: 'missing_poller',
      keys: unresolved.map(pr => pr.key),
      evidenceEventIds: unresolved.flatMap(pr => pr.discovery.evidenceEventIds),
    });
  }

  const knowledgeEvents = [...new Map(
    [...prefix, ...factPrefix]
      .map(event => [event.id ?? event, event]),
  ).values()].sort((a, b) => a.t - b.t);
  const pollerStatuses = knowledgeEvents.filter(e => e.type === 'poller_status');
  const latestPollerStatus = pollerStatuses.at(-1) ?? null;
  const pollerState = String(latestPollerStatus?.status ?? latestPollerStatus?.state ?? latestPollerStatus?.outcome ?? '').toLowerCase();
  const openPrs = prStack.prs.filter(pr => (pr.current?.state ?? pr.recorded?.state) === 'open');
  const latestPollerSignal = knowledgeEvents.filter(e => e.source === 'poll-github'
    && ['alive', 'pr', 'ci', 'poller_status'].includes(e.type)).at(-1) ?? null;
  const explicitlyStale = ['error', 'expired', 'stale', 'dead', 'off'].includes(pollerState);
  const agedOut = openPrs.length > 0
    && latestPollerSignal != null
    && knowledgeNow - latestPollerSignal.t > ACTIVE_GAP_MS;
  if (explicitlyStale || agedOut) {
    diagnostics.push({
      kind: 'stale_poller',
      status: pollerState || 'stale',
      lastSignalT: latestPollerSignal?.t ?? null,
      evidenceEventIds: [latestPollerStatus?.id, latestPollerSignal?.id].filter(Boolean),
    });
  }

  const lifecycleConflicts = [...toolCalls.conflicts, ...workLifecycleConflicts(prefix)];
  if (lifecycleConflicts.length) {
    diagnostics.push({
      kind: 'conflicting_lifecycle',
      conflicts: lifecycleConflicts,
      evidenceEventIds: lifecycleConflicts.map(conflict => conflict.eventId).filter(Boolean),
    });
  }
  for (const phase of phases.filter(span => span.wallCategory === 'unknown')) {
    diagnostics.push({
      kind: 'unclassified_span',
      startT: phase.startT,
      endT: phase.endT,
      durationMs: phase.endT - phase.startT,
      evidenceEventIds: phase.evidenceEventIds,
    });
  }
  return diagnostics;
}

// `untilT` caps occurrence time; `asOfT` independently caps when evidence became
// known. Historical recovery may therefore join the semantic prefix after its
// later recordedAt, while events whose occurrence is after untilT remain facts
// only and cannot advance work, lifecycle, or clocks.
export function buildSessionInsights(events, { untilT = Infinity, asOfT, displayNow } = {}) {
  const knowledgeHorizon = Number.isFinite(asOfT) ? asOfT : untilT;
  const prefix = visiblePrefix(events, untilT, knowledgeHorizon);
  const factPrefix = visiblePrefix(events, Infinity, knowledgeHorizon)
    .filter(event => KNOWLEDGE_FACT_TYPES.has(event.type));
  const now = displayNow ?? (Number.isFinite(untilT) ? untilT : (prefix.at(-1)?.t ?? 0));
  const bounds = deriveBounds(prefix, now);
  const lifecycleWithTimer = deriveLifecycle(prefix, bounds);
  const semanticSpans = deriveSemanticSpans(prefix, bounds);
  const phases = partitionWallTime(semanticSpans, bounds);
  const recordedSessionMs = bounds.recordedEnd - bounds.recordedStart;
  const phaseTotals = derivePhaseTotals(phases, recordedSessionMs);
  const clocks = {
    recordedSessionMs,
    producerWindowMs: bounds.producerStart == null || bounds.producerEnd == null ? 0 : bounds.producerEnd - bounds.producerStart,
    observedActiveMs: phases.filter(p => p.disposition === 'active').reduce((sum, p) => sum + p.endT - p.startT, 0),
    inferredIdleMs: phaseTotals.byWallCategory.idle,
    liveHumanWaitMs: lifecycleWithTimer.nextActor === 'human' && lifecycleWithTimer.humanWaitStart != null
      ? Math.max(0, bounds.displayNow - lifecycleWithTimer.humanWaitStart)
      : 0,
    unclassifiedMs: phaseTotals.byWallCategory.unknown,
  };
  const { humanWaitStart, ...lifecycle } = lifecycleWithTimer;
  const blockers = deriveBlockers(prefix, phases, lifecycle);
  const prStack = derivePrStack(factPrefix, bounds);
  const toolCalls = deriveToolCalls(prefix);
  const roadmap = deriveRoadmap(prefix);
  const attributionGaps = deriveAttributionGaps(prefix, prStack);
  const knowledgeNow = Number.isFinite(asOfT)
    ? asOfT
    : Math.max(bounds.displayNow, prefix.at(-1)?.t ?? bounds.recordedEnd);
  const diagnostics = deriveDiagnostics(prefix, bounds, phases, prStack, toolCalls, factPrefix, knowledgeNow);

  return {
    asOfT: Number.isFinite(asOfT) ? asOfT : (prefix.at(-1)?.t ?? 0),
    visiblePrefix: prefix,
    factPrefix,
    bounds,
    clocks,
    lifecycle,
    phases,
    phaseTotals,
    prStack,
    toolCalls,
    blockers,
    roadmap,
    attributionGaps,
    diagnostics,
  };
}
