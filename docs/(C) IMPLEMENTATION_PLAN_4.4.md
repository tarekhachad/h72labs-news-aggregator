# (C) Phase 4.4 Implementation Plan — Newspaper UI + Importance Pipeline

Full file-level plan from the Phase 4.3 Plan Mode round, copied here from the ephemeral Claude Code plan-mode artifact (`~/.claude/plans/`) so it survives session restarts and MCP reconfiguration — that file isn't part of this repo and a fresh session has no automatic reason to read it. This doc is the durable source of truth for Phase 4.4; `docs/(C) ROADMAP.md`'s 4.3/4.4 entries only summarize it.

**Track A (pipeline) is done and committed** (`7976306`, `60fceff`) — kept below for the historical record and because Track B's B9 references it. **Track B (frontend) is the active plan.**

---

## Context

Phase 4.1 produced an approved design brief (`docs/(C) UI_DESIGN.md`): the app becomes a landscape digital-newspaper — masthead, a front page capped at 6 importance-ranked stories, per-topic pages, zoom/blur focus mode, flip-in-place sources, full 3D page-flip navigation between pages, an overlay sidebar, serif type, light-only v1. Phase 4.2 picked the tools/libraries (`ui-ux-pro-max-skill` for tokens, shadcn/ui for primitives, Motion for animation, lucide-react for icons) and settled Tailwind-4-CSS-first mechanics. This phase (4.3) turned both into a concrete, file-level plan for 4.4 to execute — resolving the brief's explicitly-deferred open questions (box-size mapping, grid mechanics) and the pipeline gap it surfaced (box size needs a real importance signal; triage was a binary `notable` boolean with nowhere for a score to live).

Two Explore passes grounded this plan in the actual codebase (not assumptions): the frontend had only 4 components, no nav/masthead/sidebar/animation/icon library anywhere; the pipeline had triage as a discard-after-log boolean with no score field on `Cluster`, `Card`, or the `cards` table. A Plan agent then produced the full design; reviewed against source (`STAGE_ORDER` in `Feed.tsx`, `src/proxy.ts`'s exact-path matching, schema philosophy) and confirmed accurate. Three real scope/judgment calls were put to Tarek directly: **full cumulative front-page re-ranking every run** (not rank-once), **`/history/[date]` renders the actual full newspaper for that date** (not a plain list — clarified live, changed scope from the original plan draft), **`/saved` stays a simple restyled list**, and **the pre-existing unbounded triage-concurrency risk stays consciously deferred** (unrelated to this redesign, tracked in `ROADMAP.md`'s deferred section).

**21st MCP note (updated post-plan):** the plan originally assumed 21st MCP for generating shadcn components from prompts. It wasn't available when Track B started; Tarek is setting it up (`claude mcp add --transport http 21st https://21st.dev/api/mcp --header "x-api-key: ..."`) for a future session. **Check whether the `21st` tool is available at the start of whatever session executes B3** — if it's live, use it for faster component scaffolding; if not, fall back to the standard `shadcn` CLI directly (`npx shadcn@latest init` / `add`) for the same primitives, same end result (real shadcn components to own/restyle), just hand-picked rather than prompt-generated. Either way B3 is unblocked, this is a which-tool choice, not a gate.

---

## Design decisions resolved in this phase

**Box-size tiers — 4 discrete tiers, not continuous.** `hero` (3-col × 2-row span, squarish), `large` (2×2, vertical), `medium` (3×1, horizontal), `small` (2×1, compact) on a 6-column grid. Two mapping functions sharing the tier table (`src/lib/gridTiers.ts`): `tierForSeverity(1-5)` for topic pages (5→hero…1-2→small), `tierForFrontPageRank(1-6)` for the front page (1→hero…5-6→small). Both clamp defensively rather than throw.

**Grid layout — CSS Grid with `grid-auto-flow: dense`**, not template-areas (breaks for topic pages' unbounded, variable card counts) or a masonry library (unnecessary machinery — `dense` auto-placement is the browser bin-packing for free, no new dependency, no JS measurement pass). Ordering comes from DOM order (front page: `frontPageRank` ascending; topic pages: `severity` descending, tiebreak `publishedAt` desc + `id`, matching the existing tiebreak convention) — `dense` then naturally fills gaps in that reading order. One shared `src/components/newspaper/PageGrid.tsx` used everywhere a grid is needed.

**Topic pages — real Next.js routes**, not client-state tabs. New route group `src/app/(paper)/`, topic pages at `topic/[slug]/page.tsx`. Reasoning: the multi-page-jump page-flip needs a stable page identity to compute how many pages to flip through — a URL gives this for free; client-state would have to fabricate an equivalent. Also gets back/forward nav and bookmarkable URLs for free, and lets each topic page be a server component fetching only its own topic's cards (an efficiency improvement over the old `Feed.tsx`, which loaded the whole day's digest client-side). New `src/lib/topicSlug.ts` (`topicToSlug`/`slugToTopic`, explicit lookup table — several `Topic` values have spaces/slashes) handles the mapping; invalid slugs redirect to `/`.

**`/history/[date]` renders the actual newspaper for that date** (clarified by Tarek, changed scope from a plain restyled list): reuses the same `FrontPage`/`TopicPage`/`PageGrid` components as "today," parameterized by date instead of defaulting to today. Because front-page ranking is cumulative (Track A re-ranks the full candidate pool every run and writes the result back to every affected card), the persisted `front_page_rank`/`severity` values already represent that day's *final* arrangement once the last run of the day completes — no extra "snapshot per run" mechanism needed, the existing persisted state is exactly "the last arrangement." Route shape: `src/app/(paper)/history/[date]/page.tsx` (front page for that date) + `src/app/(paper)/history/[date]/topic/[slug]/page.tsx` (topic page for that date), so date-scoped page-flip/dropdown navigation works the same way live navigation does. `/history` itself (the date-picker list) is unchanged — just a restyle.

**`/saved` stays a simple restyled list** — existing `CardItem.tsx`/`SavedList.tsx` interaction model, light token/font restyle only. No grid, no flip, no focus-mode change (bookmarked cards aren't naturally tied to one day's newspaper arrangement, so grid/importance sizing doesn't map cleanly here — confirmed with Tarek).

---

## Track A — Pipeline (importance signal) — DONE, committed `7976306`/`60fceff`

Confirmed: full cumulative re-ranking every run (not rank-once). Actual shipped shape (final, after the review-loop fixes — see `notes-logs/project-log.md`'s 2026-08-04 entries for the full bug-by-bug history):

- **Types + schema:** `src/types.ts`'s `Card` has `severity: number` (1-5) and `frontPageRank: number | null` (1-6). `supabase/schema.sql`'s `cards` table has matching nullable `severity`/`front_page_rank` columns (no CHECK/NOT NULL). `persist_generated_cards()` does the insert, the existing-card rank update, and the cursor advance in **one atomic transaction** (extended with a `p_existing_rank_updates` param — originally a separate RPC, folded in after a review round found a rank-collision race between two non-atomic writes).
- **Graded triage** (`src/lib/triage.ts`): `TriageResult` includes `severity: z.number().int().min(1).max(5)`, same topic-relative/independent grading philosophy as the old boolean, just more granular.
- **`writeCard`** (`src/lib/writeCard.ts`): takes `severity` as a real parameter (known before it runs, from triage); `frontPageRank: null` is the genuine placeholder (ranking hasn't run yet).
- **Ranking module** (`src/lib/rank.ts`, new): `rankFrontPage(candidates): Promise<(number|null)[] | null>` — one Claude call for the whole candidate pool (not per-item, since ranking is cross-candidate comparison), fails open to `null` (not an all-null array — a missing/unparseable response throws so it's caught, rather than silently treated as "nothing picked"). Candidate text capped at `SUMMARY_CHARS_PER_CANDIDATE` (300 chars); candidate *count* is not capped (documented as a deferred risk in `ROADMAP.md`).
- **Route wiring** (`src/app/api/digest/route.ts`): a new `"ranking"` `DigestEvent` stage. Runs on **every** generation unconditionally (a round-1 "skip when zero new cards" optimization was reverted after it was found to permanently strand unranked cards). Gated only on `existingCardsFetchFailed` — if today's existing cards can't be safely fetched, ranking is skipped entirely rather than proceeding on an incomplete view (this closes a real rank-collision risk a review round found).
- **Tests:** `rank.test.ts`, `rank.extra.test.ts`, `triage.test.ts`, `rank-wiring.test.ts`, `bookmarks.test.ts`, plus updates to `dedup-wiring.test.ts`/`digests.dedup.test.ts`. 55 tests total (up from 25 at Track A's start).
- **Went through 4 full qa/code-reviewer rounds** before being considered done — 3 real bugs found and fixed (a rank-collision data-consistency gap, a Postgres function-overload deployment gotcha, a `bookmarks.ts` call site silently missing the new columns). This directly led to tightening `CLAUDE.md`'s step 4 (every round now requires both agents, no privately-decided stopping point).

---

## Track B — Frontend (token → primitive → static → animation ordering) — ACTIVE PLAN

Only Track A's types/schema (already done) blocked this; everything below can now proceed.

**B1.** Run `ui-ux-pro-max-skill` for concrete palette/serif-pairing/type-scale values against the NYT/WSJ anchor (research step, no code — see `Notes/Miscellaneous/(C) ui-ux-pro-max-skill-report.md` at the vault root for how to invoke it).

**B2.** `globals.css` rework with B1's tokens in a proper `@theme` block; `layout.tsx` swaps Geist Sans for the serif pairing; strip the stray `body { font-family: Arial }` override and the entire dark-mode media query (light-only v1, in scope to remove).

**B3.** shadcn setup — no `components.json` exists today, this is a real init (config, `cn()` helper, Tailwind 4 CSS-variable wiring). Via the `shadcn` CLI directly (21st MCP unavailable — see Context above). Generate/restyle `Sheet` (sidebar), `DropdownMenu` (topic nav), base `Button`/`Card`.

**B4.** `lucide-react` install, swap the ★/☆/← Unicode glyphs for real icons as components are touched.

**B5.** Static (non-animated) structure:
- `src/lib/gridTiers.ts`, `src/lib/topicSlug.ts`
- `src/app/(paper)/layout.tsx` (hosts `Masthead` + `Sidebar`); `src/app/page.tsx` moves to `src/app/(paper)/page.tsx` (URL unchanged — route groups don't affect URLs); `src/app/(paper)/topic/[slug]/page.tsx`; `src/app/(paper)/history/[date]/page.tsx` + `src/app/(paper)/history/[date]/topic/[slug]/page.tsx` (date-scoped, per the history decision above)
- `src/components/newspaper/{Masthead,Sidebar,TopicBand,TopicNavBox,PageGrid,NewsCard}.tsx` — `Sidebar` re-hosts the History/Saved/Settings/Sign-out links currently hardcoded into `page.tsx`'s top strip
- `src/app/(paper)/page.tsx` and the two history routes are server components fetching via `getDigestForDate` (today vs. a specific date) and passing cards to shared client components (`FrontPage.tsx`, `TopicPage.tsx`) — the history routes reuse these same components, just with a date-scoped fetch instead of "today."
- `/saved`, `/onboarding`, `/profile`, `/history` (the date-list page): token/font restyle only, no structural change.
- Track A's real `severity`/`frontPageRank` data is already live — no placeholder fallback needed (the original plan's B9 merge step is moot since Track A finished first).

**B6.** `NewsCard`'s Sources flip — self-contained CSS 3D flip (`transform-style: preserve-3d`/`backface-visibility: hidden`, animated via Motion), local state only. Build/verify first (lowest risk). The Sources button's click handler needs `e.stopPropagation()` so it doesn't also trigger focus mode.

**B7.** `FocusOverlay.tsx` — zoom/blur via Motion's `layoutId` shared-element transition, backdrop blur via a small shared `Backdrop` primitive (also usable by `Sidebar`). Reuses the existing `/api/cards/[id]/expand` lazy-fetch contract unchanged.

**B8.** Full page-flip transition — `src/components/newspaper/PageTransition.tsx`, built and verified last, once every page it transitions between already renders correctly statically. Explicit state machine: `idle → zooming-out → flipping → waiting-for-destination-mount → zooming-in → idle` — the zoom-in beat only starts once the destination route has actually mounted, not on a fixed timer (avoids a visible pop if the destination's data fetch is slow). Do **not** build on Next 16's experimental View Transitions config — it's built for simple crossfades, not a bespoke multi-stage flip with synthetic intermediate pages; keep this fully client-orchestrated with Motion.

---

## Testing approach

New unit tests as needed for pure logic (`gridTiers.ts`, `topicSlug.ts` already have plans for table-driven tests). **Explicitly NOT unit-tested, verified live instead** (per this project's existing QA convention): the page-flip choreography itself, focus-mode zoom/blur visual correctness, Sources flip visual correctness, whether the grid actually reads as a newspaper, sidebar overlay behavior, the history date-scoped newspaper rendering. These go through the standard `qa` subagent live-run pass plus manual review — animation/visual work is exercised live, not unit-tested, matching this project's process for API routes and UI flows already.

Every meaningfully-sized Track B addition still goes through the full qa/code-reviewer fix→re-verify loop per `CLAUDE.md`'s (recently tightened) step 4 — both agents, every round, no privately-decided stopping point.

---

## Verification

- Frontend: `qa` subagent live-run pass + manual browser check per feature slice (B6 Sources flip → B7 focus mode → B8 page-flip, in that order, each verified working before building the next), then `code-reviewer` per the standard fix→re-verify loop. Confirm desktop/tablet-landscape rendering specifically (out of scope: mobile/portrait, per the brief).
- End-to-end: load `/`, flip to a topic page, flip through a multi-page jump via the dropdown, open focus mode, flip a card to see sources, open the sidebar, visit `/history`, open a past date and confirm it renders as a full newspaper (not a list) with that day's final arrangement, visit `/saved` and confirm it's still a simple list.

### Critical files (Track B)
`src/app/globals.css`, `src/app/layout.tsx`, `src/lib/gridTiers.ts` (new), `src/lib/topicSlug.ts` (new), `src/components/newspaper/PageGrid.tsx` (new), `src/components/newspaper/PageTransition.tsx` (new), `src/components/newspaper/NewsCard.tsx` (new), `src/app/(paper)/` route group (new).
