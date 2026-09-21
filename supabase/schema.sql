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
  -- Null until this row's first generation run actually finishes (set
  -- explicitly then, not via a column default, so a row that exists but has
  -- never generated is distinguishable from one that has).
  --
  -- The pipeline's since-cursor is the newest non-null value across ALL of
  -- the user's rows, not this row's own (see getLatestGeneratedAtForUser in
  -- src/lib/digests.ts). Reading it per-row is what this comment used to
  -- describe, and it meant every new day started null and re-ingested the
  -- full lookback window, re-covering stories the previous day already had.
  -- The null-vs-set distinction still matters: that query filters nulls out
  -- in SQL precisely because Postgres sorts them first under DESC, so a
  -- freshly created row would otherwise win the ordering.
  last_generated_at timestamptz,
  -- Dead columns. The generation mutex is public.generation_claims, keyed on
  -- the user rather than on one day's digest row — see that table at the end
  -- of this file for why per-row claiming was wrong. These two are retained
  -- only because dropping a column cannot be undone; nothing reads or writes
  -- them, which `grep -rn generating src/` confirms in one command.
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
  front_page_rank smallint,
  -- Phase 5.5: a short headline (writeCard.ts's LLM call, same Sonnet
  -- request as short_summary — no new API call). Nullable, no CHECK
  -- constraint, same permissive-DB-layer pattern as severity above — a
  -- pre-5.5 row simply predates this column existing.
  title text,
  -- Free-form LLM-generated tags (1-2 per card), jsonb rather than a
  -- native text[] or a separate table — matches the existing `sources`
  -- column's precedent and this project's stated preference for
  -- app-layer flexibility over DB constraints. Defaults to an empty
  -- jsonb array (not null) so a pre-5.5 row and a post-5.5 row both
  -- satisfy `labels: string[]` at the app layer without a separate
  -- null-vs-empty-array branch — rowToCard's `row.labels ?? []` fallback
  -- is defensive only, for rows written before this default existed.
  labels jsonb not null default '[]'::jsonb
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

-- Phase 5.5 migration — MUST be run by hand as its own statement.
-- Editing the `create table public.cards (...)` block above to add these
-- columns is documentation only and has NO effect on an already-existing
-- live table (learned the hard way during Phase 3 — see the project's
-- own memory notes on this). `create table` never re-runs against a table
-- that already exists, so only this explicit `alter table` actually
-- changes anything in Supabase. Safe to run more than once thanks to
-- `if not exists`.
alter table public.cards add column if not exists title text;
alter table public.cards add column if not exists labels jsonb not null default '[]'::jsonb;

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
--
-- Phase 5.5 note: the function's own parameter signature is unchanged
-- here (still 4 args) — only what's extracted from each p_cards element
-- changed (title/labels added below), so `create or replace` genuinely
-- replaces the existing function body in place this time. The overload
-- gotcha above only bites on a signature change; double-checked this
-- isn't one before assuming the earlier drop-and-recreate isn't needed
-- again.
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
  insert into public.cards (id, digest_id, topic, short_summary, sources, published_at, created_at, severity, front_page_rank, title, labels)
  select
    (c->>'id')::uuid,
    p_digest_id,
    c->>'topic',
    c->>'shortSummary',
    c->'sources',
    (c->>'publishedAt')::timestamptz,
    p_generated_at,
    (c->>'severity')::smallint,
    (c->>'frontPageRank')::smallint,
    c->>'title',
    -- coalesce against the column's own default: p_cards is built from
    -- src/lib/digests.ts's saveGeneratedCards, which always sends a real
    -- (possibly empty) labels array today — this guards only against a
    -- future caller that omits the key entirely, so a missing `labels`
    -- key can't insert a literal JSON null into a `not null` column.
    coalesce(c->'labels', '[]'::jsonb)
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

-- usage_runs — one row per Claude-spending run (a digest generation or a
-- card expand), written from the route's own finally block.
--
-- THIS IS A MEASUREMENT TABLE, NOT A LEDGER, AND NOT AN ENFORCEMENT SOURCE.
-- Every row is written through the user's own cookie session (this app has
-- no service-role client anywhere), so RLS can guarantee only that a row's
-- user_id matches its author — it cannot validate the dollar figures. A user
-- holding their own JWT can POST a row claiming total_billed_usd = 0 and
-- every policy below passes. Spend caps therefore SIZE themselves from this
-- table and ENFORCE against `spend_ledger` (bottom of this file), which no
-- session can read or write. `digests` is not a safe count either: its UPDATE
-- policy lets a user rewrite `date` and `last_generated_at`.
--
-- Append-only by construction: SELECT and INSERT policies only. With RLS
-- enabled, policies are deny-by-default, so UPDATE and DELETE affect zero
-- rows for the authenticated role — the subject of a row-counting cap cannot
-- reset it.
--
-- This is the STRICTEST table in the file, and no other one shares its shape.
-- `digests` and `cards` both carry UPDATE policies, and need them (the
-- generation mutex, the lazily-written expanded_report, front_page_rank
-- reassignment). `bookmarks`, `user_topics` and `user_preferred_sources` are
-- select+insert+DELETE, since preferences are saved by replacing the whole
-- set. Only this table forbids both, because it is the only one whose rows
-- are evidence about the person who writes them.
--
-- Two holes this does NOT close: deleting the auth user cascades these rows
-- away, and creating a second account resets any per-user count. Invite-only
-- signup (V2.0) closes the second; nothing in SQL closes it.
--
-- No FK on digest_id/card_id, deliberately — written from a `finally` whose
-- one job is to never complicate the pipeline, and the sink swallows its own
-- errors, so a referential failure would silently drop the measurement.
-- numeric(12,6), not float: formatUsd renders six decimals and one triage
-- call costs ~$0.0015. is_floor is the machine-readable FLOOR warning;
-- anything averaging these rows MUST exclude is_floor rows.

create table public.usage_runs (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  schema_version smallint not null default 1,

  route text not null,                 -- 'digest' | 'expand'
  digest_id uuid,
  card_id uuid,

  -- The collector's fixed `at` — the instant the run was PRICED, not when
  -- the row was written (created_at below is that). Nullable for exactly one
  -- reason, and it is not laxness: when the clock was unusable there is no
  -- ISO instant to record, and writing the write-time or the epoch instead
  -- would put a fabricated timestamp on a money row. The check constraint
  -- below ties the null to its only legitimate cause, so a null here can
  -- never mean "the writer forgot".
  priced_at timestamptz,
  -- False when the run's `at` was an Invalid Date, so no promotional window
  -- could be confirmed for any model and everything fell back to list.
  clock_usable boolean not null,

  outcome text not null,               -- 'complete' | 'endedEarly'
  label text not null,
  run_shape text not null,             -- 'firstEver'|'firstOfDay'|'sameDayTopUp'|'unknown'
                                       -- Rows written before 2026-09-14 carry the previous
                                       -- names ('cold'|'warmNewDay'|'warmSameDay') and are NOT
                                       -- migrated: this table has no update policy by design.
                                       -- normalizeRunShape() in usageRecord.ts maps them on read.

  -- All nullable ON PURPOSE. A run that exits early never learns these, and
  -- null means "unmeasured", a different fact from 0. Never default to zero.
  topic_count smallint,
  source_count smallint,
  article_count integer,
  cluster_count integer,
  clusters_after_dedup integer,
  notable_count integer,               -- AFTER applyCardCap
  cards_dropped_by_cap integer,
  cards_written integer,
  cards_failed integer,
  rank_applied boolean,                -- null = ranking never attempted

  total_calls integer not null,
  total_calls_without_usage integer not null,
  total_tokens jsonb not null,
  total_billed_usd numeric(12,6) not null,
  total_list_usd numeric(12,6) not null,
  is_floor boolean not null,
  -- Models in this run that had no usable pricing entry. Non-empty means the
  -- dollar totals above are a floor — those rows contributed real tokens and
  -- $0.000000, because there was no honest figure to substitute.
  unpriced_models jsonb not null default '[]'::jsonb,
  pricing_verified_on date not null,
  stages jsonb not null default '[]'::jsonb,

  created_at timestamptz not null default now(),

  constraint usage_runs_nonnegative_usd
    check (total_billed_usd >= 0 and total_list_usd >= 0),
  -- A missing priced_at is only ever explained by an unusable clock.
  constraint usage_runs_priced_at_present
    check (priced_at is not null or clock_usable = false)
);

-- Exactly the query a V2.0 per-user cap will run. Built now because adding it
-- later means an index build on a live table.
--
-- PARTIAL, and the predicate is the point. priced_at is nullable (see the
-- column), and Postgres orders DESC as NULLS FIRST by default — so a plain
-- `order by priced_at desc` would surface a clock-unusable row AHEAD of a
-- user's genuinely most recent runs. Excluding nulls from the index makes the
-- degenerate rows unreachable through it rather than leaving every future
-- caller to remember a filter. Any window query (`priced_at >= now() -
-- interval '1 day'`) implies the predicate, so it still uses this index; a
-- query that genuinely wants the null rows is not a cap query and should say
-- so explicitly.
create index usage_runs_user_priced_at_idx
  on public.usage_runs (user_id, priced_at desc)
  where priced_at is not null;

alter table public.usage_runs enable row level security;

create policy "select own usage runs"
  on public.usage_runs for select
  using (auth.uid() = user_id);

create policy "insert own usage runs"
  on public.usage_runs for insert
  with check (auth.uid() = user_id);

-- Deliberately no update and no delete policy. Their absence is the design.

-- invites + hook_require_invite — invite-only signup.
--
-- THE HOOK IS THE GATE, NOT THE APP. Supabase's /auth/v1/signup endpoint is
-- callable directly with the publishable key, so a check in the signup server
-- action can be skipped entirely. The before-user-created hook below runs
-- inside Supabase Auth for every signup path (email/password, OAuth, magic
-- link, anonymous, the dashboard's "Invite user"). Admin user creation (the
-- dashboard's "Add user", or the secret key) does not trigger it, and that is
-- the manual override.
--
-- Enabling it is a dashboard step, not SQL: Authentication -> Hooks -> Before
-- User Created -> Postgres -> public.hook_require_invite. Enable the hook
-- BEFORE turning "Allow new users to sign up" on — from that moment the hook
-- is the only thing standing between the internet and account creation.
--
-- Invites are minted by `npm run invite` using the secret key, which bypasses
-- RLS; that is the only insert path. No session — anon or authenticated —
-- can read or write this table: no policies for either role, and every grant
-- revoked, so even a future policy added by mistake has nothing to unlock.
--
-- Only the sha256 of a token is stored. The raw token exists in the printed
-- link and nowhere else, so a read of this table cannot mint a working link.

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  -- Supabase Auth lowercases the signup email before the hook sees it, so the
  -- hook compares with plain equality. The check makes a mixed-case insert
  -- fail loudly instead of minting an invite that can never match.
  email text not null check (email = lower(email)),
  label text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  -- No FK: the hook runs before the auth.users row exists, and GoTrue has
  -- already assigned the id it is about to insert.
  consumed_by uuid,
  created_at timestamptz not null default now()
);

alter table public.invites enable row level security;

revoke all on table public.invites from anon, authenticated;

grant usage on schema public to supabase_auth_admin;
grant select, update on table public.invites to supabase_auth_admin;

create policy "auth admin reads invites"
  on public.invites for select
  to supabase_auth_admin
  using (true);

create policy "auth admin consumes invites"
  on public.invites for update
  to supabase_auth_admin
  using (true)
  with check (true);

-- Receives GoTrue's hook payload; `invite_token` arrives in user_metadata
-- because the signup action passes it as signUp's options.data.
--
-- Two properties of how GoTrue runs this hook shape the body:
-- - It runs in its OWN transaction, committed before the user row is
--   inserted. So a write here persists even when the function then returns
--   an error object — the token is consumed only on the path that allows the
--   signup. And if the user insert fails afterwards (a same-email race, a
--   database fault), the invite stays spent; Tarek mints another.
-- - An exception raised here makes GoTrue reject the signup, so the hook
--   fails closed.
--
-- Concurrency needs no explicit lock: two signups with one token both target
-- the same row in the UPDATE. The second blocks until the first commits,
-- re-evaluates `consumed_at is null` against the committed row, matches
-- nothing, and is rejected.
--
-- Invoker rights (Supabase's guidance for auth hooks: security definer would
-- run this as `postgres`). Empty search_path, so every name is qualified.
create or replace function public.hook_require_invite(event jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_token text := event->'user'->'user_metadata'->>'invite_token';
  v_email text := lower(event->'user'->>'email');
  v_user_id uuid := (event->'user'->>'id')::uuid;
  v_hash text;
begin
  if v_token is null or v_token = '' then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'invite_required'));
  end if;

  -- Must match hashInviteToken() in src/lib/invite.ts byte for byte.
  v_hash := encode(sha256(convert_to(v_token, 'UTF8')), 'hex');

  update public.invites
  set consumed_at = now(),
      consumed_by = v_user_id
  where token_hash = v_hash
    and consumed_at is null
    and expires_at > now()
    and email = v_email;

  if found then
    return '{}'::jsonb;
  end if;

  -- The consume failed. Tell apart only the case the invitee can fix: a live
  -- invite used with the wrong address, which leaves the link unspent. This
  -- distinction is visible only to someone already holding a real token.
  perform 1
  from public.invites
  where token_hash = v_hash
    and consumed_at is null
    and expires_at > now();

  if found then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'invite_email_mismatch'));
  end if;

  return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'invite_invalid'));
end;
$$;

-- Functions in `public` are callable over /rest/v1/rpc by default. Revoke
-- that, so only Supabase Auth can invoke the hook.
revoke execute on function public.hook_require_invite(jsonb) from public, anon, authenticated;
grant execute on function public.hook_require_invite(jsonb) to supabase_auth_admin;

-- spend_config + spend_ledger + reserve_spend / settle_spend — spend caps.
--
-- Every Claude-spending request reserves a worst-case dollar amount here
-- BEFORE any Claude call, and settles it to the real figure afterwards. A run
-- killed mid-flight never settles, so it keeps its full reservation: a crash
-- can never be free against the cap. That is what `usage_runs` cannot do,
-- since its row is written from a `finally` a timeout kill skips.
--
-- Limits apply over a ROLLING 24 hours, not a calendar day, so there is no
-- reset instant to spend across twice.
--
-- Neither table is reachable from any session: RLS on, no policies, every
-- grant revoked. The only way in is the two functions below, which run as
-- their owner (security definer).
--
-- Tuning and the kill switch are edits to the single `spend_config` row in
-- the SQL editor, and take effect on the next request with no deploy:
--   update public.spend_config set generation_enabled = false;

create table public.spend_config (
  id smallint primary key default 1 check (id = 1),
  generation_enabled boolean not null default true,
  -- numeric admits 'NaN', which compares greater than every number, so each
  -- money column excludes it explicitly.
  user_window_usd numeric(12,6) not null check (user_window_usd >= 0 and user_window_usd <> 'NaN'),
  global_window_usd numeric(12,6) not null check (global_window_usd >= 0 and global_window_usd <> 'NaN'),
  -- The first run plus top-ups.
  max_digest_runs_per_window integer not null check (max_digest_runs_per_window >= 0),
  max_expands_per_window integer not null check (max_expands_per_window >= 0),
  digest_base_usd numeric(12,6) not null check (digest_base_usd > 0 and digest_base_usd <> 'NaN'),
  digest_per_topic_usd numeric(12,6) not null check (digest_per_topic_usd >= 0 and digest_per_topic_usd <> 'NaN'),
  digest_max_usd numeric(12,6) not null check (digest_max_usd > 0 and digest_max_usd <> 'NaN'),
  -- The number of topics a profile can hold (TOPICS in src/types.ts). A topic
  -- count sent to reserve_spend is clamped to it, so a direct caller cannot
  -- size a reservation past what a real profile could produce.
  digest_max_topics integer not null check (digest_max_topics >= 1),
  -- Worst case: two Sonnet calls at max_tokens 4096 (the truncation retry).
  expand_usd numeric(12,6) not null check (expand_usd > 0 and expand_usd <> 'NaN')
);

-- Sized from measured runs: a full 13-topic profile cost $0.47 first-of-day
-- and $0.20 per top-up; an expand ~$0.0105.
insert into public.spend_config (
  id, generation_enabled, user_window_usd, global_window_usd,
  max_digest_runs_per_window, max_expands_per_window,
  digest_base_usd, digest_per_topic_usd, digest_max_usd, digest_max_topics, expand_usd
) values (1, true, 2.00, 10.00, 4, 15, 0.05, 0.05, 0.70, 13, 0.12);

create table public.spend_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('digest', 'expand')),
  reserved_usd numeric(12,6) not null check (reserved_usd > 0 and reserved_usd <> 'NaN'),
  actual_usd numeric(12,6) check (actual_usd >= 0 and actual_usd <> 'NaN'),
  status text not null default 'reserved' check (status in ('reserved', 'settled')),
  -- sha256 of the settle token. The raw token only travels database -> app
  -- server -> database, never to a browser.
  settle_token_hash text not null,
  -- The digest or card this was for. Informational only: never trusted.
  ref_id uuid,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint spend_ledger_settled_has_actual
    check ((status = 'settled') = (actual_usd is not null))
);

create index spend_ledger_user_created_idx on public.spend_ledger (user_id, created_at);
create index spend_ledger_created_idx on public.spend_ledger (created_at);

alter table public.spend_config enable row level security;
alter table public.spend_ledger enable row level security;

revoke all on table public.spend_config from anon, authenticated;
revoke all on table public.spend_ledger from anon, authenticated;

-- Returns {ok: true, reservation_id, settle_token, reserved_usd}, or
-- {ok: false, reason, available_at} where reason is one of
-- disabled | user_count | too_large | user_budget | global_budget.
-- available_at is when the refused request would next fit, or null when
-- waiting cannot help (disabled, too_large, a count cap of 0).
--
-- The amount is computed HERE from spend_config, never taken from the caller.
-- A caller-supplied figure could be 'NaN', which would poison the global sum
-- and refuse every user.
--
-- A row counts toward the run/expand COUNT while it is reserved, or settled
-- above $0. A run that stopped before any Claude call settles at $0 and does
-- not use up a top-up. Every row counts toward the DOLLAR sums at
-- coalesce(actual, reserved).
create or replace function public.reserve_spend(
  p_kind text,
  p_topic_count integer default null,
  p_ref uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_cfg public.spend_config%rowtype;
  v_since timestamptz;
  v_amount numeric;
  v_max_count integer;
  v_count integer;
  v_user_total numeric;
  v_global_total numeric;
  v_available timestamptz;
  v_token text;
  v_id uuid;
begin
  if v_user is null then
    raise exception 'reserve_spend requires a signed-in user';
  end if;
  if p_kind is null or p_kind not in ('digest', 'expand') then
    raise exception 'reserve_spend: unknown kind';
  end if;

  -- The one lock. Every reservation queues here, so two concurrent requests
  -- cannot both read the same totals and both slip under a limit. Under READ
  -- COMMITTED each statement below takes a fresh snapshot after the lock, so
  -- it sees the previous holder's committed insert.
  select * into v_cfg from public.spend_config where id = 1 for update;
  if not found then
    raise exception 'reserve_spend: spend_config row missing';
  end if;

  if not v_cfg.generation_enabled then
    return jsonb_build_object('ok', false, 'reason', 'disabled', 'available_at', null);
  end if;

  v_since := now() - interval '24 hours';

  if p_kind = 'digest' then
    v_max_count := v_cfg.max_digest_runs_per_window;
    -- A missing count is sized as the largest profile.
    v_amount := least(
      v_cfg.digest_max_usd,
      v_cfg.digest_base_usd
        + v_cfg.digest_per_topic_usd
          * least(greatest(coalesce(p_topic_count, v_cfg.digest_max_topics), 1), v_cfg.digest_max_topics)
    );
  else
    v_max_count := v_cfg.max_expands_per_window;
    v_amount := v_cfg.expand_usd;
  end if;

  select count(*) into v_count
  from public.spend_ledger
  where user_id = v_user
    and kind = p_kind
    and created_at > v_since
    and (status = 'reserved' or actual_usd > 0);

  if v_count >= v_max_count then
    v_available := null;
    if v_max_count > 0 then
      -- Newest first, the row at position max is the one whose expiry brings
      -- the count back to max - 1.
      select created_at + interval '24 hours' into v_available
      from public.spend_ledger
      where user_id = v_user
        and kind = p_kind
        and created_at > v_since
        and (status = 'reserved' or actual_usd > 0)
      order by created_at desc, id desc
      offset v_max_count - 1
      limit 1;
    end if;
    return jsonb_build_object('ok', false, 'reason', 'user_count', 'available_at', v_available);
  end if;

  if v_amount > v_cfg.user_window_usd or v_amount > v_cfg.global_window_usd then
    return jsonb_build_object('ok', false, 'reason', 'too_large', 'available_at', null);
  end if;

  select coalesce(sum(coalesce(actual_usd, reserved_usd)), 0) into v_user_total
  from public.spend_ledger
  where user_id = v_user
    and created_at > v_since;

  if v_user_total + v_amount > v_cfg.user_window_usd then
    -- Oldest first, the earliest row whose expiry (together with every older
    -- row's) frees enough room for this amount. A settle committing between
    -- the total above and this query can make the answer a few seconds off,
    -- which moves the time shown to the user, never the refusal itself.
    select t.created_at + interval '24 hours' into v_available
    from (
      select created_at, id,
        sum(coalesce(actual_usd, reserved_usd)) over (order by created_at, id) as dropped
      from public.spend_ledger
      where user_id = v_user
        and created_at > v_since
    ) t
    where v_user_total - t.dropped + v_amount <= v_cfg.user_window_usd
    order by t.created_at, t.id
    limit 1;
    return jsonb_build_object('ok', false, 'reason', 'user_budget', 'available_at', v_available);
  end if;

  select coalesce(sum(coalesce(actual_usd, reserved_usd)), 0) into v_global_total
  from public.spend_ledger
  where created_at > v_since;

  if v_global_total + v_amount > v_cfg.global_window_usd then
    select t.created_at + interval '24 hours' into v_available
    from (
      select created_at, id,
        sum(coalesce(actual_usd, reserved_usd)) over (order by created_at, id) as dropped
      from public.spend_ledger
      where created_at > v_since
    ) t
    where v_global_total - t.dropped + v_amount <= v_cfg.global_window_usd
    order by t.created_at, t.id
    limit 1;
    return jsonb_build_object('ok', false, 'reason', 'global_budget', 'available_at', v_available);
  end if;

  -- Two v4 UUIDs: 244 random bits from the core strong RNG, with no extension
  -- dependency.
  v_token := encode(uuid_send(gen_random_uuid()), 'hex') || encode(uuid_send(gen_random_uuid()), 'hex');

  insert into public.spend_ledger (user_id, kind, reserved_usd, settle_token_hash, ref_id)
  values (v_user, p_kind, v_amount, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), p_ref)
  returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'reservation_id', v_id,
    'settle_token', v_token,
    'reserved_usd', v_amount
  );
end;
$$;

-- Replaces a reservation with the real figure, once. The token is the only
-- credential, deliberately: no login is checked, so a session that expired
-- during a long run cannot strand the reservation at its worst-case amount.
-- A caller can only hold the token of a reservation the app server made for
-- them, or of one they made themselves by calling reserve_spend directly,
-- which bought no Claude spend.
--
-- The actual is STORED at no more than the reservation. The token of a
-- directly-created reservation is in the caller's hands, so any amount above
-- it would let one account record more than reserve_spend ever admitted and
-- push the global sum toward refusing every user. Every reservation was
-- checked against the limits when it was made, so capping each settle at its
-- own reservation keeps a user's recorded total within their window limit
-- whatever order reserves and settles arrive in. A real run that costs more
-- than its reservation is recorded at the reservation here; its true figure
-- is in usage_runs, and the Anthropic Console limit is the hard stop.
-- Returns false, and changes nothing, for a bad amount, a wrong token, or a
-- reservation already settled.
create or replace function public.settle_spend(
  p_id uuid,
  p_token text,
  p_actual_usd numeric
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  -- The NaN test is belt and braces: numeric sorts NaN above every value, so
  -- the upper bound rejects it too.
  if p_id is null or p_token is null or p_actual_usd is null
     or p_actual_usd = 'NaN' or p_actual_usd < 0 or p_actual_usd >= 1000000 then
    return false;
  end if;

  update public.spend_ledger
  set actual_usd = least(p_actual_usd, reserved_usd),
      status = 'settled',
      settled_at = now()
  where id = p_id
    and status = 'reserved'
    and settle_token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');

  return found;
end;
$$;

-- Functions in `public` are executable by PUBLIC, anon and authenticated by
-- default. reserve_spend needs a signed-in user; settle_spend is anon-callable
-- on purpose (see above).
revoke execute on function public.reserve_spend(text, integer, uuid) from public, anon;
grant execute on function public.reserve_spend(text, integer, uuid) to authenticated;
revoke execute on function public.settle_spend(uuid, text, numeric) from public;
grant execute on function public.settle_spend(uuid, text, numeric) to anon, authenticated;

-- generation_claims + claim_generation / release_generation — the generation
-- mutex.
--
-- Exactly one digest generation per USER at a time. The claim is keyed on
-- user_id, never on a digest row: keyed per row, a UTC midnight rollover
-- mints a new day's digest and lets a second pipeline start while the first
-- is still running, which is two ingests, duplicate cards and two worst-case
-- spend reservations for one user.
--
-- Neither the table nor its state is reachable from any session: RLS on, no
-- policies, every grant revoked. The only way in is the two functions below,
-- which run as their owner (security definer). That is load-bearing rather
-- than conventional here — the staleness window is what protects a live run,
-- so the party it binds must not be able to choose it.
create table public.generation_claims (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- The ownership token, returned by claim_generation and required to
  -- release. A run whose claim was reclaimed as stale holds a token that is
  -- no longer here, so its late release deletes nothing rather than freeing
  -- the claim that replaced it.
  claim_id uuid not null unique,
  -- Set by the function, not by a column default, so the staleness
  -- comparison can never read a timestamp the caller supplied.
  claimed_at timestamptz not null
);

-- Stated explicitly rather than left to a project-level default, so a
-- rebuild from this file alone is still locked down.
alter table public.generation_claims enable row level security;

revoke all on table public.generation_claims from anon, authenticated;

-- Returns the new claim's token, or null when a live claim is already held.
--
-- p_stale_ms is how long a claim is honored before it can be reclaimed, and
-- it is clamped at both ends. Below the floor, a caller could reclaim a
-- window still belonging to a run that is genuinely in flight; above the
-- ceiling, a caller could wedge their own account until it expired. The floor
-- must stay longer than the digest route's maxDuration, or a live run's claim
-- becomes reclaimable while that run is still going — a test reads the floor
-- out of this file and fails if the two ever cross.
drop function if exists public.claim_generation(integer, uuid);
drop function if exists public.claim_generation(integer);
create or replace function public.claim_generation(p_stale_ms integer default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_floor_ms constant integer := 180000;
  v_ceiling_ms constant integer := 3600000;
  v_ms integer := least(greatest(coalesce(p_stale_ms, 0), v_floor_ms), v_ceiling_ms);
  v_claim uuid;
begin
  if v_user is null then
    raise exception 'claim_generation requires a signed-in user';
  end if;

  -- The whole mutex, in one statement. ON CONFLICT DO UPDATE takes the
  -- conflicting row's lock and re-evaluates this WHERE against the latest
  -- committed version of it, so under genuine overlap the loser sees the
  -- winner's fresh claimed_at, updates nothing, and RETURNING yields no row.
  -- Deliberately no explicit lock: a lock on any shared row would serialize
  -- every user's claim behind every other user's for no benefit.
  insert into public.generation_claims (user_id, claim_id, claimed_at)
  values (v_user, gen_random_uuid(), now())
  on conflict (user_id) do update
    set claim_id = excluded.claim_id,
        claimed_at = excluded.claimed_at
    where public.generation_claims.claimed_at < now() - (v_ms * interval '1 millisecond')
  returning claim_id into v_claim;

  return v_claim;
end;
$$;

-- Returns true when this token held the claim and it was released, false when
-- it did not — a token whose claim was already reclaimed as stale releases
-- nothing, which is what stops a zombie run from freeing its successor's
-- claim.
--
-- The token is the only credential: no auth.uid() check, and anon may call
-- it. Release runs in the same finally block as the spend settle, so a
-- session that expired during a long run must still be able to let the claim
-- go.
drop function if exists public.release_generation(uuid);
create or replace function public.release_generation(p_claim_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_claim_id is null then
    return false;
  end if;

  delete from public.generation_claims where claim_id = p_claim_id;

  return found;
end;
$$;

-- Functions in `public` are executable by PUBLIC, anon and authenticated by
-- default. claim_generation needs a signed-in user; release_generation is
-- anon-callable on purpose (see above).
revoke execute on function public.claim_generation(integer) from public, anon;
grant execute on function public.claim_generation(integer) to authenticated;
revoke execute on function public.release_generation(uuid) from public;
grant execute on function public.release_generation(uuid) to anon, authenticated;
