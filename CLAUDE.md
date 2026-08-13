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
4. **QA pass per feature, fix, then re-verify — iterate to true convergence, no self-imposed cap** — after each feature (a roadmap phase, OR any meaningfully-sized addition) is implemented, before considering it done: spawn the `qa` subagent (`.claude/agents/qa.md`) against the new/changed code, then the `code-reviewer` subagent (`.claude/agents/code-reviewer.md`). Both have zero context at spawn time on how the feature was built or reasoned about — that's intentional, it's what makes the feedback unbiased rather than the implementer grading its own work. `qa` writes and runs real tests (or, for something better exercised live than unit-tested — like an API route or a UI flow — actually runs the app and hits it); `code-reviewer` reviews the diff itself for correctness/readability/performance/security.
   Fix what they find — then **re-run both subagents again against the updated diff**, not just self-verification with a throwaway script. **Every round means both agents, every time** — never drop to just one of the two (e.g. "code-reviewer only, this round is narrow/well-understood"), even for a round that only re-checks a specific fix. Scoping a round tightly (the specific finding + the diff resolving it, so it's fast and doesn't re-digest the whole feature) is fine; scoping it down to fewer agents is not — that's exactly the gap that let real bugs slip through unreviewed by one of the two lenses.
   **Keep iterating full rounds until one genuinely comes back with zero findings from both agents.** Do not decide in advance, before seeing a round's result, that "this will be the last round regardless of outcome" — that's a silent cap, not a stopping point earned by the evidence. The only legitimate way to stop before a round is fully clean is a **conscious, explicitly surfaced decision put to Tarek** ("round N found only X, a low-severity/cosmetic thing — keep iterating a full round, or accept and document?") — never inferred unilaterally from cost, session length, or "diminishing returns," since that judgment is his to make, not something to assume on his behalf. A fix is new code; it deserves the exact same unbiased two-agent pass the original code got, for as many rounds as it takes.
   Escalate to a full fresh cold review (both agents, no scope narrowing at all) rather than a tightly-scoped round whenever the fix touches something consequential — decision logic in the pipeline, data mutations, auth/security.
   This is a standing convention documented here, not a hook-enforced gate — it relies on actually following it every time a feature is "done," the same as any other rule in this file. It has been under-followed twice already, not from misunderstanding the rule but from quietly narrowing it under time/cost pressure: (1) 2026-07-30, a single-pass gate with no re-verification at all — a `writeCard.ts` allowlist fix shipped unreviewed and produced a real, user-visible bug the very next round, caught by Tarek's manual testing instead of a second automated pass; (2) 2026-08-04, during the front-page-ranking pipeline work — two full rounds each found and fixed real bugs (round 2 alone surfaced a high-severity Postgres deployment gotcha), then a third round quietly dropped to `code-reviewer` only and was privately decided in advance to be the last round regardless of what it found, without surfacing that as a choice to Tarek — who caught it and asked directly whether the loop had actually run to convergence or just been capped. Both incidents are the same failure shape: treating "this looks done" or "this is taking a while" as license to narrow the loop, instead of treating the loop's own output (a clean round) as the only thing that ends it. See `notes-logs/project-log.md`'s 2026-07-30 and 2026-08-04 entries for full detail on both.
5. **Sync the project's resume-ready description** — once a feature/phase clears the qa/code-reviewer loop above (same trigger: a roadmap phase, OR any meaningfully-sized addition), run the bundled `project-resume-sync` skill (`.claude/skills/project-resume-sync.md`) to update `Job Applications/Master Resources/projects/(C) personalized-news-aggregator.md` with what changed. This is what keeps `job-application-prep`'s resume bullets and cover-letter project descriptions current — that skill no longer reads this repo directly, only the synced file, so skipping this step means the next resume/cover-letter built off this project goes stale. Standing convention, not hook-enforced, same as step 4.
6. **Code review (broader)** — `/code-review` (user-invoked, Claude can't trigger it itself) is the heavier independent review for a full diff/branch — use it at bigger checkpoints (end of a phase), not as a per-feature substitute for the `code-reviewer` subagent above.

## Working in Claude Code vs. Cowork vs. Claudian

- **Claude Code (CLI)** is the primary tool for this project once building starts: `cd` into this folder and run `claude`. Full filesystem + git + run-code access.
- **Cowork** is fine for brainstorming/design-doc work and cross-domain pulls (e.g. feeding this project into a job application).
- **Claudian** for quick in-Obsidian questions about a doc while it's open.

## Folder Structure

```
Personalized News Aggregator/
├── CLAUDE.md          ← this file (project-scoped context)
├── docs/              ← design docs (ARCHITECTURE, TECH_STACK, ROADMAP, … — filled by project-brainstorm)
├── notes-logs/        ← project notes + append-only project-log.md (the master log)
├── src/               ← code (or the repo root itself — TBD at brainstorm/build time)
├── .claude/skills/    ← bundled build skills (copies of root Skills/; master lives at the Brain root)
└── .obsidian/         ← Obsidian config (shared look/feel from the template)
```

> Bundled skills in `.claude/skills/` are **copies** of the Brain root's master `Skills/`. If a master skill changes, re-copy it here. They're bundled so Claude Code can run them from inside this standalone repo. Currently bundled: `project-brainstorm`, `project-resume-sync`.

## Rules & Conventions

- **`(C)` prefix** on AI-authored content/doc files (design docs, notes). Code files follow normal code conventions, not `(C)`.
- **Ask before editing** any non-`(C)` file Tarek wrote by hand.
- **`notes-logs/project-log.md` is the single master log** (was `session-log.md` until 2026-08-12). Append-only, newest entry at top. Record what was done / decided / why / what's next there — every phase, sub-phase, design decision, bug found, and review round. This is what carries context across Claude Code sessions, and it's the file to read for project history.
- **Keep `CLAUDE.md` lean — status detail goes in the log, not here.** The Current Status section below is deliberately one `Last updated` paragraph and nothing more. When work lands: refresh that one line here, write the real detail into `project-log.md`. Never let a running changelog accumulate in this file — it's root context loaded on every request, so its length is paid for constantly and directly costs instruction-following quality. (This rule exists because that's exactly what had happened by 2026-08-12: ~105 lines of accumulated phase history, since migrated into the log.)
- **git:** Tarek runs `git init` and manages commits himself; propose commit points but don't init or force git. Per the project-brainstorm handoff, `git init` happens once design docs are done, right before Phase 1 build starts.
- **Monetization (from H72 plan):** freemium — launch free with no ads to remove friction and build a retained user base first; ad cards and/or a paid ad-free tier come later once real usage data exists. Not a v1 concern.
- **Stack (from brainstorm):** Next.js on Vercel, Supabase for Postgres + managed auth. RSS feeds as the primary news source, GNews as a supplement — NewsAPI is a dead end (free tier blocks non-localhost deployment). Tiered Claude usage (Haiku triage, Sonnet writing) plus free local embeddings for clustering — don't default to "one big Claude call does everything," it's more expensive than it needs to be. Full detail + reasoning in `docs/TECH_STACK.md` and `docs/ARCHITECTURE.md`.
- **Data handling:** real user accounts from v1 (not just Tarek) — see `docs/DATA_HANDLING.md` before touching anything account/data-related.
- **Topic/source selection:** curated multi-select only for v1 (both topics and preferred sources) — free-text entry is explicitly deferred to v2, don't build it early.

## Current Status

> **Last updated:** 2026-08-13 — **Final Phase: F.1–F.4.4 done, F.4.5 next.** Instrumentation shipped (`0fbd148`), then **F.3 measured the real cost: $1.66 billed / $1.94 at list per digest — ~10× the documented $0.17**, with triage (not writeCard) at 65% of spend and 91% of its input pure repetition. Full analysis in `notes-logs/(C) cost-diagnosis-2026-08-13.md`. **V2.0's cap arithmetic is off by ~10×** and must be rewritten. F.4.1–F.4.3 shipped (writeCard input cap, per-topic cap of 8 by severity, hybrid Haiku/Sonnet card writing). **F.4.4 shipped uncommitted**: the since-cursor now carries across days (`getLatestGeneratedAtForUser`), the 48h lookback became a ceiling rather than a fallback, and a corrupt-cursor guard is shared between the query and ingest via `src/lib/cursor.ts` — converged clean at review round 8, 332 tests green, zero API spend. **Next: F.4.5** (batch triage, 794 calls → ~42, highest risk in the phase), then F.4.6's paid re-measurement. Target ~$0.25/digest. Designs in `docs/(C) IMPLEMENTATION_PLAN_FINAL_PHASE.md`.

Keep it that way: when a phase or meaningfully-sized piece of work lands, update the one-paragraph `Last updated` line here and write the real detail into `project-log.md`. Do **not** let a running changelog accumulate in this file — `CLAUDE.md` is root context loaded into every Claude Code session, so length here is paid for on every single request and directly costs instruction-following quality.
