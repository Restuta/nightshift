// /story is the calm morning report for one canonical session prefix. Session
// insights own clocks, PR truth, lifecycle, progress, phases, and provenance;
// digest remains only the chapter/dialogue projection beneath that report.

import { fold } from './reducer.js';
import { buildDigest } from './digest.js';
import { buildStoryBlocks, buildStoryReport, buildStoryNarrativeEvents } from './story-model.js';
import { buildSessionInsights } from './session-insights-model.js';
import { buildSummaryViewModel, summaryHTML } from './session-summary.js';
import { parseViewContext, viewHref } from './session-view-context.js';
import { initSessionPicker } from './session-picker.js';

const $ = selector => document.querySelector(selector);
const viewContext = parseViewContext(location.search);

let sessionId = viewContext.session;
let sessionsMeta = [];
let loadSeq = 0;

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const pad = value => String(value).padStart(2, '0');
const clockT = t => {
  const date = new Date(t);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayLabel = t => {
  const date = new Date(t);
  return `${DAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
};
const dateTime = t => {
  const date = new Date(t);
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${clockT(t)}`;
};
const timestampText = t => Number.isFinite(t) ? new Date(t).toLocaleString() : 'Unavailable';
const titleCase = value => String(value ?? 'unknown')
  .replaceAll('_', ' ')
  .replace(/\b\w/g, character => character.toUpperCase());
const truncate = (value, length) => {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
};

function durationText(ms) {
  if (!(ms > 0)) return '0s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function countText(value) {
  const number = Number(value) || 0;
  if (number >= 10_000) return `${Math.round(number / 1000)}k`;
  if (number >= 1000) return `${(number / 1000).toFixed(1)}k`;
  return String(number);
}

function replayHref(t) {
  return viewHref('/', {
    ...viewContext,
    session: sessionId,
    cursorT: Number.isFinite(t) ? Math.round(t) : viewContext.cursorT,
    mode: 'replay',
  });
}

function syncNavigation(insights = null) {
  viewContext.session = sessionId;
  $('#home-link').href = viewHref('/', viewContext);
  $('#nav-board').href = viewHref('/', viewContext);
  $('#nav-lanes').href = viewHref('/lanes', viewContext);
  $('#nav-graph').href = viewHref('/graph', viewContext);
  $('#nav-report').href = viewHref('/report', viewContext);

  const pill = $('#asof-pill');
  pill.hidden = viewContext.mode !== 'replay';
  if (!pill.hidden) {
    const asOf = viewContext.asOfT ?? viewContext.cursorT ?? insights?.asOfT;
    pill.textContent = Number.isFinite(asOf) ? `as of ${dateTime(asOf)}` : 'replay cutoff';
    pill.href = viewHref('/story', {
      session: sessionId,
      cursorT: null,
      cutoffT: null,
      asOfT: null,
      mode: 'live',
    });
  }
}

function setPageState(state, message = '') {
  const loading = $('#story-loading');
  const error = $('#story-error');
  const emptyElement = $('#story-empty');
  const empty = state === 'empty';
  loading.hidden = state !== 'loading';
  error.hidden = state !== 'error';
  error.textContent = state === 'error' ? message : '';
  emptyElement.hidden = !empty;
  emptyElement.setAttribute('aria-hidden', String(!empty));
  for (const selector of ['#story-summary', '#morning-report', '#ledger', '#chapters']) {
    $(selector).hidden = state !== 'ready';
  }
}

function clearSessionView() {
  document.title = 'story';
  $('#session-title').textContent = '';
  const badge = $('#agent-badge');
  badge.textContent = '';
  badge.className = 'agent-badge';
  badge.hidden = true;
  $('#story-summary').replaceChildren();
  $('#story-headline').textContent = '';
  const disposition = $('#story-disposition');
  disposition.replaceChildren();
  disposition.removeAttribute('data-state');
  $('#story-checklist').replaceChildren();
  $('#story-roadmap').replaceChildren();
  $('#story-stale-warning').textContent = '';
  $('#story-stale-warning').hidden = true;
  $('#story-phase-totals').replaceChildren();
  $('#story-intervals').replaceChildren();
  $('#story-pr-stack').replaceChildren();
  $('#ledger').replaceChildren();
  $('#chapters-head').textContent = '';
  $('#blocks').replaceChildren();
}

async function loadSession(id) {
  sessionId = id || null;
  viewContext.session = sessionId;
  syncNavigation();
  clearSessionView();
  setPageState('loading');
  const sequence = ++loadSeq;
  const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
  try {
    const response = await fetch(`/events${query}`);
    if (!response.ok) throw new Error(`events request failed (${response.status})`);
    const text = await response.text();
    if (sequence !== loadSeq) return;

    const events = text.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(event => event && Number.isFinite(event.t) && typeof event.type === 'string')
      .sort((a, b) => a.t - b.t);
    const displayNow = viewContext.mode === 'replay'
      ? (viewContext.cursorT ?? viewContext.cutoffT ?? events.at(-1)?.t ?? 0)
      : Date.now();
    const insights = buildSessionInsights(events, {
      untilT: viewContext.cutoffT ?? Infinity,
      asOfT: viewContext.asOfT,
      displayNow,
    });

    if (!insights.visiblePrefix.length) {
      setPageState('empty');
      return;
    }

    const state = fold(insights.visiblePrefix);
    const meta = sessionsMeta.find(session => session.id === sessionId) ?? null;
    const title = state.session.title || meta?.title || sessionId || 'session';
    document.title = `story — ${title}`;
    $('#session-title').textContent = title;
    const agent = state.session.agent || meta?.agent;
    const badge = $('#agent-badge');
    badge.hidden = !agent;
    badge.textContent = agent || '';
    if (agent) badge.className = `agent-badge agent-${agent}`;
    syncNavigation(insights);

    const digest = buildDigest(buildStoryNarrativeEvents(insights), Infinity);
    render(digest, insights);
    setPageState('ready');
  } catch (error) {
    if (sequence !== loadSeq) return;
    clearSessionView();
    setPageState('error', `Unable to load this session. ${error.message}`);
  }
}

async function load() {
  syncNavigation();
  // Replay deliberately skips the present-day session index and all live
  // refresh paths. One /events read is cut to the shared replay boundary.
  if (viewContext.mode === 'replay') {
    $('#session-picker').hidden = true;
    await loadSession(sessionId);
    return;
  }

  const picker = await initSessionPicker({
    mount: $('#session-picker'),
    currentId: sessionId,
    onSelect: id => {
      sessionId = id;
      viewContext.session = id;
      history.replaceState(null, '', viewHref('/story', viewContext));
      loadSession(id);
    },
  });
  sessionsMeta = picker.sessions;
  if (picker.multi) $('#session-title').hidden = true;
  await loadSession(picker.current);
}

function render(digest, insights) {
  const report = buildStoryReport(insights);
  $('#story-summary').innerHTML = summaryHTML(buildSummaryViewModel(insights));
  renderMorningReport(report);
  $('#ledger').innerHTML = ledgerHTML(digest, insights, report);
  const episodeCount = digest.totals.episodes;
  const beatCount = digest.totals.beats;
  $('#chapters-head').innerHTML = `chapters <span class="chn">${digest.chapters.length}</span>`
    + `<span class="chapters-mix">${episodeCount} episode${episodeCount === 1 ? '' : 's'} · ${beatCount} beat${beatCount === 1 ? '' : 's'} · plus unattached activity</span>`;
  const prsByNumber = new Map(report.prs.map(pr => [pr.number, pr]));
  $('#blocks').innerHTML = buildStoryBlocks(digest.chapters, digest.gaps, insights)
    .map(block => blockHTML(block, prsByNumber)).join('');
}

function evidenceHTML(evidenceEventIds, confidence) {
  const ids = evidenceEventIds.length ? evidenceEventIds.join(', ') : 'No event ids recorded';
  return `<details class="story-evidence">
    <summary>Evidence and confidence</summary>
    <p><strong>${escapeHTML(confidence)}</strong></p>
    <p>${escapeHTML(ids)}</p>
  </details>`;
}

function renderMorningReport(report) {
  $('#story-headline').textContent = report.headline;
  const disposition = $('#story-disposition');
  disposition.dataset.state = report.disposition.state;
  disposition.innerHTML = `<div>
      <span class="story-status">${escapeHTML(report.disposition.label)}</span>
      <p>${escapeHTML(report.disposition.detail)}</p>
    </div>
    <dl>
      <div><dt>Current blocker</dt><dd>${escapeHTML(report.disposition.currentBlocker)}</dd></div>
      <div><dt>Next action</dt><dd>${escapeHTML(report.disposition.nextAction)}</dd></div>
      <div><dt>Confidence</dt><dd>${escapeHTML(report.disposition.confidence)}</dd></div>
    </dl>
    ${report.disposition.uncertainty ? `<aside class="story-uncertainty" aria-label="Lifecycle uncertainty">
      <strong>${escapeHTML(report.disposition.uncertainty.label)}</strong>
      <p>${escapeHTML(report.disposition.uncertainty.detail)} ${escapeHTML(report.disposition.uncertainty.confidence)}.</p>
    </aside>` : ''}`;

  $('#story-checklist').innerHTML = `<p class="story-progress-label">${escapeHTML(report.checklist.label)}</p>
    <p>Still recorded in progress: <strong>${escapeHTML(report.checklist.remaining.join(', ') || 'none')}</strong></p>
    ${evidenceHTML(report.checklist.evidenceEventIds, 'Recorded todo snapshot')}`;
  $('#story-roadmap').innerHTML = `<p class="story-progress-label">${escapeHTML(report.roadmap.label)}</p>
    <ul>${report.roadmap.milestones.map(milestone =>
      `<li><strong>${escapeHTML(milestone.label)}</strong><span>${escapeHTML(milestone.progress)}</span></li>`).join('')}</ul>
    <p class="story-assessment">${escapeHTML(report.roadmap.assessmentText)}</p>
    ${evidenceHTML(report.roadmap.evidenceEventIds, report.roadmap.assessmentConfidence)}`;

  const warning = $('#story-stale-warning');
  warning.hidden = !report.roadmap.staleSnapshot;
  warning.textContent = report.roadmap.staleWarning || '';

  $('#story-phase-totals').innerHTML = report.phases.map(phase => `<li data-phase="${escapeHTML(phase.category)}">
      <div><strong>${escapeHTML(titleCase(phase.category))}</strong><span>${durationText(phase.durationMs)} · ${phase.percent.toFixed(1)}% of recorded session</span></div>
      ${evidenceHTML(phase.evidenceEventIds, phase.confidenceText)}
    </li>`).join('');
  $('#story-intervals').innerHTML = report.intervals.map(interval => `<article>
      <strong>${escapeHTML(interval.label)}</strong>
      <span>${durationText(interval.durationMs)} · ${escapeHTML(interval.confidence)} confidence</span>
      <a href="${escapeHTML(replayHref(interval.startT))}">Replay interval evidence</a>
    </article>`).join('');
  $('#story-pr-stack').innerHTML = prStackHTML(report.prs);
}

function prStackHTML(prs) {
  const preferred = ['Plan', 'M1a', 'M1b', 'M1c', 'M1d', 'M2', 'M3', 'Unassigned'];
  const milestones = new Set(prs.map(pr => pr.milestone));
  const order = [
    ...preferred.filter(milestone => milestones.has(milestone)),
    ...[...milestones].filter(milestone => !preferred.includes(milestone)).sort(),
  ];
  return order.flatMap(milestone => {
    const group = prs.filter(pr => pr.milestone === milestone);
    if (!group.length) return [];
    return [`<section class="story-pr-group" aria-labelledby="story-pr-${escapeHTML(milestone)}">
      <h3 id="story-pr-${escapeHTML(milestone)}">${escapeHTML(milestone)}</h3>
      ${group.map(storyPrHTML).join('')}
    </section>`];
  }).join('');
}

function storyPrHTML(pr) {
  const github = pr.url ? `<a href="${escapeHTML(pr.url)}" target="_blank" rel="noreferrer">Open PR #${pr.number} on GitHub</a>` : '';
  const replay = Number.isFinite(pr.replayT)
    ? `<a href="${escapeHTML(replayHref(pr.replayT))}">Replay PR #${pr.number} evidence</a>` : '';
  return `<article class="story-pr" data-state="${escapeHTML(pr.state)}">
    <header>
      <div><span>#${pr.number}</span><h4>${escapeHTML(pr.title || 'Untitled pull request')}</h4></div>
      <strong>${escapeHTML(pr.progress)}</strong>
    </header>
    <p class="story-pr-milestone">Milestone: ${escapeHTML(pr.milestone)} · ${escapeHTML(pr.milestoneConfidence)}</p>
    <dl class="story-pr-truth">
      <div><dt>Recorded truth</dt><dd>${escapeHTML(pr.recordedTruth)}</dd></div>
      <div><dt>Current truth</dt><dd>${escapeHTML(pr.currentTruth)}</dd></div>
      <div><dt>Recorded stack</dt><dd>${escapeHTML(pr.recordedTopology)}</dd></div>
      <div><dt>Current stack</dt><dd>${escapeHTML(pr.currentTopology)}</dd></div>
      <div><dt>Provenance</dt><dd>${escapeHTML(pr.provenance)}</dd></div>
    </dl>
    <dl class="story-pr-times">
      <div><dt>Occurred</dt><dd>${escapeHTML(timestampText(pr.occurredAt))}</dd></div>
      <div><dt>Observed</dt><dd>${escapeHTML(timestampText(pr.observedAt))}</dd></div>
      <div><dt>Recovery recorded</dt><dd>${escapeHTML(timestampText(pr.recordedAt))}</dd></div>
      <div><dt>Recorded PR snapshot</dt><dd>${escapeHTML(timestampText(pr.recordedPrAt))}</dd></div>
      <div><dt>Current PR snapshot</dt><dd>${escapeHTML(timestampText(pr.currentPrAt))}</dd></div>
      <div><dt>Current fetched</dt><dd>${escapeHTML(timestampText(pr.currentFetchedAt))}</dd></div>
    </dl>
    ${pr.changedSinceRecording ? '<p class="story-pr-change">Current truth differs from the recorded snapshot.</p>' : ''}
    ${evidenceHTML(pr.evidenceEventIds, pr.confidence)}
    <div class="story-pr-links">${github}${replay}</div>
  </article>`;
}

function ledgerHTML(digest, insights, report) {
  const stats = [
    [String(digest.totals.prompts), 'prompts'],
    [String(report.prs.filter(pr => pr.state === 'open').length), 'PRs open'],
    [String(report.prs.filter(pr => pr.state === 'merged').length), 'PRs merged'],
    [String(digest.totals.commits), 'commits'],
    [countText(digest.totals.edits), 'edits'],
  ];
  let additions = 0;
  let deletions = 0;
  for (const chapter of digest.chapters) {
    for (const commit of chapter.commits) {
      additions += commit.add || 0;
      deletions += commit.del || 0;
    }
  }
  const lines = additions || deletions
    ? `<span class="lstat"><b><em class="add">+${countText(additions)}</em> <em class="del">−${countText(deletions)}</em></b><i>lines</i></span>`
    : '';
  return `<div class="ledger-hero">
      <div class="lh-time">
        <b class="lh-num">${durationText(insights.clocks.recordedSessionMs)}</b><span class="lh-lab">recorded session</span>
        <span class="lh-dot">·</span>
        <b class="lh-num lh-active">${durationText(insights.clocks.observedActiveMs)}</b><span class="lh-lab">observed work</span>
      </div>
      <div class="lh-range">${escapeHTML(dateTime(insights.bounds.recordedStart))} → ${escapeHTML(dateTime(insights.bounds.recordedEnd))}</div>
    </div>
    ${semanticStripHTML(insights)}
    <div class="ledger-stats">
      ${stats.map(([value, label]) => `<span class="lstat"><b>${value}</b><i>${label}</i></span>`).join('')}
      ${lines}
    </div>`;
}

function semanticStripHTML(insights) {
  const start = insights.bounds.recordedStart;
  const span = Math.max(1, insights.bounds.recordedEnd - start);
  const segments = insights.phases.map(phase => {
    const left = ((phase.startT - start) / span * 100).toFixed(3);
    const width = Math.max(0.15, (phase.endT - phase.startT) / span * 100).toFixed(3);
    const label = `${titleCase(phase.wallCategory)} · ${durationText(phase.endT - phase.startT)} · ${phase.confidence} confidence`;
    return `<i class="strip-seg" data-phase="${escapeHTML(phase.wallCategory)}" data-confidence="${escapeHTML(phase.confidence)}" style="left:${left}%;width:${width}%" title="${escapeHTML(label)}"></i>`;
  }).join('');
  return `<div class="strip" aria-label="Semantic phase strip"><div class="strip-track">${segments}</div></div>`;
}

function blockHTML(block, prsByNumber) {
  if (block.kind === 'gap') {
    return '<div class="story-gap"><i></i><span>recorded-event gap</span><i></i></div>';
  }
  if (block.kind === 'day') {
    return `<div class="story-day"><span>${escapeHTML(dayLabel(block.t))}</span><i></i></div>`;
  }
  if (block.kind === 'beats') return beatsHTML(block.chapters);
  if (block.kind === 'unattached') return unattachedHTML(block);
  return episodeHTML(block.chapter, prsByNumber);
}

function episodeHTML(chapter, prsByNumber) {
  const chips = chapter.prs.map(pr => prChipHTML(prsByNumber.get(pr.number) ?? pr)).join('');
  const meta = [];
  if (chapter.counts.commits) {
    let additions = 0;
    let deletions = 0;
    for (const commit of chapter.commits) {
      additions += commit.add || 0;
      deletions += commit.del || 0;
    }
    meta.push(`${chapter.counts.commits} commit${chapter.counts.commits === 1 ? '' : 's'}`);
    if (additions || deletions) meta.push(`<em class="add">+${countText(additions)}</em> <em class="del">−${countText(deletions)}</em>`);
  }
  if (chapter.counts.edits) meta.push(`${countText(chapter.counts.edits)} edits`);
  const closer = chapter.closer?.text?.trim()
    ? `<blockquote class="ep-closer" title="the agent's last word in this chapter">${escapeHTML(chapter.closer.text.trim())}</blockquote>`
    : '';
  return `<article class="ep" data-t="${chapter.startT}">
    <header class="ep-head">
      <a class="t-link" href="${escapeHTML(replayHref(chapter.startT))}">${clockT(chapter.startT)}</a>
      ${chapter.label ? `<span class="ep-turn">${escapeHTML(chapter.label)}</span>` : ''}
      <span class="ep-durs">${chapterDurationText(chapter)}</span>
    </header>
    <h4 class="ep-title">${escapeHTML(chapter.title)}</h4>
    ${chips ? `<div class="ep-chips">${chips}</div>` : ''}
    ${meta.length ? `<div class="ep-meta">${meta.join(' · ')}</div>` : ''}
    ${closer}
  </article>`;
}

function chapterDurationText(chapter) {
  return `${durationText(chapter.wallMs)} chapter span`;
}

function prChipHTML(pr) {
  const state = pr.state || 'open';
  const title = pr.title || '';
  const canonical = 'recordedTruth' in pr;
  if (!canonical) {
    const at = pr.mergedT ?? pr.openedT;
    const body = `<b>#${pr.number}</b><span>${escapeHTML(truncate(title, 36))}</span>`;
    return Number.isFinite(at)
      ? `<a class="prchip pr-${escapeHTML(state)}" href="${escapeHTML(replayHref(at))}">${body}</a>`
      : `<span class="prchip pr-${escapeHTML(state)}">${body}</span>`;
  }
  const changedTruth = pr.changedSinceRecording
    ? `<small><b>Recorded</b> ${escapeHTML(pr.recordedTruth.replace(/^Recorded:\s*/, ''))}</small>
       <small><b>Current</b> ${escapeHTML(pr.currentTruth.replace(/^Current:\s*/, ''))}</small>` : '';
  const github = pr.url ? `<a href="${escapeHTML(pr.url)}" target="_blank" rel="noreferrer">GitHub</a>` : '';
  const replay = Number.isFinite(pr.replayT) ? `<a href="${escapeHTML(replayHref(pr.replayT))}">replay</a>` : '';
  return `<span class="prchip pr-${escapeHTML(state)}">
    <span class="prchip-head"><b>#${pr.number}</b><span>${escapeHTML(truncate(title, 36))}</span></span>
    ${changedTruth}
    <span class="prchip-links">${github}${replay}</span>
  </span>`;
}

function unattachedHTML(block) {
  return `<article class="ep unattached" id="unattached-activity">
    <header class="ep-head"><span class="ep-turn">Attribution gap</span><span class="ep-durs">${escapeHTML(block.confidence)}</span></header>
    <h4 class="ep-title">${escapeHTML(block.title)}</h4>
    <p class="unattached-copy">These artifacts are canonical session facts, but no recorded item owns them. They stay visible instead of disappearing from the narrative.</p>
    <div class="ep-chips">${block.prs.map(unattachedPrChipHTML).join('')}</div>
    ${block.activity.length ? `<p class="ep-meta">${block.activity.length} producer event${block.activity.length === 1 ? '' : 's'} without item attribution</p>` : ''}
    ${evidenceHTML(block.evidenceEventIds, block.confidence)}
  </article>`;
}

function unattachedPrChipHTML(pr) {
  const github = pr.url ? `<a href="${escapeHTML(pr.url)}" target="_blank" rel="noreferrer">GitHub</a>` : '';
  const replay = Number.isFinite(pr.replayT) ? `<a href="${escapeHTML(replayHref(pr.replayT))}">replay</a>` : '';
  return `<span class="prchip pr-${escapeHTML(pr.state)}">
    <span class="prchip-head"><b>#${pr.number}</b><span>${escapeHTML(truncate(pr.title, 36))}</span></span>
    <small>${escapeHTML(pr.provenance)} · ${escapeHTML(pr.confidence)}</small>
    <span class="prchip-links">${github}${replay}</span>
  </span>`;
}

function beatsHTML(chapters) {
  const rows = chapters.map(chapter => {
    const replyText = chapter.closer?.text?.trim() || '';
    const reply = replyText ? `<span class="beat-reply"> — ${escapeHTML(truncate(replyText, 200))}</span>` : '';
    return `<div class="beat" data-t="${chapter.startT}">
      <a class="t-link" href="${escapeHTML(replayHref(chapter.startT))}">${clockT(chapter.startT)}</a>
      <p class="beat-line"><span class="beat-prompt">${escapeHTML(chapter.title)}</span>${reply}</p>
    </div>`;
  }).join('');
  return `<div class="beats">${rows}</div>`;
}

$('#blocks').addEventListener('click', event => {
  if (event.target.closest('a, button, summary, details')) return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;
  const element = event.target.closest('[data-t]');
  if (element) location.href = replayHref(Number(element.dataset.t));
});

document.addEventListener('visibilitychange', () => {
  if (viewContext.mode === 'live' && !document.hidden && sessionId) loadSession(sessionId);
});

load();
