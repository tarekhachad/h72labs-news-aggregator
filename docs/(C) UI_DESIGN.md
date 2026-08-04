# (C) UI Design — Personalized News Aggregator

Visual identity and interaction model for v1, from Phase 4.1 brainstorm (2026-08-04). This is a design brief, not a build plan — file-level implementation details get worked out in Phase 4.3. See `(C) ARCHITECTURE.md` for the pipeline this UI sits on top of, and `(C) ROADMAP.md` for where Phase 4 fits.

---

## The core metaphor

The app reads as a **digital newspaper in landscape format**, not a social feed or chat UI. Masthead title: "Your Daily Brief." Every screen is a landscape "page"; moving between topics feels like turning pages in a physical newspaper, not switching app tabs.

---

## Front page

- Shows the day's **top 6 stories across all topics** (capped — not guaranteed one per topic).
- Newspaper-style grid: box size encodes importance (bigger story → bigger box), mixing vertical and horizontal box shapes the way a real front page does.
- Below the masthead: a horizontal band listing the user's topics as selectable buttons — the primary way to navigate to a topic page from here.

## Topic pages

- One page per topic, showing all of that topic's stories for the day.
- Same newspaper grid treatment, but box size encodes importance **within that topic only** (not compared across topics).

## Importance/severity signal (pipeline implication)

Box sizing needs a real importance signal, which the pipeline doesn't currently produce — today's triage (`triage.ts`) is a binary `notable: boolean`, deliberately judged independently per cluster against that topic's own "typical day" baseline (not against other clusters). Decided approach:

- **Topic pages:** grade triage (e.g. 1–5) instead of boolean, keeping the same per-cluster/independent/topic-relative philosophy — just more granular. Drives box size directly within a topic page.
- **Front page:** a topic-relative 1–5 score isn't comparable across topics (a "5" in Sports and a "5" in Politics aren't the same magnitude). Add a separate, cheap cross-topic ranking pass after triage that looks at the day's notable clusters across topics and picks/sizes the front-page 6.

This is a real pipeline change (schema + `triage.ts` + a new ranking step), not just a UI layer — needs to be scoped into `(C) ROADMAP.md` alongside the Phase 4 UI build, not treated as pure frontend work.

---

## Focus mode (reading a story)

Clicking anywhere in a card's box (except the Sources button — see below) expands it into **focus mode**: the card scales up to ~75% of the screen, the surrounding page blurs, and the card's full report (a lazy-generated Sonnet call, same as today's expand behavior) loads with a loading state. Exiting focus mode reverses the animation back to the page grid.

## Sources (card flip)

The "Sources" button on a card flips the box in place to reveal its source list on the "back" — no focus mode, no zoom, same viewport/scale as the page grid. This is a distinct interaction from clicking the card body.

---

## Navigating between pages

Switching topics (front page ↔ topic page, or topic ↔ topic) uses a **full 3D page-flip transition**: zoom out to a whole-paper view, page-flip animation, zoom back into the destination page. Jumping multiple pages (e.g. page 2 → page 4) flips through the intervening pages rather than cutting directly.

Two ways to get back to the front page from any topic page: clicking the masthead title, or selecting "Front Page" from the topic dropdown (below) — both trigger the same page-flip transition.

**Topic navigation controls:**
- **On the front page:** the horizontal topic band under the masthead (see above).
- **On a topic page:** a square box in the top-right corner opens a dropdown listing all topics plus "Front Page." Selecting one triggers the page-flip to that destination.

---

## Sidebar

- Trigger: hamburger icon, top-left, present on every page.
- Behavior: **overlay** — slides in on top of the current page with a dimmed backdrop (like focus mode); the page underneath doesn't resize, so grid box-sizing logic never has to account for a variable content width.
- Contents: bookmarks, history, settings, preferences, log out.

---

## Visual identity

- **Typography:** serif throughout — headlines and body — for the strongest "this is a newspaper" signal.
- **Theme:** light only for v1 (cream/off-white background, black text) — closest to real newsprint and simplest to build well. Dark mode is deferred (see below).
- **Reference point:** actual print newspapers (NYT/WSJ print edition) — minimal color, rule lines between sections, ink-on-paper feel over a "modern news app" look.

## Platform scope

Desktop/tablet landscape only for v1. No designed mobile/portrait experience — phone users get a basic fallback (exact behavior TBD), not a first-class layout. Revisit after the desktop experience is built.

---

## Explicitly deferred

- **Dark mode** — light-only for v1; add once the light design system is proven.
- **Mobile/portrait layout** — no real design work until after v1 ships on desktop/tablet.
- **Ad-hoc request chat box placement** — where the "give me news about X" chat input lives in this newspaper UI is undecided; deferred until that feature itself is scoped (see `(C) ROADMAP.md`'s "Explicitly deferred" section on ad-hoc requests).
- **Box-size tier mapping** — how a 1–5 importance score maps to concrete grid box sizes (discrete tiers like hero/large/medium/small vs. something more continuous) is an open technical question for Phase 4.3, not decided here.
- **Front page/topic-page grid mechanics** — the actual layout algorithm (CSS grid template, masonry-style packing, etc.) that produces "boxes of varying size that all fit the page" is a Phase 4.3 build question.

Living document — expect revisions once Phase 4.2 (tooling/tech-stack) and 4.3 (build plan) surface real constraints.
