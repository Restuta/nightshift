---
name: nightshift
description: Start (or stop) nightshift recording for THIS session and open the live board — works in both Claude Code and Codex. Use when the user types /nightshift, or asks to record/track/watch the current session on the nightshift board. Recording is per-session and off by default; other sessions are unaffected.
---

# /nightshift — record this session, open the board

Read `~/.nightshift/install.json` for paths (`{ repo }`). If it's missing, the
one-time install hasn't run — tell the user to run `node <repo>/tools/install-global.js`
(Claude Code) or `node <repo>/tools/install-codex.js` (Codex), then retry.

**Detect the host first** — it decides how recording is wired:
```sh
[ -n "$CLAUDE_CODE_SESSION_ID" ] && echo claude || echo codex
```
Both record live via hooks gated on a per-session marker (Codex implements
Claude's hook contract). Codex additionally runs a thin "meter" tail of its
rollout for the few things hooks don't carry — token cost, PR/CI state, and the
quiet signal for idle. Either way the board is the same.

Parse the argument (default `on`). Set up once for every branch:
```sh
REPO=$(node -e 'console.log(require(require("os").homedir()+"/.nightshift/install.json").repo)')
LOG=$(node "$REPO/tools/resolve-log.js")
SLUG=$(basename "$LOG" .jsonl)
```

## `/nightshift` / `/nightshift on`

First decide whether a tape already exists for this project, and whether it's
already being recorded:
```sh
EVENTS=$([ -f "$LOG" ] && wc -l < "$LOG" | tr -d ' ' || echo 0)
# Claude records via hooks gated on a per-session marker ($CLAUDE_CODE_SESSION_ID).
# Codex may be in hook mode (marker) OR tailer-fallback mode (a worker, no marker),
# so detect its recorder by asking the tailer whether a worker is live.
if [ -n "$CLAUDE_CODE_SESSION_ID" ]; then
  [ -f ~/.nightshift/active/"$CLAUDE_CODE_SESSION_ID" ] && LIVE=live || LIVE=off
else
  LIVE=$(node "$REPO/tools/codex-tail.js" --status --log "$LOG")
fi
```

Branch on that:

- **Already recording** (`LIVE` = `live`): don't ask, don't reset. For **Codex**,
  still run `node "$REPO/tools/codex-recorder.js" "$LOG"` (idempotent — it restarts
  the recorder if it died). Then skip to *Open the board*.
- **An existing tape, not currently recording** (`LIVE` = `off` and `EVENTS` >
  0): the tape is left over from an earlier session/run. **Ask the user and wait
  for their answer** — do not start recording until they choose:
  > Found an existing nightshift tape for this project (`$EVENTS` events).
  > **Reset** to a fresh board for this session, or **continue** onto it?
  - **Reset** → run *Reset (archive the old tape)*, then *Start*, then *Open*.
  - **Continue** → *Start*, then *Open* (the old tape is kept and appended to).
- **No tape** (`EVENTS` = 0): *Start*, then *Open*.

### Reset (archive the old tape)
Archives, never deletes — the board ignores `*.bak-*` so old tapes vanish from
the switcher but stay on disk:
```sh
[ -n "$CLAUDE_CODE_SESSION_ID" ] || node "$REPO/tools/codex-tail.js" --stop --log "$LOG"
[ -s "$LOG" ] && mv "$LOG" "$LOG.bak-$(date +%s)"
# Codex: drop the per-session turn state so the fresh tape starts at turn 1 and
# doesn't write a stale 'done' for the archived card.
[ -n "$CODEX_THREAD_ID" ] && rm -f ~/.nightshift/turns/"$CODEX_THREAD_ID".json
```

### Start
**Claude Code** — mark the session, emit the opening event:
```sh
mkdir -p ~/.nightshift/active && touch ~/.nightshift/active/"$CLAUDE_CODE_SESSION_ID"
node "$REPO/tools/emit.js" session --phase start --agent claude --title "$(basename "$PWD")" --cwd "$PWD" --log "$LOG"
```

**Codex** — start recording; `codex-recorder` picks the path automatically and
prints which (`hook` or `tail`): **hook** recording + thin meter for a session
that started after the hook was installed, or the **full rollout tailer** (pinned
to this session, backfilling it) for one that predates the hook — since Codex
loads hooks only at session start.
```sh
node "$REPO/tools/codex-recorder.js" "$LOG"
```

### Open the board
```sh
node "$REPO/tools/board.js" --open --session "$SLUG"
```
Tell the user recording is **on for this session only**, give them the URL
`board.js` printed, and mention `/nightshift off` to stop.

## `/nightshift reset`
Reset without asking: run *Reset (archive the old tape)*, then *Start*, then
*Open the board*. Confirm the board is a fresh tape for this session.

## `/nightshift off` (or `stop`)
```sh
# Claude Code:
rm -f ~/.nightshift/active/"$CLAUDE_CODE_SESSION_ID"
# Codex (drop the marker so hooks stop recording, and stop the meter):
rm -f ~/.nightshift/active/"$CODEX_THREAD_ID"
node "$REPO/tools/codex-tail.js" --stop --log "$LOG"
# both:
node "$REPO/tools/emit.js" session --phase idle --log "$LOG"
```
Confirm recording is paused (the tape is kept).

## `/nightshift watch`
Just reopen the board: `node "$REPO/tools/board.js" --open --session "$SLUG"`.

## `/nightshift status`
Report the host, whether recording is on (Claude: marker file exists; Codex: an
entry for `$LOG` in `~/.nightshift/codex-tails.json` with a live pid), `$LOG`,
and its event count (`wc -l`).

Keep replies to one or two lines — this is a recorder, not a chat.
