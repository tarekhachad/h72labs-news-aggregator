# (C) Database Schema — Personalized News Aggregator

The structured data this app needs to persist, in plain language. Storage is Postgres via Supabase (see `(C) TECH_STACK.md`). Exact column types are a build-time detail — this doc is about what data exists and how it relates, not final SQL.

---

## `users`

Managed almost entirely by Supabase Auth (handles email, password/session security). What this app adds on top:

| Field | What it holds |
|---|---|
| `id` | Unique user ID (from Supabase Auth) |
| `created_at` | When they signed up |

## `user_topics`

A user's selected topics of interest (curated multi-select, up to 5 — see Phase 2 of the roadmap).

| Field | What it holds |
|---|---|
| `user_id` | Which user |
| `topic` | One of the curated topic options (e.g. "Geopolitics," "Finance," "Tech/AI," "Morocco," "Sports") |

One row per user per topic — a user with 4 topics has 4 rows.

## `user_preferred_sources`

A user's preferred news outlets (curated multi-select — e.g. NYT, WaPo, Reuters, BBC). Used as a **weighting signal** in synthesis, not a hard filter — the pipeline still pulls broadly across sources.

| Field | What it holds |
|---|---|
| `user_id` | Which user |
| `source` | One of the curated outlet options |

## `digests`

One row per **calendar date per user** (`(user_id, date)` is unique) — not one row per generation run. The same day's digest is appended to across multiple runs (e.g. clicking "give me today's news," then clicking again later the same day for what's new since) rather than duplicated.

| Field | What it holds |
|---|---|
| `id` | Unique digest ID (client-generated UUID — see `cards.id` below for why) |
| `user_id` | Which user this digest was generated for |
| `date` | The calendar date this digest belongs to (drives the calendar-history view) |
| `requested_topic` | Null for the default daily digest; set to the topic name for an ad-hoc request (Phase 4) |
| `last_generated_at` | Null until this digest's first successful generation run finishes; from then on, the cutoff the next run's ingest step filters "since" — this is what makes repeated same-day clicks append only new stories instead of re-fetching everything |
| `generating` | Mutual-exclusion flag — atomically claimed (compare-and-swap `UPDATE`) before a generation run starts, so a double-click or two open tabs can't both run the pipeline for the same digest and double the Claude spend + duplicate cards |
| `generation_started_at` | When the current claim (if any) was made — a claim older than a couple minutes is treated as stale and reclaimable, so a run that died before clearing `generating` (e.g. a hard function-timeout kill) self-heals instead of wedging the digest permanently |

## `cards`

One row per story card — the core unit of content. A single `digest` can (and usually does) have many cards, added in batches across the digest's multiple generation runs.

| Field | What it holds |
|---|---|
| `id` | Unique card ID — client-generated (`crypto.randomUUID()`) before insert, not DB-assigned, since the pipeline needs a stable id to hand back to the client in the same request that persists the row |
| `digest_id` | Which digest this card belongs to |
| `topic` | Which topic this story falls under |
| `short_summary` | The always-visible briefing-style summary |
| `expanded_report` | The longer report — **null until the first time a user expands the card**, then generated once and cached here (see the lazy-generation note in Architecture) |
| `sources` | The source articles this card was synthesized from — `{title, url, source, snippet}[]`. `snippet` (not just title/url/source) is stored so the lazy expanded-report generation, which can run days after the original cluster is gone from memory, still has real source text to work from without re-fetching source URLs |
| `published_at` | Freshest `publishedAt` across the cluster's source articles at generation time — what the UI's "2h ago" is relative to. Kept separate from `created_at` (when the row was written), which can differ once a card is added to a digest hours after its underlying news broke |
| `created_at` | When this card was generated |
| `severity` | 1-5, graded by triage relative to this card's own topic's typical-day baseline — drives topic-page box sizing (Phase 4.4 Track A). Nullable; a pre-Track-A row has none |
| `front_page_rank` | 1-6 if this card is one of today's front-page picks, null otherwise. Reassigned across a day's generation runs by `rank.ts`'s cross-topic ranking pass, applied via `persist_generated_cards()` — can be cleared back to null if a later run's bigger stories bump it out (Phase 4.4 Track A) |
| `title` | Short headline (5-8 words), written by the same Sonnet call as `short_summary` (Phase 5.5). Nullable; a pre-5.5 row has none, and the app renders that as no title row rather than a migration backfill |
| `labels` | 1-2 free-form, LLM-generated tags for the story's specific angle — `string[]` stored as `jsonb`, matching `sources`' precedent. Color-coded client-side via a deterministic hash (`src/lib/labelColor.ts`), not a stored color (Phase 5.5). Defaults to `'[]'::jsonb`, never null |

## `bookmarks`

Links a user to a card they've saved — no content is duplicated here, since the card already persists permanently via `digests`/`cards` above.

| Field | What it holds |
|---|---|
| `user_id` | Which user |
| `card_id` | Which card they bookmarked |
| `created_at` | When they bookmarked it (used to sort the Saved view) |

---

## How the pieces connect

```
users ──< user_topics
      ──< user_preferred_sources
      ──< digests ──< cards ──< bookmarks >── users
```

- A user has many topics, many preferred sources, many digests — but only one digest per calendar date (`(user_id, date)` is unique).
- A digest has many cards, added across that date's multiple generation runs.
- A card can be bookmarked by many users (though for v1, realistically, mostly by the user it was generated for) via the `bookmarks` join table.
- `cards` has no direct `user_id` column — ownership is indirect, via `digest_id → digests.user_id`, so its RLS policies (and any app-layer ownership check, e.g. before bookmarking) check ownership through that join rather than a direct column comparison.
- A generation run persists its cards and advances `last_generated_at` via one Postgres function (`persist_generated_cards`, `security invoker`), not two separate app-side writes — so the two can't drift apart if the process dies between them (cards saved but the cursor never advances, causing the next run to re-fetch and re-insert the same window).

Resolved during Phase 3 build: `sources` stays a single `jsonb` column (now including `snippet`, not just `title`/`url`/`source`) rather than its own table — the lazy expanded-report feature needs that source text preserved per-card regardless, and nothing so far needs querying into individual source rows. Living document — will be revised again if that changes.
