import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ReactFlow, MiniMap, Controls, Panel, applyNodeChanges } from '@xyflow/react';
import { nodeTypes } from './nodes/index.jsx';
import { buildFlow, sigOf } from './flow-build.js';
import Timeline from './Timeline.jsx';
import Summary from './Summary.jsx';
import { loadModels } from './models.js';
import {
  buildReplayWindow,
  contextForScrub,
  selectGraphSession,
  shouldOpenGraphStream,
} from './runtime.js';

const initialSession = new URLSearchParams(location.search).get('session');

function tooltipFor(node) {
  if (node.kind === 'pr') {
    return {
      head: `${node.repo ? `${node.repo}#` : '#'}${node.number}`,
      body: [
        node.title,
        node.currentTruth,
        node.recordedTruth,
        `Provenance: ${node.provenance}`,
        `Confidence: ${node.confidence}`,
      ].filter(Boolean).join('\n'),
    };
  }
  if (node.kind === 'plan') {
    return { head: 'Session checklist', body: `${node.counts.completed}/${node.total} complete` };
  }
  return { head: node.kind, body: node.title ?? node.text ?? 'Recorded session entity' };
}

export default function App() {
  const [models, setModels] = useState(null);
  const [viewContext, setViewContext] = useState(null);
  const [sessionId, setSessionId] = useState(initialSession);
  const [sessionsMeta, setSessionsMeta] = useState([]);
  const [pageState, setPageState] = useState('loading');
  const [pageMessage, setPageMessage] = useState('Loading session graph…');
  const [version, setVersion] = useState(0);
  const [cursorT, setCursorT] = useState(null);
  const [scrubT, setScrubT] = useState(null);
  const [dragVersion, setDragVersion] = useState(0);
  const [tick, setTick] = useState(0);
  const [tooltip, setTooltip] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);

  const eventsRef = useRef([]);
  const viewContextRef = useRef(null);
  const dragPosRef = useRef({});
  const esRef = useRef(null);
  const flowRef = useRef(null);
  const refitRef = useRef(true);
  const draggingNodeRef = useRef(false);
  const pendingFlowRef = useRef(null);
  const pickerRef = useRef(null);
  const pickerApiRef = useRef(null);
  const mainRef = useRef(null);
  const scrubTimerRef = useRef(null);
  const appendTimerRef = useRef(null);
  const sigRef = useRef({ version: -1, map: new Map() });

  const dragKey = id => `nsGraphFlowPos:${id || 'default'}`;
  const loadDrag = id => {
    try { dragPosRef.current = JSON.parse(localStorage.getItem(dragKey(id))) || {}; }
    catch { dragPosRef.current = {}; }
  };
  const saveDrag = id => {
    try { localStorage.setItem(dragKey(id), JSON.stringify(dragPosRef.current)); }
    catch { /* storage is an optional layout convenience */ }
  };

  const teardownStream = useCallback(() => {
    if (!esRef.current) return;
    esRef.current.onerror = null;
    esRef.current.close();
    esRef.current = null;
  }, []);

  const clearSessionView = useCallback(() => {
    eventsRef.current = [];
    sigRef.current = { version: -1, map: new Map() };
    setNodes([]);
    setEdges([]);
    setTooltip(null);
  }, []);

  const openStream = useCallback(id => {
    teardownStream();
    if (!shouldOpenGraphStream(viewContextRef.current)) return;
    let buffer = [];
    let ready = false;
    const stream = new EventSource('/sse?session=' + encodeURIComponent(id));
    esRef.current = stream;
    stream.onmessage = message => {
      let event;
      try { event = JSON.parse(message.data); } catch { return; }
      if (typeof event.t !== 'number' || typeof event.type !== 'string') return;
      if (!ready) { buffer.push(event); return; }
      eventsRef.current.push(event);
      if (!appendTimerRef.current) {
        appendTimerRef.current = setTimeout(() => {
          appendTimerRef.current = null;
          setVersion(value => value + 1);
        }, 500);
      }
    };
    stream.addEventListener('ready', () => {
      ready = true;
      eventsRef.current = buffer.slice().sort((a, b) => a.t - b.t);
      buffer = [];
      setPageState(eventsRef.current.length ? 'populated' : 'empty');
      setVersion(value => value + 1);
    });
    stream.onerror = () => {
      if (stream.readyState !== EventSource.CLOSED) return;
      setTimeout(() => {
        const context = viewContextRef.current;
        if (esRef.current === stream && context?.session === id && shouldOpenGraphStream(context)) openStream(id);
      }, 2_000);
    };
  }, [teardownStream]);

  const loadSession = useCallback(async (id, context = viewContextRef.current) => {
    teardownStream();
    clearSessionView();
    setPageState('loading');
    setPageMessage('Loading session graph…');
    setSessionId(id);
    loadDrag(id);
    setDragVersion(value => value + 1);
    refitRef.current = true;
    const query = id ? `?session=${encodeURIComponent(id)}` : '';
    try {
      const response = await fetch('/events' + query);
      if (!response.ok) throw new Error(`Events request failed (${response.status})`);
      const raw = await response.text();
      eventsRef.current = raw.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(event => event && typeof event.t === 'number' && typeof event.type === 'string');
      setVersion(value => value + 1);
      if (!eventsRef.current.length) {
        setPageState('empty');
        setPageMessage('No recorded events for this session.');
        return;
      }
      setPageState('populated');
      if (context.mode === 'replay') return;
      if (shouldOpenGraphStream(context)) openStream(id);
    } catch (error) {
      clearSessionView();
      setPageState('error');
      setPageMessage(error instanceof Error ? error.message : 'Unable to load session graph.');
    }
  }, [clearSessionView, openStream, teardownStream]);

  useEffect(() => {
    let cancelled = false;
    loadModels().then(runtime => {
      if (cancelled) return;
      setModels(runtime);
      const context = runtime.parseViewContext(location.search);
      viewContextRef.current = context;
      setViewContext(context);
      setCursorT(context.cutoffT);
      setScrubT(context.cutoffT);
    }).catch(error => {
      if (cancelled) return;
      setPageState('error');
      setPageMessage(error instanceof Error ? error.message : 'Unable to load graph models.');
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setTick(value => value + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!models || !viewContextRef.current || !pickerRef.current || pickerApiRef.current) return;
    let cancelled = false;
    models.initSessionPicker({
      mount: pickerRef.current,
      currentId: viewContextRef.current.session,
      onSelect: id => {
        const selection = selectGraphSession(viewContextRef, id);
        viewContextRef.current = selection.context;
        history.replaceState(null, '', models.viewHref('/graph', selection.context));
        setViewContext(selection.context);
        setSessionId(id);
        setCursorT(selection.cursorT);
        setScrubT(selection.scrubT);
        loadSession(id, selection.context);
      },
    }).then(api => {
      if (cancelled) return;
      pickerApiRef.current = api;
      setSessionsMeta(api.sessions);
      const id = viewContextRef.current.session ?? api.current;
      const selection = selectGraphSession(viewContextRef, id);
      viewContextRef.current = selection.context;
      setViewContext(selection.context);
      setSessionId(id);
      setCursorT(selection.cursorT);
      setScrubT(selection.scrubT);
      loadSession(id, selection.context);
    }).catch(error => {
      if (cancelled) return;
      setPageState('error');
      setPageMessage(error instanceof Error ? error.message : 'Unable to initialize session picker.');
    });
    return () => { cancelled = true; };
  }, [loadSession, models]);

  useEffect(() => () => teardownStream(), [teardownStream]);

  const derived = useMemo(() => {
    if (!models || !viewContext || pageState !== 'populated') return null;
    const replayWindow = buildReplayWindow({
      events: eventsRef.current,
      cursorT: Number.isFinite(scrubT) ? scrubT : viewContext.cutoffT,
      asOfT: viewContext.asOfT,
    });
    const replaying = viewContext.mode === 'replay' || Number.isFinite(scrubT);
    const untilT = replaying ? replayWindow.cursorT : Infinity;
    const displayNow = Number.isFinite(untilT) ? untilT : Date.now();
    const insights = models.buildSessionInsights(eventsRef.current, {
      untilT,
      asOfT: replaying ? viewContext.asOfT : Infinity,
      displayNow,
    });
    const model = models.buildGraphModel(insights.visiblePrefix, insights);
    const summary = models.buildSummaryViewModel(insights);
    const clock = Number.isFinite(untilT) ? untilT : Date.now();

    let glowIds = null;
    let pulseIds = null;
    if (viewContext.mode === 'live' && !Number.isFinite(scrubT)) {
      const signatures = new Map(model.nodes.map(node => [node.id, sigOf(node)]));
      const previous = sigRef.current;
      if (previous.version !== -1 && previous.version !== version) {
        glowIds = new Set();
        pulseIds = new Set();
        for (const [id, signature] of signatures) {
          if (previous.map.get(id) === signature) continue;
          glowIds.add(id);
          const node = model.nodes.find(candidate => candidate.id === id);
          if (node?.kind === 'pr' && node.semanticState === 'complete' && previous.map.has(id)) pulseIds.add(id);
        }
      }
      sigRef.current = { version, map: signatures };
    }

    const flow = buildFlow({
      model,
      columns: model.columns,
      dragPos: dragPosRef.current,
      clock,
      scrubbed: viewContext.mode === 'replay' || Number.isFinite(scrubT),
      glowIds,
      pulseIds,
    });
    const folded = models.fold(insights.visiblePrefix);
    const meta = sessionsMeta.find(session => session.id === sessionId) ?? null;
    const title = folded.session.title || meta?.title
      || models.sessionLabel({ id: sessionId || '', cwd: folded.session.cwd, title: null })
      || 'session';
    return { insights, model, summary, flow, replayWindow, title, agent: folded.session.agent ?? meta?.agent ?? null };
  }, [models, viewContext, pageState, scrubT, version, dragVersion, tick, sessionsMeta, sessionId]);

  useEffect(() => {
    if (!derived) return;
    document.title = `graph — ${derived.title}`;
    if (draggingNodeRef.current) { pendingFlowRef.current = derived.flow; return; }
    setNodes(derived.flow.nodes);
    setEdges(derived.flow.edges);
  }, [derived]);

  useEffect(() => {
    if (!refitRef.current || !flowRef.current || !nodes.length) return;
    refitRef.current = false;
    requestAnimationFrame(() => flowRef.current?.fitView({ padding: 0.12, maxZoom: 1.05, duration: 0 }));
  }, [nodes]);

  const onNodesChange = useCallback(changes => setNodes(current => applyNodeChanges(changes, current)), []);
  const onNodeDragStart = useCallback(() => { draggingNodeRef.current = true; setTooltip(null); }, []);
  const onNodeDragStop = useCallback((event, node) => {
    draggingNodeRef.current = false;
    if (node.type !== 'colband') {
      dragPosRef.current[node.id] = { x: node.position.x, y: node.position.y };
      saveDrag(sessionId);
      setDragVersion(value => value + 1);
    }
    if (pendingFlowRef.current) {
      setNodes(pendingFlowRef.current.nodes);
      setEdges(pendingFlowRef.current.edges);
      pendingFlowRef.current = null;
    }
  }, [sessionId]);

  const onScrub = useCallback((t, dragging) => {
    setCursorT(t);
    setTooltip(null);
    if (scrubTimerRef.current) clearTimeout(scrubTimerRef.current);
    if (!Number.isFinite(t)) {
      setScrubT(null);
      return;
    }
    teardownStream();
    const next = contextForScrub(
      viewContextRef.current,
      t,
      derived?.replayWindow.ceilingT,
    );
    viewContextRef.current = next;
    setViewContext(next);
    history.replaceState(null, '', models.viewHref('/graph', next));
    if (dragging) {
      scrubTimerRef.current = setTimeout(() => setScrubT(t), 100);
      return;
    }
    setScrubT(t);
  }, [derived?.replayWindow.ceilingT, models, teardownStream]);

  const onReturnLive = useCallback(() => {
    const live = { session: sessionId, cursorT: null, cutoffT: null, asOfT: null, mode: 'live' };
    location.href = models.viewHref('/graph', live);
  }, [models, sessionId]);

  const openNode = useCallback((event, flowNode) => {
    if (flowNode.type === 'colband') return;
    if (event?.target?.closest?.('a,button')) return;
    const node = flowNode.data.node;
    const t = node.replayT ?? node.lastTouched;
    const currentContext = viewContextRef.current;
    const next = {
      ...currentContext,
      session: sessionId,
      cursorT: Number.isFinite(t) ? Math.round(t) : currentContext.cursorT,
      cutoffT: Number.isFinite(t) ? Math.min(t, currentContext.asOfT ?? Infinity) : currentContext.cutoffT,
      mode: 'replay',
    };
    location.href = models.viewHref('/', next);
  }, [models, sessionId]);

  const onNodeKeyDown = useCallback((event, node) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openNode(event, node);
    }
  }, [openNode]);

  const moveTooltip = useCallback((event, node) => {
    if (node.type === 'colband' || draggingNodeRef.current || !mainRef.current) return;
    const rect = mainRef.current.getBoundingClientRect();
    const content = tooltipFor(node.data.node);
    setTooltip({ ...content, x: event.clientX - rect.left + 14, y: event.clientY - rect.top + 16 });
  }, []);

  const navigation = models && viewContext ? {
    board: models.viewHref('/', viewContext),
    story: models.viewHref('/story', viewContext),
    lanes: models.viewHref('/lanes', viewContext),
    graph: models.viewHref('/graph', viewContext),
  } : { board: '/', story: '/story', lanes: '/lanes', graph: '/graph' };

  const semantic = derived?.model.semantic;
  return (
    <div className="gf-root" data-page-state={pageState}>
      <header className="masthead">
        <div className="brand">
          <a className="home-link" href={navigation.board} title="Board">
            <svg className="logo" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 1.8 A6.6 6.6 0 1 0 14.6 8.4 A5.4 5.4 0 0 1 10 1.8 Z" fill="#F0E2C0" /></svg>
            <span className="wordmark">nightshift</span>
          </a>
          <span className="crumb-sep">/</span><span className="lanes-crumb">graph</span>
          {(!sessionsMeta.length || sessionsMeta.length <= 1) && <span className="session-title mono">{derived?.title ?? '…'}</span>}
          <span className="session-picker" ref={pickerRef} hidden={sessionsMeta.length <= 1} />
          {derived?.agent && <span className={`agent-badge agent-${derived.agent}`}>{derived.agent}</span>}
          {semantic && <span className="gf-live-state mono" data-state={semantic.state}>{semantic.state}</span>}
        </div>
        <nav className="gf-nav" aria-label="Session views">
          <a href={navigation.board}>Board</a><a href={navigation.story}>Story</a><a href={navigation.lanes}>Lanes</a><a href={navigation.graph} aria-current="page">Graph</a>
        </nav>
      </header>

      {derived && <Summary summary={derived.summary} semantic={semantic} />}
      <div className="gf-state-legend" aria-label="Graph state legend">
        {['Active', 'Attention', 'Blocked', 'Complete'].map(label => <span key={label} data-state={label.toLowerCase()}>{label}</span>)}
        {semantic && <><span>Current blocker: {semantic.currentBlocker}</span><span>Next actor: {semantic.nextActor}</span></>}
      </div>

      <main className="gf-main" ref={mainRef} aria-busy={pageState === 'loading'}>
        {pageState === 'populated' && derived && (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onInit={instance => { flowRef.current = instance; }}
            onNodeClick={openNode}
            onNodeKeyDown={onNodeKeyDown}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onNodeMouseEnter={moveTooltip}
            onNodeMouseMove={moveTooltip}
            onNodeMouseLeave={() => setTooltip(null)}
            onMoveStart={() => setTooltip(null)}
            fitView
            fitViewOptions={{ padding: 0.12, maxZoom: 1.05 }}
            minZoom={0.1}
            maxZoom={2.6}
            nodesConnectable={false}
            deleteKeyCode={null}
            selectionKeyCode={null}
            proOptions={{ hideAttribution: false }}
          >
            <Controls position="bottom-left" showInteractive={false} />
            <MiniMap position="bottom-right" pannable zoomable bgColor="#0a0e18" maskColor="rgba(7, 10, 19, .76)" nodeColor="#242d43" nodeStrokeColor="transparent" />
            {derived.replayWindow.ceilingT > derived.replayWindow.floorT && (
              <Panel position="bottom-center" className="gf-tl-panel">
                <Timeline
                  insights={derived.insights}
                  cursorT={cursorT}
                  floorT={derived.replayWindow.floorT}
                  ceilingT={derived.replayWindow.ceilingT}
                  onScrub={onScrub}
                  onReturnLive={onReturnLive}
                  isReplay={viewContext.mode === 'replay'}
                />
              </Panel>
            )}
          </ReactFlow>
        )}
        {tooltip && <div className="graph-tooltip" style={{ left: tooltip.x, top: tooltip.y }}><span className="tt-t">{tooltip.head}</span><span className="tt-b">{tooltip.body}</span></div>}
        {pageState === 'loading' && <div className="graph-state" role="status">{pageMessage}</div>}
        {pageState === 'empty' && <div className="graph-state" role="status">{pageMessage}</div>}
        {pageState === 'error' && <div className="graph-state is-error" role="alert">{pageMessage}</div>}
        {pageState === 'populated' && derived?.model.nodes.length <= 1 && <div className="graph-state">No semantic entities recorded yet.</div>}
        <div className="graph-hint">Scroll to zoom · drag canvas to pan · focus a node and press Enter to replay evidence</div>
      </main>
    </div>
  );
}
