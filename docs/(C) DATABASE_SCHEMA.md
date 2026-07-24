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

One row per generated digest — either a full default daily digest, or the result of an ad-hoc request.

| Field | What it holds |
|---|---|
| `id` | Unique digest ID |
| `user_id` | Which user this digest was generated for |
| `date` | The calendar date this digest belongs to (drives the calendar-history view) |
| `requested_topic` | Null for the default daily digest; set to the topic name for an ad-hoc request |

## `cards`

One row per story card — the core unit of content. A single `digest` can (and usually does) have many cards.

| Field | What it holds |
|---|---|
| `id` | Unique card ID |
| `digest_id` | Which digest this card belongs to |
| `topic` | Which topic this story falls under |
| `short_summary` | The always-visible briefing-style summary |
| `expanded_report` | The longer report — **null until the first time a user expands the card**, then generated once and cached here (see the lazy-generation note in Architecture) |
| `sources` | The list of source articles/URLs this card was synthesized from |
| `created_at` | When this card was generated |

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

- A user has many topics, many preferred sources, many digests.
- A digest has many cards.
- A card can be bookmarked by many users (though for v1, realistically, mostly by the user it was generated for) via the `bookmarks` join table.

Living document — will be revised once building surfaces real constraints (e.g. exact source-list format, whether `sources` needs its own table if it grows more structured).
