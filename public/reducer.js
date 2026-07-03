// Pure fold over the event log. UI state is `fold(events, t)` — live mode is
// t = now, replay is any earlier t. No fetches, no Date.now(): purity over the
// log is what makes time travel work (see docs/EVENTS.md).

export const STATUSES = ['inbox', 'doing', 'pr', 'done'];

const FEED_CAP = 150;

// Sources allowed to author v2 `pr` STATE (plan 1.4 — PR truth single-writer). The
// live poller is the sole live writer; emit is the manual CLI; import/demo are the
// offline whole-tape synthesizers. The demoted live producers (hook, codex-tail)
// now emit `pr_ref`, so their v2 `pr` events are ignored. v1 events are exempt.
const PR_AUTHORITY = new Set(['poll-github', 'emit', 'import', 'demo']);

// A single working gap longer than this is almost certainly the session
// sitting idle without an `idle` event (a missed Stop hook, say), not real
// work — cap each gap so one stuck window can't inflate a card's timer.
const ACTIVE_GAP_CAP = 30 * 60e3;

// Approximate USD per million tokens, matched by model-id substring. A local
// estimate, not a billing source of truth — update as prices move. Cache reads
// bill ~0.1× input; cache writes ~1.25×.
const PRICES = [
  [/opus/i, { in: 15, out: 75 }],
  [/sonnet/i, { in: 3, out: 15 }],
  [/haiku/i, { in: 0.8, out: 4 }],
  [/fable|mythos/i, { in: 5, out: 25 }],
  [/gpt-5|o[34]|codex/i, { in: 1.25, out: 10 }],
];
const DEFAULT_PRICE = { in: 3, out: 15 };

function priceFor(model) {
  if (model) for (const [re, p] of PRICES) if (re.test(model)) return p;
  return DEFAULT_PRICE;
}

function usageCost(ev) {
  const p = priceFor(ev.model);
  return (
    ((ev.in || 0) * p.in) +
    ((ev.out || 0) * p.out) +
    ((ev.cacheRead || 0) * p.in * 0.1) +
    ((ev.cacheWrite || 0) * p.in * 1.25)
  ) / 1e6;
}

// Sources that record EXTERNAL reconciliation, not the agent's own work: the
// GitHub poller and the board server's reconcile. Their events — and any `alive`
// heartbeat from anyone — must NOT accrue work-time, reset the quiet clock, or
// count as the agent-recorder being alive. Coupling liveness to them is exactly
// what made a dead session read LIVE all night while the server poller kept
// appending an event every 30s (see PLAN F3).
const RECONCILE_SOURCES = new Set(['poll-github', 'server']);

// Is this event agent-WORK from a live recorder (vs a reconcile append)? A v1
// event (no `source`) is, by definition — every pre-envelope producer recorded
// agent work, so old tapes fold exactly as before. `alive` is never work; it's
// handled before this is consulted.
function isProducerEvent(ev) {
  return !RECONCILE_SOURCES.has(ev.source);
}

export function initialState() {
  return {
    // `lastAt` = the last event of ANY kind (feed/clock display). `lastProducerAt`
    // = the last agent-WORK event (accrual + the "quiet" clock) — split so a
    // reconcile append (poll-github/server) can't bump the work clock. `sources`
    // = per-source freshness (source → latest t), fed by every v2 event incl.
    // `alive` heartbeats; the badge derives honest staleness from it.
    session: { title: null, startedAt: null, lastAt: null, lastProducerAt: null, phase: null, cwd: null, agent: null, attentionText: null, lastSay: null },
    sources: new Map(),
    items: new Map(),
    todos: [],            // full current plan (session-scoped) → the sidebar Plan panel
    stepTimes: new Map(), // step text → {firstSeenAt, startedAt, doneAt}
    todoPrev: new Map(),  // step text → status at the previous snapshot (for per-turn deltas)
    files: new Map(), // path → {edits, lastAt} — churn signal
    prs: new Map(),   // repo#number (bare number for v1/no-repo) → {number, repo, state, url, title, ci, openedAt, mergedAt} — the PR panel
    prRefs: new Set(),// session-relevant PR numbers seen via pr_ref sightings; NOT rendered (they carry no state) until a real pr event arrives
    feed: [],
    totals: { add: 0, del: 0, commits: 0, edits: 0, events: 0, tokIn: 0, tokOut: 0, cacheTok: 0, cost: 0 },
  };
}

// Any agent activity means the session is live again. Codex fires task_complete
// at the end of every internal task, so in an autonomous run (no human prompts
// to "resume") the badge would otherwise stick on idle while the agent keeps
// working — this flips it back on the next edit/command/plan/commit.
function awake(state) {
  if (state.session.phase === 'idle' || state.session.phase === 'attention') {
    state.session.phase = 'working';
    state.session.attentionText = null;
  }
}

// Most recently touched item still in `doing` — the card the agent is on now.
function activeDoingItem(state) {
  let best = null;
  for (const it of state.items.values()) {
    if (it.status !== 'doing') continue;
    if (!best || (it.touchedAt || 0) > (best.touchedAt || 0)) best = it;
  }
  return best;
}

// state.prs is keyed by repo#number when the producer knows the repo (poll-github
// stamps it), else by the bare number for v1/no-repo back-compat. Two repos can
// each have a PR #1 in one session; a bare-number key collided them into one row.
function prKey(number, repo) {
  return repo ? `${repo}#${number}` : number;
}

// Does a card's PR link refer to this (number, repo)? Match by number, and when
// BOTH sides name a repo require it to agree — so a poll-github event scoped to
// one repo never resolves onto a same-numbered PR from another repo.
function samePr(link, number, repo) {
  if (!link || link.number !== number) return false;
  if (link.repo && repo) return link.repo === repo;
  return true;
}

// True when a card has a linked PR that hasn't merged/closed yet. A turn
// boundary (Stop / next prompt) marks a card 'done', but if its PR is still
// open the work hasn't actually shipped — defer 'done' to the PR lifecycle.
function prStillOpen(state, it) {
  if (!it.pr || it.pr.number == null) return false;
  const pr = state.prs.get(prKey(it.pr.number, it.pr.repo));
  const prState = (pr && pr.state) || it.pr.state;
  return prState === 'open';
}

// Events usually arrive unattributed (hooks don't know which card they belong
// to). Explicit `ev.item` wins; PR/CI events match by PR number; otherwise the
// most recently touched item in `doing` takes them.
function targetItem(state, ev) {
  if (ev.item && state.items.has(ev.item)) return state.items.get(ev.item);
  const prNum = ev.type === 'ci' ? ev.pr : ev.type === 'pr' ? ev.number : null;
  if (prNum != null) {
    for (const it of state.items.values()) {
      if (it.pr && it.pr.number === prNum) return it;
    }
  }
  let best = null;
  for (const it of state.items.values()) {
    if (it.status !== 'doing') continue;
    if (!best || (it.touchedAt || 0) > (best.touchedAt || 0)) best = it;
  }
  return best;
}

export function reduce(state, ev) {
  // Per-source freshness: every v2 event stamps who produced it, and the fold
  // tracks each source's latest t. `alive` heartbeats land ONLY here — that is
  // the whole point of a heartbeat: proof the recorder is alive without being
  // agent work. The badge derives honest staleness from this map.
  if (ev.source != null) {
    const prev = state.sources.get(ev.source) || 0;
    if (ev.t > prev) state.sources.set(ev.source, ev.t);
  }

  // A recorder heartbeat is not activity: it must not enter the feed, touch a
  // card, wake the session, accrue time, or count as an event. It has already
  // updated per-source freshness above — nothing else.
  if (ev.type === 'alive') return state;

  // Accrue active work-time to the card in progress over the gap that just
  // elapsed — but keyed on PRODUCER activity (lastProducerAt), NOT any event, and
  // only while working. A reconcile append (poll-github/server) during a working
  // phase must not accrue phantom hours (F3: the overnight server poller bumped
  // the clock every 30s), so those don't advance lastProducerAt. Idle/attention
  // gaps (waiting on the human) don't count either, so a card's timer reflects
  // time spent on it, not wall-clock since it opened. Pure over the log, so the
  // number is the same live or in replay.
  const producer = isProducerEvent(ev);
  if (producer && state.session.lastProducerAt != null && state.session.phase === 'working') {
    const dt = ev.t - state.session.lastProducerAt;
    if (dt > 0) {
      const active = activeDoingItem(state);
      if (active) active.activeMs += Math.min(dt, ACTIVE_GAP_CAP);
    }
  }

  state.totals.events++;
  state.session.lastAt = ev.t;                        // any event → feed/clock display
  if (producer) state.session.lastProducerAt = ev.t;  // agent work → accrual + quiet clock

  switch (ev.type) {
    case 'session': {
      if (ev.title != null) state.session.title = ev.title;
      if (ev.cwd != null) state.session.cwd = ev.cwd;
      if (ev.agent != null) state.session.agent = ev.agent;
      if (ev.phase === 'start' || ev.phase === 'resume') {
        if (state.session.startedAt == null) state.session.startedAt = ev.t;
        state.session.phase = 'working';
        state.session.attentionText = null;
      } else if (ev.phase === 'attention') {
        state.session.phase = 'attention';
        state.session.attentionText = ev.text || null;
      } else if (ev.phase === 'idle') {
        state.session.phase = 'idle';
        state.session.attentionText = null;
      } else if (ev.phase === 'end') {
        state.session.phase = 'ended';
        state.session.attentionText = null;
        // Session boundary (1.6): any card still in `doing` when the session ends
        // was never finished — the agent stopped mid-flight (0/20 real tapes ever
        // emitted an `end`, so these cards latched in "in progress" forever). Mark
        // them abandoned — a derived, pure stale marker the board renders as
        // distinct from done. Cleared if a later event re-activates the card.
        for (const it of state.items.values()) {
          if (it.status === 'doing') it.abandoned = true;
        }
      }
      break;
    }

    case 'item': {
      if (!ev.id) break;
      let it = state.items.get(ev.id);
      if (!it) {
        it = {
          id: ev.id, title: '', status: 'inbox', note: null, emoji: null,
          add: 0, del: 0, commits: 0, edits: 0, activeMs: 0,
          delta: null, pr: null, ci: null, now: null, abandoned: false,
          createdAt: ev.t, touchedAt: ev.t,
        };
        state.items.set(ev.id, it);
      }
      if (ev.title != null) it.title = ev.title;
      if (ev.status != null && STATUSES.includes(ev.status)) {
        // A card can't be 'done' while its PR is still open — its CI may still
        // be running. Park it in 'pr'; the PR's own merge/close (handled below,
        // matched by number) carries it to 'done'. Without this a turn jumps to
        // Done the instant the agent stops talking, mid-flight work and all.
        it.status = (ev.status === 'done' && prStillOpen(state, it)) ? 'pr' : ev.status;
      }
      if (ev.note != null) it.note = ev.note;
      if (ev.emoji != null) it.emoji = ev.emoji;
      it.touchedAt = ev.t;
      it.abandoned = false; // a fresh upsert (reopen / move) un-abandons the card
      break;
    }

    case 'todos': {
      // The plan is SESSION state, not a turn's: the agent keeps one cumulative
      // list. The full plan lives at session level (state.todos -> the sidebar
      // Plan panel); each card carries only its DELTA -- the steps that advanced
      // while it was active. A card never shows the whole plan, which is what
      // stops the cumulative list smearing onto every turn.
      // Per-step timing (keyed by step text): startedAt when a step first goes
      // in_progress, doneAt when it completes — for the durations on the panel.
      const times = state.stepTimes, prev = state.todoPrev;
      const target = (ev.item && state.items.get(ev.item)) || activeDoingItem(state);
      const todos = (ev.todos || []).map(td => {
        const status = td.status || (td.done ? 'completed' : 'pending');
        let tm = times.get(td.text);
        if (!tm) { tm = { firstSeenAt: ev.t }; times.set(td.text, tm); }
        if (status === 'in_progress' && tm.startedAt == null) tm.startedAt = ev.t;
        if (status === 'completed' && tm.doneAt == null) {
          tm.doneAt = ev.t;
          if (tm.startedAt == null) tm.startedAt = tm.firstSeenAt;
        }
        // A step joins this turn's delta only if we WITNESS it advance here: it
        // was seen earlier not-yet-done and now moved forward. A step first seen
        // already completed/in_progress (a continued session, work from an earlier
        // turn, or a checklist written pre-checked) was not moved here — which is
        // what stops a long first turn absorbing the whole backlog.
        const was = prev.get(td.text);
        // A step witnessed in_progress on this card, then dropped from the plan (frozen
        // 'superseded' by the sweep below), that now REAPPEARS: the agent restored it,
        // so resume witnessing. todoPrev dropped the text when it left the plan, so the
        // frozen entry stands in for its prior state — any advance (in_progress or
        // completed) overwrites the fossil with a live entry again.
        const frozen = target && target.delta && target.delta.get(td.text);
        const resuming = !!frozen && frozen.status === 'superseded' &&
          (status === 'in_progress' || status === 'completed');
        const advanced = resuming || (was != null && was !== 'completed' && status !== was &&
          (status === 'completed' || status === 'in_progress'));
        if (advanced && target) {
          const d = target.delta || (target.delta = new Map());
          d.set(td.text, { text: td.text, status, startedAt: tm.startedAt, doneAt: tm.doneAt, elapsedMs: td.elapsedMs });
          target.touchedAt = ev.t;
          target.abandoned = false;
        }
        return {
          text: td.text, done: status === 'completed', status,
          startedAt: tm && tm.startedAt, doneAt: tm && tm.doneAt, firstSeenAt: tm && tm.firstSeenAt,
          // Real duration carried by the producer (task tools) wins over the
          // snapshot-delta estimate — a backfill folds the whole plan at once, so
          // the delta would read 0.
          elapsedMs: td.elapsedMs,
        };
      });
      state.todos = todos;
      // Fossil sweep: the plan is session-scoped and agents rewrite it constantly. Any
      // delta entry still in_progress whose exact text is ABSENT from this snapshot is
      // a step the plan moved past without ever finishing — freeze it 'superseded'
      // (keep startedAt so elapsed = supersededAt − startedAt; no live tick, no green
      // check). A ticking timer on a dead step is misinformation. Swept across ALL
      // cards, not just the active one: the whole plan is one session stream, so every
      // card's still-ticking fossil is equally stale (their turns are over). A later
      // snapshot that reintroduces the exact text resumes witnessing (see `resuming`
      // above). Pure over the log — supersededAt is ev.t, never Date.now().
      const present = new Set(todos.map(t => t.text));
      for (const it of state.items.values()) {
        if (!it.delta) continue;
        for (const d of it.delta.values()) {
          if (d.status === 'in_progress' && !present.has(d.text)) {
            d.status = 'superseded';
            d.supersededAt = ev.t;
          }
        }
      }
      // An unchanged re-emit refreshes the reference but isn't real activity on
      // the card, so it must not bump touchedAt (which drives ordering / "active
      // card") — only a genuine plan change counts as touching it.
      state.todoPrev = new Map(todos.map(t => [t.text, t.status]));
      awake(state);
      break;
    }

    case 'edit': {
      state.totals.edits++;
      if (ev.path) {
        const f = state.files.get(ev.path) || { edits: 0, lastAt: 0 };
        f.edits++;
        f.lastAt = ev.t;
        state.files.set(ev.path, f);
      }
      const it = targetItem(state, ev);
      if (it) { it.edits++; it.touchedAt = ev.t; it.abandoned = false; }
      awake(state);
      break;
    }

    case 'commit': {
      state.totals.commits++;
      state.totals.add += ev.add || 0;
      state.totals.del += ev.del || 0;
      const it = targetItem(state, ev);
      if (it) {
        it.commits++;
        it.add += ev.add || 0;
        it.del += ev.del || 0;
        it.touchedAt = ev.t;
        it.abandoned = false;
      }
      awake(state);
      break;
    }

    case 'pr_ref': {
      // A SIGHTING (plan 1.4): the hook / codex tailer noticed a PR is relevant to
      // this session (a `gh pr create`/`merge` line, a rollout mention). It carries
      // NO state and never moves a card to done. It only (a) registers the number
      // so poll-github knows to fetch its real state, and (b) links the owning card
      // so poll-github's later pr events (matched by number) carry it pr -> done. It
      // must NOT create a PR-panel row: the panel reads state.prs, a ref only touches
      // state.prRefs — so no title-less phantom row is conjured.
      if (ev.number != null) {
        state.prRefs.add(Number(ev.number));
        const it = ev.item ? state.items.get(ev.item) : null;
        if (it && (!it.pr || it.pr.number == null)) {
          // Link, presuming open (a just-created/-referenced PR isn't merged until
          // gh says so). Do NOT touch it.status — no state means no column move;
          // parking to 'pr' at a turn boundary still works via prStillOpen, and the
          // poller's real open/merged events drive the actual transitions.
          it.pr = { number: ev.number, repo: null, state: 'open', url: ev.url || null, title: ev.title || null };
          it.touchedAt = ev.t;
        } else if (it) {
          // Already linked (re-sighted) — refresh soft metadata only, never state.
          if (ev.url && !it.pr.url) it.pr.url = ev.url;
          if (ev.title && !it.pr.title) it.pr.title = ev.title;
          it.touchedAt = ev.t;
        }
      }
      break;
    }

    case 'pr': {
      // Single-writer authority (plan 1.4): a v2 pr STATE event is honored only from
      // producers that legitimately author pr state — the live poller (poll-github),
      // the manual CLI (emit), and the offline tape synthesizers (import, demo). The
      // demoted live producers (hook, codex-tail) now emit pr_ref, never pr, so a
      // stray v2 pr from them is ignored. v1 events (no source/v) stay honored for
      // back-compat — old tapes fold unchanged.
      if (ev.v >= 2 && ev.source && !PR_AUTHORITY.has(ev.source)) break;

      const repo = ev.repo || null;
      // occurredAt is gh's REAL transition time (mergedAt/closedAt/createdAt); t is
      // when we recorded it. Using it means replay shows the 2am merge at 2am even
      // though the poller only noticed (and recorded) it at 9am.
      const when = ev.occurredAt != null ? ev.occurredAt : ev.t;
      const key = prKey(ev.number, repo);

      // A metadata-only event (title/url, no state) must not conjure a PR — an
      // unknown number would default to 'open' and flood the panel (e.g. a
      // `gh pr list` dump of merged PRs). Attach to a known PR or skip.
      if (ev.number != null && !(ev.meta && !state.prs.has(key))) {
        // PRs are session-level entities (the PR panel), keyed by repo#number.
        const pr = state.prs.get(key) ||
          { number: ev.number, repo, state: 'open', url: null, title: null, ci: null,
            base: null, openedAt: ev.createdAt != null ? ev.createdAt : when, mergedAt: null };
        if (ev.state) pr.state = ev.state;
        // base: the PR number this PR is stacked on (poll-github resolves it from
        // baseRefName when the base branch is itself a known PR head). Sticky —
        // a later state-only event without base keeps it. The /graph view draws
        // the stacked-PR chain from it; old tapes lack it and draw no edge.
        if (ev.base != null) pr.base = ev.base;
        // add/del: the PR's diff size (poll-github reads it from gh). Sticky — a
        // later state-only echo (a merge with no size) must NOT erase the numbers,
        // so the /graph diff chip keeps rendering. Absent until a sized event lands.
        if (ev.add != null) pr.add = ev.add;
        if (ev.del != null) pr.del = ev.del;
        if (ev.createdAt != null) pr.openedAt = ev.createdAt;      // gh's real open time
        if (ev.state === 'merged' && pr.mergedAt == null) pr.mergedAt = when;
        if (ev.state === 'open') pr.mergedAt = null; // reopened / corrected
        if (ev.url) pr.url = ev.url;
        if (ev.title) pr.title = ev.title;
        if (repo && pr.repo == null) pr.repo = repo;
        pr.t = ev.t;
        state.prs.set(key, pr);
      }
      // Resolve the owning card: an explicit ev.item link (set at pr_ref time), or
      // any card that already claimed this number/repo — so a later poller event
      // with no item (the merge/close) still reaches the card that opened the PR and
      // can finish it. Matching only cards that already own the number means the
      // attribution heuristic never hijacks an unrelated card.
      let it = ev.item ? state.items.get(ev.item) : null;
      if (!it && ev.number != null) {
        for (const c of state.items.values()) {
          if (samePr(c.pr, ev.number, repo)) { it = c; break; }
        }
      }
      if (it) {
        it.pr = {
          number: ev.number,
          repo: repo || (it.pr && it.pr.repo) || null,
          state: ev.state || (it.pr && it.pr.state) || 'open',
          url: ev.url || (it.pr && it.pr.url) || null,
          title: ev.title || (it.pr && it.pr.title) || null,
        };
        if (it.pr.state === 'open' && (it.status === 'inbox' || it.status === 'doing')) it.status = 'pr';
        if (it.pr.state === 'merged' || it.pr.state === 'closed') it.status = 'done';
        it.touchedAt = ev.t;
        it.abandoned = false;
      }
      break;
    }

    case 'ci': {
      // poll-github stamps repo on ci too, so it keys onto the same repo#number PR.
      if (ev.pr != null) {
        const key = prKey(ev.pr, ev.repo || null);
        if (state.prs.has(key)) state.prs.get(key).ci = ev.status;
        // attach to a card only if one is explicitly carrying this PR
        for (const it of state.items.values()) {
          if (samePr(it.pr, ev.pr, ev.repo || null)) { it.ci = ev.status; it.touchedAt = ev.t; }
        }
      }
      break;
    }

    case 'tool': {
      // The agent ran a command (read a file, ran tests). Activity, not a file
      // change — it warms the active card and scrolls the tape so a working
      // turn looks alive between edits. The text becomes the card's live "now"
      // line until newer narration (a `say`) or another command replaces it.
      state.totals.tools = (state.totals.tools || 0) + 1;
      const it = targetItem(state, ev);
      if (it) {
        it.tools = (it.tools || 0) + 1;
        it.touchedAt = ev.t;
        it.abandoned = false;
        if (ev.text) it.now = { text: ev.text, kind: 'tool', t: ev.t };
      }
      awake(state);
      break;
    }

    case 'say': {
      // The agent's plaintext narration — its running status ("waiting one more
      // interval for the harvest to finish"). It used to live only in the CLI /
      // rollout, so a turn spent thinking and watching looked frozen on the
      // board. Surface the latest line on the card it belongs to as the live
      // "now" line; narration outranks a bare command, so it wins the slot.
      const it = targetItem(state, ev);
      if (it && ev.text) { it.now = { text: ev.text, kind: 'say', t: ev.t }; it.touchedAt = ev.t; it.abandoned = false; }
      if (ev.text) state.session.lastSay = ev.text;
      awake(state);
      break;
    }

    case 'usage': {
      // Token accounting, emitted per model turn (mostly by the importer —
      // live hooks have no token visibility). Drives the masthead meters.
      state.totals.tokIn += ev.in || 0;
      state.totals.tokOut += ev.out || 0;
      state.totals.cacheTok += (ev.cacheRead || 0) + (ev.cacheWrite || 0);
      state.totals.cost += usageCost(ev);
      break;
    }

    // 'note' and unknown types land in the feed only (forward compatibility).
  }

  // Usage events feed the meters, not the tape. `pr_ref` is a low-level linking
  // signal — the gh command line (or the poller's real pr event) already narrates
  // the sighting — so it stays out of the human-readable activity feed too.
  if (ev.type !== 'usage' && ev.type !== 'pr_ref') {
    state.feed.unshift(ev);
    if (state.feed.length > FEED_CAP) state.feed.length = FEED_CAP;
  }
  return state;
}

// A `retract` corrects the tape itself — it says "this event / this card was a
// recording bug, it was never real." That is META-level, so it applies at ALL
// replay times, not just after its own t (a recording bug is not history — see
// docs/EVENTS.md). So fold first pre-scans the ENTIRE array (ignoring untilT) for
// retractions, then folds everything else while dropping what was retracted.
function scanRetractions(events) {
  const retractedEvents = new Set(); // envelope ids ({target:{event}})
  const retractedItems = new Set();  // work-item ids ({target:{item}})
  for (const ev of events) {
    if (!ev || ev.type !== 'retract' || !ev.target) continue;
    if (ev.target.event != null) retractedEvents.add(ev.target.event);
    if (ev.target.item != null) retractedItems.add(ev.target.item);
  }
  return { retractedEvents, retractedItems };
}

function isRetracted(ev, retractedEvents, retractedItems) {
  if (ev.type === 'retract') return true; // meta-event: applied in the pre-scan
  if (ev.id != null && retractedEvents.has(ev.id)) return true;
  // A retracted item vanishes completely: its own `item` upserts AND anything
  // attributed to it (edit/commit/todos/ci/... carrying ev.item) drop out, so it
  // leaves no trace in board, counts, or feed.
  if (ev.type === 'item' && ev.id != null && retractedItems.has(ev.id)) return true;
  if (ev.item != null && retractedItems.has(ev.item)) return true;
  return false;
}

export function fold(events, untilT = Infinity) {
  const state = initialState();
  const { retractedEvents, retractedItems } = scanRetractions(events);
  for (const ev of events) {
    // `continue`, not `break`: the log is meant to be time-ordered, but a tape
    // can be out of order (a late backfill, or the n154 re-append seam), so a
    // single event whose t exceeds untilT must NOT stop the fold — skip just it
    // and keep going. With `break`, an out-of-order tape made scrub-to-end and
    // live-fold disagree (F4). Consumers sort by t; this is the guard for when
    // they haven't. (See docs/EVENTS.md "Ordering".)
    if (ev.t > untilT) continue;
    if (isRetracted(ev, retractedEvents, retractedItems)) continue;
    reduce(state, ev);
  }
  return state;
}

// Files an agent keeps coming back to — the visual signature of flailing.
// Pure over state, so live and replay agree. Tiers: 3+ warm, 5+ hot, 8+ churn.
export function hotFiles(state, min = 3, cap = 5) {
  return [...state.files.entries()]
    .filter(([, f]) => f.edits >= min)
    .sort((a, b) => b[1].edits - a[1].edits || b[1].lastAt - a[1].lastAt)
    .slice(0, cap)
    .map(([path, f]) => ({ path, ...f, tier: f.edits >= 8 ? 'churn' : f.edits >= 5 ? 'hot' : 'warm' }));
}

// The card whose todo drill-in is expanded: most recently touched `doing` item.
// PRs touched this session, most recent first — drives the PR panel.
export function prList(state) {
  return [...state.prs.values()].sort((a, b) => (b.t || 0) - (a.t || 0));
}

export function activeItemId(state) {
  const it = activeDoingItem(state);
  return it ? it.id : null;
}

// The freshest sign that SOME recorder of this session's agent work is alive:
// the newest of the per-source freshnesses (excluding the reconcile lanes) and
// the last producer event. A resident recorder (codex-tail) keeps this fresh via
// `alive` heartbeats even while the agent quietly thinks; a hook-based recorder
// CANNOT heartbeat (it is event-driven), so its honest signal is simply the age
// of its last real event. Pure over state → live and replay agree.
export function freshestProducerAt(state) {
  let best = state.session.lastProducerAt;
  for (const [src, at] of state.sources) {
    if (RECONCILE_SOURCES.has(src)) continue;
    if (best == null || at > best) best = at;
  }
  return best;
}

// A hook-based recorder goes quiet between turns (a turn ends → idle), so it
// gets a long grace; a heartbeating recorder (codex-tail, ~30s) is stale fast.
const STALE_TTL_HEARTBEAT = 5 * 60e3;
const STALE_TTL_HOOK = 15 * 60e3;

// Honest liveness for the badge, derived PURELY from (phase, freshest producer
// age) at time `now`. `working` is trusted only while a recorder signal is
// fresh; past the TTL it becomes `stale` — the honest "the recorder died, data
// ends at <that time>" instead of a latched, lying LIVE (F3). idle / attention /
// ended pass through as the recorded phase. Same inputs → same output, so the
// badge agrees live and in replay.
export function liveness(state, now) {
  const phase = state.session.phase;
  if (phase === 'attention') return { state: 'attention' };
  if (phase === 'ended') return { state: 'ended' };
  if (phase === 'idle') return { state: 'idle' };
  if (phase !== 'working') return { state: 'waiting' };
  const at = freshestProducerAt(state);
  const heartbeats = state.sources.has('codex-tail') || state.session.agent === 'codex';
  const ttl = heartbeats ? STALE_TTL_HEARTBEAT : STALE_TTL_HOOK;
  if (at != null && now - at > ttl) return { state: 'stale', dataEndsAt: at };
  return { state: 'live' };
}

// Display helper (pure): the moment a session went QUIET, or null when it isn't
// idle. Keyed on the *recorded* phase 'idle' — the true idle the recorder emitted,
// NOT the display-side stale inference (liveness → 'stale') — so a paused card/step
// freezes only when the agent genuinely stopped its turn, never merely because a
// hook recorder went silent mid-work. The frozen "now": the last producer event
// (the same clock the board's "quiet Xm" uses), so a paused step's timer stops at
// the value it held at idle instead of ticking phantom motion. Used by the board
// (paused doing card) and /graph (paused step node) so both tell the same truth.
export function sessionPausedAt(state) {
  if (state.session.phase !== 'idle') return null;
  return state.session.lastProducerAt ?? state.session.lastAt ?? null;
}
