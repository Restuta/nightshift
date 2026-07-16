// Semantic forensic timeline. Session insights own all clocks, phases, PR truth,
// blockers, and tool lifecycles. Canvas paints a quiet visual index; matching DOM
// buttons provide the accessible interaction and evidence drill-down layer.

import { fold } from './reducer.js';
import { buildModel } from './lanes-model.js';
import { buildSessionInsights } from './session-insights-model.js';
import { buildSummaryViewModel, summaryHTML } from './session-summary.js';
import { parseViewContext, viewHref } from './session-view-context.js';
import { initSessionPicker } from './session-picker.js';

const $ = selector => document.querySelector(selector);
const canvas = $('#lanes-canvas');
const ctx = canvas.getContext('2d');
const main = $('#lanes-main');
const shell = $('#timeline-shell');
const segmentLayer = $('#segment-layer');
const tooltip = $('#lanes-tooltip');
const drawer = $('#evidence-drawer');
const evidenceBody = $('#evidence-body');
const evidenceTitle = $('#evidence-title');
const evidenceClose = $('#evidence-close');
const preflightToggle = $('#preflight-toggle');
const itemOverlayToggle = $('#item-overlay-toggle');
const activityOverlayToggle = $('#activity-overlay-toggle');

const LABEL_W = 238;
const RIGHT_PAD = 18;
const AXIS_H = 34;
const ROW_H = 32;
const SECTION_H = 25;
const ROW_GAP = 2;
const PHASE_ORDER = ['coding', 'testing', 'preflight', 'other', 'waiting', 'idle', 'unknown'];
const PREFLIGHT_ORDER = [
  'prepare', 'local_validation', 'visual_qa', 'self_review',
  'cross_ai_review', 'publish_pr', 'readiness_wait', 'readiness_fix',
];

const COLORS = {
  background: '#070a13',
  railA: '#0a0e18',
  railB: '#0c101c',
  line: '#222b42',
  lineSoft: '#18202f',
  ink: '#e6eaf2',
  dim: '#8b93a8',
  faint: '#5d6781',
  coding: '#4ea7fc',
  testing: '#4cb782',
  preflight: '#d29922',
  other: '#7f89a8',
  waiting: '#cf8d45',
  idle: '#596177',
  unknown: '#3d465c',
  pr: '#4cb782',
  merged: '#a371f7',
  attention: '#eb6e64',
  tool: '#7bb8ef',
  item: '#5e6ad2',
};

let viewContext = parseViewContext(location.search);
let sessionId = viewContext.session;
let sessionsMeta = [];
let events = [];
let insights = null;
let model = null;
let rows = [];
let descriptorById = new Map();
let contentH = AXIS_H + ROW_H;
let preflightExpanded = true;
let evidenceReturnFocus = null;

function titleCase(value) {
  return String(value ?? 'unknown')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, character => character.toUpperCase());
}

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

function timeText(t) {
  if (!Number.isFinite(t)) return 'unavailable';
  return new Date(t).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function axisTime(t) {
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function setPageState(state, message = '') {
  const loading = $('#lanes-loading');
  const empty = $('#lanes-empty');
  const error = $('#lanes-error');
  loading.hidden = state !== 'loading';
  empty.hidden = state !== 'empty';
  empty.setAttribute('aria-hidden', String(state !== 'empty'));
  error.hidden = state !== 'error';
  if (message) error.textContent = message;
}

function clearSessionView() {
  closeEvidence();
  events = [];
  insights = null;
  model = null;
  rows = [];
  descriptorById = new Map();
  contentH = AXIS_H + ROW_H;
  document.title = 'lanes';
  $('#session-title').textContent = '';
  const badge = $('#agent-badge');
  badge.textContent = '';
  badge.hidden = true;
  $('#lanes-summary').replaceChildren();
  $('#phase-summary').replaceChildren();
  segmentLayer.replaceChildren();
  tooltip.hidden = true;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function syncNavigation() {
  $('#brand-link').href = viewHref('/', viewContext);
  $('#board-link').href = viewHref('/', viewContext);
  $('#story-link').href = viewHref('/story', viewContext);
  $('#graph-link').href = viewHref('/graph', viewContext);
}

function renderSummary() {
  $('#lanes-summary').innerHTML = summaryHTML(buildSummaryViewModel(insights));
  const values = [
    ['Recorded session', insights.clocks.recordedSessionMs],
    ['Observed work', insights.clocks.observedActiveMs],
    ...PHASE_ORDER.map(category => [titleCase(category), insights.phaseTotals.byWallCategory[category] ?? 0]),
  ];
  const list = $('#phase-summary');
  list.replaceChildren(...values.map(([label, ms]) => {
    const item = document.createElement('li');
    item.dataset.phase = label.toLowerCase().replaceAll(' ', '-');
    const value = document.createElement('strong');
    value.textContent = durationText(ms);
    const name = document.createElement('span');
    name.textContent = label;
    item.append(value, name);
    return item;
  }));
}

function prRowLabel(pr) {
  const base = pr.current?.base ?? pr.recorded?.base;
  const branch = base == null ? 'root' : `← #${base}`;
  return `#${pr.number} ${branch} · ${pr.milestone}`;
}

function prStateLabel(pr) {
  const recorded = pr.recorded
    ? `Tape: ${pr.recorded.state ?? 'unknown'} / ${pr.recorded.validation ?? 'unknown'}`
    : 'Tape: unavailable';
  const current = pr.current
    ? `Current: ${pr.current.state ?? 'unknown'} / ${pr.current.validation ?? 'unknown'}`
    : 'Current: unavailable';
  return `${recorded} → ${current}`;
}

function buildRows() {
  rows = [];
  rows.push({
    kind: 'section',
    label: 'SEMANTIC WALL TIME · EXCLUSIVE PARTITION',
    h: SECTION_H,
  });
  rows.push({
    kind: 'primary',
    label: 'Semantic phases',
    h: ROW_H + 8,
    segments: model.semanticRows.primary,
    marks: model.marks,
  });

  if (preflightExpanded && model.semanticRows.preflight.length) {
    const byStage = new Map();
    for (const segment of model.semanticRows.preflight) {
      if (!byStage.has(segment.stage)) byStage.set(segment.stage, []);
      byStage.get(segment.stage).push(segment);
    }
    for (const stage of PREFLIGHT_ORDER) {
      if (!byStage.has(stage)) continue;
      rows.push({
        kind: 'preflight',
        label: `↳ ${titleCase(stage)}`,
        h: ROW_H,
        segments: byStage.get(stage),
      });
    }
  }

  rows.push({
    kind: 'section',
    label: `PR STACK · ${model.semanticRows.prs.length} MILESTONES · RECORDED / CURRENT`,
    h: SECTION_H,
  });
  for (const pr of model.semanticRows.prs) {
    rows.push({ kind: 'pr', label: prRowLabel(pr), h: ROW_H + 8, segments: [pr], pr });
  }

  if (model.semanticRows.agents.length) {
    rows.push({ kind: 'section', label: 'PARALLEL AGENT COVERAGE · NOT SUMMED AS WALL TIME', h: SECTION_H });
    for (const agent of model.semanticRows.agents) {
      rows.push({ kind: 'agent', label: agent.label, h: ROW_H, segments: agent.segments });
    }
  }

  if (itemOverlayToggle.checked && model.overlays.items.length) {
    rows.push({ kind: 'section', label: 'ITEM ATTRIBUTION OVERLAY · HEURISTIC', h: SECTION_H });
    for (const item of model.overlays.items) {
      rows.push({ kind: 'item', label: item.label, h: ROW_H, segments: item.segments });
    }
  }

  let y = AXIS_H;
  for (const row of rows) {
    row.y = y;
    y += row.h + ROW_GAP;
  }
  contentH = y + 12;
}

function plotWidth() {
  return Math.max(1, canvas.clientWidth - LABEL_W - RIGHT_PAD);
}

function xOf(t) {
  const span = Math.max(1, model.t1 - model.t0);
  return LABEL_W + ((t - model.t0) / span) * plotWidth();
}

function segmentRect(row, descriptor) {
  const start = Math.max(LABEL_W, Math.min(canvas.clientWidth - RIGHT_PAD, xOf(descriptor.startT)));
  const end = Math.max(LABEL_W, Math.min(canvas.clientWidth - RIGHT_PAD, xOf(descriptor.endT)));
  return {
    x: start,
    y: row.y + 7,
    w: Math.max(row.kind === 'pr' ? 5 : 2, end - start),
    h: row.h - 14,
  };
}

function colorFor(descriptor) {
  if (descriptor.kind === 'item_episode') return COLORS.item;
  if (descriptor.kind === 'pr') {
    return descriptor.state === 'merged' ? COLORS.merged
      : descriptor.validation === 'fail' ? COLORS.attention
        : descriptor.validation === 'pending' ? COLORS.preflight : COLORS.pr;
  }
  return COLORS[descriptor.wallCategory] || COLORS[descriptor.phase] || COLORS.other;
}

function drawConfidenceSegment(rect, descriptor) {
  const color = colorFor(descriptor);
  ctx.save();
  if (descriptor.confidence === 'explicit') {
    ctx.globalAlpha = 0.78;
    ctx.fillStyle = color;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  } else if (descriptor.confidence === 'strong') {
    ctx.globalAlpha = 0.42;
    ctx.fillStyle = color;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.globalAlpha = 0.72;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    for (let x = rect.x - rect.h; x < rect.x + rect.w + rect.h; x += 6) {
      ctx.beginPath();
      ctx.moveTo(x, rect.y + rect.h);
      ctx.lineTo(x + rect.h, rect.y);
      ctx.stroke();
    }
  } else {
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = color;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.globalAlpha = 0.72;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, Math.max(0, rect.w - 1), Math.max(0, rect.h - 1));
  }
  ctx.restore();
}

function drawActivity(row) {
  if (!activityOverlayToggle.checked || !model.overlays.eventActivity.length) return;
  const buckets = 120;
  const counts = new Array(buckets).fill(0);
  const span = Math.max(1, model.t1 - model.t0);
  for (const t of model.overlays.eventActivity) {
    const index = Math.min(buckets - 1, Math.max(0, Math.floor((t - model.t0) / span * buckets)));
    counts[index] += 1;
  }
  const peak = Math.max(1, ...counts);
  const width = plotWidth() / buckets;
  ctx.fillStyle = '#26314e';
  for (let i = 0; i < counts.length; i += 1) {
    if (!counts[i]) continue;
    const height = Math.max(1, counts[i] / peak * (row.h - 8));
    ctx.fillRect(LABEL_W + i * width, row.y + row.h - height - 2, Math.max(1, width - 1), height);
  }
}

function markColor(mark) {
  if (['human_input', 'permission_block', 'recorder_gap', 'source_stale'].includes(mark.kind)) return COLORS.attention;
  if (mark.kind === 'ci_review_wait') return COLORS.preflight;
  if (mark.kind.startsWith('tool')) return COLORS.tool;
  return COLORS.faint;
}

function drawMark(row, mark) {
  const x = Math.max(LABEL_W, Math.min(canvas.clientWidth - RIGHT_PAD, xOf(mark.startT)));
  const top = row.y + 3;
  const bottom = row.y + row.h - 3;
  ctx.save();
  ctx.strokeStyle = markColor(mark);
  ctx.fillStyle = markColor(mark);
  ctx.globalAlpha = mark.confidence === 'heuristic' ? 0.55 : 0.9;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, top);
  ctx.lineTo(Math.round(x) + 0.5, bottom);
  ctx.stroke();
  if (mark.kind.startsWith('tool')) {
    ctx.translate(x, top + 3);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-3, -3, 6, 6);
  } else {
    ctx.beginPath();
    ctx.arc(x, top + 3, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPr(row) {
  const pr = row.pr;
  const rect = segmentRect(row, pr);
  const center = row.y + row.h / 2;
  ctx.strokeStyle = colorFor(pr);
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(rect.x, center);
  ctx.lineTo(Math.max(rect.x + 2, rect.x + rect.w), center);
  ctx.stroke();
  ctx.globalAlpha = 1;
  for (const transition of pr.transitions) {
    const x = Math.max(LABEL_W, Math.min(canvas.clientWidth - RIGHT_PAD, xOf(transition.startT)));
    const current = transition.kind.startsWith('current');
    ctx.fillStyle = current ? COLORS.ink : colorFor(pr);
    ctx.strokeStyle = current ? COLORS.ink : colorFor(pr);
    if (current) {
      ctx.fillRect(x - 2.5, center - 2.5, 5, 5);
    } else {
      ctx.beginPath();
      ctx.arc(x, center, 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if (pr.attention) {
    ctx.fillStyle = COLORS.attention;
    ctx.beginPath();
    ctx.arc(canvas.clientWidth - RIGHT_PAD - 4, center, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function truncateLabel(text, maxWidth, font) {
  ctx.font = font;
  if (ctx.measureText(text).width <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && ctx.measureText(`${result}…`).width > maxWidth) result = result.slice(0, -1);
  return `${result}…`;
}

function drawAxisAndGrid() {
  const width = canvas.clientWidth;
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, contentH);
  const ticks = 6;
  ctx.font = "10px 'IBM Plex Mono', monospace";
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= ticks; i += 1) {
    const fraction = i / ticks;
    const x = LABEL_W + fraction * plotWidth();
    const t = model.t0 + fraction * (model.t1 - model.t0);
    ctx.fillStyle = COLORS.lineSoft;
    ctx.fillRect(Math.round(x), AXIS_H - 3, 1, contentH - AXIS_H + 3);
    ctx.fillStyle = COLORS.faint;
    ctx.fillText(axisTime(t), x + 4, 14);
    ctx.fillText(`T+${durationText(t - model.t0)}`, x + 4, 27);
  }
  ctx.fillStyle = COLORS.line;
  ctx.fillRect(LABEL_W - 1, 0, 1, contentH);
}

function drawRows() {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind === 'section') {
      ctx.fillStyle = COLORS.background;
      ctx.fillRect(0, row.y, canvas.clientWidth, row.h);
      ctx.fillStyle = COLORS.faint;
      ctx.font = "600 9px 'Inter', sans-serif";
      ctx.textBaseline = 'middle';
      ctx.fillText(row.label, 12, row.y + row.h / 2);
      ctx.fillStyle = COLORS.lineSoft;
      ctx.fillRect(LABEL_W, row.y + row.h - 1, plotWidth(), 1);
      continue;
    }

    ctx.fillStyle = index % 2 ? COLORS.railA : COLORS.railB;
    ctx.fillRect(0, row.y, canvas.clientWidth, row.h);
    ctx.fillStyle = row.kind === 'preflight' || row.kind === 'item' ? COLORS.dim : COLORS.ink;
    ctx.font = row.kind === 'pr' ? "10px 'IBM Plex Mono', monospace" : "11px 'Inter', sans-serif";
    ctx.textBaseline = 'middle';
    if (row.kind === 'pr') {
      ctx.fillText(truncateLabel(row.label, LABEL_W - 22, ctx.font), 12, row.y + 12);
      ctx.fillStyle = COLORS.faint;
      ctx.font = "8.5px 'IBM Plex Mono', monospace";
      ctx.fillText(truncateLabel(prStateLabel(row.pr), LABEL_W - 22, ctx.font), 12, row.y + 28);
    } else {
      ctx.fillText(truncateLabel(row.label, LABEL_W - 22, ctx.font), 12, row.y + row.h / 2);
    }

    if (row.kind === 'primary') drawActivity(row);
    if (row.kind === 'pr') drawPr(row);
    else for (const segment of row.segments ?? []) drawConfidenceSegment(segmentRect(row, segment), segment);
    for (const mark of row.marks ?? []) drawMark(row, mark);
  }
}

function descriptorAriaLabel(descriptor) {
  const stage = descriptor.stage ? `, ${titleCase(descriptor.stage)}` : '';
  const outcome = descriptor.outcome ? `, outcome ${descriptor.outcome}` : '';
  const truths = [descriptor.recordedTruth, descriptor.currentTruth, descriptor.stackTruth]
    .filter(Boolean).join(', ');
  const temporalTruth = [
    Number.isFinite(descriptor.occurredAt) ? `occurred ${timeText(descriptor.occurredAt)}` : null,
    Number.isFinite(descriptor.observedAt) ? `observed ${timeText(descriptor.observedAt)}` : null,
  ].filter(Boolean).join(', ');
  const recordedPercent = Number.isFinite(descriptor.percent)
    ? `${descriptor.percent.toFixed(1)} percent of recorded session`
    : null;
  return `${descriptor.label}${stage}, ${durationText(descriptor.durationMs)}${recordedPercent ? `, ${recordedPercent}` : ''}, ${descriptor.confidence} confidence${outcome}, ${descriptor.evidenceEventIds.length} evidence events${temporalTruth ? `, ${temporalTruth}` : ''}${truths ? `, ${truths}` : ''}`;
}

function descriptorTooltip(descriptor) {
  const phase = descriptor.stage
    ? `${titleCase(descriptor.phase)} / ${titleCase(descriptor.stage)}`
    : titleCase(descriptor.phase ?? descriptor.kind);
  const recordedPercent = Number.isFinite(descriptor.percent)
    ? `${descriptor.percent.toFixed(1)}% of recorded session`
    : null;
  return [
    `${descriptor.label} · ${phase}`,
    [durationText(descriptor.durationMs), recordedPercent].filter(Boolean).join(' · '),
    `${timeText(descriptor.startT)} → ${timeText(descriptor.endT)}`,
    `Outcome: ${descriptor.outcome ?? 'not recorded'}`,
    `${titleCase(descriptor.confidence)} confidence · ${descriptor.evidenceEventIds.length} evidence events`,
  ].join('\n');
}

function positionTooltip(button, descriptor) {
  tooltip.textContent = descriptorTooltip(descriptor);
  tooltip.hidden = false;
  const buttonRect = button.getBoundingClientRect();
  const mainRect = main.getBoundingClientRect();
  let left = buttonRect.left - mainRect.left + Math.min(buttonRect.width, 18) + 8;
  let top = buttonRect.bottom - mainRect.top + 6 + main.scrollTop;
  if (left + tooltip.offsetWidth > main.clientWidth - 8) left = main.clientWidth - tooltip.offsetWidth - 8;
  if (top + tooltip.offsetHeight > main.scrollTop + main.clientHeight - 8) {
    top = buttonRect.top - mainRect.top + main.scrollTop - tooltip.offsetHeight - 6;
  }
  tooltip.style.left = `${Math.max(4, left)}px`;
  tooltip.style.top = `${Math.max(4, top)}px`;
}

function addSegmentButton(row, descriptor, rect, kind = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `semantic-segment ${kind}`.trim();
  button.dataset.confidence = descriptor.confidence;
  button.dataset.kind = descriptor.kind;
  button.style.left = `${Math.max(0, rect.x)}px`;
  button.style.top = `${Math.max(0, rect.y)}px`;
  button.style.width = `${Math.max(6, rect.w)}px`;
  button.style.height = `${Math.max(8, rect.h)}px`;
  button.setAttribute('aria-label', descriptorAriaLabel(descriptor));
  button.addEventListener('click', () => openEvidence(descriptor.id, button));
  button.addEventListener('mouseenter', () => positionTooltip(button, descriptor));
  button.addEventListener('focus', () => positionTooltip(button, descriptor));
  button.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  button.addEventListener('blur', () => { tooltip.hidden = true; });
  segmentLayer.append(button);
}

function renderSegmentButtons() {
  segmentLayer.replaceChildren();
  for (const row of rows) {
    if (row.kind === 'section') continue;
    for (const descriptor of row.segments ?? []) {
      const rect = segmentRect(row, descriptor);
      addSegmentButton(row, descriptor, rect, row.kind);
    }
    for (const descriptor of row.marks ?? []) {
      const x = Math.max(LABEL_W, Math.min(canvas.clientWidth - RIGHT_PAD, xOf(descriptor.startT)));
      addSegmentButton(row, descriptor, {
        x: x - 6,
        y: row.y + 1,
        w: 12,
        h: row.h - 2,
      }, 'marker');
    }
    for (const transition of row.pr?.transitions ?? []) {
      const x = Math.max(LABEL_W, Math.min(canvas.clientWidth - RIGHT_PAD, xOf(transition.startT)));
      addSegmentButton(row, transition, {
        x: x - 6,
        y: row.y + 1,
        w: 12,
        h: row.h - 2,
      }, 'marker pr-transition');
    }
  }
}

function draw() {
  if (!model) return;
  drawAxisAndGrid();
  drawRows();
  renderSegmentButtons();
}

function sizeCanvas() {
  if (!model) return;
  buildRows();
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = Math.max(720, main.clientWidth);
  shell.style.height = `${contentH}px`;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${contentH}px`;
  segmentLayer.style.width = `${cssWidth}px`;
  segmentLayer.style.height = `${contentH}px`;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(contentH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function addFact(list, label, value) {
  if (value == null || value === '') return;
  const wrapper = document.createElement('div');
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  term.textContent = label;
  description.textContent = String(value);
  wrapper.append(term, description);
  list.append(wrapper);
}

function evidenceList(descriptor) {
  const section = document.createElement('section');
  const heading = document.createElement('h3');
  heading.textContent = `Evidence events · ${descriptor.evidence.length}`;
  section.append(heading);
  if (!descriptor.evidence.length) {
    const empty = document.createElement('p');
    empty.className = 'evidence-empty';
    empty.textContent = 'No direct event is attached; this span is retained as an explicitly labeled inference.';
    section.append(empty);
    return section;
  }
  const list = document.createElement('ol');
  list.className = 'evidence-events';
  for (const evidence of descriptor.evidence) {
    const item = document.createElement('li');
    const header = document.createElement('div');
    const type = document.createElement('strong');
    const time = document.createElement('time');
    type.textContent = `${titleCase(evidence.type)} · ${evidence.id}`;
    time.dateTime = new Date(evidence.t).toISOString();
    time.textContent = timeText(evidence.t);
    header.append(type, time);
    const detail = document.createElement('p');
    detail.textContent = evidence.detail;
    const provenance = document.createElement('p');
    provenance.className = 'evidence-provenance';
    provenance.textContent = `Provenance: ${evidence.provenance}`;
    item.append(header, detail, provenance);
    if (evidence.toolUseId) {
      const tool = document.createElement('code');
      tool.textContent = `${evidence.tool ?? 'tool'} · ${evidence.agentId ?? 'agent unknown'} · ${evidence.toolUseId} · ${evidence.state ?? evidence.outcome ?? 'outcome unknown'}`;
      item.append(tool);
    }
    list.append(item);
  }
  section.append(list);
  return section;
}

function openEvidence(id, returnFocus) {
  const descriptor = descriptorById.get(id);
  if (!descriptor) return;
  evidenceReturnFocus = returnFocus;
  evidenceTitle.textContent = descriptor.label;
  evidenceBody.replaceChildren();

  const facts = document.createElement('dl');
  facts.className = 'evidence-facts';
  addFact(facts, 'Type', titleCase(descriptor.kind));
  addFact(facts, 'Phase / stage', `${titleCase(descriptor.phase ?? descriptor.kind)}${descriptor.stage ? ` / ${titleCase(descriptor.stage)}` : ''}`);
  addFact(facts, 'Labeled duration', durationText(descriptor.durationMs));
  addFact(facts, 'Recorded session portion', Number.isFinite(descriptor.percent)
    ? `${descriptor.percent.toFixed(1)}%`
    : null);
  addFact(facts, 'Start', timeText(descriptor.startT));
  addFact(facts, 'End', timeText(descriptor.endT));
  addFact(facts, 'Occurred', Number.isFinite(descriptor.occurredAt)
    ? timeText(descriptor.occurredAt)
    : null);
  addFact(facts, 'Observed', Number.isFinite(descriptor.observedAt)
    ? timeText(descriptor.observedAt)
    : null);
  addFact(facts, 'Outcome', descriptor.outcome);
  addFact(facts, 'Confidence', titleCase(descriptor.confidence));
  addFact(facts, 'Source', descriptor.source);
  addFact(facts, 'Evidence count', descriptor.evidenceEventIds.length);
  addFact(facts, 'Recorded truth', descriptor.recordedTruth);
  addFact(facts, 'Current truth', descriptor.currentTruth);
  addFact(facts, 'Stack', descriptor.stackTruth);
  evidenceBody.append(facts, evidenceList(descriptor));

  const links = document.createElement('div');
  links.className = 'evidence-links';
  const replay = document.createElement('a');
  replay.href = descriptor.replayHref;
  replay.textContent = 'Replay from this evidence';
  links.append(replay);
  if (descriptor.githubHref) {
    const github = document.createElement('a');
    github.href = descriptor.githubHref;
    github.target = '_blank';
    github.rel = 'noreferrer';
    github.textContent = `Open PR #${descriptor.number} on GitHub`;
    links.append(github);
  }
  evidenceBody.append(links);
  drawer.hidden = false;
  document.body.classList.add('evidence-open');
  evidenceClose.focus();
}

function closeEvidence() {
  if (drawer.hidden) return;
  drawer.hidden = true;
  document.body.classList.remove('evidence-open');
  evidenceReturnFocus?.focus();
  evidenceReturnFocus = null;
}

async function loadSession(id) {
  sessionId = id || null;
  viewContext = { ...viewContext, session: sessionId };
  syncNavigation();
  clearSessionView();
  setPageState('loading');
  const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
  try {
    const response = await fetch(`/events${query}`);
    if (!response.ok) throw new Error(`events request failed (${response.status})`);
    const text = await response.text();
    events = text.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(event => event && Number.isFinite(event.t) && typeof event.type === 'string')
      .sort((a, b) => a.t - b.t);

    const displayNow = viewContext.mode === 'replay'
      ? (viewContext.cursorT ?? viewContext.cutoffT ?? events.at(-1)?.t ?? 0)
      : Date.now();
    insights = buildSessionInsights(events, {
      untilT: viewContext.cutoffT ?? Infinity,
      asOfT: viewContext.asOfT,
      displayNow,
    });

    if (!insights.visiblePrefix.length) {
      clearSessionView();
      setPageState('empty');
      return;
    }

    const state = fold(insights.visiblePrefix);
    const meta = sessionsMeta.find(session => session.id === sessionId) ?? null;
    const title = state.session.title || meta?.title || sessionId || 'session';
    document.title = `lanes — ${title}`;
    $('#session-title').textContent = title;
    const agent = state.session.agent || meta?.agent;
    const badge = $('#agent-badge');
    if (agent) {
      badge.textContent = agent;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }

    model = buildModel(events, insights, viewContext);
    descriptorById = new Map(model.descriptors.map(descriptor => [descriptor.id, descriptor]));
    renderSummary();
    setPageState('ready');
    sizeCanvas();
  } catch (error) {
    clearSessionView();
    setPageState('error', `Unable to load this session. ${error.message}`);
  }
}

async function load() {
  syncNavigation();
  // Replay avoids the present-day session index entirely. It performs only the
  // one-shot /events read, then applies the shared cutoff before folding.
  if (viewContext.mode === 'replay') {
    $('#session-picker').hidden = true;
    await loadSession(sessionId);
    return;
  }

  const picker = await initSessionPicker({
    mount: $('#session-picker'),
    currentId: sessionId,
    onSelect: id => {
      viewContext = { ...viewContext, session: id };
      history.replaceState(null, '', viewHref('/lanes', viewContext));
      loadSession(id);
    },
  });
  sessionsMeta = picker.sessions;
  if (picker.multi) $('#session-title').hidden = true;
  await loadSession(picker.current);
}

preflightToggle.addEventListener('click', () => {
  preflightExpanded = !preflightExpanded;
  preflightToggle.setAttribute('aria-expanded', String(preflightExpanded));
  sizeCanvas();
});
itemOverlayToggle.addEventListener('change', sizeCanvas);
activityOverlayToggle.addEventListener('change', draw);
evidenceClose.addEventListener('click', closeEvidence);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !drawer.hidden) {
    event.preventDefault();
    closeEvidence();
  }
});
window.addEventListener('resize', sizeCanvas);

load();
