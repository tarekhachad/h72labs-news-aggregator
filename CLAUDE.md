# Personalized News Aggregator

A personalized daily news tool, one of H72 Labs' two flagship products. A chat-style request interface ("give me today's news," with ad-hoc topic requests), backed by a scrollable feed where **each card is one specific story** (not a broad theme), synthesized from multiple sources — short summary by default, full report + sources on expand. Backed by a calendar history of past days, plus bookmarking of individual cards. Real signup/login from v1 (managed auth, not hand-rolled), with curated multi-select for topics and preferred sources at profile setup. Backend: tiered Claude API usage (Haiku for notability triage, Sonnet for card writing) plus free local embedding-based clustering, RSS feeds as the primary source (GNews as a supplement — NewsAPI is excluded, its free tier blocks non-localhost use). Hosted on Vercel + Supabase from day one. Full detail in `docs/`; full product context also lives in the vault root's `H72_Labs_Company_Plan.md`.

---

## Claude's Role in This Project

Vibe-code this end to end: turn the design docs into working code one small piece at a time, explaining each step since Tarek doesn't come from a software-engineering background. He digs deep and wants to fully understand what's being built — teach, don't just decide.

**Prime directive:** working end-to-end for Tarek himself and a handful of friends testing it — the chat-style "give me today's news" interaction, the scrollable feed of one-story-per-card synthesis, real login, calendar history, and bookmarking, per `docs/ROADMAP.md`. That's "shipped" for v1. Build Phase 1 (the core pipeline, hardcoded profile, no auth yet) before Phase 2 (real accounts) — prove the riskiest part cheaply first. If a session drifts into planning or polishing instead of moving toward the next roadmap phase, call it out and pull Tarek back to the smallest next build step. (He over-plans and under-ships — fight it here too.)

---

## Process

How work flows from idea to done in this project. Default for a vibe-coded build:
1. **Brainstorm** — conversation → design docs in `docs/`. Run the bundled `project-brainstorm` skill at `.claude/skills/project-brainstorm.md`. Ideally in Claude Code.
2. **Review** — read/annotate the design docs in Obsidian before building.
3. **Build** — Claude Code implements one small, explained piece at a time; commit as you go.
4. **QA pass per feature, fix, then re-verify — not a single-pass gate** — after each feature (a roadmap phase, OR any meaningfully-sized addition) is implemented, before considering it done: spawn the `qa` subagent (`.claude/agents/qa.md`) against the new/changed code, then the `code-reviewer` subagent (`.claude/agents/code-reviewer.md`). Both have zero context at spawn time on how the feature was built or reasoned about — that's intentional, it's what makes the feedback unbiased rather than the implementer grading its own work. `qa` writes and runs real tests (or, for something better exercised live than unit-tested — like an API route or a UI flow — actually runs the app and hits it); `code-reviewer` reviews the diff itself for correctness/readability/performance/security.
   Fix what they find — then **re-run both subagents again against the updated diff**, not just self-verification with a throwaway script. Repeat until a round comes back clean, or until any residual issue is a conscious, surfaced decision (fix again vs. accept and document) rather than silently dropped after one round. A fix is new code; it deserves the same unbiased pass the original code got. Give the re-verification round the specific finding being addressed plus the diff that resolves it (keeps it fast — no need to re-digest the whole feature), but do a full fresh cold review instead of a targeted one when the fix touches something consequential — decision logic in the pipeline, data mutations, auth/security. Skip the loop only for changes with no logic to re-check at all (pure doc edits, renames) — not as a size-based judgment call, since "this fix looks small" is exactly the reasoning that has let real bugs through unreviewed before (see `notes-logs/session-log.md`, 2026-07-30 entries — the `writeCard.ts` allowlist fix shipped unreviewed and produced a real, user-visible bug the very next round, caught by Tarek's manual testing instead of a second automated pass).
   This is a standing convention documented here, not a hook-enforced gate — it relies on actually following it every time a feature is "done," the same as any other rule in this file.
5. **Code review (broader)** — `/code-review` (user-invoked, Claude can't trigger it itself) is the heavier independent review for a full diff/branch — use it at bigger checkpoints (end of a phase), not as a per-feature substitute for the `code-reviewer` subagent above.

## Working in Claude Code vs. Cowork vs. Claudian

- **Claude Code (CLI)** is the primary tool for this project once building starts: `cd` into this folder and run `claude`. Full filesystem + git + run-code access.
- **Cowork** is fine for brainstorming/design-doc work and cross-domain pulls (e.g. feeding this project into a job application).
- **Claudian** for quick in-Obsidian questions about a doc while it's open.

## Folder Structure

```
Personalized News Aggregator/
├── CLAUDE.md          ← this file (project-scoped context)
├── docs/              ← design docs (ARCHITECTURE, TECH_STACK, ROADMAP, … — filled by project-brainstorm)
├── notes-logs/        ← project notes + append-only session-log.md
├── src/               ← code (or the repo root itself — TBD at brainstorm/build time)
├── .claude/skills/    ← bundled build skills (copies of root Skills/; master lives at the Brain root)
└── .obsidian/         ← Obsidian config (shared look/feel from the template)
```

> Bundled skills in `.claude/skills/` are **copies** of the Brain root's master `Skills/`. If a master skill changes, re-copy it here. They're bundled so Claude Code can run them from inside this standalone repo. Currently bundled: `project-brainstorm`.

## Rules & Conventions

- **`(C)` prefix** on AI-authored content/doc files (design docs, notes). Code files follow normal code conventions, not `(C)`.
- **Ask before editing** any non-`(C)` file Tarek wrote by hand.
- **Append-only session log:** record what was done / decided / what's next in `notes-logs/session-log.md`, newest at top — so context survives across Claude Code sessions.
- **git:** Tarek runs `git init` and manages commits himself; propose commit points but don't init or force git. Per the project-brainstorm handoff, `git init` happens once design docs are done, right before Phase 1 build starts.
- **Monetization (from H72 plan):** freemium — launch free with no ads to remove friction and build a retained user base first; ad cards and/or a paid ad-free tier come later once real usage data exists. Not a v1 concern.
- **Stack (from brainstorm):** Next.js on Vercel, Supabase for Postgres + managed auth. RSS feeds as the primary news source, GNews as a supplement — NewsAPI is a dead end (free tier blocks non-localhost deployment). Tiered Claude usage (Haiku triage, Sonnet writing) plus free local embeddings for clustering — don't default to "one big Claude call does everything," it's more expensive than it needs to be. Full detail + reasoning in `docs/TECH_STACK.md` and `docs/ARCHITECTURE.md`.
- **Data handling:** real user accounts from v1 (not just Tarek) — see `docs/DATA_HANDLING.md` before touching anything account/data-related.
- **Topic/source selection:** curated multi-select only for v1 (both topics and preferred sources) — free-text entry is explicitly deferred to v2, don't build it early.

## Current Status

> **Last updated:** 2026-07-30
> **Status:** Phase 2 built and real-usage-tested, plus the profile/settings page (edit topics/sources, change password) is now built, QA'd, and code-reviewed.

Design docs are in `docs/`: `ARCHITECTURE.md`, `TECH_STACK.md`, `ROADMAP.md`, `DATABASE_SCHEMA.md`, `GLOSSARY.md`, `DATA_HANDLING.md`. Phase 0 (scaffold), Phase 1 (RSS ingest → local embedding clustering → Haiku triage → Sonnet card writing → feed UI), and Phase 2 (real accounts) are done — see `notes-logs/session-log.md` for the full build log. Phase 2 highlights: signup/login/sign-out via Supabase Auth (`src/app/{login,signup}`, `src/app/auth/`), a curated multi-select onboarding flow (13 topics × 46 sources, no selection cap — expanded well beyond the original 2/3 during scoping, every feed live-verified), `user_topics`/`user_preferred_sources` tables with RLS (`supabase/schema.sql`), route protection via `src/proxy.ts` (Next.js renamed `middleware.ts` → `proxy.ts` in v16, migrated live) plus `/api/digest`'s own independent auth check, and `src/config/devProfile.ts` deleted now that real profiles drive the pipeline.

Same-day follow-up after real testing surfaced real problems: (1) the triage prompt's "head of state's briefing" framing had calcified into literal geopolitical-significance criteria that structurally excluded Sports/Finance/most topics — rewrote it to judge notability relative to each topic's own standard, and added topic-grouped tabs with explicit "no notable news today" empty states in `Feed.tsx`; (2) the "since last digest" recency-filter timestamp was keyed to the browser (`localStorage`) not the account, so switching test accounts in one browser leaked one account's history into another's supposedly-fresh first run — fixed by namespacing the key by user ID; (3) a real memory-crash incident — `cluster.ts` batched an entire large digest's articles (1000+, once topic/source selection has no cap) into one embedding call, and transformer batch padding made memory scale catastrophically (~34GB, crashed the machine); fixed by chunking into bounded batches of 64.

Two feature ideas raised during scoping (dynamic "hot topics" discovery, hierarchical subtopics like specific leagues/clubs/players) were deliberately deferred — documented with full reasoning in `ROADMAP.md`'s "Explicitly deferred" section, not lost. Also deferred: capping unbounded `Promise.all` concurrency in the triage step (risk of tripping Anthropic rate limits at large topic/source selections — 300-500+ clusters means 300-500+ simultaneous API calls today), and whether very large topic/source selections should have a sane cap at all. Not yet started: Phase 3 (history/bookmarking), Phase 4 (ad-hoc chat requests), Phase 5 (cost/quality pass + friends testing).

**Profile/settings page (2026-07-30):** built `/profile` — edit topic/preferred-source selections (pre-populated, reusing the onboarding multi-select UI via a new shared `src/components/PreferencesForm.tsx`) and change password (`supabase.auth.updateUser`, no current-password reauth — Supabase doesn't require it and no reauth pattern exists elsewhere in the app, accepted as a documented trade-off). Refactored the onboarding save action's delete-then-insert DB logic into a shared `saveUserProfile()` in `src/lib/profile.ts` so onboarding and the new edit flow share one write path. Independent `qa` and `code-reviewer` subagent passes both caught a real bug: the delete-then-insert wasn't atomic and a duplicate-value submission (or an ordinary double-click, since neither form had a pending-disabled submit button) could wipe a user's saved preferences when the insert half failed after the delete half had already committed — fixed by deduping the zod input and adding a shared `SubmitButton` (`useFormStatus`) that disables while pending; verified live that both trigger paths no longer reproduce. Flagged but **not fixed** (new scope, not a bug in this feature): there's no forgot-password/email-reset flow anywhere in the app, so the password-change trade-off is bigger than documented — a hijacked session could lock a user out with no self-service recovery. Full detail in `notes-logs/session-log.md`.

**Next session:** Tarek to decide on the password-reset/forgot-password gap (fix now vs. defer); otherwise resume the roadmap — Phase 3 (history/bookmarking), Phase 4 (ad-hoc chat requests), Phase 5 (cost/quality pass + friends testing). The deferred triage-concurrency and topic/source-selection-cap questions are still open too.
