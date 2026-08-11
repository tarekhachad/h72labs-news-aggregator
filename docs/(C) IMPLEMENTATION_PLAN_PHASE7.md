# (C) Implementation Plan — Phase 7 (UI Fixes)

> Copied from the ephemeral Claude Code plan-mode artifact (`.claude/plans/`, not part of this repo and not durable across sessions) so it survives session restarts — same convention as `IMPLEMENTATION_PLAN_PHASE5.md`/`IMPLEMENTATION_PLAN_PHASE6.md`. This is the file-level detail; `ROADMAP.md`'s Phase 7 section is only a summary that gets "Done (date):" notes appended as each sub-phase ships.

# Phase 7 — UI fixes

## Context

Tarek tested the app live after Phase 6 shipped and found two more real issues. This becomes the new **Phase 7**, per the numbering convention just established: the old "Phase 7" (cost/quality pass + friends testing) is now a fixed, non-numeric **"Final Phase (v1 launch)"** section in `ROADMAP.md` that never moves — every further round of fixes Tarek brings gets its own new sequential phase number (7, 8, 9, …) inserted before it, without renumbering anything already shipped or the Final Phase itself.

Two Explore agents diagnosed both bugs first, tracing root causes directly in source (including the installed Framer Motion package's runtime code, not just its docs) rather than guessing. A Plan agent then designed the fix for the harder of the two. Every file/line claim was independently re-verified against current source (post-Phase-6 line numbers had shifted) before finalizing this plan — nothing here is taken on faith.

**Sub-phase order (risk-ordered, per this project's established convention):**
1. **7.1** — Focus-mode exit animation not instant (small, fully-specified, low-risk fix)
2. **7.2** — Digest-generation state lost on navigation + incorrect topic-nav gating (real architectural fix — a new Context/Provider)

---

## 7.1 — Focus-mode exit animation still animated (should be instant, matching Phase 6.3's entry fix)

**Root cause, confirmed by tracing the actual installed `framer-motion`/`motion-dom` source (not assumed):** Phase 6.3 made focus-mode's OPEN transition instant by setting `FocusOverlay.tsx`'s `transition={{ duration: 0 }}` on its `layoutId`-sharing `motion.div`. This only fixed opening because of how Motion resolves a shared-layoutId animation: whichever component's `motion.div` is *newly mounting* becomes the animation's "lead" and its transition config governs the animation — read from that node's own `options.transition`/`props.transition`, never the other side's. On open, `FocusOverlay` is the newly-mounting node, so its `duration: 0` applies. On close, `FocusOverlay` unmounts and `NewsCard.tsx`'s grid-cell `motion.div` remounts (it's swapped for a placeholder `<div>` while focused, per `NewsCard.tsx`'s existing comment) — it becomes the new lead, and its own `transition` prop is `undefined` for a normal (non-`isNew`) card, so Motion falls through to `visualElement.getDefaultTransition()` (also unset) down to its hardcoded `defaultLayoutTransition = { duration: 0.45, ease: [0.4, 0, 0.1, 1] }` — the animated zoom-out Tarek is still seeing.

**Fix, verified against Motion's actual `Transition` type and its `getValueTransition` resolution logic (`transition?.[key] ?? transition?.default ?? transition`):** Motion supports a `layout` sub-key on the `transition` prop specifically for the shared-element/layout-position animation, independent of other keyed values like `opacity`/`scale`. Give `NewsCard.tsx`'s grid-cell `motion.div` an *always-present* `layout: { duration: 0 }`, while keeping its existing `isNew` opacity/scale entrance animation exactly as-is:

```tsx
transition={{
  layout: { duration: 0 },
  ...(isNew
    ? {
        opacity: { duration: 0.3, ease: "easeOut", delay: entranceDelay },
        scale: { duration: 0.3, ease: "easeOut", delay: entranceDelay },
      }
    : {}),
}}
```

**File:** `src/components/newspaper/NewsCard.tsx` (the grid-cell `motion.div`'s `transition` prop, currently `isNew ? {opacity: {...}, scale: {...}} : undefined`).

**Confirmed non-interactions:**
- `FocusOverlay.tsx` needs no change — its bare `transition={{ duration: 0 }}` has no `layout` key to shadow it, so `getValueTransition`'s fallback chain already resolves `duration: 0` for the layout value there too.
- Phase 6.5's `layoutDependency={card.id}` on the same element is unaffected — it only gates whether Motion sets up a `resumeFrom`/animation handoff at all (a *detection*-stage concern); the `transition.layout` key only affects what config is used *once* an animation is triggered (an *execution*-stage concern). Different stages of the same pipeline, don't conflict.
- `Backdrop.tsx` is confirmed unrelated — no `layoutId`, no `exit` prop, removed via a plain conditional (not `AnimatePresence`) — its close was already instant in both directions and stays that way.

---

## 7.2 — Digest-generation progress lost on navigation + topic-nav wrongly un-gated

**Two compounding root causes, both confirmed via source tracing:**

**(a) No state survives navigation.** `FrontPage.tsx`'s `cards`/`loading`/`stageEvent`/`error`/`recentlyAddedIds` are plain `useState`, and `loadDigest()` (the fetch + NDJSON-stream-reading loop) is a plain async function with no `AbortController`/cleanup. `src/app/(paper)/layout.tsx` is the only layout for `/`, `/history`, `/saved`, `/topic/[slug]`, etc. — they're all siblings under it, so Next.js remounts `{children}` (destroying `FrontPage` and all its local state) on every navigation between them, while the layout itself (and its own `PageTransitionProvider`) survives. The underlying fetch/stream isn't cancelled by this — it keeps running server-side and being read client-side — but its `setState` calls become no-ops on the unmounted component, so the UI has no memory of it on return.

**(b) The "does a digest exist" checks are wrong.** `upsertDigestForToday` (`src/lib/digests.ts`) creates a bare `digests` row **immediately** when generation starts (`src/app/api/digest/route.ts`'s `POST` handler, before any pipeline stage runs) — cards are only attached much later, right before the `"done"` event. So `getTodayDigest`/`getDigestForDate` return `{cards: []}` (not `null`) for the entire generation window. `FrontPage.tsx`'s `hasDigest = cards !== null` (`[] !== null` → `true`) and `digests.ts`'s `digestExistsForDate` (a bare row-existence check, no join to `cards`) both wrongly report "a digest exists" during that window — which is exactly why, on returning to `/` mid-generation, the topic-nav band shows fully clickable instead of greyed, and topic pages render empty when visited.

### Fix: new `DigestGenerationContext`, mounted at the layout level

**New file: `src/components/newspaper/DigestGenerationContext.tsx`.** Single combined context (not split like `PageTransitionContext`'s read/actions split — that split exists there because of multiple, differently-shaped, perf-sensitive consumers; here there's exactly one consumer, `FrontPage.tsx`, needing both state and action together, same shape as the simpler `FocusModeContext.tsx` pattern). Owns:
- State: `cards: Card[] | undefined`, `seededDate: string | null`, `loading`, `stageEvent`, `error`, `recentlyAddedIds`.
- `seed(cards, date)`: called once per `FrontPage` mount to hand it that mount's server-rendered snapshot — but only takes effect if the context isn't already tracking `date` (so a live or just-finished in-context generation is never clobbered by a stale SSR snapshot from a fresh remount — this is what makes "navigate away and back" resume instead of re-flashing).
- `startGeneration()`: the relocated `fetch`/NDJSON-reading loop (byte-for-byte the same logic currently in `FrontPage.tsx`'s `loadDigest`), guarded against a second concurrent call via a `loadingRef`.
- `useDigestGeneration()` hook, throwing if used outside the provider (matching this codebase's existing `useFocusMode`/`usePageTransition*` convention).

**Mount point:** `src/app/(paper)/layout.tsx` — wrap `{children}` with `<DigestGenerationProvider>` (nesting relative to `PageTransitionProvider` doesn't matter, the two are fully independent). Since `PaperLayout` itself never remounts on sibling navigation, this provider instance — and its state — survives `/` → `/history` → `/` exactly like `PageTransitionProvider` already does.

**`FrontPage.tsx` changes:** remove its local `useState`s and `loadDigest` entirely; consume `useDigestGeneration()` instead. Derive:
```tsx
const todayKey = new Date().toISOString().slice(0, 10);
const seeded = interactive && digestGen.seededDate === todayKey;
const cards = seeded ? (digestGen.cards ?? []) : initialDigest?.cards;
const loading = seeded ? digestGen.loading : false;
const stageEvent = seeded ? digestGen.stageEvent : null;
const error = seeded ? digestGen.error : null;
// Scoped to `interactive` (not shared unconditionally) so a live
// generation's isNew entrance never incorrectly replays if this same
// session later visits a /history/[today] view of today's own date.
const recentlyAddedIds = interactive ? digestGen.recentlyAddedIds : new Set<string>();
const hasDigest = cards !== undefined && cards.length > 0;
```
A one-shot mount effect (guarded by a `useRef`, so it never re-fires) calls `digestGen.seed(initialDigest?.cards ?? [], todayKey)` when `interactive` — this seeds the context on first-ever mount today (no-op afterward, matching or preserving existing live state on any later remount). The "Give me/Complete today's news" button's `onClick` becomes `digestGen.startGeneration`.

**Three scenarios this produces:**
- **First-ever mount today:** `seeded` is false, renders directly from `initialDigest?.cards` — identical to current behavior, no regression, no flash. The mount effect then seeds the context for later remounts.
- **Mid-generation, navigate away and back:** the provider never unmounted, already has `seededDate === todayKey`, live `loading`/`stageEvent`/`cards`. `seeded` is true on the very first render — the progress bar and disabled button state reappear exactly as they'd have looked had the user never left. `seed()`'s call this time is a no-op (dates already match).
- **Hard refresh (explicitly out of scope, confirmed not attempted):** the whole provider remounts, `seededDate` resets to `null` — functionally identical to "first-ever mount," falling back to `initialDigest?.cards`. The live server-side pipeline keeps running regardless (nothing aborts it on navigation *or* reload today — a reload does abort the fetch itself, which is a pre-existing, unrelated behavior), but the client has no way to know until a fresh `getTodayDigest` read. This matches the stated scope boundary.

**Real side-effect worth knowing about (not a regression, a genuine fix):** because `loading` now lives in the persistent context, the generate button's `disabled={loading}` guard now *also* survives navigation — previously, navigating away and back re-enabled a button that, if clicked, would have fired a second `POST /api/digest` into the existing 409 claim-conflict path. That latent hole closes as a side effect of this fix.

### Fix: correct the "does a digest exist" checks (Part b)

- **`FrontPage.tsx`:** already fixed above — `hasDigest = cards !== undefined && cards.length > 0` replaces `cards !== null`. This is what makes `TopicNav`'s existing `digestExistsToday={interactive ? hasDigest : true}` call (unchanged) correct during any in-flight generation, navigated-to or not.
- **`src/lib/digests.ts`'s `digestExistsForDate`:** extend the existing row-lookup with a second, cheap `select("id").eq("digest_id", digestRow.id).limit(1)` on `cards` (uses the existing `cards_digest_id_idx` index) — only returns `true` once at least one card is actually attached, not merely once the row exists:
  ```ts
  export async function digestExistsForDate(supabase, userId, date): Promise<boolean> {
    const { data: digestRow, error } = await supabase
      .from("digests").select("id").eq("user_id", userId).eq("date", date).maybeSingle();
    if (error) throw new Error(`digestExistsForDate: ${error.message}`);
    if (!digestRow) return false;

    const { data: anyCard, error: cardsError } = await supabase
      .from("cards").select("id").eq("digest_id", digestRow.id).limit(1);
    if (cardsError) throw new Error(`digestExistsForDate: ${cardsError.message}`);
    return (anyCard?.length ?? 0) > 0;
  }
  ```
  Its one caller (`src/app/(paper)/topic/[slug]/page.tsx`) already `.catch(() => true)`s failures and passes the result straight through — no call-site change needed.

### Confirmed: no interaction with the existing generation-claim mechanism

`claimDigestForGeneration`/`releaseDigestGeneration` (`digests.ts`) already enforce one-generation-at-a-time server-side. This plan issues the original `fetch` exactly once (from `startGeneration()`, guarded by both `loadingRef` internally and the button's `disabled={loading}` externally — the latter now also surviving navigation, per the side-effect above). `seed()` never calls `startGeneration()` — it's a pure state-sync, no network request. The already-running stream's reading loop is the exact same code, just relocated to something that outlives page-level navigation; nothing about a real full-page reload's abort/claim-release behavior changes.

### Known, accepted trade-off (documented, not fixed)

Once the context seeds today's date, it stays authoritative over any later server-rendered snapshot for the rest of the browser session (until a hard reload) — this is what makes the resume-on-navigate-back fix work at all. One minor consequence: if a second tab or session generates additional cards for today, this tab won't reflect that until a hard reload, even after revisiting `/`. Low-probability (multi-tab same-day generation), not a regression from today's behavior in any way that matters, and not worth solving as part of this fix.

---

## Verification

Per this project's standing process: each sub-phase gets its own `qa` + `code-reviewer` pass, fix → re-verify, iterated to genuine convergence before the next starts. 7.2 touches shared client-side architecture (a new Context mounted at the layout level, affecting every page under `(paper)`) — treat any fix here as consequential enough to warrant a fresh full round rather than a narrowly-scoped one, per this project's own escalation rule.

Live-in-browser checks needed beyond automated tests:
- **7.1:** open/close focus mode on a card — confirm both directions are now instant (no zoom animation either way). Confirm the `isNew` entrance animation (a genuinely new card arriving via a live generation) still plays correctly — this sub-phase must not touch that.
- **7.2:** (1) start a generation, navigate to `/history` mid-run, navigate back to `/` — confirm the progress bar/stage resumes exactly where it would have been, not an empty state. (2) During that same window, confirm the topic-nav band is greyed out (not clickable) on both `/` and any topic page reached via a direct/stale link. (3) Once generation completes, confirm topic links ungate immediately (reactive, no reload) and topic pages show real content. (4) Confirm a first-ever-today generation (no prior state) behaves identically to before — no regression, no flash. (5) Confirm the generate button stays disabled while navigated away and generation is still running, and re-enables correctly once it finishes. (6) Confirm history routes (`/history/[date]`, its topic pages) are never affected by any of this — they don't consume the new context (`interactive=false`).

## Critical files
- `src/components/newspaper/NewsCard.tsx` (7.1 — `transition.layout` fix)
- `src/components/newspaper/DigestGenerationContext.tsx` (7.2 — new file)
- `src/components/newspaper/FrontPage.tsx` (7.2 — consumes new context instead of local state)
- `src/app/(paper)/layout.tsx` (7.2 — mounts the new provider)
- `src/lib/digests.ts` (7.2 — `digestExistsForDate` cards-aware fix)
- `docs/(C) ROADMAP.md` (this file's own Phase 7 section)
- `docs/(C) IMPLEMENTATION_PLAN_PHASE7.md` (this file)
