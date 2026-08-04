-- Phase 2 schema: user_topics + user_preferred_sources.
-- Phase 3 schema (below): digests + cards + bookmarks.
-- Run this by hand in the Supabase SQL editor.
--
-- Design notes:
-- - No shadow `public.users` table — `auth.users` (managed by Supabase Auth)
--   already has everything this phase needs (id, created_at).
-- - Composite primary key (user_id, topic/source), not a surrogate id —
--   naturally prevents duplicate rows for the same user/topic pair.
-- - No DB-level enum/CHECK restricting which topic/source values are
--   allowed — the curated list (src/types.ts TOPICS/SOURCES) will keep
--   growing, and app-layer zod validation avoids a migration every time
--   it does. Nothing lets a user submit arbitrary free text anyway.
-- - SELECT/INSERT/DELETE policies only, no UPDATE — saving preferences is
--   delete-then-insert (replace the whole set), not in-place edits.
-- - on delete cascade — a deleted auth user's preference rows clean up
--   automatically.

create table public.user_topics (
  user_id uuid not null references auth.users(id) on delete cascade,
  topic text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, topic)
);

alter table public.user_topics enable row level security;

create policy "select own topics"
  on public.user_topics for select
  using (auth.uid() = user_id);

create policy "insert own topics"
  on public.user_topics for insert
  with check (auth.uid() = user_id);

create policy "delete own topics"
  on public.user_topics for delete
  using (auth.uid() = user_id);

create table public.user_preferred_sources (
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, source)
);

alter table public.user_preferred_sources enable row level security;

create policy "select own sources"
  on public.user_preferred_sources for select
  using (auth.uid() = user_id);

create policy "insert own sources"
  on public.user_preferred_sources for insert
  with check (auth.uid() = user_id);

create policy "delete own sources"
  on public.user_preferred_sources for delete
  using (auth.uid() = user_id);

-- Phase 3 schema: digests + cards + bookmarks.
--
-- Design notes:
-- - digests.id/cards.id are client-generated UUIDs (crypto.randomUUID()),
--   not `default gen_random_uuid()` — the pipeline builds the whole cards
--   array in memory before any DB write, and assigning ids up front makes
--   the in-memory Card -> persisted row -> NDJSON-response mapping
--   trivially certain, with no reliance on insert/RETURNING order.
-- - digests has a unique (user_id, date) constraint: one digest per user
--   per calendar day, appended to across multiple generation runs that
--   day rather than duplicated. last_generated_at is the server-owned
--   "since" cursor for the next run's ingest filter (replaces the old
--   client-localStorage cursor).
-- - cards has no direct user_id column — ownership is via digest_id ->
--   digests.user_id, so its RLS policies check ownership indirectly.
-- - cards is the one table with an UPDATE policy (scoped to the owning
--   user, same as select) because expanded_report is written lazily,
--   after the row already exists — not a stylistic inconsistency with
--   the insert/delete-only pattern above, just a different write shape.
-- - bookmarks has no update policy (add/remove only, same as
--   user_topics/user_preferred_sources) and no direct content — a card
--   already persists permanently via cards, so bookmarking just links a
--   user to a card id.

create table public.digests (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  requested_topic text,
  -- Null until the first generation run for this digest actually finishes
  -- and persists cards (set explicitly then, not via a column default) —
  -- a fresh row must still look like "no prior run today" to the pipeline,
  -- so its since-cursor falls back to the normal first-run lookback window
  -- instead of filtering against its own creation timestamp.
  last_generated_at timestamptz,
  -- Mutual exclusion for concurrent generation requests (double-click, two
  -- open tabs) — claimed via an atomic compare-and-swap UPDATE (see
  -- claimDigestForGeneration in src/lib/digests.ts) before the pipeline
  -- runs, so two concurrent requests can't both ingest/write/persist the
  -- same window and double Claude spend + duplicate cards. generation_started_at
  -- lets a claim be reclaimed if it's gone stale (the process died before
  -- clearing the flag, e.g. a hard function-timeout kill) rather than
  -- wedging a digest permanently — see the staleness window in the same
  -- claim function.
  generating boolean not null default false,
  generation_started_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, date)
);

alter table public.digests enable row level security;

create policy "select own digests"
  on public.digests for select
  using (auth.uid() = user_id);

create policy "insert own digests"
  on public.digests for insert
  with check (auth.uid() = user_id);

create policy "update own digests"
  on public.digests for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table public.cards (
  id uuid primary key,
  digest_id uuid not null references public.digests(id) on delete cascade,
  topic text not null,
  short_summary text not null,
  expanded_report text,
  sources jsonb not null,
  -- Freshest coverage across the cluster's source articles at generation
  -- time (Card.publishedAt) — persisted separately from created_at (when
  -- the row was written) because the app displays "2h ago" relative to the
  -- underlying news, not to when this card happened to be saved to the DB.
  published_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- 1-5, graded by triage relative to this card's own topic's typical-day
  -- baseline. Nullable, no CHECK constraint — the DB layer stays
  -- permissive (same pattern as user_topics/user_preferred_sources
  -- above), the real guarantee lives in the write path (writeCard always
  -- receives a severity from triage), not a migration-triggering
  -- constraint here.
  severity smallint,
  -- 1-6 if this card is one of today's front-page picks, null otherwise.
  -- Reassigned across a day's generation runs by rank.ts, applied via
  -- persist_generated_cards() below (not just set once) — a card's rank
  -- can be cleared back to null if a later run's bigger stories bump it.
  front_page_rank smallint
);

-- Postgres doesn't auto-index FK columns — this is the hottest new read
-- path in the app (every home-page/history-day load filters cards by
-- digest_id), so a full-table scan here would get worse as cards grows
-- across all users.
create index cards_digest_id_idx on public.cards (digest_id);

alter table public.cards enable row level security;

create policy "select own cards"
  on public.cards for select
  using (digest_id in (select id from public.digests where user_id = auth.uid()));

create policy "insert own cards"
  on public.cards for insert
  with check (digest_id in (select id from public.digests where user_id = auth.uid()));

create policy "update own cards"
  on public.cards for update
  using (digest_id in (select id from public.digests where user_id = auth.uid()))
  with check (digest_id in (select id from public.digests where user_id = auth.uid()));

create table public.bookmarks (
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id uuid not null references public.cards(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, card_id)
);

alter table public.bookmarks enable row level security;

create policy "select own bookmarks"
  on public.bookmarks for select
  using (auth.uid() = user_id);

create policy "insert own bookmarks"
  on public.bookmarks for insert
  with check (auth.uid() = user_id);

create policy "delete own bookmarks"
  on public.bookmarks for delete
  using (auth.uid() = user_id);

-- Persists a generation run's cards, applies this same run's front-page
-- re-ranking to already-existing cards, and advances the digest's
-- since-cursor — all as one atomic transaction (a Postgres function body is
-- one transaction). p_existing_rank_updates defaults to an empty array so
-- older call sites (and a rank.ts failure, which passes []) don't need a
-- special case. Originally the existing-card rank update was a separate,
-- best-effort RPC called after this one — code review caught a real
-- correctness gap in that split: if this insert succeeded but the second
-- call failed, a newly-inserted card and a stale existing card could
-- simultaneously claim the same front_page_rank until the next successful
-- run overwrote both. Folding both writes into one transaction closes that
-- window entirely rather than just documenting it as accepted risk.
--
-- Doing all of this as several separate supabase-js calls would leave
-- real gaps: if the process died mid-sequence, the digest could end up
-- with new cards but a stale cursor (causing the next run to re-ingest the
-- same window and insert a near-duplicate batch), or with the rank
-- inconsistency described above. security invoker (the default, stated
-- explicitly) keeps this scoped by the caller's own RLS — this app has no
-- service-role usage anywhere, and this function doesn't introduce one.
--
-- The drop below is required, not defensive boilerplate: Postgres
-- identifies a function by its parameter type signature, so `create or
-- replace` on a signature that GAINED a parameter (the 3-arg version below
-- becoming 4-arg) defines a second overload instead of replacing the first
-- — it does NOT drop the old one. Since this file is applied by hand in
-- the Supabase SQL editor (not a real migration tool), re-running it after
-- this signature change would otherwise leave both overloads live
-- simultaneously. Safe to leave in permanently: a no-op once only the
-- 4-arg version exists.
drop function if exists public.persist_generated_cards(uuid, jsonb, timestamptz);

create or replace function public.persist_generated_cards(
  p_digest_id uuid,
  p_cards jsonb,
  p_generated_at timestamptz,
  p_existing_rank_updates jsonb default '[]'::jsonb
) returns void
language plpgsql
security invoker
as $$
begin
  -- created_at is set explicitly to p_generated_at (not left to its own
  -- `default now()`) so every card in this run shares the exact same value
  -- as digests.last_generated_at below, byte-for-byte — that's what the
  -- feed's run-divider relies on to group a run's cards, rather than
  -- trusting two separate now() calls to agree.
  insert into public.cards (id, digest_id, topic, short_summary, sources, published_at, created_at, severity, front_page_rank)
  select
    (c->>'id')::uuid,
    p_digest_id,
    c->>'topic',
    c->>'shortSummary',
    c->'sources',
    (c->>'publishedAt')::timestamptz,
    p_generated_at,
    (c->>'severity')::smallint,
    (c->>'frontPageRank')::smallint
  from jsonb_array_elements(p_cards) as c;

  -- rank.ts's cross-topic front-page ranking pass, applied to cards already
  -- persisted in an earlier run today (this run's own new cards get their
  -- rank set directly in the insert above instead). An empty array here
  -- (ranking failed, or there was nothing new to rank this run) makes this
  -- a correct no-op — no rows match jsonb_array_elements('[]'). The
  -- digest_id guard isn't load-bearing today (the caller only ever builds
  -- p_existing_rank_updates from this same digest's own cards), but this
  -- function exists specifically to close correctness windows rather than
  -- rely on caller discipline — without it, a future bug upstream that fed
  -- in a stale/wrong id list would silently update a *different* digest's
  -- card with no error, since RLS only checks card ownership, not which
  -- digest it belongs to.
  update public.cards as c
  set front_page_rank = (u->>'frontPageRank')::smallint
  from jsonb_array_elements(p_existing_rank_updates) as u
  where c.id = (u->>'id')::uuid
    and c.digest_id = p_digest_id;

  update public.digests
  set last_generated_at = p_generated_at
  where id = p_digest_id;
end;
$$;
