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
rollout for the few things hooks don't carry — token cost, PR sightings, and the
quiet signal for idle. Either way the board is the same.

Parse the argument (default `on`). Set up once for every branch:
```sh
REPO=$(node -e 'console.log(require(require("os").homedir()+"/.nightshift/install.json").repo)')
LOG=$(node "$REPO/tools/resolve-log.js")
SLUG=$(basename "$LOG" .jsonl)
POLL_SID=${CLAUDE_CODE_SESSION_ID:-$CODEX_THREAD_ID}
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
  # Codex is live if hooks are recording (marker exists) OR a tailer/meter worker
  # is up — a hook-mode session with a dead meter is still recording.
  if { [ -n "$CODEX_THREAD_ID" ] && [ -f ~/.nightshift/active/"$CODEX_THREAD_ID" ]; } \
     || [ "$(node "$REPO/tools/codex-tail.js" --status --log "$LOG")" = live ]; then LIVE=live; else LIVE=off; fi
fi
```

Branch on that:

- **Already recording** (`LIVE` = `live`): don't ask, don't reset. For **Codex**,
  still run `node "$REPO/tools/codex-recorder.js" "$LOG"` (idempotent — it restarts
  the recorder if it died). For **Claude**, re-run the task backfill from *Start*.
  For both hosts, re-run the poller registration line from *Start* (atomic and
  idempotent), then skip to *Open the board*.
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
# Cancel any unclaimed mid-turn reservation before its tape is archived. A new
# Start below will reserve turn 1 against the fresh tape; Continue never archives,
# so its reservation scans and preserves the existing tape numbering.
ATTACH_SID=${CLAUDE_CODE_SESSION_ID:-$CODEX_THREAD_ID}
if [ -n "$ATTACH_SID" ]; then
  if ! node "$REPO/tools/turn-attachment.js" cancel --sid "$ATTACH_SID" --reason reset; then
    echo "nightshift: failed to cancel the turn attachment; reset aborted before archiving." >&2
    exit 1
  fi
fi
# Remove the durable supervisor registration before rotating its tape.
if [ -n "$POLL_SID" ]; then
  if ! node "$REPO/tools/poller-registration.js" unregister --log "$LOG" --session "$POLL_SID" --drain; then
    echo "nightshift: PR reconciliation did not drain; reset aborted before archiving." >&2
    exit 1
  fi
fi
[ -n "$CLAUDE_CODE_SESSION_ID" ] || node "$REPO/tools/codex-tail.js" --stop --log "$LOG"
[ -s "$LOG" ] && mv "$LOG" "$LOG.bak-$(date +%s)"
# Drop the per-session turn state so the fresh tape starts at turn 1 and doesn't
# write a stale 'done' for the archived card. Both agents synthesize per-turn
# cards now (Claude in central recordings), so clear whichever id this host has.
[ -n "$CODEX_THREAD_ID" ] && rm -f ~/.nightshift/turns/"$CODEX_THREAD_ID".json
[ -n "$CLAUDE_CODE_SESSION_ID" ] && rm -f ~/.nightshift/turns/"$CLAUDE_CODE_SESSION_ID".json
# Drop the Claude task-list state too, so the fresh tape re-seeds from the
# transcript instead of tailing from a stale byte offset.
[ -n "$CLAUDE_CODE_SESSION_ID" ] && rm -f ~/.nightshift/tasks/"$CLAUDE_CODE_SESSION_ID".json
```

### Start
**Claude Code** — mark the session, emit the opening event:
```sh
mkdir -p ~/.nightshift/active && touch ~/.nightshift/active/"$CLAUDE_CODE_SESSION_ID"
# UserPromptSubmit already fired before this skill could create the marker. Reserve
# its deterministic card now; the next PostToolUse atomically recovers the newest
# real human prompt from this session's transcript.
if ! node "$REPO/tools/turn-attachment.js" request --sid "$CLAUDE_CODE_SESSION_ID" --log "$LOG" --cwd "$PWD"; then
  echo "nightshift: failed to reserve the current turn; recording was not started." >&2
  rm -f ~/.nightshift/active/"$CLAUDE_CODE_SESSION_ID"
  exit 1
fi
node "$REPO/tools/emit.js" session --phase start --agent claude --title "$(basename "$PWD")" --cwd "$PWD" --log "$LOG"
# Backfill before this Bash invocation returns: its PostToolUse is the claim that
# opens the recovered card, and can attach this freshly seeded task snapshot.
node "$REPO/tools/backfill-tasks.js" --log "$LOG" --sid "$CLAUDE_CODE_SESSION_ID" --cwd "$PWD" 2>/dev/null || true
```
Claude's task tools (TaskCreate/TaskUpdate) live only in the transcript and aren't
in the hook matcher, so that one-time backfill seeds the current task list; the
hook then keeps it live by tailing the transcript on each tool call.

**Codex** — start recording; `codex-recorder` picks the path automatically and
prints which (`hook` or `tail`): **hook** recording + thin meter for a session
that started after the hook was installed, or the **full rollout tailer** (pinned
to this session, backfilling it) for one that predates the hook — since Codex
loads hooks only at session start.
```sh
node "$REPO/tools/codex-recorder.js" "$LOG"
```

**Both hosts** — register this session for the board server's durable PR/CI
supervisor. The server is the sole scheduler/writer; it invokes the session-scoped
one-shot poller under a lease, survives restarts, and needs no open viewer:
```sh
# BEGIN_CHECKED_POLLER_REGISTRATION
if [ -n "$POLL_SID" ]; then
  if ! node "$REPO/tools/poller-registration.js" register --log "$LOG" --session "$POLL_SID" --cwd "$PWD"; then
    echo "nightshift: PR supervisor registration failed; recording was not started." >&2
    ATTACH_SID=${CLAUDE_CODE_SESSION_ID:-$CODEX_THREAD_ID}
    if [ -n "$ATTACH_SID" ]; then
      node "$REPO/tools/turn-attachment.js" cancel --sid "$ATTACH_SID" --reason poller-registration-failed >/dev/null 2>&1 || true
    fi
    [ -n "$CLAUDE_CODE_SESSION_ID" ] && rm -f ~/.nightshift/active/"$CLAUDE_CODE_SESSION_ID"
    [ -n "$CODEX_THREAD_ID" ] && rm -f ~/.nightshift/active/"$CODEX_THREAD_ID"
    if [ -z "$CLAUDE_CODE_SESSION_ID" ]; then
      node "$REPO/tools/codex-tail.js" --stop --log "$LOG" >/dev/null 2>&1 || true
    fi
    node "$REPO/tools/emit.js" session --phase idle --log "$LOG" >/dev/null 2>&1 || true
    exit 1
  fi
fi
# END_CHECKED_POLLER_REGISTRATION
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
# Prevent a late PostToolUse from claiming a reservation after recording stops.
ATTACH_SID=${CLAUDE_CODE_SESSION_ID:-$CODEX_THREAD_ID}
if [ -n "$ATTACH_SID" ]; then
  if ! node "$REPO/tools/turn-attachment.js" cancel --sid "$ATTACH_SID" --reason off; then
    echo "nightshift: failed to cancel the turn attachment; recording remains on." >&2
    exit 1
  fi
fi
# Cancel and drain PR reconciliation before stopping recorders or mutating their
# markers; a timeout leaves the whole recording path intact and retryable.
if [ -n "$POLL_SID" ]; then
  if ! node "$REPO/tools/poller-registration.js" unregister --log "$LOG" --session "$POLL_SID" --drain; then
    echo "nightshift: PR reconciliation did not drain; recording remains on." >&2
    exit 1
  fi
fi
# Retire the open per-turn card before dropping the marker — once the marker is
# gone the Stop hook (Claude) / meter (Codex) is gated out and can't close it, so
# it would stick in "doing" on the kept tape. No-op if no card is open.
node "$REPO/tools/retire-turn.js" --log "$LOG"
# Claude Code:
rm -f ~/.nightshift/active/"$CLAUDE_CODE_SESSION_ID"
# Codex (drop the marker so hooks stop recording, and stop the meter):
rm -f ~/.nightshift/active/"$CODEX_THREAD_ID"
node "$REPO/tools/codex-tail.js" --stop --log "$LOG"
# both: mark idle after supervision and recording have stopped.
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
