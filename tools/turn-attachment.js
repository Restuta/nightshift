#!/usr/bin/env node
// Recover the one conversational turn in which /nightshift was enabled.
//
// Hooks are separate processes and the UserPromptSubmit hook has already passed
// by the time the skill creates its active marker. The skill therefore reserves
// a deterministic turn id here; the next PostToolUse claims it under a small
// session-scoped fs lease. The tape remains the commit record: state is never
// marked consumed until the reserved item can be found in the append-only log.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_LEASE_STALE_MS = 30_000;
const DEFAULT_LEASE_WAIT_MS = 2_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

const nsHome = () => process.env.NIGHTSHIFT_HOME || path.join(os.homedir(), '.nightshift');
const attachmentsDir = () => path.join(nsHome(), 'attachments');
const safeSid = sid => String(sid || '').replace(/[^A-Za-z0-9._-]/g, '_');
const sid8 = sid => String(sid || '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 8);
const statePath = sid => path.join(attachmentsDir(), `${safeSid(sid)}.json`);
const leasePath = sid => path.join(attachmentsDir(), `${safeSid(sid)}.lease`);
const duration = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
const leaseStaleMs = () => duration('NIGHTSHIFT_ATTACHMENT_LEASE_STALE_MS', DEFAULT_LEASE_STALE_MS);
const leaseWaitMs = () => duration('NIGHTSHIFT_ATTACHMENT_LEASE_WAIT_MS', DEFAULT_LEASE_WAIT_MS);

function attachmentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function acquireLease(sid) {
  fs.mkdirSync(attachmentsDir(), { recursive: true });
  const file = leasePath(sid);
  const deadline = Date.now() + leaseWaitMs();
  while (Date.now() <= deadline) {
    const acquiredAt = Date.now();
    const record = JSON.stringify({ pid: process.pid, acquiredAt });
    try {
      // One native exclusive write avoids exposing the open-then-fill window of
      // an empty lease file to contenders.
      fs.writeFileSync(file, record, { flag: 'wx' });
      return { file, record };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const existingRaw = (() => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } })();
      const existingStat = (() => { try { return fs.statSync(file); } catch { return null; } })();
      let existing = null;
      try { existing = JSON.parse(existingRaw); } catch { /* incomplete owner write */ }
      const ownerTime = existing && Number.isFinite(existing.acquiredAt)
        ? existing.acquiredAt
        : existingStat && existingStat.mtimeMs;
      if (Number.isFinite(ownerTime) && acquiredAt - ownerTime > leaseStaleMs()) {
        // Only unlink the exact stale record we inspected. If another contender
        // replaced it between read and unlink, leave that new owner's lease alone.
        try {
          const currentStat = fs.statSync(file);
          const sameFile = existingStat && currentStat.ino === existingStat.ino
            && currentStat.mtimeMs === existingStat.mtimeMs
            && currentStat.size === existingStat.size;
          if (sameFile && fs.readFileSync(file, 'utf8') === existingRaw) fs.unlinkSync(file);
        } catch { /* another contender won */ }
        continue;
      }
      Atomics.wait(sleepCell, 0, 0, 5);
    }
  }
  return null;
}

function releaseLease(lease) {
  if (!lease) return;
  try {
    if (fs.readFileSync(lease.file, 'utf8') === lease.record) fs.unlinkSync(lease.file);
  } catch { /* already released/recovered */ }
}

function withLease(sid, fn) {
  const lease = acquireLease(sid);
  if (!lease) throw attachmentError('attachment_lease_unavailable', `attachment lease unavailable for ${sid}`);
  try { return fn(); } finally { releaseLease(lease); }
}

function readTape(log) {
  try {
    return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function maxTurnN(log, namespace) {
  if (!namespace) return 0;
  const pattern = new RegExp(`^turn-${namespace}-(\\d+)$`);
  let max = 0;
  for (const event of readTape(log)) {
    if (event.type !== 'item' || !event.id) continue;
    const match = pattern.exec(event.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

function tapeHasItem(log, turnId) {
  return readTape(log).some(event => event.type === 'item' && event.id === turnId);
}

function openTurnInTape(log, sid) {
  const namespace = sid8(sid);
  if (!namespace) return null;
  const prefix = `turn-${namespace}-`;
  const folded = new Map();
  for (const event of readTape(log)) {
    if (event.type !== 'item' || typeof event.id !== 'string' || !event.id.startsWith(prefix)) continue;
    folded.set(event.id, { ...(folded.get(event.id) || {}), ...event });
  }
  const open = [...folded.values()].filter(item => item.status === 'doing');
  return open.length ? open[open.length - 1].id : null;
}

function promptTitle(prompt) {
  const text = prompt || '';
  const name = text.match(/<command-name>\s*([\s\S]*?)\s*<\/command-name>/);
  if (name) {
    const args = text.match(/<command-args>\s*([\s\S]*?)\s*<\/command-args>/);
    return `${name[1]}${args && args[1].trim() ? ` ${args[1].trim()}` : ''}`.replace(/\s+/g, ' ').slice(0, 64).trim();
  }
  const line = text.split('\n').map(value => value.trim()).find(Boolean) || '';
  return line.replace(/^["'>`*•\-\s]+/, '').slice(0, 64).trim();
}

function humanContent(event) {
  if (!event || event.type !== 'user' || event.isMeta || !event.message || event.message.role !== 'user') return null;
  const content = event.message.content;
  let prompt = null;
  if (typeof content === 'string') {
    prompt = content;
  } else if (Array.isArray(content)) {
    // Claude represents tool delivery as role=user tool_result blocks. A mixed
    // tool-result payload is still external delivery, not human text.
    if (content.some(block => block && block.type === 'tool_result')) return null;
    const text = content.filter(block => block && block.type === 'text' && typeof block.text === 'string').map(block => block.text);
    if (text.length) prompt = text.join('\n');
  }
  if (!prompt || !prompt.trim()) return null;
  const start = prompt.trimStart();
  if (/^<(task-notification|system-reminder|local-command(?:-[^>\s]+)?)(?:>|\s)/.test(start)) return null;
  return prompt;
}

function newestHumanPrompt(transcriptPath, activatedAt) {
  let text;
  try { text = fs.readFileSync(transcriptPath, 'utf8'); } catch { return null; }
  if (!text.trim()) return null;
  const records = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try { records.push(JSON.parse(raw)); }
    catch { return null; } // partial append: retry on the next hook
  }
  for (let index = records.length - 1; index >= 0; index--) {
    const prompt = humanContent(records[index]);
    if (!prompt) continue;
    const parsed = records[index].timestamp ? Date.parse(records[index].timestamp) : NaN;
    return { prompt, promptT: Number.isFinite(parsed) ? parsed : activatedAt };
  }
  return null;
}

function requestAttachment({ sid, log, transcriptPath, activatedAt }) {
  if (!sid || !log) throw attachmentError('attachment_invalid_request', 'request requires sid and log');
  return withLease(sid, () => {
    const file = statePath(sid);
    const current = readJson(file);
    if (current && /^(requested|pending_adoption|boundary_pending)$/.test(current.status)) return current;
    const namespace = sid8(sid);
    const turnN = maxTurnN(log, namespace) + 1;
    const state = {
      version: 1,
      sid,
      log,
      transcriptPath: transcriptPath || null,
      activatedAt: Number.isFinite(Number(activatedAt)) ? Number(activatedAt) : Date.now(),
      turnId: namespace ? `turn-${namespace}-${turnN}` : `turn-${turnN}`,
      status: 'requested',
    };
    atomicWrite(file, state);
    return state;
  });
}

function claimAttachment({ sid, log, transcriptPath }) {
  if (!sid) throw attachmentError('attachment_invalid_request', 'claim requires sid');
  const retryable = { status: 'retryable_missing_transcript', turnId: null, prompt: null, promptT: null };
  return withLease(sid, () => {
    const file = statePath(sid);
    const state = readJson(file);
    if (!state) return null;
    const tape = log || state.log;
    const result = (status, adoptable = true) => ({
      status,
      turnId: adoptable ? (state.claimedTurnId || state.turnId || null) : null,
      prompt: adoptable ? (state.prompt || null) : null,
      promptT: adoptable && state.promptT != null ? state.promptT : null,
    });
    if (state.status === 'cancelled_by_next_prompt') return result('cancelled_by_next_prompt', false);
    // Acknowledged reservations are terminal. In particular, never return their
    // historical turn id to a later PostToolUse.
    if (state.status === 'consumed') return result('consumed', false);
    if (state.status === 'boundary_pending') return result('consumed', false);
    if (state.status === 'pending_adoption') return result(state.claimStatus || 'recovered');

    // A process may have appended the item and died before checkpointing state.
    // The tape wins: repair to pending_adoption, but do not consume until the
    // hook has saved its turn state and explicitly acknowledges.
    if (tape && state.turnId && tapeHasItem(tape, state.turnId)) {
      state.status = 'pending_adoption';
      state.claimedTurnId = state.turnId;
      state.claimStatus = 'recovered';
      atomicWrite(file, state);
      return result('recovered');
    }

    const existing = tape && openTurnInTape(tape, sid);
    if (existing) {
      state.status = 'pending_adoption';
      state.claimedTurnId = existing;
      state.claimStatus = 'adopted_existing';
      atomicWrite(file, state);
      return result('adopted_existing');
    }

    const found = newestHumanPrompt(transcriptPath || state.transcriptPath, state.activatedAt);
    if (!found) return { ...retryable, turnId: state.turnId };

    fs.mkdirSync(path.dirname(tape), { recursive: true });
    if (!tapeHasItem(tape, state.turnId)) {
      fs.appendFileSync(tape, JSON.stringify({
        t: found.promptT,
        source: 'hook',
        v: 2,
        type: 'item',
        id: state.turnId,
        title: promptTitle(found.prompt) || `turn ${maxTurnN(tape, sid8(sid)) + 1}`,
        status: 'doing',
      }) + '\n');
    }
    if (!tapeHasItem(tape, state.turnId)) return { ...retryable, turnId: state.turnId };
    state.status = 'pending_adoption';
    state.claimedTurnId = state.turnId;
    state.claimStatus = 'recovered';
    state.prompt = found.prompt;
    state.promptT = found.promptT;
    atomicWrite(file, state);
    return result('recovered');
  });
}

// A claim is single-use only after the hook has adopted the card into turn state.
// Clearing the adoptable fields prevents any later tool delivery from reopening it.
function ackAttachment({ sid, turnId, adopt }) {
  if (!sid) throw attachmentError('attachment_invalid_request', 'ack requires sid');
  return withLease(sid, () => {
    const file = statePath(sid);
    const state = readJson(file);
    if (!state) return null;
    if (/^(consumed|boundary_pending|cancelled_by_next_prompt)$/.test(state.status)) {
      return { status: 'consumed', turnId: null, prompt: null, promptT: null };
    }
    const claimed = state.claimedTurnId || state.turnId;
    if (turnId && claimed && turnId !== claimed) {
      throw attachmentError('attachment_ack_mismatch', `cannot acknowledge ${turnId}; pending ${claimed}`);
    }
    if (state.status === 'pending_adoption') {
      // Adoption and acknowledgement share this lease with boundaryAttachment.
      // If the boundary won first, status is already terminal and this callback
      // is never invoked; if adoption won, turn state is saved before consume.
      if (typeof adopt === 'function') adopt();
      state.status = 'consumed';
      state.acknowledgedAt = Date.now();
      delete state.claimedTurnId;
      delete state.claimStatus;
      delete state.prompt;
      delete state.promptT;
      atomicWrite(file, state);
    }
    return { status: state.status, turnId: null, prompt: null, promptT: null };
  });
}

// Atomically end attachment eligibility at a conversational boundary. The state
// is terminal before the lease is released, so a delayed PostToolUse can never
// claim an unused or helper-appended reservation after Stop/next prompt. The hook
// may append `done` for a returned id after release because no claim can reopen it.
function boundaryAttachment({ sid, log, reason }) {
  if (!sid) throw attachmentError('attachment_invalid_request', 'boundary requires sid');
  return withLease(sid, () => {
    const file = statePath(sid);
    const state = readJson(file);
    if (!state) return null;
    const tape = log || state.log;
    if (/^(consumed|cancelled_by_next_prompt)$/.test(state.status)) {
      return { status: state.status, turnId: null, prompt: null, promptT: null };
    }

    if (state.status === 'boundary_pending') {
      return {
        status: 'boundary_pending',
        turnId: state.boundaryTurnId || null,
        prompt: state.prompt || null,
        promptT: state.promptT == null ? null : state.promptT,
      };
    }

    let turnId = null;
    if (state.status === 'pending_adoption') turnId = state.claimedTurnId || state.turnId;
    else if (state.status === 'requested' && tape && state.turnId && tapeHasItem(tape, state.turnId)) turnId = state.turnId;

    const result = {
      status: turnId ? 'boundary_pending' : 'cancelled_by_next_prompt',
      turnId,
      prompt: turnId ? (state.prompt || null) : null,
      promptT: turnId && state.promptT != null ? state.promptT : null,
    };
    state.status = turnId ? 'boundary_pending' : 'cancelled_by_next_prompt';
    state.boundaryReason = reason || 'boundary';
    state.boundaryStartedAt = Date.now();
    if (turnId) state.boundaryTurnId = turnId;
    else state.reason = reason || 'boundary';
    delete state.claimedTurnId;
    delete state.claimStatus;
    if (!turnId) {
      delete state.prompt;
      delete state.promptT;
    }
    atomicWrite(file, state);
    return result;
  });
}

// Consume a boundary only after the hook has durably appended `done` and saved
// turn state. If the hook dies first, boundary_pending retains the id and the
// next Stop/UserPromptSubmit repeats the close path idempotently.
function ackBoundaryAttachment({ sid, turnId }) {
  if (!sid) throw attachmentError('attachment_invalid_request', 'boundary ack requires sid');
  return withLease(sid, () => {
    const file = statePath(sid);
    const state = readJson(file);
    if (!state) return null;
    if (state.status === 'consumed') return { status: 'consumed', turnId: null };
    if (state.status !== 'boundary_pending') return { status: state.status, turnId: null };
    if (turnId && state.boundaryTurnId && turnId !== state.boundaryTurnId) {
      throw attachmentError('attachment_boundary_ack_mismatch', `cannot acknowledge boundary ${turnId}; pending ${state.boundaryTurnId}`);
    }
    state.status = 'consumed';
    state.acknowledgedAt = Date.now();
    delete state.boundaryTurnId;
    delete state.prompt;
    delete state.promptT;
    atomicWrite(file, state);
    return { status: 'consumed', turnId: null };
  });
}

function cancelAttachment({ sid, reason }) {
  if (!sid) return null;
  return withLease(sid, () => {
    const file = statePath(sid);
    const state = readJson(file);
    if (!state || state.status === 'consumed') return state;
    // A conversational next prompt first finalizes pending_adoption in the hook,
    // while reset/off intentionally discard any still-pending attachment so the
    // next Start can reserve against its new/current tape.
    if (state.status !== 'requested' && reason === 'next_prompt') return state;
    state.status = 'cancelled_by_next_prompt';
    state.reason = reason || 'cancelled';
    delete state.boundaryTurnId;
    delete state.prompt;
    delete state.promptT;
    atomicWrite(file, state);
    return state;
  });
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function inferredClaudeTranscript(sid, cwd) {
  const project = String(cwd || process.cwd()).replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', project, `${sid}.jsonl`);
}

if (require.main === module) {
  try {
    const command = process.argv[2];
    const sid = arg('--sid') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID;
    const log = arg('--log') || process.env.NIGHTSHIFT_LOG;
    const transcriptPath = arg('--transcript') || inferredClaudeTranscript(sid, arg('--cwd'));
    let result = null;
    if (command === 'request') {
      result = requestAttachment({ sid, log, transcriptPath, activatedAt: arg('--activated-at') || Date.now() });
    } else if (command === 'claim') {
      result = claimAttachment({ sid, log, transcriptPath });
    } else if (command === 'ack') {
      result = ackAttachment({ sid, turnId: arg('--turn-id') });
    } else if (command === 'boundary') {
      result = boundaryAttachment({ sid, log, reason: arg('--reason') });
    } else if (command === 'ack-boundary') {
      result = ackBoundaryAttachment({ sid, turnId: arg('--turn-id') });
    } else if (command === 'cancel') {
      result = cancelAttachment({ sid, reason: arg('--reason') });
    } else {
      throw attachmentError('attachment_invalid_command', `unknown attachment command: ${command || '(missing)'}`);
    }
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: 'error',
      code: error && error.code || 'attachment_error',
      message: error && error.message || String(error),
    })}\n`);
    process.exitCode = 1;
  }
}

module.exports = { requestAttachment, claimAttachment, ackAttachment, boundaryAttachment, ackBoundaryAttachment, cancelAttachment };
