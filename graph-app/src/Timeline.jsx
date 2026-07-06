// The bottom timeline panel — the session's shape in every phase. A slim strip
// of the digest's active bursts (amber) over a quiet idle track, same palette
// as /story's ledger strip, with a draggable cursor that scrubs the whole graph
// through time (the model refolds at the cursor). Blue = time travel, the same
// replay language as the board's ?t= and /story's "as of" pill.
import React, { useRef, useCallback } from 'react';
import { fmtSpan, hhmm, dateTime } from './format.js';

export default function Timeline({ digest, segments, cursorT, onScrub }) {
  const trackRef = useRef(null);
  const draggingRef = useRef(false);
  const { startT, endT } = digest;
  const span = Math.max(1, endT - startT);
  const scrubbed = cursorT != null && cursorT < endT;
  const curT = cursorT != null ? cursorT : endT;
  const pct = t => Math.max(0, Math.min(100, (t - startT) / span * 100));

  const timeAt = useCallback(clientX => {
    const r = trackRef.current.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return Math.round(startT + f * span);
  }, [startT, span]);

  const onPointerDown = e => {
    if (e.button !== 0) return;
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    onScrub(timeAt(e.clientX), true);
  };
  const onPointerMove = e => {
    if (!draggingRef.current) return;
    onScrub(timeAt(e.clientX), true);
  };
  const onPointerUp = e => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const t = timeAt(e.clientX);
    // Snap back to live when released at (or past) the end of the tape.
    onScrub(t >= endT - span * 0.005 ? null : t, false);
  };

  return (
    <div className={`gf-timeline ${scrubbed ? 'scrubbed' : ''}`}>
      <div className="gf-tl-row">
        <span className="gf-tl-label mono">{dateTime(startT)}</span>
        <span className="gf-tl-mid mono">
          {scrubbed
            ? <button className="gf-tl-live" onClick={() => onScrub(null, false)} title="back to the full tape">as of {dateTime(curT)} · ⏵ latest</button>
            : <span className="gf-tl-spans">{fmtSpan(digest.wallMs)} wall · {fmtSpan(digest.activeMs)} active</span>}
        </span>
        <span className="gf-tl-label mono">{dateTime(endT)}</span>
      </div>
      <div
        className="gf-tl-track"
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title="drag to scrub the graph through time"
      >
        <div className="gf-tl-base" />
        {segments.map((s, i) => (
          <i
            key={i}
            className="gf-tl-seg"
            style={{ left: pct(s.fromT) + '%', width: Math.max(0.18, (s.toT - s.fromT) / span * 100) + '%' }}
          />
        ))}
        {scrubbed && <div className="gf-tl-dim" style={{ left: pct(curT) + '%' }} />}
        <div className="gf-tl-cursor" style={{ left: pct(curT) + '%' }}>
          <i className="gf-tl-knob" />
        </div>
        {scrubbed && <span className="gf-tl-cursor-time mono" style={{ left: pct(curT) + '%' }}>{hhmm(curT)}</span>}
      </div>
    </div>
  );
}
