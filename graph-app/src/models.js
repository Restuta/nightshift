// Runtime loader for nightshift's PURE models. These are browser-ready ES
// modules served from the board server's /public — the SAME files the board,
// /lanes and /story import. They are deliberately NOT bundled: a merged fix to
// reducer.js or graph-model.js goes live on this app with zero rebuilds, which
// is the repo's "no build step" invariant surviving in spirit. The
// /* @vite-ignore */ comments keep Vite from trying to resolve or inline them.
let cached = null;

export async function loadModels() {
  if (cached) return cached;
  const [reducer, graphModel, digest, turnId, sessionLabel, storyModel, sessionPicker] = await Promise.all([
    import(/* @vite-ignore */ '/reducer.js'),
    import(/* @vite-ignore */ '/graph-model.js'),
    import(/* @vite-ignore */ '/digest.js'),
    import(/* @vite-ignore */ '/turn-id.js'),
    import(/* @vite-ignore */ '/session-label.js'),
    import(/* @vite-ignore */ '/story-model.js'),
    import(/* @vite-ignore */ '/session-picker.js'),
  ]);
  cached = {
    fold: reducer.fold,
    liveness: reducer.liveness,
    buildGraphModel: graphModel.buildGraphModel,
    COLUMNS: graphModel.COLUMNS,
    buildDigest: digest.buildDigest,
    turnLabel: turnId.turnLabel,
    sessionLabel: sessionLabel.sessionLabel,
    activeSegments: storyModel.activeSegments,
    initSessionPicker: sessionPicker.initSessionPicker,
  };
  return cached;
}
