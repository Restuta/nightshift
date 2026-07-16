function finiteParam(params, name) {
  const raw = params.get(name);
  if (raw == null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function parseViewContext(search) {
  const params = search instanceof URLSearchParams
    ? search
    : new URLSearchParams(typeof search === 'string' ? search : '');
  const cursorT = finiteParam(params, 't');
  const asOfT = finiteParam(params, 'at');
  const cutoffs = [cursorT, asOfT].filter(Number.isFinite);

  return {
    session: params.get('session') || null,
    cursorT,
    cutoffT: cutoffs.length ? Math.min(...cutoffs) : null,
    asOfT,
    mode: params.has('t') || params.has('at') ? 'replay' : 'live',
  };
}

export function viewHref(path, context) {
  const params = new URLSearchParams();
  if (context?.session) params.set('session', context.session);
  if (Number.isFinite(context?.cursorT)) params.set('t', String(context.cursorT));
  if (Number.isFinite(context?.asOfT)) params.set('at', String(context.asOfT));
  if (context?.mode === 'replay' && !params.has('t') && !params.has('at')) params.set('t', '');
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
