# (C) Architecture — Personalized News Aggregator

How the product fits together, in plain language. See `(C) TECH_STACK.md` for the specific tools and why each was picked, `(C) DATABASE_SCHEMA.md` for the data model, and `(C) GLOSSARY.md` for any term below that isn't obvious.

---

## The core idea

You ask for news (either "give me today's news," or something ad-hoc like "what's new with the Fed"). The system doesn't hand you a chat reply — it hands you a **scrollable feed of cards**, where each card is *one specific story* ("Anthropic released a new model yesterday"), not a broad theme like "tech." A card shows a short, briefing-style summary by default; expanding it reveals a longer report plus every source it drew from. Think of it as the daily brief a head of state gets from staff, not a social feed.

---

## The pipeline, end to end

```
 1. Ingest         Pull raw articles for the user's selected topics
                    (RSS feeds, optionally GNews) — free, no AI involved.

 2. Cluster         Group articles that are about the same underlying
                    event using text embeddings (a free, local model —
                    NOT a Claude call). "5 outlets covering the Fed
                    decision" becomes one cluster, not 5 separate items.

 3. Triage          One cheap Claude Haiku call per ~20 same-topic clusters asks:
                    "is this actually a distinct, notable story?"
                    Filters out noise before the expensive step.

 4. Write           For clusters that pass triage, one Claude Sonnet
                    call writes the card's short summary in the
                    briefing tone. This is the one step that truly
                    needs a capable LLM — turning messy multi-source
                    text into clean, readable prose.

 5. Serve            Cards render in the scrollable feed, newest/most
                    notable first. No fixed card count — however many
                    clusters are actually notable that day.

 6. Expand (lazy)   The longer report + full source list is NOT
                    pre-generated for every card. It's generated once,
                    the first time a user actually expands that card,
                    then cached — most cards are never opened, so this
                    avoids paying for reports nobody reads.
```

Steps 1–3 cost nothing or close to it. Step 4 (and occasionally step 6) is the only real per-use cost — see the cost note in `(C) TECH_STACK.md`.

---

## Request flow

1. **Default daily digest** — on request ("give me today's news"), the pipeline above runs once per topic in the user's profile, using their preferred sources as a weighting signal (not a hard filter — the system still pulls broadly, but leans toward outlets the user picked, e.g. NYT/WaPo).
2. **Ad-hoc request** — a request outside the user's default topics (e.g. "what's happening with the Fed today") runs the same pipeline for that one topic and **appends** the resulting card(s) to the existing feed, rather than replacing it.
3. **Calendar history** — each day's digest is persisted, so past days are browsable via a calendar view. This is also what makes bookmarking cheap to build (see below).
4. **Bookmarking** — a card already exists permanently in storage the moment it's generated (because of the calendar history above). Bookmarking a card doesn't copy or re-store its content — it just adds a record linking the user to that card's ID. A dedicated "Saved" view pulls all of a user's bookmarked cards regardless of which day they came from.

---

## Accounts & auth

Real signup/login from v1 (not a hardcoded single user) — handled by a managed auth provider (see Tech Stack) rather than hand-built, so password/session security isn't something built from scratch. On signup, a user picks:
- **Topics of interest** — curated multi-select, up to 5, from a fixed list (free-text topic entry is a v2 idea, deferred — it would need its own step to interpret arbitrary text into a source query, which is real added complexity for not much MVP value).
- **Preferred sources** — same pattern, curated multi-select (NYT, WaPo, Reuters, BBC, etc.), used as the weighting signal described above.

---

## System diagram

```
                        ┌──────────────────────────┐
                        │        Frontend          │
                        │  (feed of cards, chat     │
                        │   input, calendar,        │
                        │   saved view, login)      │
                        └────────────┬─────────────┘
                                     │
                        ┌────────────▼─────────────┐
                        │   Backend (serverless)    │
                        │  - handles requests        │
                        │  - runs the pipeline        │
                        │  - talks to Supabase        │
                        └──┬───────┬───────┬────────┘
                           │       │       │
              ┌────────────▼─┐ ┌───▼────┐ ┌▼─────────────┐
              │ RSS / GNews  │ │ Claude  │ │  Supabase     │
              │ (ingestion)  │ │ API     │ │ (Postgres DB  │
              │              │ │ (Haiku  │ │  + Auth)      │
              │              │ │ +Sonnet)│ │               │
              └──────────────┘ └─────────┘ └───────────────┘
```

---

## What's explicitly out of scope for v1

- Free-text topic/source entry (curated multi-select only).
- Social media sources like X (news sources only — RSS/GNews).
- A public/external API for third parties to consume (this app is a single coupled frontend+backend for its own use; no separate `API_SPEC.md` needed yet).
- Ads or a paid tier (freemium plan is real, but not until real usage data exists).

Living document — expect this to be revised once building reveals reality.
