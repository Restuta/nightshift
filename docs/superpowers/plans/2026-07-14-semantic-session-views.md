# Semantic Session Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make Board, Story, Lanes, and Graph render the same session clocks, progress, PR truth, lifecycle, and provenance while specializing their detail.

**Architecture:** Shared context and summary modules sit above the canonical session-insights model. Lanes becomes the forensic semantic timeline; Story becomes the morning report; Board keeps live operations; Graph reuses the PR registry/topology. Replay is one-shot and never opens SSE; live mode shares append-only reconciled facts.

**Tech Stack:** Browser-native ES modules, Canvas 2D, existing React Flow graph app, CSS, node:test, committed graph build artifacts.

## Global Constraints

- Visual thesis: A calm forensic instrument: flat near-black rails, one semantic color per state, and provenance shown as texture rather than decoration.
- Content order: shared session truth, semantic timeline or PR stack, then inspectable evidence.
- Interaction thesis: expand preflight, focus or hover a span, and open evidence/replay; motion communicates data changes only.
- Use the existing Linear-style near-black, quiet-hairline, Inter and IBM Plex Mono language.
- No gradients, glow, serif, decorative cards, ornamental motion, or new runtime dependencies.
- Every confidence/state difference is available in text, not color alone.
- Cross-view navigation preserves session, t, and at.
- Either t or at makes a view replay-only; replay never opens SSE.
- Populated Story and Lanes remove the accessible empty message.
- Graph source changes require npm run build:graph and committed public/graph-flow output.

---

## File Structure

- Create public/session-view-context.js: shared query parsing and navigation.
- Create public/session-summary.js: shared text/view model.
- Modify public/app.js and public/index.html: Board summary, semantic strip, tool panel, labeled timing.
- Modify public/story.js, public/story.html, public/story-model.js: morning report and unattached activity.
- Modify public/lanes.js, public/lanes.html, public/lanes-model.js: semantic ribbon, PR swimlane, evidence drawer.
- Modify public/style.css: shared restrained presentation and accessible controls.
- Modify public/graph-model.js, graph-app/src/models.js, App.jsx, Timeline.jsx, flow-build.js, nodes/index.jsx, app.css: shared truth in Graph.
- Modify test/session-summary.test.mjs, test/session-view-context.test.mjs, test/lanes-model.test.mjs, test/story-model.test.mjs, test/graph-model.test.mjs; add test/view-contract.test.mjs.

### Task 1: Share replay context and compact summary copy

**Files:**
- Create: public/session-view-context.js
- Create: public/session-summary.js
- Add: test/session-view-context.test.mjs
- Add: test/session-summary.test.mjs

**Interfaces:**
- Produces: parseViewContext(search), viewHref(path, context), buildSummaryViewModel(insights), summaryHTML(summary).

- [ ] **Step 1: Add failing context and summary tests**

~~~js
test('context preserves session, cursor, and cutoff and disables live mode', () => {
  const x = parseViewContext('?session=s1&t=100&at=120');
  assert.deepEqual(x, { session: 's1', cursorT: 100, cutoffT: 100, asOfT: 120, mode: 'replay' });
  assert.equal(viewHref('/lanes', x), '/lanes?session=s1&t=100&at=120');
});

test('summary gives exact, labeled shared copy', () => {
  const s = buildSummaryViewModel(referenceInsights);
  assert.equal(s.prs, '7 PRs open · 0 merged');
  assert.equal(s.checklist, 'Session checklist: 8/10');
  assert.equal(s.roadmap, 'Product roadmap: roughly one-third');
  assert.match(s.recordedSpan, /recorded session$/);
  assert.match(s.disposition, /human is next actor/);
});
~~~

- [ ] **Step 2: Run RED**

Run: node --test test/session-view-context.test.mjs test/session-summary.test.mjs

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement the shared modules**

parseViewContext accepts URLSearchParams/string; cutoffT is the minimum finite value among t and at; mode is replay when either exists. viewHref emits parameters in session,t,at order. buildSummaryViewModel returns asOf, prs, checklist, remaining, roadmap, disposition, recordedSpan, producerWindow, observedWork, provenance, and sourceFreshness strings. summaryHTML renders one section with an h2 screen-reader label, definition-list semantics, and no inline event handlers.

- [ ] **Step 4: Verify and commit**

Run: node --test test/session-view-context.test.mjs test/session-summary.test.mjs

Expected: PASS.

Run: npm test

Expected: all tests pass.

~~~bash
git add public/session-view-context.js public/session-summary.js test/session-view-context.test.mjs test/session-summary.test.mjs
git commit -m "feat: share session view context and summary"
~~~

### Task 2: Make Lanes the semantic forensic timeline

**Files:**
- Modify: public/lanes-model.js
- Modify: public/lanes.js
- Modify: public/lanes.html
- Modify: public/style.css
- Modify: test/lanes-model.test.mjs
- Add: test/view-contract.test.mjs

**Interfaces:**
- Consumes: buildSessionInsights, buildSummaryViewModel, parseViewContext, viewHref.
- Produces: semantic/preflight/PR/agent rows and evidence-button descriptors.

- [ ] **Step 1: Add failing model/view-contract tests**

Assert the reference fixture yields one semantic row, expanded preflight substages, a seven-PR swimlane with current and recorded truth, attention/staleness markers, optional agent rows, and item episodes as overlay only. Static DOM tests assert the summary region, evidence drawer, focusable segment layer, hidden canvas semantics, and hidden populated empty state.

- [ ] **Step 2: Run RED**

Run: node --test test/lanes-model.test.mjs test/view-contract.test.mjs

Expected: FAIL because semantic rows and drawer do not exist.

- [ ] **Step 3: Extend the Lanes model and layout**

Change buildModel(events, insights) to return existing item lanes plus semanticRows {primary,preflight,prs,agents}, marks, and evidence descriptors. Each descriptor contains id,label,startT,endT,confidence,evidenceEventIds,replayHref. Keep event density as an optional overlay and filter heartbeat/usage/reconcile traffic.

- [ ] **Step 4: Implement pointer and keyboard evidence**

Canvas remains aria-hidden. Overlay one button per visible segment at the same geometry; Enter, Space, and click call openEvidence(id). The drawer includes phase/stage, labeled duration, percentage, start/end, confidence, evidence count/list, GitHub/replay links, close button, focus return, Escape close, and aria-live polite. Add an expandable preflight row control with aria-expanded.

- [ ] **Step 5: Apply restrained styles**

Add shared session-summary and summary-chip styles, semantic phase fills, confidence solid/hatch/dotted treatments, PR transition marks, drawer, segment focus ring, and event-activity overlay. Use existing tokens and no animation except a short data-driven live update transition disabled by prefers-reduced-motion.

- [ ] **Step 6: Verify and commit**

Run: node --test test/lanes-model.test.mjs test/view-contract.test.mjs

Expected: PASS.

Run: npm test

Expected: all tests pass.

~~~bash
git add public/lanes-model.js public/lanes.js public/lanes.html public/style.css test/lanes-model.test.mjs test/view-contract.test.mjs
git commit -m "feat: add semantic forensic lanes"
~~~

### Task 3: Turn Story into a coherent morning report

**Files:**
- Modify: public/story.js
- Modify: public/story.html
- Modify: public/story-model.js
- Modify: public/style.css
- Modify: test/story-model.test.mjs
- Modify: test/view-contract.test.mjs

**Interfaces:**
- Consumes: insights for all truth; digest remains chapter/dialogue input only.
- Produces: shared header, roadmap/checklist distinction, phase totals, PR stack, stale warning, unattached chapter.

- [ ] **Step 1: Add failing Story assertions**

Assert the golden fixture renders 7 open/0 merged; checklist 8/10 with Roadmap and Final handoff named; product roadmap roughly one-third; M1 complete/M2–M3 first slices/M4–M7 not started; turn complete/session open/human next/no missing tool outcome; recorded/current readiness; stale snapshot warning; and an Unattached activity chapter containing recovered #104.

- [ ] **Step 2: Run RED**

Run: node --test test/story-model.test.mjs test/view-contract.test.mjs

Expected: FAIL on Story summary and unattached activity.

- [ ] **Step 3: Migrate Story derivation**

Load one event prefix, build insights once, and pass it to render. digest remains for chapters and dialogue but no longer owns clocks, PR totals, lifecycle, or roadmap. buildStoryBlocks appends Unattached activity from insights.attributionGaps. PR chips show two labeled truth lines when current differs from recorded and link to GitHub plus replay time.

- [ ] **Step 4: Fix navigation and empty semantics**

Use viewHref for all view and replay links. When populated, set the empty element hidden and aria-hidden=true; when empty, reverse both. Story stays one-shot in replay and refreshes live only through the shared live path.

- [ ] **Step 5: Verify and commit**

Run: node --test test/story-model.test.mjs test/view-contract.test.mjs

Expected: PASS.

Run: npm test

Expected: all tests pass.

~~~bash
git add public/story.js public/story.html public/story-model.js public/style.css test/story-model.test.mjs test/view-contract.test.mjs
git commit -m "feat: align Story with semantic session truth"
~~~

### Task 4: Align Board live state and timing language

**Files:**
- Modify: public/app.js
- Modify: public/index.html
- Modify: public/style.css
- Modify: test/view-contract.test.mjs

**Interfaces:**
- Consumes: insights.prStack, roadmap, toolCalls, phases, diagnostics, and shared summary.
- Produces: separate work, PR, and tool entities; semantic footer; exact event labels.

- [ ] **Step 1: Add failing Board contract assertions**

Assert the document has a shared summary, separate Tool calls region, source freshness status, and semantic timeline legend. Assert source text contains open for rather than a bare PR age, observed work for card time, waiting for your next instruction distinct from permission/tool outcome unknown, and non-heartbeat/heartbeat-excluded event labels.

- [ ] **Step 2: Run RED**

Run: node --test test/view-contract.test.mjs

Expected: FAIL on Board structure/copy.

- [ ] **Step 3: Migrate Board data and rendering**

Parse context before loading. Replay fetches /events once and never calls EventSource; live opens SSE. renderAll builds insights once. renderPRs consumes insights.prStack; renderPlan consumes roadmap; renderToolCalls consumes explicit lifecycles and historical points; drawTimeline consumes phases while raw density moves behind an event activity toggle. Recovered/unattached PRs remain visible.

- [ ] **Step 4: Label every clock and freshness state**

PR age says Open for. Card time says observed work. The event footer names non-heartbeat events and excluded heartbeats. Poller stale/current unavailable appears as text with last successful refresh. Human next-prompt, permission, measured tool execution, missing outcome, and idle are separate copy branches.

- [ ] **Step 5: Verify and commit**

Run: node --test test/view-contract.test.mjs

Expected: PASS.

Run: npm test

Expected: all tests pass.

~~~bash
git add public/app.js public/index.html public/style.css test/view-contract.test.mjs
git commit -m "feat: align Board with semantic session truth"
~~~

### Task 5: Align Graph registry, summary, and replay behavior

**Files:**
- Modify: public/graph-model.js
- Modify: graph-app/src/models.js
- Modify: graph-app/src/App.jsx
- Create: graph-app/src/Summary.jsx
- Modify: graph-app/src/Timeline.jsx
- Modify: graph-app/src/flow-build.js
- Modify: graph-app/src/nodes/index.jsx
- Modify: graph-app/src/app.css
- Modify: test/graph-model.test.mjs
- Modify: test/view-contract.test.mjs
- Regenerate: public/graph-flow/index.html
- Regenerate: public/graph-flow/assets/graph-app.js
- Regenerate: public/graph-flow/assets/graph-app.css

**Interfaces:**
- Consumes: canonical insights and shared summary/context.
- Produces: graph nodes/edges from insights.prStack and a keyboard semantic timeline.

- [ ] **Step 1: Add failing Graph model and contract tests**

Assert PR nodes and edges exactly match current authoritative topology in live cutoff and recorded topology in replay; all seven PRs exist after recovery; summary values match other views; replay source contains no SSE path; timeline exposes slider semantics and keyboard commands.

- [ ] **Step 2: Run RED**

Run: node --test test/graph-model.test.mjs test/view-contract.test.mjs

Expected: FAIL because Graph recomputes registry and has no shared summary.

- [ ] **Step 3: Migrate Graph source**

Runtime-import session-insights-model.js, session-summary.js, and session-view-context.js. Build insights once in App derived state. buildGraphModel(events, insights) sources PR nodes and base edges only from insights.prStack. flow-build uses graph data and stops recalculating totals/readiness. Summary.jsx renders shared labels. Links use viewHref. Replay performs one /events request and no EventSource.

- [ ] **Step 4: Make the semantic timeline keyboard-operable**

Timeline renders insights.phases and uses role=slider, tabIndex=0, aria-valuemin/max/now/valuetext. Arrow keys move one percent, Page keys ten percent, Home/End jump bounds, and Enter returns live. Actionable nodes use semantic buttons or equivalent keyboard activation with descriptive aria-label.

- [ ] **Step 5: Build committed Graph artifacts**

Run: npm run build:graph

Expected: Vite build succeeds and public/graph-flow assets change only through the build.

- [ ] **Step 6: Verify and commit**

Run: node --test test/graph-model.test.mjs test/view-contract.test.mjs

Expected: PASS.

Run: npm test

Expected: all tests pass.

~~~bash
git add public/graph-model.js graph-app/src public/graph-flow test/graph-model.test.mjs test/view-contract.test.mjs
git commit -m "feat: align Graph with semantic session truth"
~~~

### Task 6: Verify the cross-view reference-session contract

**Files:**
- Modify: test/view-contract.test.mjs
- Modify: docs/superpowers/specs/2026-07-13-semantic-session-timeline-design.md

**Interfaces:**
- Consumes: all completed model and view tasks.
- Produces: a deterministic static contract plus live browser evidence for the reference session.

- [ ] **Step 1: Add the final cross-view assertions**

Render or call each view’s shared summary path against semantic-reference.jsonl and assert identical as-of, PR 7/0, checklist 8/10, roadmap assessment, lifecycle, next actor, clocks, and provenance. Assert navigation keeps session/t/at and replay code never constructs EventSource. Assert every duration string includes recorded session, producer window, observed work, open for, waiting, idle, or unknown.

- [ ] **Step 2: Run the full automated suite**

Run: npm test

Expected: all tests pass.

Run: npm run build:graph

Expected: build succeeds with no uncommitted source-to-dist drift after a second run.

- [ ] **Step 3: Browser-verify the four local reference URLs**

Open Board, Story, Lanes, and Graph for semantic-reference. Verify live and a frozen replay cutoff, inspect desktop and narrow viewport, traverse every interactive control by keyboard, open Lanes evidence by pointer and keyboard, and confirm Graph timeline keys. Capture console errors, failed requests, summary text, and screenshots as verification evidence. Do not edit the reference application PRs.

- [ ] **Step 4: Record verified rollout notes**

Change the design status from Proposed to Implemented only if all automated and browser checks pass. Add a Verification section listing the commands, reference cutoff, four URLs, known retrospective limits, and any current-GitHub freshness caveat.

- [ ] **Step 5: Commit**

~~~bash
git add test/view-contract.test.mjs docs/superpowers/specs/2026-07-13-semantic-session-timeline-design.md public/graph-flow
git commit -m "test: verify semantic session views"
~~~

## Self-Review

- Spec coverage: shared summary, replay contract, Lanes ribbon/evidence, Story report/unattached activity, Board entities/timing, Graph topology/timeline, accessible confidence, and cross-view agreement are assigned.
- Placeholder scan: every task names exact files, commands, expected failures, interfaces, and interaction behavior.
- Type consistency: all views consume buildSessionInsights and buildSummaryViewModel; navigation uniformly consumes parseViewContext and viewHref.
