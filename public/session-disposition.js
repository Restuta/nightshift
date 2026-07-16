function actorLabel(actor) {
  return ({
    human: 'Human',
    agent: 'Agent',
    external: 'External system',
    none: 'None',
  })[actor] ?? 'Unknown';
}

function lifecycleDetail(lifecycle, missing) {
  const turn = lifecycle.turn === 'complete' ? 'Turn complete'
    : lifecycle.turn === 'working' ? 'Turn working'
      : 'Turn status unknown';
  const session = lifecycle.session === 'ended' ? 'session explicitly ended'
    : lifecycle.session === 'recorder-stale' ? 'session recorder stale'
      : lifecycle.session === 'open' ? 'session open'
        : 'session status unknown';
  const actor = lifecycle.nextActor === 'human' ? 'human is next actor'
    : lifecycle.nextActor === 'agent' ? 'agent is next actor'
      : lifecycle.nextActor === 'external' ? 'external system is next actor'
        : 'no next actor';
  const outcomes = missing === 0 ? 'no tool outcome is missing'
    : missing === 1 ? '1 tool outcome is missing'
      : `${missing} tool outcomes are missing`;
  return `${turn} · ${session} · ${actor} · ${outcomes}`;
}

export function buildSessionDisposition(insights) {
  const lifecycle = insights.lifecycle ?? {};
  const inputRequest = lifecycle.inputRequest ?? 'none';
  const nextActor = lifecycle.nextActor ?? 'none';
  const missing = Number(insights.toolCalls?.missingOutcomeCount) || 0;
  // Blocker overlays are forensic history. The current lifecycle request alone
  // decides whether permission is still unresolved.
  const permission = inputRequest === 'permission';

  let state = 'idle';
  let label = 'Idle';
  let currentBlocker = 'None recorded';
  let nextAction = 'No next action recorded';

  if (permission) {
    state = 'blocked';
    label = 'Permission blocked';
    currentBlocker = 'Permission decision required';
    nextAction = 'Human: approve or decline the permission request';
  } else if (inputRequest === 'question') {
    state = 'attention';
    label = 'Waiting for your answer';
    currentBlocker = 'Human answer required';
    nextAction = 'Human: answer the recorded question';
  } else if (nextActor === 'human') {
    state = 'attention';
    label = 'Waiting for your next instruction';
    currentBlocker = 'No execution blocker';
    nextAction = 'Human: provide the next instruction';
  } else if (lifecycle.session === 'ended') {
    state = 'complete';
    label = 'Session explicitly ended';
    currentBlocker = 'None';
  } else if (lifecycle.session === 'recorder-stale') {
    state = 'stale';
    label = 'Recorder stale';
    currentBlocker = 'Recorder gap';
    nextAction = nextActor === 'agent' ? 'Agent: continue when recording resumes' : nextAction;
  } else if (lifecycle.turn === 'working') {
    state = 'active';
    label = 'Agent working';
    currentBlocker = 'No execution blocker';
    nextAction = nextActor === 'external' ? 'External system: complete the pending gate'
      : 'Agent: continue the active turn';
  } else if (nextActor === 'external') {
    state = 'active';
    label = 'Waiting for external system';
    currentBlocker = 'Waiting for external system';
    nextAction = 'External system: complete the pending gate';
  }

  const uncertainty = missing > 0 ? {
    kind: 'tool_outcome_unknown',
    label: `${missing} tool ${missing === 1 ? 'outcome' : 'outcomes'} not observed`,
    detail: 'Outcome uncertainty is not evidence of blocked or running work.',
    confidence: 'Explicit unmatched tool lifecycle',
  } : null;

  return {
    state,
    inputRequest,
    label,
    detail: lifecycleDetail(lifecycle, missing),
    currentBlocker,
    nextActor,
    nextActorLabel: actorLabel(nextActor),
    nextAction,
    confidence: 'Explicit lifecycle evidence',
    uncertainty,
    uncertaintyText: uncertainty?.label ?? 'No unresolved tool outcomes',
  };
}
