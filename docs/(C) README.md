# docs/ — what's in here and what to read

_Added 2026-09-14, at the same time the six shipped implementation plans moved into `docs/archive/`. This file exists because the folder had grown to thirteen files with nothing distinguishing live design docs from closed-phase history, and because `(C) GLOSSARY.md` was orphaned — nothing in the repo told anyone it existed._

## Live design docs — read these

| File | What it's for | When to read it |
|---|---|---|
| `(C) ROADMAP.md` | The plan. v1's phases (all closed), then Roadmap V2: the V2.0 spend-cap gate, deploy, README, and the deferred work grouped into tracks | Start of any planning session, and before picking up any deferred item |
| `(C) ARCHITECTURE.md` | How the pipeline fits together — ingest → cluster → triage → dedup → write → rank | Before changing pipeline structure or adding a stage |
| `(C) TECH_STACK.md` | Stack choices and why, plus the per-digest cost figures | Before adding a dependency or quoting a cost |
| `(C) DATABASE_SCHEMA.md` | The tables, their relationships, and the RLS model | Before any schema change or anything touching row access |
| `(C) DATA_HANDLING.md` | How real user data is treated | Before anything account- or data-related |
| `(C) GLOSSARY.md` | The project's domain vocabulary — triage, notability, clusters, cards, front-page rank | First session in a while, or any time a term's exact meaning matters |
| `(C) UI_DESIGN.md` | The visual identity and interaction model | Before UI work |

Design tokens live outside this folder, in `design-system/personalized-news-aggregator/MASTER.md`.

## `docs/archive/` — closed-phase history, not current design

Six file-level implementation plans, one per shipped phase: `4.4`, `PHASE5`, `PHASE6`, `PHASE7`, `PHASE8`, `FINAL_PHASE`. Each was copied out of Claude Code's ephemeral plan-mode artifact (`.claude/plans/`, not durable across sessions) so the file-level detail survived.

**Read them for how something was built. Never as current design.** Every one of these phases is closed, and the code has moved since — `PHASE5.md` says so itself: `notes-logs/project-log.md` and `(C) ROADMAP.md` are the ongoing record and **take precedence wherever they and an archived plan disagree**.

## The record, which is neither of the above

`notes-logs/project-log.md` is the append-only master log — every phase, decision, bug and review round, newest entry first. It is the file to read for project history, and the reason nothing in this folder needs to carry a changelog. Note that it is **append-only**: entries record what was true on their date, so a historical entry may cite a path or figure that has since changed. The 27 references to the implementation plans predating 2026-09-14 still name their old `docs/` paths, and that is by design rather than an oversight.
