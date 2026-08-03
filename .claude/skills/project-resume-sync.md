# Skill: Project Resume Sync

**Trigger:** Run proactively by Claude after a project reaches a "significant update" during build — the same threshold each project's own `CLAUDE.md` already defines for the qa/code-reviewer loop (a full roadmap phase, or any meaningfully-sized feature/addition). Also invokable on demand ("sync the resume file for this project," "update my project library entry," "refresh [project]'s resume description").

**One-liner:** Read this project's own persisted build record — `CLAUDE.md`, `docs/`, `notes-logs/session-log.md`, git log — and write/update its entry in `Job Applications/Master Resources/projects/(C) [slug].md`, the single source `job-application-prep` uses for this project's resume bullets and cover-letter descriptions. Transcribes and compresses real, already-documented work into resume-ready language. **Never invents.**

---

## Why this exists

`job-application-prep` names the `projects/*.md` library as its highest-precedence tailoring source, but that only works if every real project actually has an entry, and that entry stays current. Before this skill, the only way a live-build project's status reached any job-search artifact was an ad hoc, undocumented read of the live repo — inconsistent in what got read and how it was phrased. This skill makes that update a real, repeatable procedure instead of a one-off improvisation.

---

## Inputs

- This project's `CLAUDE.md` — especially the **Current Status** section (the build changelog).
- `docs/*.md` (`ARCHITECTURE.md`, `ROADMAP.md`, `TECH_STACK.md`, etc.) — technical grounding for what was actually built and why.
- `notes-logs/session-log.md` — the detailed, dated build history. This is where the real numbers and specific bugs/fixes live.
- `git log` for this repo — a factual cross-check on what shipped and when.
- The existing `Job Applications/Master Resources/projects/(C) [slug].md`, if one already exists — read its `last_synced` frontmatter field and full content **before** writing anything, so incremental updates extend it rather than silently overwriting any content Tarek added by hand.
- `Job Applications/Master Resources/projects/_TEMPLATE.md` — the structure every entry (including this one) must follow.
- `Job Applications/Master Resources/master-resume.tex` — read a couple of its existing project bullets as the phrasing/density/quality bar to match. Don't invent a new style.

---

## Process

### 1. Resolve the target file
Kebab-case the project's folder name to get its slug (e.g. `Personalized News Aggregator` → `personalized-news-aggregator`). Target path: `Job Applications/Master Resources/projects/(C) [slug].md`.

### 2. Create or update
- **If the file doesn't exist:** create it from `_TEMPLATE.md`, backfilling the project's full history to date from `CLAUDE.md` + `session-log.md`.
- **If it exists:** read its `last_synced` date and treat only `CLAUDE.md`/`session-log.md` content dated after that as "new." Extend the existing sections (append to "What I did," add new Results/Skills bullets, refresh the bullet menu) rather than regenerating the whole file from scratch — this preserves anything Tarek has hand-edited in.

### 3. Extract concrete, real facts
Mine specifics, not vague summaries:
- Real numbers: test counts, scale (records/rows/GB processed, concurrency levels), performance deltas, cost figures.
- Bugs found and fixed, and their **real-world consequence** if they'd shipped (data loss, double-spend, crash) — these are genuine engineering-rigor signals, not embarrassing details to hide.
- Stack and specific tools/APIs used.
- Process signals worth surfacing: the qa/code-reviewer fix→re-verify loop catching a real bug before it shipped, deliberate scope decisions (and why), phased delivery discipline.

### 4. Write every `_TEMPLATE.md` section
- **What it was / Your role** — plain, accurate description.
- **What I did** — reorganize the template's categories to fit what's actually true for this kind of project (e.g. for a full-stack product: pipeline/backend, frontend/product surface, infra/auth/data, process/QA) rather than forcing a data-pipeline shape onto a product build.
- **Results & impact** — only real, quantifiable outcomes. If a number can't be verified from source, leave it out; don't approximate into a fake-sounding metric.
- **Skills demonstrated.**
- **Resume bullets (menu)** — write 4-6 dense, quantified variants, each leaning a different angle relevant to a job-search context (e.g. full-stack product delivery, LLM/AI application design, concurrency/reliability debugging, systematic QA/process discipline, product scoping and phased shipping) so `job-application-prep`'s per-job selection step has real material to choose from and re-emphasize. Match `master-resume.tex`'s existing density: action verb → what was built/engineered → concrete technical detail → quantified outcome, in one sentence.

### 5. Update frontmatter
Set `last_synced: <today's date>` and `source: <what was read through>` (e.g. `"CLAUDE.md Current Status + session-log.md through 2026-08-03"`) so future runs and other tooling can tell how fresh the entry is.

### 6. Report
Tell Tarek what changed in the file (new sections, updated bullets, anything flagged as unverifiable and left out) and confirm it's ready for `job-application-prep` to use.

---

## Rules

- **Truth only.** Every claim traces to this project's own `CLAUDE.md`, `docs/`, `session-log.md`, or `git log`. Never invent results, metrics, or scope — same standard `job-application-prep` itself holds to.
- **`(C)` prefix** on the target file — it's fully AI-maintained, unlike its hand-written sibling entries in the same folder (same reasoning as `(C) candidate-profile.md`, the other synced file in `Master Resources/`). This is also what lets Claude update it proactively without asking first each time, per the vault's "ask before editing non-`(C)` files" rule.
- **Never touch `(C) candidate-profile.md`.** That file belongs to `job-scanner`'s own separate sync process — keep the two paths independent.
- **Master copy lives at `Skills/project-resume-sync.md`.** Bundled copies in each project's `.claude/skills/` are copies — re-copy into existing projects if the master changes, same convention as `qa`, `code-reviewer`, and `project-brainstorm`.
