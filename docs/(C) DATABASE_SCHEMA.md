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

A user's selected topics of interest (curated multi-select, at least 1 and no upper bound — the per-topic card cap is what bounds a digest, not the topic count — 8 per topic on the day's first run, 2 on each later same-day run, capped at 14 per topic per digest. See Phase 2 of the roadmap).

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

## `user_settings`

One row per user, holding the timezone their "today" is computed in. A user with no row is treated as UTC until their first page load writes one.

| Field | What it holds |
|---|---|
| `user_id` | Which user (primary key) |
| `time_zone` | An IANA name such as `America/New_York`, taken from the reader's browser and rewritten whenever the device reports a different zone |
| `updated_at` | When it was last written |

Sessions can only read their own row. The one write path is `set_time_zone(text)`, a security-definer function that uses the caller's own id and refuses any name missing from Postgres's `pg_timezone_names`.

## `digests`

One row per **calendar date per user** (`(user_id, date)` is unique) — not one row per generation run. The same day's digest is appended to across multiple runs (e.g. clicking "give me today's news," then clicking again later the same day for what's new since) rather than duplicated.

| Field | What it holds |
|---|---|
| `id` | Unique digest ID (client-generated UUID — see `cards.id` below for why) |
| `user_id` | Which user this digest was generated for |
| `date` | The calendar date this digest belongs to **in the reader's own timezone** (`user_settings.time_zone`), which is what drives "today" and the calendar-history view |
| `requested_topic` | Null for the default daily digest; set to the topic name for an ad-hoc request (Phase 4) |
| `last_generated_at` | Null until this digest's first successful generation run finishes; from then on, the cutoff the next run's ingest step filters "since" — this is what makes repeated same-day clicks append only new stories instead of re-fetching everything |
| `generating` | **Dead.** Was the mutual-exclusion flag; the mutex is now `generation_claims` (below), keyed on the user rather than on one day's row. Read and written by nothing — kept only because dropping a column cannot be undone |
| `generation_started_at` | **Dead**, alongside `generating`. Any value still in this column is a leftover timestamp from the last run that claimed the row before the mutex moved |

## `generation_claims`

At most one digest generation per **user** at a time. One row per user while a generation is in flight, and no row at all otherwise.

Keyed on `user_id` because that is the thing that has to be exclusive. The previous design put the flag on `digests`, which is keyed `(user_id, date)` — so when UTC midnight passed mid-run, a second request computed a new day, got a brand-new row, claimed it, and one user ended up with two pipelines running: duplicate cards, overlapping ingest windows, and two worst-case spend reservations.

Unreachable from any session: RLS is on with **no policies** and every grant revoked. The only way in is `claim_generation` and `release_generation`, which run as their owner. That matters rather than being mere convention — the staleness window is what protects a run that is still going, so the party it binds must not be able to choose it.

| Field | What it holds |
|---|---|
| `user_id` | Primary key, and the whole point: one claim per user. Cascades on account deletion |
| `claim_id` | The ownership token, minted by `claim_generation` and required by `release_generation`. A run whose claim was reclaimed as stale holds a token that is no longer here, so its late release deletes nothing instead of freeing the claim that replaced it |
| `claimed_at` | When the claim was taken. Set by the function, never by a column default, so the staleness comparison cannot read a timestamp a caller supplied |

`claim_generation(p_stale_ms)` returns a new token, or null when a live claim is already held. It takes the whole mutex in one statement — `insert ... on conflict (user_id) do update ... where <stale> returning claim_id` — so under genuine overlap the loser re-evaluates against the winner's committed row, updates nothing, and gets no row back. `p_stale_ms` is clamped between 180000 and 3600000: below the floor a caller could steal a claim from a run still in flight, above the ceiling a caller could wedge their own account until it expired. The floor must stay longer than the digest route's `maxDuration`, and a test reads it out of `schema.sql` to make sure it does.

`release_generation(p_claim_id)` deletes the row only if the token still matches, returning whether it did. It is anon-callable on purpose, for the same reason `settle_spend` is: release runs in the same `finally` that settles the spend reservation, so a session that expired during a long run must still be able to let the claim go.

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
