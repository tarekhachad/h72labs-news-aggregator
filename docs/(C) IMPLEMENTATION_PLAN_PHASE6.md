# (C) Implementation Plan — Phase 6 (UI Tweaks)

> Copied from the ephemeral Claude Code plan-mode artifact (`.claude/plans/`, not part of this repo and not durable across sessions) so it survives session restarts — same convention as `IMPLEMENTATION_PLAN_PHASE5.md`. This is the file-level detail; `ROADMAP.md`'s Phase 6 section is only a summary that gets "Done (date):" notes appended as each sub-phase ships.

# Phase 6 — UI Tweaks (new intermediary phase)

## Context

Tarek tested the app live after Phase 5 shipped and found five more UI issues/requests spanning a real animation bug, a navigation gap, and three polish items. This inserts a new **Phase 6** between the now-complete Phase 5 and the old Phase 6 (cost/quality pass + friends testing, renumbered to **Phase 7**) — same pattern as Phase 5 itself being inserted after Phase 4. Each of the five items becomes an independently-buildable sub-phase (6.1–6.5), following this project's standing convention: build low-risk/isolated first, higher-risk/coupled last, each sub-phase going through the full qa/code-reviewer convergence loop before the next starts (`CLAUDE.md`'s process section, no exceptions).

Three explore agents diagnosed the code first; a Plan agent then designed the fix for each item and I independently verified its highest-risk claims (the `layoutId`/animation mechanism, exact line numbers in `NewsCard.tsx`/`TopicNav.tsx`/`FrontPage.tsx`) by reading the actual source directly rather than trusting the sub-agent summaries at face value. Two decisions were confirmed with Tarek: **grey out** (not hide) topic links when no digest exists yet, and **risk-ordered** sub-phases (not the order the issues were originally listed in).

**Sub-phase order (risk-ordered, per Phase 5's own documented convention):**
1. **6.1** — Spacing: TopicNav band → hero card gap (front page)
2. **6.2** — Spacing: NewsCard internal rhythm (topic label → title → chips → summary)
3. **6.3** — Instant focus-mode transition (no animation)
4. **6.4** — Disable topic-page nav when no digest exists yet today (grey out)
5. **6.5** — Fix the card-rearrangement animation bug (`layoutId`/`LayoutGroup` architecture)

6.3 and 6.5 both touch the shared `layoutId` mechanism (`NewsCard.tsx` / `FocusOverlay.tsx`) but modify disjoint lines — no hard build-order dependency, but do 6.5's manual QA pass (open/close focus mode) *after* 6.3 lands, so it's validated against the final structure once, not twice.

---

## 6.1 — Spacing: TopicNav → hero card gap

**File:** `src/components/newspaper/FrontPage.tsx`

Line 212's grid wrapper has no top padding, so on a history front page (`interactive={false}`, no generation-trigger block rendered) `TopicNav`'s `border-b` sits flush against the first grid row with zero gap. On the live front page there's only *incidental* spacing via the trigger block's own `py-8`.

**Change:** `className="px-6 pb-10 md:px-10"` → `className="px-6 pt-4 pb-10 md:px-10"` (line 212). Applies unconditionally to both `interactive` branches, fixing the zero-gap case and giving the live front page deliberate rather than incidental spacing.

**Why this is safe:** verified `globals.css:89`'s `--masthead-height: 73px` and `TopicNav.tsx`'s `top: var(--masthead-height)` sticky offset (lines 57–61) only govern the two sticky headers' relative position *while scrolling* — no coupling to space below `TopicNav`'s closing tag. Adding padding on the wrapper that follows `TopicNav`, rather than inside `TopicNav` itself, leaves that sticky math untouched.

`TopicPage.tsx` doesn't have this problem (its `<h1 className="px-6 py-6" ...>` already supplies a gap) — no change needed there.

---

## 6.2 — Spacing: NewsCard internal rhythm

**File:** `src/components/newspaper/NewsCard.tsx`

Verified current structure (lines 319–367): topic badge/time row → `mt-2` → title (line 337) → `mt-1` → label chips (line 340) → `mt-2` → summary (line 356, `ref={summaryRef}`) → flexible clamped space → footer (line 367, `ref={footerRef}`, `mt-auto pt-3`).

**Changes:**
- Line 337: `cn(TITLE_CLASS[tier], "mt-2")` → `cn(TITLE_CLASS[tier], "mt-3")`
- Line 340: `className="mt-1 flex flex-wrap gap-1"` → `className="mt-2 flex flex-wrap gap-1"`

**Do not touch** the summary's own `mt-2` (line 358) or the footer's `pt-3` (line 367) — both sit *below* `summaryRef`, and `src/hooks/useDynamicLineClamp.ts` computes `availableHeight = footer.offsetTop - summary.offsetTop` (a live DOM measurement, not a hardcoded gap). Anything added above the summary is free — it just shifts where `summary.offsetTop` naturally lands and the hook adapts automatically. Anything added between summary and footer directly shrinks `availableHeight` and reduces how many lines of summary text show, which is a real trade-off, not something this sub-phase should touch. Values above are a reasonable default and easily tunable if the result looks off live.

---

## 6.3 — Instant focus-mode transition

**Files:** `src/components/newspaper/FocusOverlay.tsx`, `src/components/newspaper/Backdrop.tsx`

Both currently animate the zoom/blur shared-element transition (`FocusOverlay.tsx`'s `transition={{ duration: prefersReducedMotion ? 0 : 0.4, ease: "easeInOut" }}` on the `layoutId`-carrying `motion.div`, `Backdrop.tsx`'s `transition={{ duration: prefersReducedMotion ? 0 : 0.25 }}` fade). Tarek wants this instant.

**Changes:**
- `FocusOverlay.tsx`: `transition={{ duration: prefersReducedMotion ? 0 : 0.4, ease: "easeInOut" }}` → `transition={{ duration: 0 }}`. `prefersReducedMotion` becomes unused there — remove the `useReducedMotion()` call and its import.
- `Backdrop.tsx`: same treatment — `transition={{ duration: prefersReducedMotion ? 0 : 0.25 }}` → `transition={{ duration: 0 }}`, remove the now-unused `useReducedMotion` import/call.
- Keep `layoutId` structurally intact in both files (don't strip it) — lower risk than removing Motion's layout-projection wrapping outright, same visual result.

**Verified not to break anything:** the accessibility/focus-management effects this transition sits next to (`FocusOverlay.tsx`'s `useLayoutEffect` inert-sweep + close-button focus, `NewsCard.tsx`'s focus-restoration effect) are keyed to React's commit/effect ordering, not animation duration — confirmed by reading both, including the focus-restoration effect's own doc comment stating this explicitly. Safe with duration 0.

**Minor doc nit while in this area:** `useDynamicLineClamp.ts`'s comment references "closing focus mode plays a ~0.4s Motion shared-element transition" — update that line to reflect the new instant behavior (logic itself is unaffected either way).

**Manual check after implementing (not a code change, just a look):** confirm the now-unmasked DOM swap (grid card unmounting, portaled overlay mounting) doesn't read as a jarring flash. Do this check after 6.5 lands (see ordering note above), so it's checked once against the final structure.

---

## 6.4 — Disable topic-page nav when no digest exists yet today

**Decision (confirmed with Tarek): grey out, not hide.** Reuses `TopicNav.tsx`'s existing inert-span pattern (already used for `activeTopic`), keeps topics visible/discoverable, and avoids a dead-end where a user on `/topic/x` via a stale link has no nav back if the whole band were hidden.

**Changes:**
- `src/components/newspaper/TopicNav.tsx`: add `digestExistsToday?: boolean` prop (default `true`, so every caller that doesn't pass it — all history routes — stays ungated automatically). In the `topics.map(...)` block (lines 104–124), when `topic !== activeTopic && !digestExistsToday`, render an inert span instead of the `<Link>`:
  ```tsx
  <span
    key={topic}
    aria-disabled="true"
    title="Today's edition hasn't been generated yet"
    className="text-sm font-medium uppercase tracking-wide opacity-40"
    style={{ color: "var(--color-muted-foreground)" }}
  >
    {topic}
  </span>
  ```
  Leave the `activeTopic` branch and the "Front Page" link (lines 64–77) untouched — a topic page's own back-to-front-page link must always work.
- `src/components/newspaper/FrontPage.tsx`: no new prop needed — `hasDigest` (line 84) is already reactive client state. Pass `digestExistsToday={interactive ? hasDigest : true}` into the `<TopicNav>` call (line 174). The `interactive ? … : true` guard keeps history front pages (`interactive={false}`) always ungated.
- `src/components/newspaper/TopicPage.tsx`: add `digestExistsToday?: boolean` prop (default `true`), forward into its own `<TopicNav>` call (line 48).
- `src/app/(paper)/topic/[slug]/page.tsx`: currently never fetches digest existence. Import `getTodayDigest` from `@/lib/digests` (already used identically in `src/app/(paper)/page.tsx`), fetch it alongside the existing `getCardsForTopicOnDate` call, and pass `digestExistsToday={digest !== null}` into `<TopicPage>`.
- `src/app/(paper)/history/[date]/page.tsx` and `.../history/[date]/topic/[slug]/page.tsx`: **no changes** — omitting the new prop keeps the `= true` default, so history stays ungated per the requirement.

---

## 6.5 — Fix the card-rearrangement animation bug

**Root cause (confirmed against `NewsCard.tsx`, `FrontPage.tsx`, and installed `framer-motion`/`motion-dom` source):** `layoutId={`newscard-${card.id}`}` on `NewsCard.tsx`'s outer `motion.div` (lines 118, 278), with no `<LayoutGroup>` anywhere in the app, means Motion runs one single global shared-layout registry for every card, site-wide. This causes two distinct bugs:

- **(a) Cross-page collision:** the front page's top-6 cards share `card.id`/`layoutId` with the same card's appearance on its own topic page. A client-side nav between the two (plain `router.push` — the page-flip system is fully disabled today, `PageTransitionContext.tsx:28`'s `FLIP_ENABLED = false`, confirmed dead code, not the cause) can register/unregister a shared id across outgoing/incoming trees within the same commit, which Motion reads as "this element moved" and animates a slide between two unrelated component trees.
- **(b) Same-page live reflow:** `FrontPage.tsx`'s `loadDigest` SSE handler (line 149, additive `setCards`) triggers a full grid repack (`packGridWithRunDividers`, lines 164–170) on every chunk. Already-mounted cards (same key) can get a new `gridPosition`; because `layoutId` implies layout-projection tracking, that ordinary reflow gets FLIP-animated as a visible slide. The existing `isNew`/`recentlyAddedIds` gate (line 81, correctly scoped to the entrance fade/scale) can't and doesn't gate this separate reposition animation.

### Fix (a): `LayoutGroup` scoping per page instance

Verified in `framer-motion.dev.js` (`useLayoutId`): `<LayoutGroup id="x">` transparently prefixes every descendant's `layoutId` with `"x-"` before registration — no change needed to the `layoutId={`newscard-${card.id}`}` string itself anywhere. Wrapping each page's grid in its own `LayoutGroup` makes the same `card.id` register under different keys on the front page vs. a topic page, so Motion can never connect an exiting node in one page's tree to an entering node in the other's. Because `createPortal(<FocusOverlay .../>, document.body)` is called from inside `NewsCard`'s own render (portals only change DOM placement, not React context), the portaled overlay automatically inherits the same `LayoutGroup` prefix as its originating card — **the B7 zoom transition keeps working with zero changes to `FocusOverlay.tsx` or how `layoutId` is constructed.**

**Changes:**
- `src/components/newspaper/FrontPage.tsx`: import `LayoutGroup` from `motion/react`; wrap the `<FocusModeProvider>...</FocusModeProvider>` block (lines 222–253, confirmed via direct read) with `<LayoutGroup id={`front-${basePath || "today"}`}>`.
- `src/components/newspaper/TopicPage.tsx`: same import; wrap its own `<FocusModeProvider>...</FocusModeProvider>` block (lines 58–80) with `<LayoutGroup id={`topic-${topic}-${basePath || "today"}`}>`.

(Including `basePath` keeps every page instance's group id unique by page-type + topic + date, closing off the low-probability history-date collision case too, not just the live front-page/topic-page one.)

### Fix (b): `layoutDependency` to stop self-reflow animation

`LayoutGroup` alone doesn't fix (b) — it's a within-one-group problem. Verified in `framer-motion.dev.js` (`MeasureLayoutWithContext.getSnapshotBeforeUpdate`): when `layoutDependency` is passed and stays the same value between renders, Motion skips its layout-change detection (`projection.willUpdate()`) entirely on that render — the position change just snaps, no FLIP. This only gates the *update* path; the mount/unmount handoff that powers the focus-mode zoom goes through `componentWillUnmount`, which is unconditional regardless of `layoutDependency` — so the shared-node snapshot `FocusOverlay` needs still gets captured correctly.

**Change:**
- `src/components/newspaper/NewsCard.tsx`: add `layoutDependency={card.id}` to the grid-cell `motion.div` (line 276–278 area). `card.id` is stable for the life of the mounted instance by construction — add a short comment explaining this is intentional (a constant `layoutDependency` reads like a bug otherwise): "never changes on purpose — this card's own reposition should never self-animate; the only intended animation off this layoutId is the mount/unmount handoff to FocusOverlay, which isn't gated by layoutDependency."

**Confirmed unaffected:** the Sources-flip `rotateY` animation (line 307, separate inner `motion.div`, no `layoutId`/`layoutDependency`) and the `isNew` entrance stagger (lines 285–301, a plain motion-value target animation, a different subsystem from layout-projection tracking) — neither interacts with either fix.

### QA checklist for this sub-phase
- Navigate `/` → a topic page containing a card also in the front-page top-6, both directions — confirm no slide/reflow, cards just appear in their new page's grid.
- Trigger `loadDigest()` live (or simulate multiple SSE chunks) — confirm newly-arrived cards still play the `isNew` entrance; already-present cards silently snap to any new `gridPosition` with no animation.
- Open/close focus mode on a card on both the front page and a topic page — confirm the zoom/shrink transition is pixel-identical to today's behavior (verify this after 6.3 has also landed, since 6.3 changes this transition's duration to 0 — confirm the shared-element handoff itself, not the duration, still works).
- Flip a card to Sources and back — confirm unaffected.

---

## Verification (all sub-phases)

Per this project's standing process (`CLAUDE.md`): each sub-phase gets its own `qa` + `code-reviewer` pass, fix → re-verify, iterated to genuine convergence (both agents, every round, no silently-capped rounds) before the next sub-phase starts. For 6.5 specifically (touches core animation/layout architecture shared across the whole app), treat any fix as consequential enough to warrant a fresh full round rather than a narrowly-scoped one, per this file's own escalation rule.

Live-in-browser checks needed beyond automated tests (this app has no visual/animation test coverage by convention — animation correctness is qa-agent-live-verified, not unit-tested):
- 6.1/6.2: visual spacing check on front page (both `interactive` states) and a card at each tier (hero/medium/small).
- 6.3: open/close focus mode, confirm instant switch, no jarring flash.
- 6.4: grey-out rendering before any digest exists today, ungating immediately after a live generation completes (no reload needed, since `hasDigest` is reactive), and confirm history routes are never gated.
- 6.5: the QA checklist above.

## Critical files
- `src/components/newspaper/NewsCard.tsx`
- `src/components/newspaper/FrontPage.tsx`
- `src/components/newspaper/TopicPage.tsx`
- `src/components/newspaper/TopicNav.tsx`
- `src/components/newspaper/FocusOverlay.tsx`
- `src/components/newspaper/Backdrop.tsx`
- `src/app/(paper)/topic/[slug]/page.tsx`
- `src/hooks/useDynamicLineClamp.ts` (comment-only touch in 6.3)
- `docs/(C) ROADMAP.md` (renumber old Phase 6 → 7, insert new Phase 6 structure)
- `docs/(C) IMPLEMENTATION_PLAN_PHASE6.md` (this file)
