// Custom React Flow node types for the /graph view — faithful ports of the SVG
// node designs in public/graph.js (same geometry, colors, and honesty rules:
// paused steps freeze their duration, now-lines re-tense past the 10-min TTL).
// All text is pre-wrapped/truncated by flow-build.js with the same canvas
// measurer the SVG used, so nodes render exactly the lines that were measured.
import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { ageText, costText, hhmm, fmtNum, truncate, SANS, MONO_SM } from '../format.js';

const RING = { open: '#d29922', merged: '#a371f7', closed: '#5d6781' };
const STATUS_ACCENT = { inbox: '#5d6781', doing: '#d29922', pr: '#4cb782', done: '#5e6ad2' };

const hasSize = n => (n.add || 0) > 0 || (n.del || 0) > 0;

function Ports() {
  return (
    <>
      <Handle type="target" position={Position.Left} className="gf-port" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="gf-port" isConnectable={false} />
    </>
  );
}

function DiffChip({ add, del }) {
  return (
    <div className="gf-diff mono">
      <em className="a">+{fmtNum(add)}</em>
      <em className="d">−{fmtNum(del)}</em>
    </div>
  );
}

// ------------------------------------------------------------------ session
export function SessionNode({ data }) {
  const n = data.node;
  const act = data.view;
  return (
    <div className={`gfn gfn-session ${data.glow ? 'glow' : ''}`}>
      <span className="gf-accent" style={{ background: '#F0E2C0' }} />
      <Ports />
      <div className="gfs-base">
        <div className="gfs-head">
          <span className="gf-title">{truncate(n.title, 132, SANS)}</span>
          {n.agent && <span className={`gf-agent agent-${n.agent}`}>{n.agent.toUpperCase()}</span>}
        </div>
        <div className="gf-meta mono">{costText(n.cost)} · {n.commits} commits</div>
        <div className="gf-meta mono">+{fmtNum(n.add)} / -{fmtNum(n.del)} lines</div>
        {n.startedAt ? <div className="gf-sub mono">since {hhmm(n.startedAt)}</div> : null}
      </div>
      {act && (
        <div className="gfs-act">
          {act.prompt && <div className="gfa-on mono">{act.prompt}</div>}
          {act.body && (
            <div className={`gfa-body ${act.body.cls}`}>
              <i className={`gfa-dot ${act.body.cls}`}>{act.body.pulse && <i className="gfa-ping" />}</i>
              <div className="gfa-lines">
                {act.body.lines.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------- plan
export function PlanNode({ data }) {
  const n = data.node;
  const v = data.view;
  return (
    <div className={`gfn gfn-plan ${data.glow ? 'glow' : ''}`}>
      <Ports />
      <div className="gfp-head">
        <span className="gf-title">Plan</span>
        <span className="gf-frac mono">{n.counts.completed}/{n.total}</span>
      </div>
      <div className="gfp-rows">
        {v.shown.map((s, i) => (
          <div key={i} className={`gfp-row ${s.status}`}>
            <i className={`gfp-dot ${s.status}`} />
            <span>{s.text}</span>
          </div>
        ))}
        {v.more > 0 && <div className="gfp-row muted"><i className="gfp-dot spacer" /><span>+{v.more} more steps</span></div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- intent
export function IntentNode({ data }) {
  const n = data.node;
  const stats = [];
  if (n.commits) stats.push(`${n.commits} commit${n.commits > 1 ? 's' : ''}`);
  if (n.edits) stats.push(`${n.edits} edit${n.edits > 1 ? 's' : ''}`);
  return (
    <div className={`gfn gfn-intent ${data.glow ? 'glow' : ''}`}>
      <span className="gf-accent" style={{ background: STATUS_ACCENT[n.status] || '#5d6781' }} />
      <Ports />
      <div className="gf-title">{truncate(n.title, 186, SANS)}</div>
      <div className="gf-meta mono">{truncate(stats.join(' · ') || n.status, 186, MONO_SM)}</div>
      {hasSize(n) && <DiffChip add={n.add} del={n.del} />}
      <span className={`gf-chip mono ${n.abandoned ? 'abandoned' : ''}`}>{n.abandoned ? 'abandoned?' : n.status}</span>
    </div>
  );
}

// ----------------------------------------------------------------------- pr
function CiMark({ ci }) {
  if (ci === 'fail') return <svg className="gf-ci fail" width="12" height="12" viewBox="0 0 12 12"><path d="M2 2 L10 10 M10 2 L2 10" fill="none" strokeWidth="1.8" /></svg>;
  if (ci === 'pass') return <svg className="gf-ci pass" width="12" height="12" viewBox="0 0 12 12"><path d="M2 6.5 L5 9.5 L10 2.5" fill="none" strokeWidth="1.8" /></svg>;
  if (ci === 'pending') return <i className="gf-ci pending" />;
  return null;
}

export function PrNode({ data }) {
  const n = data.node;
  const label = (n.repo ? n.repo + '#' : '#') + n.number;
  const at = n.mergedAt || n.openedAt || n.lastTouched;
  return (
    <div className={`gfn gfn-pr ${data.glow ? 'glow' : ''}`} data-state={n.semanticState}>
      <span className="gf-accent" aria-hidden="true" />
      <Ports />
      <div className="gfr-head">
        <i className={`gf-ring ${n.prState}`} style={{ borderColor: RING[n.prState] || RING.open }}>
          {n.prState === 'merged' && <i style={{ background: RING.merged }} />}
        </i>
        <span className="gf-title">{truncate(n.title || '#' + n.number, 142, SANS)}</span>
        <CiMark ci={n.ci} />
      </div>
      <div className="gfr-meta">
        <span className="gf-meta mono">{truncate(label, 126, MONO_SM)}</span>
        {at ? <span className="gf-age mono">Open for {ageText(Math.max(0, data.clock - at))}</span> : null}
      </div>
      <div className="gfr-milestone mono" title={n.milestoneConfidence}>Milestone: {n.milestone} · {n.semanticState}</div>
      <div className="gfr-truth">
        <div><b>Current truth</b><span>{n.currentTruth?.replace(/^Current:\s*/, '') ?? 'Unavailable at this cutoff'}</span></div>
        <div><b>Recorded truth</b><span>{n.recordedTruth?.replace(/^Recorded:\s*/, '') ?? 'Not recorded'}</span></div>
      </div>
      <div className="gfr-evidence mono">
        <span>Discovery provenance: {n.discoveryProvenance}</span>
        <span>Snapshot provenance: {n.snapshotProvenance}</span>
        <span>Confidence: {n.confidence}</span>
      </div>
      {hasSize(n) && <DiffChip add={n.add} del={n.del} className="gfr-diff" />}
      {n.url && (
        <a
          className="gf-ext"
          href={n.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open PR #${n.number} on GitHub`}
          aria-label={`Open PR #${n.number} on GitHub`}
          onClick={e => e.stopPropagation()}
          onPointerDown={e => e.stopPropagation()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 9 L8 2 M4 2 H8 V6" fill="none" strokeWidth="1.3" /></svg>
        </a>
      )}
    </div>
  );
}

// ------------------------------------------------------------ running step
export function StepNode({ data }) {
  const n = data.node;
  const v = data.view;
  const ms = n.paused
    ? (n.pausedAt != null && n.startedAt ? Math.max(0, n.pausedAt - n.startedAt) : null)
    : (n.startedAt ? Math.max(0, data.clock - n.startedAt) : null);
  return (
    <div className={`gfn gfn-step ${n.paused ? 'paused' : ''} ${data.glow ? 'glow' : ''}`}>
      <span className="gf-accent" style={{ background: n.paused ? '#5d6781' : '#d29922' }} />
      <Ports />
      <div className="gft-glyph">
        {n.paused
          ? <span className="gft-pause"><i /><i /></span>
          : <i className="gft-ring" />}
      </div>
      <div className="gft-body">
        {v.lines.map((l, i) => <div key={i} className="gft-text">{l}</div>)}
        {ms != null && <div className="gft-dur mono">{n.paused ? `paused · ${ageText(ms)}` : ageText(ms)}</div>}
      </div>
    </div>
  );
}

export function StepMoreNode({ data }) {
  const n = data.node;
  return (
    <div className={`gfn gfn-fold ${n.paused ? 'paused' : ''}`}>
      <Ports />
      <span className="gf-fold-txt mono">…{n.count} more running</span>
    </div>
  );
}

// ------------------------------------------------------------- "now" node
export function NowNode({ data }) {
  const n = data.node;
  const v = data.view;
  return (
    <div className={`gfn gfn-now ${v.attn ? 'attn' : ''} ${data.glow ? 'glow' : ''}`}>
      <span className="gf-accent" style={{ background: v.attn ? '#eb6e64' : '#d29922' }} />
      <Ports />
      <div className="gfw-head">
        <i className="gfw-dot">{v.pulse && <i className="gfa-ping" />}</i>
        <span className="gfw-label mono">{v.attn ? 'needs you' : 'now'}</span>
      </div>
      <div className="gfw-prompt">
        {v.promptLines.map((l, i) => <div key={i}>{l}</div>)}
      </div>
      {v.body && (
        <div className={`gfw-line ${v.body.cls}`}>
          {v.body.lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------- collapsed "N more" stack
export function CollapsedNode({ data }) {
  const n = data.node;
  return (
    <div className="gfn gfn-fold">
      <Ports />
      <span className="gf-stack" aria-hidden="true"><i /><i /><i /></span>
      <span className="gf-fold-txt mono">{n.label}</span>
    </div>
  );
}

// ----------------------------------------------------------- column band
export function ColBandNode({ data }) {
  return (
    <div className={`gf-band ${data.alt ? 'alt' : ''}`}>
      <span className="gf-band-label mono">{data.label}</span>
      {data.count ? <span className="gf-band-count mono">{data.count}</span> : null}
    </div>
  );
}

export const nodeTypes = {
  session: SessionNode,
  plan: PlanNode,
  intent: IntentNode,
  pr: PrNode,
  step: StepNode,
  'step-more': StepMoreNode,
  now: NowNode,
  collapsed: CollapsedNode,
  colband: ColBandNode,
};
