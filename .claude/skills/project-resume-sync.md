# Skill: Project Resume Sync

**Trigger:** Run proactively by Claude after a project reaches a "significant update" during build — the same threshold each project's own `CLAUDE.md` already defines for the qa/code-reviewer loop (a full roadmap phase, or any meaningfully-sized feature/addition). Also invokable on demand ("sync the resume file for this project," "update my project library entry," "refresh [project]'s resume description").

**One-liner:** Read this project's own persisted build record — `CLAUDE.md`, `docs/`, `notes-logs/project-log.md`, git log — and write/update its entry in `Job Applications/Master Resources/projects/(C) [slug].md`, the single source `job-application-prep` uses for this project's resume bullets and cover-letter descriptions. Transcribes and compresses real, already-documented work into resume-ready language. **Never invents.**

---

## Why this exists

`job-application-prep` names the `projects/*.md` library as its highest-precedence tailoring source, but that only works if every real project actually has an entry, and that entry stays current. Before this skill, the only way a live-build project's status reached any job-search artifact was an ad hoc, undocumented read of the live repo — inconsistent in what got read and how it was phrased. This skill makes that update a real, repeatable procedure instead of a one-off improvisation.

---

## The two altitudes (read this before writing anything)

**This is the most important rule in the skill.** The target file is not one document at one altitude — it is two zones with opposite writing standards, and mixing them is the failure mode this skill exists to prevent.

| | **Detail zone** | **Resume-facing zone** |
|---|---|---|
| **Sections** | `What I did`, plus `tags`/`tech` frontmatter | `outcome:` frontmatter, `Results & impact`, `Skills demonstrated`, `Resume bullets (menu)` |
| **Written for** | Claude — as tailoring source material | A recruiter or hiring manager with **zero context** on this project |
| **Standard** | Specific, technical, dense. Granularity is a *feature*. | Legible cold, on one read, with no explanation |
| **Over time** | Grows — new work is filed under an existing capability theme | **Bounded.** Re-derived in full each sync, never appended to |

**The detail zone is the raw material; the resume-facing zone is the product. Never let raw material leak into the product.**

### Why this matters (the failure this prevents)

Left unseparated, every sync appends one more bullet describing *the sub-phase just built*, phrased at build altitude. After enough syncs the bullet menu is a changelog: bullets keyed to internal phases, thick with library-internal jargon and review-process vocabulary, unreadable to anyone who wasn't in the build. That material is genuinely valuable — but as *detail-zone* context, not as resume bullets. `job-application-prep` then compresses an already-opaque bullet into a resume line that means nothing to the person reading it.

This happened for real: by 2026-08-12 the news aggregator's entry had reached 41 KB with sixteen 60–80-word bullets, an `outcome:` field that ran ~300 words, and roughly 60% of its bullets describing the qa/code-reviewer loop rather than what was built. Tarek flagged it directly — the bullets didn't make sense to recruiters who lacked project context. The two-zone model plus the fixed capability slots below is the structural fix.

---

## The recruiter-legibility test

**A hard gate. Every line in the resume-facing zone must pass all five checks before this skill reports done.**

1. **Cold-read.** Would someone who has never seen this project understand it on one read, with no explanation from Tarek?
2. **Capability, not incident.** Does it name something Tarek *can do*, rather than something that *happened on a specific day*? "Engineered X" passes; "fixed the bug that round 2 found in the fix from round 1" fails.
3. **Durable.** Would it still be worth saying if the project doubled in size? Capabilities survive that; changelog entries don't.
4. **Ban list.** None of the following ever appears in the resume-facing zone:
   - Phase/sub-phase numbers, review-round counts, feature tallies — *"fourteen sub-phases across three fix-iteration phases," "four consecutive rounds," "converged to zero findings."*
   - Internal process vocabulary — *the `qa` subagent, the `code-reviewer` subagent, "escalated as a fix-or-accept decision," "run to convergence."*
   - Library-internal jargon — *`inert`, `ResizeObserver`, `layoutId`, `getBoundingClientRect`, React Strict Mode, `grid-auto-flow: dense`.*
   - Internal file, component, or module names.
   - **Not banned:** stack-level technology names (Next.js, Supabase, PostgreSQL, Claude API, TypeScript, React). Those are resume-standard and belong there.
5. **Length.** ≤ 40 words, one sentence. Match `master-resume.tex`'s existing density and shape: **action verb → what was built → concrete technical substance → quantified or concrete outcome.**

A useful reframe for checks 2 and 4: the underlying work is almost always worth claiming — it just has to be claimed as an *engineering capability* rather than narrated as a *build event*. Don't delete the substance; raise its altitude.

---

## Inputs

- This project's `CLAUDE.md` — especially the **Current Status** section.
- `docs/*.md` (`ARCHITECTURE.md`, `ROADMAP.md`, `TECH_STACK.md`, etc.) — technical grounding for what was actually built and why.
- `notes-logs/project-log.md` — the detailed, dated build history. This is where the real numbers and specific bugs/fixes live.
- `git log` for this repo — a factual cross-check on what shipped and when.
- The existing `Job Applications/Master Resources/projects/(C) [slug].md`, if one already exists — read its `last_synced` frontmatter field and full content **before** writing anything.
- `Job Applications/Master Resources/projects/_TEMPLATE.md` — the structure every entry (including this one) must follow.
- `Job Applications/Master Resources/master-resume.tex` — read its existing project bullets as the phrasing/density/quality bar to match. Don't invent a new style. **This is the calibration reference for the whole resume-facing zone** — if the new bullets are visibly longer or denser than those, they're wrong.

---

## Process

### 1. Resolve the target file
Kebab-case the project's folder name to get its slug (e.g. `Personalized News Aggregator` → `personalized-news-aggregator`). Target path: `Job Applications/Master Resources/projects/(C) [slug].md`.

### 2. Create or update — by zone, not by whole file

- **If the file doesn't exist:** create it from `_TEMPLATE.md`, backfilling the project's full history to date from `CLAUDE.md` + `project-log.md`.
- **If it exists:** read its `last_synced` date and treat only `CLAUDE.md`/`project-log.md` content dated after that as "new." Then update the two zones by their own rules:
  - **Detail zone** — extend, as before. But file new work **under its existing capability theme**, never as a new chronological entry. If the new work genuinely belongs to no existing theme, add a theme; don't add a phase.
  - **Resume-facing zone** — **re-derive in full** from the *complete* detail zone (not just the new part), every sync. This is a rewrite, not an append. Rewriting from the whole is what lets a bullet get *better* as the project grows instead of the list getting *longer*.
- **Preserving hand edits:** the resume-facing zone is regenerated, so any bullet Tarek has hand-edited and wants kept verbatim must be marked with a trailing `<!-- keep -->` comment. Honor those exactly; regenerate everything else.

### 3. Extract concrete, real facts (detail zone)
Mine specifics, not vague summaries:
- Real numbers: test counts, scale (records/rows/GB processed, concurrency levels), performance deltas, cost figures.
- Bugs found and fixed, and their **real-world consequence** if they'd shipped (data loss, double-spend, crash) — these are genuine engineering-rigor signals, not embarrassing details to hide.
- Stack and specific tools/APIs used.
- Process signals worth surfacing: the qa/code-reviewer fix→re-verify loop catching a real bug before it shipped, deliberate scope decisions (and why), phased delivery discipline.

All of this belongs in the detail zone at full specificity. It reaches the resume-facing zone only after being raised to capability altitude by step 4.

### 4. Write the detail zone
- **What it was / Your role** — plain, accurate description.
- **What I did** — organize by **capability theme**, never by build chronology. Pick themes that fit what's actually true for this kind of project (for a full-stack product: pipeline/backend, LLM/AI architecture, data model & security, frontend/product surface, reliability & QA) rather than forcing a data-pipeline shape onto a product build. Nest the specifics — the numbers, the bugs, the design decisions — *underneath* the theme they evidence.

  Theme-first organization is not cosmetic: the shape of this section determines the shape of the bullets derived from it. A section organized by phase produces bullets about phases.

  Soft ceiling: ~6–8 themes. When a project outgrows that, merge related themes rather than adding a ninth.

### 5. Write the resume-facing zone

Every line here must pass the recruiter-legibility test above.

- **`outcome:` frontmatter** — one sentence, **≤ 30 words**, naming what was built, the stack, and the single strongest number. Hard cap. This is a headline, not a summary.
- **Results & impact** — **≤ 8 lines.** Only real, quantifiable outcomes; if a number can't be verified from source, leave it out rather than approximating into a fake-sounding metric.

  **Aggregate, don't enumerate.** Promote repeated specifics into one generalized, quantified statement instead of listing each occurrence. Real numbers (cost per run, memory reduction, test count, coverage) stay verbatim — they're the strongest content in the file. What gets collapsed is the narration around them.

- **Skills demonstrated** — **≤ 10 grouped headline skills**, in language a recruiter or an ATS matches on. Group hyper-granular entries upward: several lines about specific browser APIs, React internals, and animation timing collapse into one frontend/React engineering line naming the capability.
- **Resume bullets (menu)** — **fixed capability slots, not a growing list.** See below.

#### The capability slots

Instead of accumulating bullets, the menu has a **permanent slot list**. Each sync rewrites the best current version of each slot, drawing from the whole detail zone.

**Rule: a new phase never earns a new bullet. It earns a better version of an existing slot's bullet, or it changes nothing.**

Default slots — adapt the names to the project, **hard cap 8**, exactly one bullet each:

1. **Headline** — what the product is, that it shipped, and the stack
2. **Backend / data pipeline & architecture**
3. **AI/LLM application engineering** — including cost architecture
4. **Data modeling, infrastructure & security**
5. **Frontend / product surface & design system**
6. **Reliability, testing & quality engineering**
7. **Product scoping, ownership & decision-making**

Drop a slot with no real material behind it rather than padding it. Each bullet leans a different angle so `job-application-prep`'s per-job selection step has genuinely differentiated material to choose from — seven distinct, legible angles select far better than sixteen overlapping opaque ones.

### 6. Update frontmatter
Set `last_synced: <today's date>` and `source: <what was read through>` (e.g. `"project-log.md through 2026-08-03 + git log"`) so future runs and other tooling can tell how fresh the entry is. Keep `source:` to one short line — it's provenance, not a changelog. Leave `tags`/`tech` granular; they're machine-matching fields where specificity helps.

### 7. Verification gate (before reporting done)

Mirrors the provenance check `job-application-prep` runs at its own step 7 — a stated standard without an actual line-by-line pass is not verification.

Re-read the resume-facing zone **cold**, as if seeing this project for the first time. For every line:
- Confirm all five legibility checks pass.
- Confirm the word count is within cap.

Any line that fails gets rewritten before this skill reports complete. Then check size:

- **Resume-facing zone: ~5 KB.** This isn't an independent target — it's simply what the caps above (≤ 8 bullets, ≤ 8 results lines, ≤ 10 skills, all within word limits) produce. **The caps are the real control; the byte figure is only a sanity check.** If the zone is meaningfully larger, a cap is being violated somewhere — find which, don't trim prose to hit a number.
- **Detail zone: no byte cap.** It legitimately scales with the size of the project, and capping it would mean deleting real context as the work grows — the opposite of what it's for. Its control is the **~6–8 theme ceiling**: when it feels bloated, merge related themes and consolidate the specifics beneath them. **Never truncate real content to hit a byte target.**

Report the resume-facing zone's size and the detail zone's theme count in step 8.

### 8. Report
Tell Tarek what changed in the file (which slots' bullets were rewritten and why, what was newly filed into the detail zone, anything flagged as unverifiable and left out), the file's size against budget, and confirm it's ready for `job-application-prep` to use.

---

## Worked examples — before/after

Real pairs from the news aggregator's entry. The information is the same; the altitude isn't.

**Bullet — accessibility work**
- ❌ *"Root-caused and fixed a three-layer accessibility/React-internals bug chain in an animated UI component — a keyboard-focus reachability gap, a spec-defined focus-ejection side effect from its own fix, and a React Strict Mode timing bug in the fix after that — via four consecutive rounds of independent review, each fix independently re-verified rather than trusted…"* (65 words; fails checks 1, 2, 3, 4, 5)
- ✅ *"Engineered accessible animated UI in React/Next.js — keyboard navigation, focus management, and screen-reader correctness — with defects caught by an automated review pipeline before release."* (24 words)

**Bullet — state architecture**
- ❌ *"Redesigned a streaming feature's React state ownership from component-local (broken by client-side routing) to a shared, layout-scoped Context architecture… then hardened it through three independent-review rounds, two of which found real race/staleness bugs (one explicitly escalated as a fix-or-accept product decision rather than resolved unilaterally)…"* (80 words; fails 1, 2, 3, 4, 5)
- ✅ *"Re-architected client state ownership in a React/Next.js app so long-running background operations survive in-app navigation, resolving race and staleness defects in concurrent async workflows."* (24 words)

**Results line**
- ❌ *"Fourteen total feature sub-phases across three structured fix-iteration phases post-launch, maintaining the same independent-review convergence discipline as core pipeline work throughout — zero known regressions shipped past it."* (fails 2, 3, 4)
- ✅ *"Built a 120-test regression suite and an automated review process that caught every high-severity defect — auth, concurrency, data-integrity — before release."*

Note what survives in each: the real engineering (accessibility, state architecture, test count, defect classes) is fully preserved. What's dropped is the build-process narration around it.

---

## Rules

- **Truth only.** Every claim traces to this project's own `CLAUDE.md`, `docs/`, `project-log.md`, or `git log`. Never invent results, metrics, or scope — same standard `job-application-prep` itself holds to. Raising altitude means generalizing a real claim, **never broadening it into one the source doesn't support.**
- **`(C)` prefix** on the target file — it's fully AI-maintained, unlike its hand-written sibling entries in the same folder (same reasoning as `(C) candidate-profile.md`, the other synced file in `Master Resources/`). This is also what lets Claude update it proactively without asking first each time, per the vault's "ask before editing non-`(C)` files" rule.
- **Never touch `(C) candidate-profile.md`.** That file belongs to `job-scanner`'s own separate sync process — keep the two paths independent.
- **Never touch the hand-written entries** in `projects/` (`electramap-ai.md`, `boehringer-ingelheim.md`, etc.). They're Tarek's, non-`(C)`, and out of this skill's scope.
- **Master copy lives at `Skills/project-resume-sync.md`.** Bundled copies in each project's `.claude/skills/` are copies — re-copy into existing projects if the master changes, same convention as `qa`, `code-reviewer`, and `project-brainstorm`.
