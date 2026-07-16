import React from 'react';

const Row = ({ label, children }) => (
  <div className="gf-summary-item">
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);

const actorLabel = actor => ({
  human: 'Human', agent: 'Agent', external: 'External system', none: 'None',
})[actor] ?? 'Unknown';

export default function Summary({ summary, semantic }) {
  if (!summary || !semantic) return null;
  return (
    <section className="gf-summary" aria-labelledby="graph-summary-title" data-state={semantic.state}>
      <div className="gf-summary-heading">
        <div>
          <span className="gf-kicker mono">Session truth</span>
          <h1 id="graph-summary-title">PR stack and execution state</h1>
        </div>
        <span className="gf-state-word mono" data-state={semantic.state}>{semantic.state}</span>
      </div>
      <dl>
        <Row label="As of">{summary.asOf}</Row>
        <Row label="Pull requests">{summary.prs}</Row>
        <Row label="Session checklist">{summary.checklist}</Row>
        <Row label="Product roadmap">{summary.roadmap}</Row>
        <Row label="Current blocker">{semantic.currentBlocker}</Row>
        <Row label="Uncertainty">{semantic.uncertaintyText}</Row>
        <Row label="Next actor">{actorLabel(semantic.nextActor)}</Row>
        <Row label="Disposition">{summary.disposition}</Row>
        <Row label="Clocks">{summary.recordedSpan} · {summary.producerWindow}</Row>
        <Row label="Observed work">{summary.observedWork}</Row>
        <Row label="Provenance">{summary.provenance}</Row>
        <Row label="Source freshness">{summary.sourceFreshness}</Row>
      </dl>
    </section>
  );
}
