// The /graph app shell: load the PURE models at runtime, fetch the tape, keep
// it live over SSE, and render the React Flow canvas + timeline. All judgment
// about WHAT the graph is stays in public/graph-model.js and public/digest.js
// (never bundled); this file owns fetching, live wiring, scrub state, and
// interaction — the same division of labor as the SVG view it replaces.
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  ReactFlow, MiniMap, Controls, Panel, applyNodeChanges,
} from '@xyflow/react';
import { nodeTypes } from './nodes/index.jsx';
import { buildFlow, sigOf } from './flow-build.js';
import Timeline from './Timeline.jsx';
import { loadModels } from './models.js';
import { ageText, costText, hhmm, dateTime, fmtSpan, fmtNum } from './format.js';

const urlq = () => new URLSearchParams(location.search);

const BADGE = {
  live: ['is-live', 'LIVE'],
  stale: ['is-stale', null], // text carries dataEndsAt
  idle: ['is-idle', 'IDLE'],
  attention: ['is-attn', 'NEEDS YOU'],
  ended: ['is-stale', 'ENDED'],
};

// ------------------------------------------------------------------ tooltip
function tooltipFor(n, models, clock) {
  const hasSize = x => (x.add || 0) > 0 || (x.del || 0) > 0;
  if (n.kind === 'pr') {
    const label = (n.repo ? n.repo + '#' : '#') + n.number;
    const bits = [`${n.prState}`];
    if (n.ci) bits.push(`CI ${n.ci}`);
    const when = n.mergedAt ? `merged ${hhmm(n.mergedAt)}` : n.openedAt ? `opened ${hhmm(n.openedAt)}` : '';
    const size = hasSize(n) ? `\n+${fmtNum(n.add)} / −${fmtNum(n.del)} lines` : '';
    return [label, (n.title || '') + '\n' + bits.join(' · ') + (when ? '\n' + when : '') + size + (n.base != null ? `\nbased on #${n.base}` : '')];
  }
  if (n.kind === 'intent') {
    return [models.turnLabel(n.itemId), `${n.title}\n${n.status}${n.abandoned ? ' · abandoned?' : ''}\n${n.commits} commits · ${n.edits} edits · +${fmtNum(n.add)} / −${fmtNum(n.del)} lines`];
  }
  if (n.kind === 'plan') return ['Plan', `${n.counts.completed} done · ${n.counts.in_progress} in progress · ${n.counts.pending} pending`];
  if (n.kind === 'step') {
    const ms = n.paused
      ? (n.pausedAt != null && n.startedAt ? Math.max(0, n.pausedAt - n.startedAt) : null)
      : (n.startedAt ? Math.max(0, clock - n.startedAt) : null);
    const when = ms != null ? (n.paused ? `paused · ${ageText(ms)}` : `running ${ageText(ms)}`) : (n.paused ? 'paused' : 'running');
    return [n.paused ? 'paused step' : 'running step', `${n.text}\n${when}`];
  }
  if (n.kind === 'now') {
    const nowLine = n.now && n.now.text ? '\n' + n.now.text : '';
    return ['current turn', `${n.prompt || models.turnLabel(n.turnId)}${nowLine}\n${models.turnLabel(n.turnId)}`];
  }
  if (n.kind === 'step-more') return [`${n.count} more running`, 'additional in-progress plan steps, folded to keep the graph legible'];
  if (n.kind === 'session') return [n.title, `${n.agent || 'agent'}\n${costText(n.cost)} · ${n.commits} commits\nsince ${n.startedAt ? hhmm(n.startedAt) : '—'}`];
  if (n.kind === 'collapsed') return [n.label, 'the oldest PRs in this column, folded to keep the graph legible'];
  return [n.kind, ''];
}

function chapterTooltip(d) {
  const g = d.group;
  const merged = g.members.filter(m => m.prState === 'merged').length;
  const closed = g.members.length - merged;
  return [
    'chapter',
    `${g.title}\n${g.members.length} PRs${closed ? ` (${merged} merged · ${closed} closed)` : ''} · ${fmtSpan(g.activeMs)} active\n${dateTime(g.startT)} → ${dateTime(g.endT)}\nclick to ${d.expanded ? 'collapse' : 'expand'}`,
  ];
}

// ---------------------------------------------------------------------- app
export default function App() {
  const [models, setModels] = useState(null);
  const [sessionId, setSessionId] = useState(() => urlq().get('session'));
  const [sessionsMeta, setSessionsMeta] = useState([]);
  const [version, setVersion] = useState(0);          // bumps when events change
  const [cursorT, setCursorT] = useState(() => {      // live drag position
    const t = Number(urlq().get('t'));
    return Number.isFinite(t) && t > 0 ? t : null;
  });
  const [scrubT, setScrubT] = useState(cursorT);      // committed (debounced) scrub
  const [expanded, setExpanded] = useState(() => {
    const raw = urlq().get('expand');
    return new Set(raw && raw !== 'all' ? raw.split(',') : []);
  });
  const [expandAll, setExpandAll] = useState(() => urlq().get('expand') === 'all');
  const [dragVersion, setDragVersion] = useState(0);
  const [tick, setTick] = useState(0);
  const [tooltip, setTooltip] = useState(null);

  const eventsRef = useRef([]);
  const dragPosRef = useRef({});
  const esRef = useRef(null);
  const flowRef = useRef(null);       // ReactFlow instance
  const refitRef = useRef(true);
  const draggingNodeRef = useRef(false);
  const pendingFlowRef = useRef(null);
  const pickerRef = useRef(null);
  const pickerApiRef = useRef(null);
  const mainRef = useRef(null);
  const scrubTimerRef = useRef(null);
  const appendTimerRef = useRef(null);
  const sigRef = useRef({ version: -1, map: new Map() });

  // ------------------------------------------------------------ persistence
  const dragKey = id => 'nsGraphFlowPos:' + (id || 'default');
  const loadDrag = id => {
    try { dragPosRef.current = JSON.parse(localStorage.getItem(dragKey(id))) || {}; }
    catch { dragPosRef.current = {}; }
  };
  const saveDrag = id => {
    try { localStorage.setItem(dragKey(id), JSON.stringify(dragPosRef.current)); } catch { /* quota */ }
  };

  // -------------------------------------------------------------- data load
  useEffect(() => { loadModels().then(setModels); }, []);
  useEffect(() => {
    let alive = true;
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { if (alive) setTick(t => t + 1); });
    }
    const iv = setInterval(() => setTick(t => t + 1), 30000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const teardownStream = () => {
    if (esRef.current) { esRef.current.onerror = null; esRef.current.close(); esRef.current = null; }
  };

  const openStream = useCallback(id => {
    teardownStream();
    let buf = [], connReady = false;
    const es = new EventSource('/sse?session=' + encodeURIComponent(id));
    esRef.current = es;
    es.onmessage = ev => {
      let e; try { e = JSON.parse(ev.data); } catch { return; }
      if (typeof e.t !== 'number' || typeof e.type !== 'string') return;
      if (!connReady) { buf.push(e); return; }
      eventsRef.current.push(e);
      // Throttle live refolds to ~1s so an append burst folds once.
      if (!appendTimerRef.current) {
        appendTimerRef.current = setTimeout(() => {
          appendTimerRef.current = null;
          setVersion(v => v + 1);
        }, 1000);
      }
    };
    es.addEventListener('ready', () => {
      connReady = true;
      eventsRef.current = buf.slice().sort((a, b) => a.t - b.t);
      buf = [];
      setVersion(v => v + 1);
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setTimeout(() => { if (esRef.current === es || esRef.current === null) openStream(id); }, 2000);
      }
    };
  }, []);

  const loadSession = useCallback(async id => {
    teardownStream();
    setSessionId(id);
    loadDrag(id);
    sigRef.current = { version: -1, map: new Map() }; // no glow-everything on switch
    setDragVersion(v => v + 1);
    const q = id ? '?session=' + encodeURIComponent(id) : '';
    let raw = '';
    try { raw = await (await fetch('/events' + q)).text(); } catch { raw = ''; }
    eventsRef.current = raw.split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(ev => ev && typeof ev.t === 'number' && typeof ev.type === 'string');
    refitRef.current = true;
    setVersion(v => v + 1);
    if (id) openStream(id);
  }, [openStream]);

  // Mount the shared session picker (a runtime-imported vanilla module that
  // owns its own DOM, so React never re-renders inside it).
  useEffect(() => {
    if (!models || !pickerRef.current || pickerApiRef.current) return;
    let cancelled = false;
    models.initSessionPicker({
      mount: pickerRef.current,
      currentId: sessionId,
      onSelect: id => {
        const p = urlq();
        p.set('session', id);
        p.delete('t'); p.delete('expand');
        history.replaceState(null, '', '?' + p.toString());
        setCursorT(null); setScrubT(null);
        setExpanded(new Set()); setExpandAll(false);
        loadSession(id);
      },
    }).then(api => {
      if (cancelled) return;
      pickerApiRef.current = api;
      setSessionsMeta(api.sessions);
      loadSession(api.current);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models]);

  useEffect(() => () => teardownStream(), []);

  // ------------------------------------------------------------- derivation
  const derived = useMemo(() => {
    if (!models) return null;
    const events = eventsRef.current;
    const fullState = models.fold(events);
    const fullDigest = models.buildDigest(events);
    const scrubbed = scrubT != null && fullDigest.endT != null && scrubT < fullDigest.endT;
    const evs = scrubbed ? events.filter(e => e.t <= scrubT) : events;
    const state = scrubbed ? models.fold(evs) : fullState;
    const model = models.buildGraphModel(evs);
    const digest = scrubbed ? models.buildDigest(events, scrubT) : fullDigest;
    const clock = scrubbed ? scrubT : Date.now();
    const expandedView = { has: id => expandAll || expanded.has(id) };
    // Live-change detection (the SVG view's glow/pulse): compare entity
    // signatures across appends. Suppressed while scrubbing — time travel is
    // not data changing.
    let glowIds = null, pulseIds = null;
    if (!scrubbed) {
      const sigs = new Map();
      for (const n of model.nodes) sigs.set(n.id, sigOf(n));
      const prev = sigRef.current;
      if (prev.version !== -1 && prev.version !== version) {
        glowIds = new Set(); pulseIds = new Set();
        for (const [id, s] of sigs) {
          if (!prev.map.has(id) || prev.map.get(id) !== s) {
            glowIds.add(id);
            const n = model.nodes.find(x => x.id === id);
            if (n && n.kind === 'pr' && (n.prState === 'merged' || n.prState === 'closed')
              && prev.map.has(id)) pulseIds.add(id);
          }
        }
      }
      sigRef.current = { version, map: sigs };
    }
    const flow = buildFlow({
      model, digest, state, columns: model.columns,
      expanded: expandedView, dragPos: dragPosRef.current, clock, scrubbed,
      glowIds, pulseIds,
    });
    const chapterIds = flow.nodes.filter(n => n.type === 'chapter').map(n => n.id);
    const segments = fullDigest.startT != null
      ? models.activeSegments(fullDigest.startT, fullDigest.endT, fullDigest.gaps)
      : [];
    const meta = sessionsMeta.find(s => s.id === sessionId) || null;
    const title = fullState.session.title || (meta && meta.title)
      || models.sessionLabel({ id: sessionId || '', cwd: fullState.session.cwd, title: null }) || 'session';
    const agent = fullState.session.agent || (meta && meta.agent) || null;
    const liveness = models.liveness(fullState, Date.now());
    return { flow, model, fullDigest, scrubbed, clock, chapterIds, segments, title, agent, liveness };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, version, scrubT, expanded, expandAll, tick, dragVersion, sessionsMeta, sessionId]);

  useEffect(() => {
    if (derived) document.title = `graph — ${derived.title}`;
  }, [derived && derived.title]);

  // -------------------------------------------------------- controlled flow
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  useEffect(() => {
    if (!derived) return;
    if (draggingNodeRef.current) { pendingFlowRef.current = derived.flow; return; }
    setNodes(derived.flow.nodes);
    setEdges(derived.flow.edges);
  }, [derived]);

  // Refit once per session load, after the new nodes land.
  useEffect(() => {
    if (!refitRef.current || !flowRef.current || nodes.length === 0) return;
    refitRef.current = false;
    requestAnimationFrame(() => {
      flowRef.current && flowRef.current.fitView({ padding: 0.1, maxZoom: 1.1, duration: 0 });
    });
  }, [nodes]);

  const onNodesChange = useCallback(changes => {
    setNodes(nds => applyNodeChanges(changes, nds));
  }, []);

  const onNodeDragStart = useCallback(() => { draggingNodeRef.current = true; setTooltip(null); }, []);
  const onNodeDragStop = useCallback((e, node) => {
    draggingNodeRef.current = false;
    if (node.type !== 'colband') {
      dragPosRef.current[node.id] = { x: node.position.x, y: node.position.y };
      saveDrag(sessionId);
      setDragVersion(v => v + 1);
    }
    if (pendingFlowRef.current) {
      const f = pendingFlowRef.current;
      pendingFlowRef.current = null;
      setNodes(f.nodes); setEdges(f.edges);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ------------------------------------------------------------------ scrub
  const onScrub = useCallback((t, dragging) => {
    setCursorT(t);
    setTooltip(null);
    if (scrubTimerRef.current) clearTimeout(scrubTimerRef.current);
    if (dragging) {
      scrubTimerRef.current = setTimeout(() => setScrubT(t), 120);
    } else {
      setScrubT(t);
      const p = urlq();
      if (t == null) p.delete('t'); else p.set('t', String(Math.round(t)));
      history.replaceState(null, '', '?' + p.toString());
    }
  }, []);

  // ------------------------------------------------------------ interaction
  const toggleChapter = useCallback(id => {
    setExpanded(prev => {
      const base = expandAll ? new Set(derived ? derived.chapterIds : []) : new Set(prev);
      if (base.has(id)) base.delete(id); else base.add(id);
      const p = urlq();
      if (base.size) p.set('expand', [...base].join(',')); else p.delete('expand');
      history.replaceState(null, '', '?' + p.toString());
      return base;
    });
    setExpandAll(false);
  }, [expandAll, derived]);

  const onNodeClick = useCallback((e, node) => {
    if (node.type === 'colband') return;
    if (node.type === 'chapter') { toggleChapter(node.id); return; }
    if (node.type === 'collapsed' || node.type === 'step-more') return;
    const n = node.data.node;
    const q = new URLSearchParams();
    if (sessionId) q.set('session', sessionId);
    if (n.lastTouched) q.set('t', String(Math.round(n.lastTouched)));
    location.href = '/?' + q.toString();
  }, [sessionId, toggleChapter]);

  const moveTooltip = useCallback((e, node) => {
    if (!models || node.type === 'colband' || draggingNodeRef.current) return;
    const r = mainRef.current.getBoundingClientRect();
    const [head, body] = node.type === 'chapter'
      ? chapterTooltip(node.data)
      : tooltipFor(node.data.node, models, node.data.clock);
    let x = e.clientX - r.left + 14, y = e.clientY - r.top + 16;
    setTooltip({ head, body, x, y });
  }, [models]);
  const hideTooltip = useCallback(() => setTooltip(null), []);

  // ------------------------------------------------------------------ render
  const lv = derived && derived.liveness;
  const badge = lv && BADGE[lv.state];
  const empty = derived && derived.model.nodes.length <= 1;

  return (
    <div className="gf-root">
      <header className="masthead">
        <div className="brand">
          <a className="home-link" href={'/' + (sessionId ? '?session=' + encodeURIComponent(sessionId) : '')} title="board home">
            <svg className="logo" width="16" height="16" viewBox="0 0 16 16"><path d="M10 1.8 A6.6 6.6 0 1 0 14.6 8.4 A5.4 5.4 0 0 1 10 1.8 Z" fill="#F0E2C0" /></svg>
            <span className="wordmark">nightshift</span>
          </a>
          <span className="crumb-sep">/</span>
          <span className="lanes-crumb">graph</span>
          <span className="crumb-sep">/</span>
          {(!sessionsMeta.length || sessionsMeta.length <= 1) && (
            <span className="session-title mono">{derived ? derived.title : '…'}</span>
          )}
          <span className="session-picker" ref={pickerRef} hidden={sessionsMeta.length <= 1} />
          {derived && derived.agent && <span className={`agent-badge agent-${derived.agent}`}>{derived.agent}</span>}
          {badge && (
            <span className={`badge ${badge[0]}`}>
              <i className="badge-dot" />
              <span>{badge[1] || `STALE · data ends ${hhmm(lv.dataEndsAt)}`}</span>
            </span>
          )}
          {derived && derived.scrubbed && (
            <a className="asof-pill" href="#" onClick={e => { e.preventDefault(); onScrub(null, false); }} title="scrubbed — click for the full tape">
              as of {dateTime(derived.clock)}
            </a>
          )}
        </div>
        <div className="instruments">
          <span className="graph-legend">
            <span className="lg"><i className="gl-ring gl-open" />open</span>
            <span className="lg"><i className="gl-ring gl-merged" />merged</span>
            <span className="lg"><i className="gl-ring gl-closed" />closed</span>
            <span className="lg"><i className="gl-mark gl-fail" />CI fail</span>
            <span className="lg"><i className="gl-dot gl-intent" />work item</span>
          </span>
          <button
            className="icon-btn" title="reset layout (clear dragged positions)"
            onClick={() => { dragPosRef.current = {}; saveDrag(sessionId); setDragVersion(v => v + 1); refitRef.current = true; }}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.2V5h-2.8" /></svg>
          </button>
          <a className="icon-btn" href={'/?session=' + encodeURIComponent(sessionId || '')} title="open the board">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="1.5" y="2" width="3.4" height="12" rx="1" /><rect x="6.3" y="2" width="3.4" height="8" rx="1" /><rect x="11.1" y="2" width="3.4" height="10" rx="1" /></svg>
          </a>
        </div>
      </header>

      <main className="gf-main" ref={mainRef}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onInit={inst => { flowRef.current = inst; }}
          onNodeClick={onNodeClick}
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
          onNodeMouseEnter={moveTooltip}
          onNodeMouseMove={moveTooltip}
          onNodeMouseLeave={hideTooltip}
          onMoveStart={hideTooltip}
          fitView
          fitViewOptions={{ padding: 0.1, maxZoom: 1.1 }}
          minZoom={0.1}
          maxZoom={2.6}
          nodesConnectable={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          proOptions={{ hideAttribution: false }}
        >
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            bgColor="rgba(10, 14, 24, 0.92)"
            maskColor="rgba(7, 10, 19, 0.72)"
            nodeColor={n => n.type === 'colband' ? 'rgba(255,255,255,0.02)'
              : n.type === 'chapter' ? '#1a2136'
              : n.type === 'session' ? '#2b3550'
              : '#222b42'}
            nodeStrokeColor="transparent"
          />
          {derived && derived.fullDigest.startT != null && derived.fullDigest.endT > derived.fullDigest.startT && (
            <Panel position="bottom-center" className="gf-tl-panel">
              <Timeline
                digest={derived.fullDigest}
                segments={derived.segments}
                cursorT={cursorT}
                onScrub={onScrub}
              />
            </Panel>
          )}
        </ReactFlow>
        {tooltip && (
          <div
            className="graph-tooltip"
            style={{ left: Math.min(tooltip.x, (mainRef.current ? mainRef.current.clientWidth : 1200) - 330), top: tooltip.y }}
          >
            <span className="tt-t">{tooltip.head}</span>
            <span className="tt-b">{tooltip.body}</span>
          </div>
        )}
        {empty && <div className="graph-empty">no entities on this tape yet</div>}
        {!models && <div className="graph-empty">loading…</div>}
        <div className="graph-hint">scroll to zoom · drag canvas to pan · drag a node to arrange · click a chapter to expand · click a node to replay</div>
      </main>
    </div>
  );
}
