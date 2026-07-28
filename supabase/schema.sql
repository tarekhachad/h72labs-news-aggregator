-- Phase 2 schema: user_topics + user_preferred_sources only.
-- digests/cards/bookmarks (docs/(C) DATABASE_SCHEMA.md) are Phase 3 scope,
-- not created here. Run this by hand in the Supabase SQL editor.
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
