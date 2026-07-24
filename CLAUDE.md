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
4. **Code review** — run `/code-review` against the diff before considering a chunk of work done. User-invoked only (Claude can't trigger it itself).
5. **QA pass per feature** — after each feature (a roadmap phase, or any meaningfully-sized addition), spawn a `general-purpose` subagent as an independent tester. It gets no context on how the feature was built (only the spec and how to run it), so it isn't biased by the implementer's own assumptions about what "should" work. It actually exercises the feature (runs it, hits the real endpoints/UI, tries edge cases and error paths — not just re-reads the code) and reports bugs/gaps found. This is a lighter-weight standing pattern, not a formal automated test suite — no test framework is set up for this project (decided 2026-07-24; revisit if the project grows enough to justify one).

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

> **Last updated:** 2026-07-24
> **Status:** Phase 1 built and verified end-to-end (core pipeline, hardcoded profile, no auth).

Design docs are in `docs/`: `ARCHITECTURE.md`, `TECH_STACK.md`, `ROADMAP.md`, `DATABASE_SCHEMA.md`, `GLOSSARY.md`, `DATA_HANDLING.md`. Phase 0 (scaffold) and Phase 1 (RSS ingest → local embedding clustering → Haiku triage → Sonnet card writing → feed UI) are done — see `notes-logs/session-log.md` for the full build log. Not yet started: Phase 2 (real accounts/Supabase), Phase 3 (history/bookmarking), Phase 4 (ad-hoc chat requests), Phase 5 (cost/quality pass + friends testing). Next: run the QA subagent pass (per Process above) on Phase 1, then decide whether to keep polishing Phase 1 or move to Phase 2.
