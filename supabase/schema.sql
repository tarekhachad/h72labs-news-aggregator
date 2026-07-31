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
  created_at timestamptz not null default now()
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

-- Persists a generation run's cards and advances the digest's since-cursor
-- as one atomic transaction (a Postgres function body is one transaction).
-- Doing this as two separate supabase-js calls (insert, then update) would
-- leave a real gap: if the process died between them, the digest would
-- have new cards but a stale cursor, and the next run would re-ingest the
-- same window and insert a near-duplicate batch. security invoker (the
-- default, stated explicitly) keeps this scoped by the caller's own RLS —
-- this app has no service-role usage anywhere, and this function doesn't
-- introduce one.
create or replace function public.persist_generated_cards(
  p_digest_id uuid,
  p_cards jsonb,
  p_generated_at timestamptz
) returns void
language plpgsql
security invoker
as $$
begin
  insert into public.cards (id, digest_id, topic, short_summary, sources, published_at)
  select
    (c->>'id')::uuid,
    p_digest_id,
    c->>'topic',
    c->>'shortSummary',
    c->'sources',
    (c->>'publishedAt')::timestamptz
  from jsonb_array_elements(p_cards) as c;

  update public.digests
  set last_generated_at = p_generated_at
  where id = p_digest_id;
end;
$$;
