# Session Log — Personalized News Aggregator
Append-only. Newest entries at the top. Each entry: date + what was done/decided/next.

## 2026-07-24 — Phase 1 built and proven end-to-end
Built the core pipeline per `docs/ROADMAP.md` Phase 1: Next.js app scaffolded (TypeScript, App Router, Tailwind), deployed structure pushed to GitHub (`h72labs-news-aggregator`). Pipeline modules: `src/lib/ingest.ts` (RSS via `rss-parser`, curated NYT/BBC/TechCrunch feeds in `src/config/feeds.ts`), `src/lib/cluster.ts` (free local embeddings, `Xenova/all-MiniLM-L6-v2`, greedy cosine-similarity clustering), `src/lib/triage.ts` (Haiku `claude-haiku-4-5`, structured output), `src/lib/writeCard.ts` (Sonnet `claude-sonnet-5`, structured output). Orchestrated in `src/app/api/digest/route.ts`, rendered in `src/app/page.tsx` (single button + scrollable card feed, expand-to-sources).

Scoping decisions (confirmed with Tarek before building): Supabase deferred to Phase 2 (no persistence needed yet); card expand shows sources only, not a full generated report (that needs the Phase 2/3 `cards` table for caching); dev profile kept small — 2 topics (Tech/AI, Geopolitics), 3 sources (NYT, BBC, TechCrunch) — to keep the first pipeline test cheap and fast to debug.

Bugs hit and fixed during build:
- Claude Sonnet 5 runs adaptive thinking by default now, and `max_tokens` caps thinking + output combined — was truncating card JSON output. Fixed with `thinking: {type: "disabled"}` (this is a short bounded writing task, doesn't need reasoning) plus more `max_tokens` headroom (2048).
- A single failing card used to fail the entire digest (`Promise.all`) — switched to `Promise.allSettled` so one bad card is dropped/logged instead of nuking the whole response.
- ESLint was linting the entire vault (Obsidian plugin bundles included) since this app's root is the project's Obsidian sub-vault, not an isolated repo — scoped it to app code only in `eslint.config.mjs`.

Verified end-to-end in a real browser (Playwright): full "Give me today's news" flow works, cards render with real synthesized summaries from real RSS articles, expand/collapse works, source links are real and correct, zero console errors.

**Triage tuning — resolved.** Rewrote the Haiku prompt with explicit include/reject criteria matching the "head of state's briefing" framing (reject when torn) and gave it article snippets, not just headlines. Went from ~47–50 of 136 clusters passing to 13 on the same article set — a real curated brief.

**Workflow decision:** set up the QA/code-review workflow that was deferred at brainstorm time (see `CLAUDE.md` Process section). `/code-review` (user-invoked, independent review agent) runs against a diff on request. Per-feature QA is a `general-purpose` subagent with no context on how the feature was built, prompted to actually exercise the running app (not just read the code) and report bugs. No formal test suite (Vitest etc.) — decided against for now, revisit if the project grows enough to justify one.

First real QA pass (against Phase 1) found two genuine bugs, both fixed:
1. Articles appearing in more than one feed (e.g. a BBC story syndicated into both its Technology and World feeds) were ingested twice across topics with no cross-topic dedup, producing a card with the same source listed twice and — separately — a couple of truncated summaries. Fixed with URL-based dedup in `ingestArticles`.
2. `triageCluster` calls used a plain `Promise.all` — one Haiku call failing would throw and discard the entire digest, including clusters that had already succeeded, unlike `writeCard` which was already resilient. Fixed with fail-closed per-cluster error handling (a failed triage is treated as not-notable, not fatal).

Also added a truncation guard in `writeCard`: a summary that doesn't end on sentence-terminal punctuation is now treated as a failed write and dropped, instead of shipping mid-sentence.

Re-verified end to end after fixes: 15 well-formed cards, zero duplicate-source cards, zero truncated summaries.

**Phase 1 is done.** All 6+ commits pushed to `origin/master`. Per `CLAUDE.md`'s prime directive, stopping here — next session should go back to plan mode to scope Phase 2 (real accounts / Supabase) before any further building.

## 2026-07-24 — Brainstorm complete, design docs written
Ran the `project-brainstorm` interview end to end. Key decisions:
- **Card model:** each card = one specific story (not a topic theme), synthesized from multiple sources — short summary by default, full report + sources on expand. No fixed card count per digest; driven by actual notability.
- **Accounts:** real signup/login in v1 via Supabase Auth (managed, not hand-rolled) — explicitly wanted to test the real workflow, not just for Tarek. Curated multi-select (not free text) for both topic and preferred-source selection at profile setup; free text deferred to v2.
- **Sourcing:** RSS feeds as primary source, GNews as an optional supplement. NewsAPI ruled out — its free tier blocks any non-localhost deployment, a dead end once friends are testing it. No social media (X) sourcing in v1.
- **Synthesis pipeline:** split clustering (free, local embeddings, no LLM) from notability triage (cheap Claude Haiku call) from card writing (Claude Sonnet) — cheaper than one big Claude call doing everything. Expanded reports generated lazily (only on first expand, then cached), not pre-built for every card.
- **Hosting:** Vercel (Hobby, free) + Supabase (Free tier) from day one, since friends will test it — not local-only. Estimated fixed cost $0/month; variable Claude API cost roughly $15–50/month, to be corrected with real usage data once live.
- **New feature vs. original scope:** bookmarking added (save a card, dedicated "Saved" view) — cheap to add since digests already persist via calendar history.
- Docs written to `docs/`: `ARCHITECTURE.md`, `TECH_STACK.md`, `ROADMAP.md`, `DATABASE_SCHEMA.md`, `GLOSSARY.md`, `DATA_HANDLING.md`. Skipped a separate `API_SPEC.md` — no external/public API surface for v1, internal routes covered in `ARCHITECTURE.md`.
- Project CLAUDE.md updated (summary, prime directive, stack/data-handling rules, status → "Brainstormed — ready to build").
- Noted but deferred to build phase: whether to use Claude Code subagents (QA agent, code-review agent, deep-research agent) during Phase 1 build — a build-workflow decision, not a product-design one.

**Next:** `git init` + GitHub remote, then a fresh Claude Code session in plan mode to scope Phase 1 (core synthesis pipeline, hardcoded profile, no auth yet).

## 2026-07-24 — Project scaffolded
Created via the New Project skill. Success condition for v1 ("shipped"): working end-to-end for Tarek himself (3–4 default topics, chat-style "give me today's news," scrollable feed) — not yet shared with outside users. Next: run `project-brainstorm` (ideally in Claude Code) to produce design docs.
