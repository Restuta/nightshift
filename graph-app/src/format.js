// View-side formatting + text measurement, ported from the SVG graph.js so the
// React Flow nodes keep the exact same wording, wrapping and geometry. This is
// display logic (the view we replaced owns it) — the pure models stay untouched
// on the server.

export const NOW_TTL = 10 * 60e3; // same 10-min re-tense TTL as the board

const pad = n => String(n).padStart(2, '0');

export function ageText(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function costText(c) {
  if (!c) return '$0';
  return c >= 1 ? `$${c.toFixed(2)}` : `$${c.toFixed(3)}`;
}

export function hhmm(t) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dateTime(t) {
  const d = new Date(t);
  return `${MON[d.getMonth()]} ${d.getDate()} ${hhmm(t)}`;
}

// Decimal hours ("9.1h"), minutes under an hour — same unit as /story.
export function fmtSpan(ms) {
  if (!(ms > 0)) return '0m';
  const h = ms / 3600e3;
  if (h >= 1) return `${h.toFixed(1)}h`;
  const m = Math.floor(ms / 60e3);
  return m >= 1 ? `${m}m` : `${Math.floor(ms / 1000)}s`;
}

export const fmtNum = n => Number(n || 0).toLocaleString();

// ------------------------------------------------------------- text measure
// Canvas-based truncate/wrap, identical to graph.js, so node heights are a
// deterministic function of the data (single-pass layout, no measure loop).
const meas = document.createElement('canvas').getContext('2d');

export const SANS = "13px 'Inter', system-ui, sans-serif";
export const SANS_SM = "11px 'Inter', system-ui, sans-serif";
export const SANS_STEP = "11.5px 'Inter', system-ui, sans-serif";
export const MONO_SM = "10.5px 'IBM Plex Mono', ui-monospace, monospace";

export function truncate(text, maxW, font) {
  meas.font = font;
  text = String(text == null ? '' : text);
  if (meas.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && meas.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

export function wrapLines(str, maxW, font, maxLines) {
  meas.font = font;
  str = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
  if (!str) return [];
  const words = str.split(' ');
  const lines = [];
  let cur = '', idx = 0;
  while (idx < words.length && lines.length < maxLines) {
    const trial = cur ? cur + ' ' + words[idx] : words[idx];
    if (!cur || meas.measureText(trial).width <= maxW) { cur = trial; idx++; }
    else { lines.push(cur); cur = ''; }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (idx < words.length && lines.length) {
    lines[lines.length - 1] += ' ' + words.slice(idx).join(' ');
  }
  return lines.map(l => truncate(l, maxW, font));
}

export function measureText(text, font) {
  meas.font = font;
  return meas.measureText(String(text == null ? '' : text)).width;
}
