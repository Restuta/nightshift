// Runtime loader for nightshift's PURE models. These are browser-ready ES
// modules served from the board server's /public — the SAME files the board,
// /lanes and /story import. They are deliberately NOT bundled: a merged fix to
// reducer.js or graph-model.js goes live on this app with zero rebuilds, which
// is the repo's "no build step" invariant surviving in spirit. The
// /* @vite-ignore */ comments keep Vite from trying to resolve or inline them.
let cached = null;

export async function loadModels() {
  if (cached) return cached;
  const [
    reducer, graphModel, turnId, sessionLabel, sessionPicker,
    sessionInsights, sessionSummary, sessionViewContext,
  ] = await Promise.all([
    import(/* @vite-ignore */ '/reducer.js'),
    import(/* @vite-ignore */ '/graph-model.js'),
    import(/* @vite-ignore */ '/turn-id.js'),
    import(/* @vite-ignore */ '/session-label.js'),
    import(/* @vite-ignore */ '/session-picker.js'),
    import(/* @vite-ignore */ '/session-insights-model.js'),
    import(/* @vite-ignore */ '/session-summary.js'),
    import(/* @vite-ignore */ '/session-view-context.js'),
  ]);
  cached = {
    fold: reducer.fold,
    buildGraphModel: graphModel.buildGraphModel,
    COLUMNS: graphModel.COLUMNS,
    turnLabel: turnId.turnLabel,
    sessionLabel: sessionLabel.sessionLabel,
    initSessionPicker: sessionPicker.initSessionPicker,
    buildSessionInsights: sessionInsights.buildSessionInsights,
    buildSummaryViewModel: sessionSummary.buildSummaryViewModel,
    parseViewContext: sessionViewContext.parseViewContext,
    viewHref: sessionViewContext.viewHref,
  };
  return cached;
}
