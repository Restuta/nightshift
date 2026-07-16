// A semantic phase spine for the canonical session projection. Phase widths are
// proportional to recorded time. Tool lifecycles and legacy post-tool points
// sit above it as labeled evidence, never as an unlabeled activity histogram.
import React, { useRef, useCallback } from 'react';
import { fmtSpan, hhmm, dateTime } from './format.js';
import { timelineKeyTarget, timelinePointerTarget } from './runtime.js';

const PHASE_LABEL = {
  coding: 'Coding', testing: 'Testing', preflight: 'Preflight', other: 'Other',
};

function evidenceLabel(tool) {
  const outcome = tool.outcome ?? 'observation only';
  return `Tool evidence: ${tool.tool ?? 'Tool'} · ${outcome}`;
}

export default function Timeline({ insights, cursorT, floorT, ceilingT, onScrub, onReturnLive, isReplay }) {
  const trackRef = useRef(null);
  const draggingRef = useRef(false);
  const startT = floorT;
  const endT = ceilingT;
  const span = Math.max(1, endT - startT);
  const curT = Number.isFinite(cursorT) ? Math.max(startT, Math.min(endT, cursorT)) : endT;
  const scrubbed = curT < endT || isReplay;
  const pct = t => Math.max(0, Math.min(100, (t - startT) / span * 100));
  const nowPercent = Math.round(pct(curT) * 10) / 10;

  const timeAt = useCallback(clientX => {
    const rect = trackRef.current.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return timelinePointerTarget(fraction, { floorT: startT, ceilingT: endT });
  }, [endT, startT]);

  const commitScrub = (t, dragging = false) => {
    if (!isReplay && t >= endT - span * 0.005) onScrub(null, dragging);
    else onScrub(Math.max(startT, Math.min(endT, t)), dragging);
  };

  const onPointerDown = event => {
    if (event.button !== 0) return;
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    commitScrub(timeAt(event.clientX), true);
  };
  const onPointerMove = event => {
    if (draggingRef.current) commitScrub(timeAt(event.clientX), true);
  };
  const onPointerUp = event => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    commitScrub(timeAt(event.clientX), false);
  };

  const onKeyDown = event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onReturnLive();
      return;
    }
    const next = timelineKeyTarget(event.key, {
      floorT: startT,
      ceilingT: endT,
      cursorT: curT,
    });
    if (!Number.isFinite(next)) return;
    event.preventDefault();
    commitScrub(next, false);
  };

  const lifecycles = insights.toolCalls.lifecycles;
  const pointObservations = insights.toolCalls.pointObservations;

  return (
    <section className={`gf-timeline ${scrubbed ? 'scrubbed' : ''}`} aria-labelledby="graph-timeline-title">
      <div className="gf-tl-row">
        <span id="graph-timeline-title" className="gf-tl-title">Semantic session spine</span>
        <span className="gf-tl-mid mono">
          {scrubbed
            ? <button className="gf-tl-live" onClick={onReturnLive}>As of {dateTime(curT)} · return live</button>
            : <span>{fmtSpan(insights.clocks.recordedSessionMs)} recorded session</span>}
        </span>
      </div>
      <div className="gf-tl-times mono"><span>{dateTime(startT)}</span><span>{dateTime(endT)}</span></div>
      <div
        className="gf-tl-track"
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Replay position on semantic session timeline"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={nowPercent}
        aria-valuetext={`${dateTime(curT)} · ${nowPercent}% of recorded session`}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div className="gf-phase-spine" aria-hidden="true">
          {insights.phases.map((phase, index) => (
            <i
              key={`${phase.startT}:${phase.endT}:${index}`}
              className="gf-phase"
              data-category={phase.wallCategory}
              data-confidence={phase.confidence}
              style={{ left: `${pct(phase.startT)}%`, width: `${Math.max(0.12, pct(phase.endT) - pct(phase.startT))}%` }}
              title={`${PHASE_LABEL[phase.phase] ?? phase.phase} · ${phase.disposition} · ${phase.confidence} confidence`}
            />
          ))}
        </div>
        <div className="gf-tool-overlay" aria-hidden="true">
          {lifecycles.map((tool, index) => (
            <i
              key={tool.key?.join(':') ?? index}
              className="gf-tool-span"
              data-outcome={tool.outcome}
              style={{ left: `${pct(tool.startT)}%`, width: `${Math.max(0.18, pct(tool.endT ?? tool.startT) - pct(tool.startT))}%` }}
              title={`${evidenceLabel(tool)} · recorded lifecycle · explicit confidence`}
            />
          ))}
          {pointObservations.map((tool, index) => (
            <i
              key={tool.id ?? index}
              className="gf-tool-point"
              style={{ left: `${pct(tool.t)}%` }}
              title={`${evidenceLabel(tool)} · recorded point; duration unknown`}
            />
          ))}
        </div>
        {scrubbed && <div className="gf-tl-dim" style={{ left: `${pct(curT)}%` }} />}
        <div className="gf-tl-cursor" style={{ left: `${pct(curT)}%` }} aria-hidden="true"><i className="gf-tl-knob" /></div>
        {scrubbed && <span className="gf-tl-cursor-time mono" style={{ left: `${pct(curT)}%` }}>{hhmm(curT)}</span>}
      </div>
      <div className="gf-tl-legend" aria-label="Semantic timeline legend">
        {['Coding', 'Testing', 'Preflight', 'Other', 'Waiting', 'Idle', 'Unknown'].map(label => <span key={label}>{label}</span>)}
        <span>Tool evidence: lifecycle line / point observation</span>
        <span>Confidence: solid explicit / hatched strong / dotted heuristic</span>
      </div>
      <ul className="sr-only" aria-label="Tool evidence">
        {lifecycles.map((tool, index) => <li key={index}>{evidenceLabel(tool)}; recorded lifecycle; explicit confidence</li>)}
        {pointObservations.map((tool, index) => <li key={index}>{evidenceLabel(tool)}; recorded point; duration unknown</li>)}
      </ul>
    </section>
  );
}
