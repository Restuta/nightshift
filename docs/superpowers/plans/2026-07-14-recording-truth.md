# Recording Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make newly attached sessions record their current turn, notification intent, tool lifecycle, and PR reconciliation durably enough for the semantic model to tell the truth.

**Architecture:** A small attachment state machine reserves a deterministic turn id and is claimed atomically by the next eligible tool hook. Hook producers add structured notification and tool lifecycle events without inventing unsupported failure signals. Polling becomes one server-supervised, lease-protected append-only writer; the skill registers sessions but never spawns a competing detached worker.

**Tech Stack:** Node.js 18+, filesystem atomic rename and exclusive-create leases, Claude/Codex hooks, node:test, existing poll-github one-shot worker.

## Global Constraints

- Recovery is append-only, idempotent, and session-scoped.
- Meta prompts, task notifications, system reminders, and local-command output are never recovered as a human turn.
- Missing or truncated transcripts leave the sentinel retryable.
- Stop closes a conversational turn, not an active work item or subagent task.
- Only notification reasons permission and question set needsInput.
- PostToolUse proves success only when a matching PreToolUse identity exists.
- Stop or SessionEnd may close an unmatched tool start only as outcome unknown.
- Host hook names not observed in this repository are not invented.
- The board server is the sole poller supervisor.
- Poll retention defaults to 24 hours and is configurable with NIGHTSHIFT_PR_RETENTION_MS.
- Root runtime remains zero dependency.

---

## File Structure

- Create tools/turn-attachment.js: sentinel request, claim, recovery, and cancellation state machine.
- Modify hooks/agent-hook.js: shared turn creation, attachment claim, notification reasons, tool lifecycles.
- Modify tools/install-global.js, tools/install-codex.js, tools/attach.js: symmetric PreToolUse/PostToolUse installation.
- Modify skills/nightshift/SKILL.md: request/cancel attachment and register polling.
- Modify public/reducer.js and public/fleet-summary.js: notification compatibility and actionable input.
- Create tools/poller-registration.js: atomic registrations and durable leases.
- Modify server.js and tools/poll-github.js: sole-owner scheduled reconciliation.
- Extend test/agent-hook.test.mjs and add test/hook-installers.test.mjs, test/notification-semantics.test.mjs, test/tool-lifecycle.test.mjs, test/poller-supervision.test.mjs.

### Task 1: Recover exactly one mid-turn attachment

**Files:**
- Create: tools/turn-attachment.js
- Modify: hooks/agent-hook.js
- Modify: skills/nightshift/SKILL.md
- Modify: test/agent-hook.test.mjs

**Interfaces:**
- Produces: requestAttachment({sid, log, transcriptPath, activatedAt}), claimAttachment({sid, log, transcriptPath}), cancelAttachment({sid, reason}).
- claimAttachment returns {status, turnId, prompt, promptT}; status is adopted_existing, recovered, consumed, retryable_missing_transcript, or cancelled_by_next_prompt.

- [ ] **Step 1: Add failing end-to-end recovery tests**

Extend the hook sandbox with an attachment directory and a real JSONL transcript. Assert: starting after UserPromptSubmit then firing PostToolUse appends one deterministic doing turn; duplicate delivery and concurrent claims still leave one item; a crash after append is repaired without a duplicate; meta-only or truncated transcript stays retryable; an existing open card is adopted; next normal UserPromptSubmit cancels an unused reservation.

- [ ] **Step 2: Run RED**

Run: node --test test/agent-hook.test.mjs

Expected: FAIL because attachment state is not requested or claimed.

- [ ] **Step 3: Implement the atomic state machine**

Use attachments/<sid>.json, attachments/<sid>.lease, temp-file plus rename, and wx lease creation. Reserve turn-<sid8>-<next sequence> by scanning the tape. Before append, scan for the reserved id. Parse transcript records from newest to oldest and accept only role=user human content; reject payloads tagged task-notification, system-reminder, local-command, or isMeta. Release a stale lease after 30 seconds using its recorded pid/time. Do not mark consumed until the deterministic item exists in the tape.

- [ ] **Step 4: Integrate the hook and skill**

Refactor normal turn creation into openTurn({id,title,promptT,sessionId}). At the very start of PostToolUse, claim the attachment before reading current turn state, then attach the current task snapshot. UserPromptSubmit finalizes a recovered card or cancels an unused reservation before opening its own turn. Reset/off cancels attachment state; start writes the active marker, requests attachment, then backfills tasks; continue preserves tape numbering.

- [ ] **Step 5: Verify and commit**

Run: node --test test/agent-hook.test.mjs

Expected: PASS.

Run: npm test

Expected: all tests pass.

~~~bash
git add tools/turn-attachment.js hooks/agent-hook.js skills/nightshift/SKILL.md test/agent-hook.test.mjs
git commit -m "fix: recover mid-turn nightshift attachment"
~~~

### Task 2: Record notification reasons and tool lifecycles

**Files:**
- Modify: hooks/agent-hook.js
- Modify: public/reducer.js
- Modify: public/fleet-summary.js
- Modify: tools/install-global.js
- Modify: tools/install-codex.js
- Modify: tools/attach.js
- Add: test/hook-installers.test.mjs
- Add: test/notification-semantics.test.mjs
- Add: test/tool-lifecycle.test.mjs

**Interfaces:**
- Consumes: event shapes documented by the semantic-core plan.
- Produces: notification.reason and tool_call compound lifecycles.

- [ ] **Step 1: Add failing producer and consumer tests**

Assert Stop then next_prompt remains idle/turn complete; permission and question alone request input; later tool/resume/idle/end clears actionable attention; legacy session attention remains readable. Assert PreToolUse/PostToolUse emits start/success with identical sessionId, agentId, toolUseId; two agents with the same tool id remain isolated; Stop and SessionEnd close open starts as unknown. Assert all three installers add symmetric PreToolUse/PostToolUse matchers idempotently and preserve user hooks.

- [ ] **Step 2: Run RED**

Run: node --test test/notification-semantics.test.mjs test/tool-lifecycle.test.mjs test/hook-installers.test.mjs

Expected: FAIL because the structured producers and installers do not exist.

- [ ] **Step 3: Implement structured notification folding**

Map only structured subtype fields from the hook payload. Unknown values become system_notice. Append {type:'notification',reason,text}. In reducer state keep unresolvedInputReason; permission/question set it, informational reasons preserve the current phase, and later work/resume/idle/end clears it. Keep the legacy session phase attention branch. fleet-summary derives needsInput from permission/question only.

- [ ] **Step 4: Implement tool lifecycle production**

On PreToolUse with an id, append a start. On PostToolUse with the same id, append success. Use sessionId from payload/environment, agentId from payload or 'main', and toolUseId from tool_use_id/toolUseId. Persist open identities in session-scoped hook state so Stop/SessionEnd can append unknown terminal events. When no id exists, retain the existing legacy tool point event and emit no synthetic lifecycle.

- [ ] **Step 5: Install symmetric hooks**

Add PreToolUse alongside existing PostToolUse in the global, Codex, and attached installers, using each installer’s existing tool matcher. Preserve foreign hook arrays and idempotent reruns. Do not register failure/cancel event names.

- [ ] **Step 6: Verify and commit**

Run: node --test test/notification-semantics.test.mjs test/tool-lifecycle.test.mjs test/hook-installers.test.mjs

Expected: PASS.

Run: npm test

Expected: all tests pass.

~~~bash
git add hooks/agent-hook.js public/reducer.js public/fleet-summary.js tools/install-global.js tools/install-codex.js tools/attach.js test/hook-installers.test.mjs test/notification-semantics.test.mjs test/tool-lifecycle.test.mjs
git commit -m "feat: record actionable notifications and tool lifecycles"
~~~

### Task 3: Move PR reconciliation to one durable server supervisor

**Files:**
- Create: tools/poller-registration.js
- Modify: server.js
- Modify: tools/poll-github.js
- Modify: skills/nightshift/SKILL.md
- Add: test/poller-supervision.test.mjs
- Modify: test/supervision.test.mjs

**Interfaces:**
- Produces: registerSession({log,sessionId,cwd}), unregisterSession({log,sessionId}), listRegistrations(), acquireLease(key), releaseLease(key).
- Server scheduler constants: FRESH_MS=15000, IDLE_MS=60000, STALE_MS=300000, RECONCILE_RETENTION_MS=86400000 by default.

- [ ] **Step 1: Add failing registration, lease, and cadence tests**

Use temp NIGHTSHIFT_HOME, a fake one-shot poller executable, and fake time injection. Assert atomic repo/session registration, repo-qualified identities, two servers produce one poll, dead lease recovery, 15s/60s/5m cadence, exponential error backoff, immediate scheduling after pr_ref, restart recovery without SSE clients, terminal/retention stop, and no poll for replay-only requests.

- [ ] **Step 2: Run RED**

Run: node --test test/poller-supervision.test.mjs test/supervision.test.mjs

Expected: FAIL because durable registrations and leases do not exist.

- [ ] **Step 3: Implement durable registration and leasing**

Canonicalize realpath(log), key registrations by a stable hash of realpath plus sessionId, store JSON under poller-sessions, and lease under poller-leases using wx. Atomic writes use temp plus rename. A lease record contains owner pid, acquiredAt, expiresAt, log, and sessionId. Dead/expired owners are replaceable; live owners are not.

- [ ] **Step 4: Implement the server scheduler**

Load registrations at startup, inspect the append-only tape for lifecycle/PR state, choose fresh/idle/stale cadence, apply bounded concurrency 2 and exponential backoff capped at five minutes, and call poll-github --once --known. Newly observed pr_ref makes nextDue immediate. Record poller_status success/error/expired events so every view can expose freshness. HTTP replay requests never register or trigger reconciliation; live SSE clients may accelerate the same scheduler but never own a second writer.

- [ ] **Step 5: Remove the competing detached worker**

Change the Nightshift skill start/continue path to call poller-registration register and off/reset to unregister as appropriate. Retain poll-github --once --known as the server executor, but remove its detached registry/max-life mode only after server tests are green.

- [ ] **Step 6: Verify and commit**

Run: node --test test/poller-supervision.test.mjs test/supervision.test.mjs

Expected: PASS.

Run: npm test

Expected: all tests pass.

~~~bash
git add tools/poller-registration.js server.js tools/poll-github.js skills/nightshift/SKILL.md test/poller-supervision.test.mjs test/supervision.test.mjs
git commit -m "fix: supervise PR reconciliation durably"
~~~

## Self-Review

- Spec coverage: mid-turn attach, idempotency, notification severity, tool start/end, closure semantics, hook installation, sole poller ownership, recovery, cadence, diagnostics, and no replay polling are assigned.
- Placeholder scan: the retention decision is fixed at 24 hours with an environment override.
- Type consistency: hook event shapes match the semantic-core contract and server reconciliation remains append-only.
