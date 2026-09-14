# Phase 8 — Implementation Plan

## Context

Phases 0–7 are shipped. Tarek tested the live app and brought four fixes. Per the standing numbering convention, these become **Phase 8**, inserted before the Final Phase without renumbering anything already shipped.

Sub-phases are ordered **risk-ascending** (Tarek's call, matching the Phase 6 precedent): build confidence on isolated changes first, do the core layout/data-flow change last with full attention. Each sub-phase goes through the standard `qa` + `code-reviewer` convergence loop — **both agents, every round, until a round comes back genuinely clean.**

One design decision changed during planning and is worth stating up front: Tarek's original ask for 8.4 was to group cards into per-run blocks with one divider between them. On review he reversed it — **keep one unified importance-ordered grid and label individual cards with their run instead.** That makes 8.4 a net deletion of the Phase 5.7 divider system rather than a rebuild of it.

---

## 8.1 — Hide today's digest from the history list

**Problem.** `/history` lists today's date, duplicating the front page. `listDigestDatesForUser` applies no upper date bound and [history/page.tsx:31](src/app/(paper)/history/page.tsx#L31) passes no range, so today's row appears the moment `upsertDigestForToday` inserts it — which happens when generation *starts*, before any card exists.

**Decision:** hide today entirely, all day. It reappears tomorrow.

**Changes**

- [src/lib/digests.ts](src/lib/digests.ts) — in `listDigestDatesForUser` (~227-261), add `.lt("date", todayDateString())` to the query. `todayDateString` is already module-private at line 54, so nothing needs exporting. This is the only caller-facing change; the optional `range` param is untouched (it's the extension point reserved for a future calendar-grid view).
- Same function — drop rows with `cardCount === 0` in the existing `.map()` return. **Adjacent bug fixed in passing:** Phase 7.2 changed `digestExistsForDate` to require ≥1 card, but `listDigestDatesForUser` was left checking row existence only, so the two functions currently disagree about what "a digest exists" means. A day whose generation produced nothing renders as a clickable "0 cards" row.
- [src/app/(paper)/history/[date]/page.tsx](src/app/(paper)/history/[date]/page.tsx) — `redirect("/")` when the requested date equals today, so a typed or bookmarked `/history/<today>` doesn't render a second copy of the front page.
- [src/app/(paper)/history/[date]/topic/[slug]/page.tsx](src/app/(paper)/history/[date]/topic/[slug]/page.tsx) — same guard, redirecting to `/topic/<slug>`.

**Note on UTC.** "Today" is a UTC day ([digests.ts:45-56](src/lib/digests.ts#L45-L56)). For Tarek in Atlanta, an evening digest is already dated tomorrow-UTC, so during the UTC-evening window the front page and history can briefly disagree about which day is "today." That is the pre-existing, already-deferred timezone issue — this change neither causes nor fixes it, and shouldn't try to.

**Tests.** Add coverage for `listDigestDatesForUser` in `src/lib/__tests__/` (no tests exist for it today): today excluded, yesterday included, zero-card rows dropped, `range` still applied when passed.

---

## 8.2 — Sign-out confirmation

**Problem.** [Sidebar.tsx:86-93](src/components/newspaper/Sidebar.tsx#L86-L93) submits `signOutAction` directly — one click, instantly signed out, no confirmation.

**Decision:** clicking Sign out closes the sidebar, then a small centered confirmation box appears over the dimmed page — visually matching focus mode.

**Why the sidebar closes first.** The Sign out button lives inside an already-open Base UI `Dialog` (the `Sheet`). A `createPortal(..., document.body)` modal opened from inside it becomes a *sibling* of the Sheet's portal, and Base UI's focus trap and background-`inert` would fight it. Closing the sheet first sidesteps the nested-dialog problem entirely and gives the cleaner look.

**Changes**

- New `src/components/newspaper/ConfirmDialog.tsx` — small centered dialog. Reuse rather than reinvent:
  - [Backdrop.tsx](src/components/newspaper/Backdrop.tsx) verbatim (already generic: `onClick` only, `z-40`, `aria-hidden`, instant).
  - The inert-sweep `useLayoutEffect` from [FocusOverlay.tsx:56-72](src/components/newspaper/FocusOverlay.tsx#L56-L72) and the Escape effect from [:74-80](src/components/newspaper/FocusOverlay.tsx#L74-L80) — ~20 lines total. This is the second consumer, so extracting a `useInertBackground(rootRef)` hook is now justified; refactor FocusOverlay onto it in the same change so there is one implementation, not two.
  - Panel styling copied from FocusOverlay for visual parity: `rounded-md`, `background: var(--color-card)`, `border: 1px solid var(--color-border)`, `boxShadow: "0 10px 24px rgba(26,26,26,0.16)"`, `role="dialog"`, `aria-modal="true"`. Centered via `fixed inset-0 flex items-center justify-center` (the pattern [PageTransition.tsx:46](src/components/newspaper/PageTransition.tsx#L46) already uses), sized to content — not focus mode's 75% box.
  - `transition={{ duration: 0 }}`, matching the codebase-wide instant-overlay convention.
  - Buttons from [src/components/ui/button.tsx](src/components/ui/button.tsx) — its `destructive` variant for Sign out, `outline`/`ghost` for Cancel. **Initial focus goes to Cancel**, the safe choice for a destructive action.
- [Sidebar.tsx](src/components/newspaper/Sidebar.tsx) — replace the `<form action={signOutAction}>` with a button that closes the sheet and opens the confirmation. Confirming submits the existing `signOutAction` server action unchanged; cancelling just dismisses. Verify whether the Sheet's `open` is currently controlled — if not, it needs to become controlled to sequence the close.

**No inert collision with focus mode.** FocusOverlay inerts every `document.body` child including the Masthead, so the sidebar can't be opened while a card is focused. The two overlays are mutually unreachable — worth confirming live, not just reasoning about, given the history behind [FocusModeContext.tsx](src/components/newspaper/FocusModeContext.tsx).

**Verification is live-only** (no component-test infrastructure): all three dismiss paths, focus lands on Cancel, focus returns to the sidebar trigger on cancel, background not tabbable while open, sign-out still actually works.

---

## 8.3 — "Generate Full Report" button

**Problem.** The report fetch fires automatically on entering focus mode — [NewsCard.tsx:176-192](src/components/newspaper/NewsCard.tsx#L176-L192), a `useEffect` keyed on `focused`. Opening a card just to read its full short summary silently spends a Sonnet call.

**Decision:** gate the fetch behind an explicit button in focus mode.

**Prior art to copy:** [CardItem.tsx:30-55](src/components/CardItem.tsx#L30-L55) (the legacy `/saved` component) already implements exactly this shape — button-gated, with a real `loadingReport` boolean and the same `if (report !== null) return;` cache guard. Follow it.

**Changes**

- [NewsCard.tsx](src/components/newspaper/NewsCard.tsx) — add `reportRequested` state; change the effect's guard from `if (!focused) return;` to the request flag. Keep the `fetchStarted` ref and its reset-in-`.catch()` (that's the in-flight guard preventing a duplicate paid call).
- [NewsCard.tsx:476](src/components/newspaper/NewsCard.tsx#L476) — `loadingReport` is currently *derived* as `report === null && reportError === null`, which under a gated flow would read "loading" forever before the user clicks. Replace with real state.
- [FocusOverlay.tsx](src/components/newspaper/FocusOverlay.tsx) — new `onGenerateReport` callback prop (it has only `onClose` today) and a fourth branch in the report region ([:131-148](src/components/newspaper/FocusOverlay.tsx#L131-L148)) for **idle**: the "Generate Full Report" button. The three existing branches (loading / error / report) stay.
- Report state persists across close/reopen exactly as today — `NewsCard` stays mounted, `FocusOverlay` doesn't. A card seeded with `card.expandedReport` from SSR shows the report immediately and never shows the button.
- Retry improves for free: a failed attempt currently requires closing and reopening the card. With a button it's a second click.

**Deliberately unchanged:** initial focus stays on the close button ([FocusOverlay.tsx:66](src/components/newspaper/FocusOverlay.tsx#L66)). Moving it to the generate button would be defensible, but it would perturb the focus-restoration behavior that has already been through three review rounds, for no clear gain.

**Verification is live-only:** entering focus mode fires zero network requests; the button fires exactly one; reopening after generation refetches nothing; a failed generation can be retried in place; an already-generated card shows no button.

---

## 8.4 — Replace run dividers with a per-card "New" badge, and fix stale ranks

Highest-risk sub-phase — core layout code plus a data-flow change. Do it last, review it hardest.

**Problem.** Phase 5.7's `RunDivider` splits the grid with a full-width horizontal rule per run boundary. It consumes an entire 180px grid row, and because ranking is cumulative across the day, runs interleave by importance — so two runs can produce *three* dividers. Tarek finds the result unreadable.

**Decision.** Delete the divider system. Keep one unified importance-ordered grid (unchanged `frontPageRank` / `severity` ordering). Mark provenance with a **"New" badge on the most recent run's cards, shown only when the page holds 2+ distinct runs** — so a normal single-run day shows no badges at all.

### Deletions

- [src/components/newspaper/RunDivider.tsx](src/components/newspaper/RunDivider.tsx) — whole file.
- [packGrid.ts:187-256](src/lib/packGrid.ts#L187-L256) — `packGridWithRunDividers` and `RunDividerPosition`.
- The `breakBefore` field on `GridItemInput` and its two handling sites inside `packGrid` (the `currentRow += 1` at ~127, the band-fill clause at ~158). `GridItemInput` becomes `{ id, tier }`; `packGrid`'s signature is unchanged.
- Divider rendering in [FrontPage.tsx:195-207](src/components/newspaper/FrontPage.tsx#L195-L207) and [TopicPage.tsx:84-93](src/components/newspaper/TopicPage.tsx#L84-L93); both switch from `packGridWithRunDividers` to plain `packGrid`.
- Stale comments asserting the now-reversed design: [packGrid.ts:200-209](src/lib/packGrid.ts#L200-L209), [FrontPage.tsx:195-201](src/components/newspaper/FrontPage.tsx#L195-L201), [TopicPage.tsx:85-87](src/components/newspaper/TopicPage.tsx#L85-L87), plus the "…so the feed can draw a divider" clauses in [types.ts:111](src/types.ts#L111), [route.ts:130](src/app/api/digest/route.ts#L130), [digests.ts:330](src/lib/digests.ts#L330) (the `generatedAt`-is-identical-per-run invariant those document is still true and still load-bearing — only the divider clause goes).

### The badge

New `src/lib/newRun.ts` — `newRunCardIds(cards: Card[]): Set<string>`. A pure lib helper because it must be shared by `FrontPage` (client, reads context) and `TopicPage` (server, reads props), and because logic left inline in a `.tsx` is untestable in this repo (vitest runs `environment: "node"`, no jsdom, no component tests).

Two non-obvious rules it encodes:
- **Returns an empty set when all cards share one run.** "New" is only meaningful relative to something older.
- **Groups on `Date.parse(generatedAt)`, not the raw string.** `generatedAt` reaches the client through two serializers — PostgREST's `timestamptz` rendering via `rowToCard` (`…+00:00`) and [route.ts:132](src/app/api/digest/route.ts#L132)'s `new Date().toISOString()` (`…Z`) for live-streamed cards. Same instant, different strings. With today's data a naive comparison happens to work, so this is robustness against a serializer change, not a currently-firing bug — say that plainly rather than overclaiming it in the log.

Scoped to the cards the caller actually renders, not the whole day: a second run that wins no front-page slots correctly badges nothing there while still badging its cards on their own topic page.

**Rename `isNew` → `animateEntrance`** in [NewsCard.tsx](src/components/newspaper/NewsCard.tsx) (5 sites, 1 call site). The existing prop means "play the entrance animation because this streamed in live this session" — genuinely different from the badge (after a reload, the badge shows and the entrance doesn't). Two props both called "new" is precisely what `code-reviewer` will flag.

**Header row** ([NewsCard.tsx:334-348](src/components/newspaper/NewsCard.tsx#L334-L348)): replace the `showTopicBadge ? chip : <span />` placeholder pattern with a left-hand flex group holding the topic chip and the badge. That handles all four badge × topic-chip combinations without a placeholder — the badge must still render on topic pages, where `showTopicBadge={false}`.

Badge styling: geometry identical to the topic chip (`rounded px-2 py-0.5 text-xs font-semibold`) so they read as one vocabulary; solid `var(--color-accent)` on `var(--color-on-accent)` — both tokens exist ([globals.css:24-25](src/app/globals.css#L24-L25)), and the design system explicitly sanctions accent for card badges. If it reads too loud live, the outline variant is a one-line swap.

**The badge text must be the literal string `"New"` — never a formatted time.** `FrontPage` is a client component that is also server-rendered, so any locale/timezone formatting here would reintroduce the exact SSR/hydration mismatch that forced `RunDivider` to use `useSyncExternalStore` in Phase 5.7. Put that reasoning in a code comment, or a future "show the run time on hover" tweak silently reopens it.

`FocusOverlay` does not get the badge — its job is scanning the grid.

### The stale-rank fix

`rank.ts` re-ranks the full cumulative pool every run, but the stream returns only the *new* cards, so already-rendered cards keep stale `frontPageRank` values. Two cards can both hold rank 1 and both render hero-sized until reload. Removing the divider makes this more visible, not less. [DigestGenerationContext.tsx:178-186](src/components/newspaper/DigestGenerationContext.tsx#L178-L186) documents it as known and unfixed.

The server already computes and persists the fix — `existingCardRankUpdates` in [route.ts:200-209](src/app/api/digest/route.ts#L200-L209) — it just never sends it.

- [route.ts](src/app/api/digest/route.ts) — add `rankUpdates: { id, frontPageRank }[]` to the `done` event type and pass `existingCardRankUpdates` when yielding it (~228). It's already in scope and already correctly empty on every fail-open path.
- New `src/lib/rankUpdates.ts` — `applyRankUpdates(cards, updates)`. Cards not mentioned keep object identity; unknown ids are ignored; **`null` is a meaningful value** (demotion off the front page), so lookups must test `undefined` explicitly, not falsiness.
- [DigestGenerationContext.tsx](src/components/newspaper/DigestGenerationContext.tsx) — apply updates to `prev` *before* appending the new cards, so this run's cards never collide with a stale value. Treat a missing field as `[]` ("change nothing"), which also covers a stream started against an older deployment mid-rollout.

Demotion needs no extra code: `frontPageCardsOf` filters and re-sorts on every render, so front-page membership, tier assignment, and packing all recompute from the fresh values.

**Two consequences to accept and document rather than fix here:**
- A card promoted onto the front page mid-session appears without an entrance animation (`recentlyAddedIds` only ever receives new cards). Computing "which were promoted" means reading `prev` inside a setter and writing other state — the impure-updater pattern React Strict Mode is designed to catch, and the exact hazard [DigestGenerationContext.tsx:63-68](src/components/newspaper/DigestGenerationContext.tsx#L63-L68) already warns about. With `layout: { duration: 0 }` the grid snaps anyway, so a promoted card appearing instantly is consistent with everything around it.
- If a second run demotes the card currently open in focus mode, its `NewsCard` unmounts and the overlay vanishes mid-read. Low probability, self-healing on the next open — but it's the one behavior change that could look like a crash, so it goes on the qa list explicitly.

### Tests

- `packGrid.test.ts`: remove `packGridWithRunDividers` from the line-2 import (a compile error otherwise), delete the `breakBefore` and `packGridWithRunDividers` describe blocks. 25 → 16 tests, back to the pre-5.7 count. The other 16 and all four helpers pass untouched.
- New `newRun.test.ts`: single run → empty set (the headline rule); two and three runs; the two serializer formats for one instant collapse to one run; a case where the lexicographically largest string is *not* the latest instant; order-independence; malformed values ignored.
- New `rankUpdates.test.ts`: empty updates returns the same array reference; promotion applied; **demotion to `null` applied** (the test that pins the `undefined`-vs-`null` lookup); unknown ids ignored; untouched cards keep identity; no add/remove/reorder.
- Extend `rank-wiring.test.ts`: the `done` event's `rankUpdates` deep-equals the persisted list (the actual regression guard); `[]` on both fail-open paths; a `null` demotion survives JSON round-tripping.

### Order within 8.4

`packGrid.ts` + its tests → both callers + delete `RunDivider` → `newRun.ts` + badge + rename → `rankUpdates.ts` + `route.ts` + context. Lib before components so `tsc` points at every stale caller. The data-flow change last, so a rollback doesn't take the UI work with it.

---

## Verification (every sub-phase)

`npx tsc --noEmit` · `npx eslint` · `npx vitest run` — all three clean before a sub-phase is considered done. `next build` additionally for 8.4 (it touches shared layout data flow).

Then the standing loop from `CLAUDE.md`: spawn `qa` and `code-reviewer` against the diff, fix what they find, **re-run both against the updated diff**, and keep going until a round comes back clean from both. Never drop to one agent; never decide in advance that a round is the last one. If a round surfaces only something cosmetic, that's a question for Tarek, not a call to make unilaterally.

Live verification is the primary method here — three of four sub-phases are UI behavior with no component-test infrastructure in this repo. Per the standing cost-discipline note: reuse one account and one digest, narrow topic/source picks, and prefer Playwright network interception over triggering a second real paid generation. 8.4's multi-run scenarios in particular should be driven by intercepting `/api/digest` with a synthetic `done` event rather than paying for real runs.

## Docs

`docs/(C) ROADMAP.md` gets the Phase 8 section (inserted before the Final Phase, nothing renumbered) — plus a "superseded by Phase 8.4" note appended to the 5.7 entry, leaving that historical record intact rather than rewriting it. `notes-logs/project-log.md` gets the real detail. `CLAUDE.md`'s one-line status paragraph updates when the phase lands — that line only. `project-resume-sync` runs once the phase clears the review loop.
