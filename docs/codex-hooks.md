# Codex via hooks — design (and why this PR is just the probe)

## The realization
Codex (current CLI / v149 app) implements **Claude Code's hook system**: `~/.codex/hooks.json`
uses the same schema (`PreToolUse`, `SessionStart`, `matcher`, `type:"command"`), the same
JSON-on-stdin payload (a shared `PreToolUse` script reads `input=$(cat) | jq -r '.tool_input.command'`),
and a hook **trust** model (`config.toml [hooks.state]`, `codex --dangerously-bypass-hook-trust`).

So nightshift's founding premise — *"Codex has no per-tool hooks → tail the rollout"* — is obsolete.
Today's Codex recording (`tools/codex-tail.js`) reverse-engineers session identity from anonymous
rollout files by heuristic (newest-mtime, cwd match, `findSuccessor` rotation). That guessing is the
root of a whole class of reliability bugs: wrong rollout at start, a new session or a **subagent**
rollout getting bridged onto the tape, duplicate workers, idle mis-fires, statefile races. Hooks
deliver the session identity and per-tool facts *at the source* — no guessing.

## It's a HYBRID, not a pivot
Two independent reviews (verified against 30+ real rollouts and the live trust state) established that
hooks **cannot** deliver everything the tailer does:

| Fact (today, from the rollout) | Via hooks? |
|---|---|
| edits (`apply_patch`), plan (`update_plan`), commits/activity (`exec_command`) | **Yes** — `PostToolUse` |
| per-turn card boundary (`user_message`) | **Yes** — `UserPromptSubmit` (needs turn-card synthesis, below) |
| token counts → usage/cost | **No** — it's a rollout `event_msg`, not a tool call |
| PR-merge narration (`agent_message`) | **No** — model prose, not a tool call |
| idle / card retirement | **No** — Codex fires **no `Stop` event** |

Confirmed Codex hook events that actually fire: **`session_start`, `user_prompt_submit`,
`pre_tool_use`, `post_tool_use`** (no `stop`, no `notification`, no `session_end`).
Confirmed tool names: **`exec_command`** (not Claude's `Bash`/`shell`), **`apply_patch`**,
**`update_plan`**, plus `spawn_agent`/`close_agent`/`wait_agent` for subagents.

So the target architecture is:
- **Hooks** own identity + per-tool facts (edits, plan→todos, commits, exec activity, per-turn cards).
- **A thin, always-on tail** owns only what hooks structurally can't carry: `token_count`→usage/cost,
  `agent_message`→PR-merge narration, and idle→card-retirement. (`findSuccessor` rotation stays only
  if the thin tail needs it; identity no longer depends on it.)

This is *add a hook path + slim the tail*, not *replace the tail*. Net maintenance rises short-term;
the payoff is identity reliability (no wrong-rollout / dup-worker / bridging bugs).

## Two blockers that gate the architecture — must be confirmed on a live Codex session
1. **Subagents share the parent's cwd** (33 of 40 recent rollouts are `thread_source:subagent`, all in
   the parent's dir). Global hooks fire for subagent tool calls too, so a per-cwd gate would firehose
   subagent activity onto the parent tape. We must know whether the **payload carries a
   `thread_source`/subagent/parent-id field** to suppress them. (The tailer already filters these;
   the hook path must not lose that.)
2. **Session id** — is it in the payload (gating is per-session) and is there a session-id **env var**
   for the skill to create the opt-in marker? Without it, gating collapses to per-cwd → blocked by (1).

Also unverified: does `PostToolUse` carry `exec_command` **stdout** (commit/PR capture depends on it),
and under what field; exact `tool_input` shape for `apply_patch`/`update_plan`; an agent discriminator
(claude vs codex) in the payload.

## Why this PR is only the probe
The blockers decide the *shape* of the build, and confirming them needs one real Codex session — which
can't be triggered from a Claude session. So this PR ships the one safe, decisive step both reviews
demanded: **production-grade instrumentation** that captures the real payload.

- `tools/hook-probe.js` — capture-only. Appends each raw payload (+ its top-level `keys`) to
  `~/.nightshift/hook-debug.jsonl`, size-capped, fail-open. Records no tape, can't double-record.
- `tools/install-codex.js` — safely registers the probe in `~/.codex/hooks.json`:
  parse-guarded, backed up once, **appended at the end** (Codex trust is index-keyed, so we never
  insert/reorder and never de-trust the user's existing hooks), idempotent, symlink-aware; `--remove`
  strips only our group. (Verified in a sandbox: the user's security hook stays at `PreToolUse[0]`.)

Run one Codex session, approve the hook trust prompt, then read `~/.nightshift/hook-debug.jsonl`.

## Follow-up PR (after the probe confirms the payload)
- `hooks/agent-hook.js` — unified hook (keep `claude-hook.js` working; the Claude installer's MARK must
  match both old and new paths so re-install/`--remove` stays idempotent).
- Codex mapping: `exec_command`/`apply_patch`/`update_plan`; **per-turn card synthesis** in
  `UserPromptSubmit` (close `turn-N`, open `turn-N+1`, stamp `item:` on PostToolUse) with the turn
  counter persisted in a per-session statefile (hooks are separate processes); **subagent suppression**;
  per-session gating (or documented per-cwd degraded mode).
- Thin always-on tail for `token_count`, `agent_message` merge narration, idle/retirement; mutual
  exclusion so hook + tail never double-record.
- Docs: correct the "Codex has no hooks" line in `CLAUDE.md`.
