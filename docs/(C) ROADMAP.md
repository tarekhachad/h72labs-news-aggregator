# (C) Roadmap — Personalized News Aggregator

Phased build plan. **MVP end-to-end before polish** — each phase should leave you with something real and runnable, not a half-finished piece. Living document — expect revisions as building reveals reality.

---

## Phase 0 — Scaffold the real thing

- `git init`, GitHub repo, first commit (scaffold + these design docs).
- Next.js app created, deployed to Vercel — even an empty "hello world" page, live on a real URL.
- Supabase project created and connected.
- **Done when:** you can visit a real deployed URL and see something, however trivial.

## Phase 1 — Prove the core pipeline (hardest part first, no auth yet)

- Hardcode one dev profile (your own topics + preferred sources) — no login screen yet.
- Build the full pipeline: RSS ingestion → embedding-based clustering → Haiku triage → Sonnet card writing → render as a scrollable feed.
- No calendar history, no bookmarking, no ad-hoc chat requests yet — just: request a digest, get real cards back, for one hardcoded set of topics.
- **Why this before auth:** this is the actual novel/risky part of the product — whether the synthesis pipeline produces genuinely good, notable, well-written cards. Proving that cheaply (without spending time on login screens) tells you fast whether the core idea works before investing in anything else.
- **Done when:** you personally get a real "give me today's news" digest, end to end, with real cards from real sources.

## Phase 2 — Real accounts

- Wire in Supabase Auth: real signup/login screen.
- Profile setup flow: curated multi-select for topics (up to 5), curated multi-select for preferred sources.
- Replace the hardcoded dev profile from Phase 1 with real per-user preferences driving the same pipeline.
- **Done when:** you can sign up, pick your topics/sources, and get a digest driven by your actual profile — not a hardcoded one.

## Phase 3 — History and bookmarking

- Persist each day's digest so past days are retrievable; add the calendar view to browse them.
- Add bookmarking: a join table linking a user to a card ID, plus a "Saved" view.
- **Done when:** you can revisit yesterday's digest via the calendar, and bookmark a card and find it again later in Saved.

## Phase 4 — Ad-hoc requests

- Chat-style input for requests outside default topics ("what's happening with the Fed today") — runs the same pipeline for that one topic and appends the resulting card(s) to the current feed.
- **Done when:** an off-topic ask produces new cards appended to the feed, without disturbing the existing default-topic cards.

## Phase 5 — Cost/quality pass + friends testing

- Confirm the lazy expanded-report generation is actually lazy (not accidentally pre-generating for every card).
- Instrument real Claude API usage/cost against the estimate in `(C) TECH_STACK.md` — correct the estimate with real numbers.
- Invite a small group of friends to test; watch for actual return usage as the signal, not just verbal feedback (per the H72 go-to-market approach).
- **Done when:** a handful of real people outside you have used it more than once.

---

## Explicitly deferred (not v1)

- Free-text topic/source entry (v2).
- Social media sources, e.g. X (v2).
- Ads or a paid tier (post-monetization decision, once real usage data exists).
- A public/external API for third parties.
- **Dynamically-updated "hot topics" sublists** (raised during Phase 2 scoping, 2026-07-28): a regularly-refreshed list of trending sub-topics within Geopolitics/Tech-AI (e.g. "Middle East gas prices," a specific hot AI company) that users could browse and add to their preferences over time, beyond the fixed curated list. This is a discovery/recommendation feature, not a config change — it needs something to *decide* what's trending (LLM analysis of recent ingested articles, or manual curation), storage, a refresh cadence, and a UI for revisiting/updating preferences post-signup. Same category of problem as free-text entry (open-ended vs. fixed option set), so it's deferred alongside it. Worth revisiting once the core pipeline + accounts are solid — could plausibly reuse the existing clustering/triage pipeline to surface trending clusters as suggestions.
- **Hierarchical subtopics within a topic** (raised during Phase 2 scoping, 2026-07-28): e.g. Football → specific leagues/competitions (Champions League, Europa League)/favorite clubs/transfers; Tennis → specific players/tournaments (Grand Slams, Masters); Tech/AI → specific companies. A genuinely different data shape than the flat `user_topics(user_id, topic)` model (needs nested per-topic sub-preferences), a multi-step onboarding UX instead of one flat checkbox screen, and — the harder part — there's usually no RSS feed granular enough for "Champions League" as distinct from "football"; real club/player-level filtering needs either much more granular feeds (mostly don't exist for free) or a filtering/tagging step on top of general feeds. Scope this properly as its own phase when it comes up, not as an add-on to account/profile plumbing.
- **Forgot-password / email-based reset flow** (surfaced during the profile/settings page build, 2026-07-30): the new `/profile` password-change form calls Supabase's `auth.updateUser({ password })` directly, which requires an existing valid session and has no reauth challenge (not a Supabase requirement, and no reauth pattern exists anywhere else in this app — an accepted trade-off for a personal reader at this stage). Independent `qa` and `code-reviewer` subagent passes both flagged that this makes the gap bigger than it looks: since there's no self-service "forgot password" flow anywhere in the app, a hijacked/stolen session could change the password and lock the real user out **permanently**, with no recovery path short of a manual fix in the Supabase dashboard. Not built yet — needs an email-based reset flow (Supabase supports this via `auth.resetPasswordForEmail` + a callback route, similar shape to the existing `src/app/auth/callback/route.ts` email-confirmation handler). Worth doing before this goes beyond Tarek + a few trusted friends testing it.
- **Duplicate/near-duplicate story cards, if they persist after the best-match clustering fix** (surfaced during Tarek's first manual testing pass, 2026-07-30): `src/lib/cluster.ts`'s greedy clustering was changed from first-match to best-match (highest cosine similarity among all existing clusters clearing `SIMILARITY_THRESHOLD`, not just the first one found) to remove one concrete, order-dependent source of inconsistency. That fix does **not** address the deeper limitation: a single fixed similarity threshold (0.65) on embedding-only similarity can't cleanly separate "same story, worded differently across outlets" from "different but related stories" for every topic and every day's mix — same-story articles vary a lot in embedded similarity depending on wording overlap, cross-language pairs (e.g. a French-language Le360/Le Monde piece vs. an English source on the same event), snippet length, and how much of the RSS snippet is boilerplate vs. substance. Confirmed live (2026-07-30, 29-card European Football digest): the best-match fix is real but duplicates still occur — at least 3 clear same-story pairs stayed split (e.g. two separate cards both about Eddie Howe leaving Newcastle).

  Brainstormed with Tarek (2026-07-30) on next steps, ranked by confidence:
  - **Low confidence: retune `SIMILARITY_THRESHOLD` alone.** The code comment already shows real same-story pairs scoring as low as 0.70–0.777 while a known false positive scored 0.634 — a ~0.07 band where same-story and different-story genuinely overlap in embedding space. Moving the one threshold trades one failure mode for another (catch more real duplicates ↔ merge more unrelated stories); without the actual scores for the specific pairs still splitting, there's no guarantee a new threshold value would even catch them.
  - **Moderate confidence, real effort: add a secondary dedup signal** (e.g. named-entity/keyword overlap as a tiebreaker alongside embedding similarity). A legitimate, standard idea — shared specific names is a crisper same-story signal than sentence-embedding cosine similarity alone — but it's a real design change (needs its own extraction step, and a way to combine two signals sensibly; entity overlap alone isn't sufficient either, since two different transfers involving the same club would share an entity without being the same story).
  - **Recommended first thing to actually try: an LLM-based borderline check.** After embedding clustering runs, for any pair of clusters sitting near the threshold, ask Haiku directly "are these the same real-world story?" — the one mechanism that can actually *read and reason* about "same event, differently framed," rather than proxying it through embedding math or keyword counts. Reuses infrastructure already trusted elsewhere in the pipeline (tiered Claude usage, Haiku already does triage) rather than introducing a new one. Considered and ruled out: training a custom clustering/classification model — clustering algorithms like DBSCAN/agglomerative are unsupervised (no training data needed) so "train a model" isn't quite the right frame anyway, and a supervised approach would need a labeled same-story/different-story dataset that doesn't exist — disproportionate effort for this project's current stage. Swapping the greedy single-pass algorithm for a proper clustering algorithm (agglomerative/DBSCAN) is a smaller, second-order improvement worth doing too (removes remaining order-dependence), but the LLM check is expected to move the needle more.

## Guiding principle throughout

If a session starts polishing Phase 2 before Phase 1 actually works end-to-end, that's the over-planning failure mode — stop and go finish the smaller, earlier phase first.
