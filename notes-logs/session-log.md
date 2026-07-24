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

**Open finding, not yet resolved:** Haiku's triage is currently quite permissive — ~47–50 of ~136 clusters passed as "notable" in test runs, which is a lot more cards than a curated daily briefing implies, and costs more per digest than the `TECH_STACK.md` estimate assumed. Worth a prompt-tuning pass before calling Phase 1 fully done — either tightening the triage bar or accepting this is genuinely how much news 2 topics × 3 sources produces in a day.

**Next:** decide on triage tuning (see above), then either continue polishing Phase 1 or move to Phase 2 (real accounts) per the roadmap.

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
