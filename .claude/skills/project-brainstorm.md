# Skill: Project Brainstorm

**Trigger:** After a project is scaffolded — "let's brainstorm the X", "design docs for project X", "help me plan this build before I code." Also the natural next step the New Project skill hands off to.

**One-liner:** Turn a project idea into a blueprint Tarek can actually understand and build from — a conversation that produces an **adaptive set of design docs** in the project's `docs/`. He doesn't need engineering knowledge going in; the whole point is to produce a plan in plain language, not a pile of code.

> **Venue:** this works in Cowork, but **recommend running it in Claude Code** inside the project folder — that's where the build will live, so the docs and the code stay in one context. If run in Cowork, remind him to continue building in Claude Code afterward.

---

## How It Works

### 1. Interview (conversational, plain-language)

Ask what's needed to design the thing — one topic at a time, no jargon dumps. Typical threads (skip what doesn't apply):

- **What is it / who's it for / what's the core job it does?**
- **Users & accounts?** Real-time vs. batch/digest? Web app, CLI, notebook?
- **Data:** what goes in, what comes out, where it's stored.
- **Integrations / APIs** it depends on (Claude API, news API, a database, etc.).
- **Hosting / deployment** thoughts (local first? Streamlit? later cloud?).
- **Scope for v1** — push hard for a _tight_ MVP. This is where his over-planning shows; anchor to the smallest thing that works end-to-end. (Cross-check the H72 plan for the two LLC products — their MVP scopes are already written there.)

Explain any technical choice in plain terms as you go — he digs deep and wants to fully understand what he's building, so teach, don't just decide.

### 2. Pick the doc set (adaptive)

Generate only the docs this project actually needs — no empty boilerplate. Choose from:

|Doc|Include when…|
|---|---|
|`(C) ARCHITECTURE.md`|almost always — how the pieces fit, plain-language + a simple diagram|
|`(C) TECH_STACK.md`|almost always — chosen tools, **explained in plain language and why**|
|`(C) ROADMAP.md`|always — phased build plan, MVP first, small shippable steps|
|`(C) DATABASE_SCHEMA.md`|there's persistent structured data|
|`(C) API_SPEC.md`|it exposes or heavily consumes an API|
|`(C) GLOSSARY.md`|there are terms he'll want defined as he learns the stack|
|`(C) DATA_HANDLING.md`|it ingests user data (e.g. the Data Quality Agent's upload policy)|

State which docs you're creating and why those, before writing them.

### 3. Write the docs

- Save to the project's `docs/`, each `(C)`-prefixed.
- Plain language over jargon; where jargon is necessary, define it (or add to the glossary).
- `ROADMAP.md` breaks the build into phases, **MVP end-to-end before polish** — mirror the H72 build approach (scope tight → build core pipeline → get it in front of a few real users → instrument → iterate).
- Keep them living documents — note that they'll be revised as building reveals reality.

### 4. Update project context

- Fill in any `<!-- TODO -->`s in the project `CLAUDE.md` that the brainstorm now answers (process, stack constraints, data-handling rule).
- Append a `notes-logs/project-log.md` entry: brainstorm done, which docs exist, what's next.
- Bump the project's **Current Status** (project CLAUDE.md + the root CLAUDE.md one-liner) to "Brainstormed — ready to build."

### 5. Confirm + hand off to build

Summarize the blueprint and the very first build step from the roadmap. Don't go straight into building from here — the brainstorm conversation is long and mostly conceptual, and starting to code inside it means Claude Code is implementing with a context full of design chatter instead of a clean read of the docs it just wrote. Hand off through a fresh session and a plan-mode checkpoint instead:

> Docs are in `docs/`. Next steps:
> 
> 1. If you haven't already, `cd` into the project folder and `git init` — first commit should be the scaffold + these design docs, so Phase 1 starts from a real repo. Create the GitHub remote now too if you want one (`gh repo create`), so history is backed up from the first build step.
> 2. Open a **fresh Claude Code session** in this project (or `/clear` if you're already in one) — this brainstorm conversation is done its job; building should start from a clean read of the docs, not the discussion that produced them.
> 3. In that fresh session, enter **plan mode** and ask Claude to read `docs/` and propose a concrete plan for Phase 1 of the roadmap — `<the concrete first build step>`. Plan mode reads the actual repo state and proposes the specific files/diff before anything is written, which is a different (and needed) step from this conceptual brainstorm.
> 4. Approve the plan, then build. One small piece at a time, commit as you go.

---

## Rules

- **Produce a blueprint he understands** — teaching is part of the job; he refuses to use what he doesn't understand.
- Adaptive doc set — never generate a doc the project doesn't need just to fill the folder.
- Fight scope creep: MVP first, always. Reference the H72 plan's MVP scopes for the two LLC products.
- `(C)` prefix on all generated docs. Docs are living — expect revision during the build.
- Recommend Claude Code as the venue for both brainstorm and build.
- **Brainstorm and build are separate contexts.** Never hand off straight from the brainstorm conversation into coding — always route through a fresh/cleared Claude Code session and a plan-mode pass over the docs first. This is also the natural point for `git init` (and a GitHub remote, if wanted) so plan mode and the first real commit both land on a real repo, not an empty skeleton.