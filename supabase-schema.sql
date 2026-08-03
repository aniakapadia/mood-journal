-- Mood Journal — cloud schema
-- Applied to project fkorolkxfvetdilhhssd.
--
-- Design notes:
--  * Primary key is (user_id, id) where id is the client-generated entry id.
--    That makes every sync push an idempotent upsert — re-running a sync can
--    never duplicate an entry.
--  * Deletes are tombstones (deleted = true), never row removal, so a delete
--    on one device propagates instead of the entry resurrecting on next sync.
--  * updated_at is client epoch millis and drives last-write-wins merging.

create table if not exists public.entries (
  user_id     uuid        not null references auth.users(id) on delete cascade,
  id          text        not null,
  day         date        not null,
  mood        text        not null,
  note        text        not null default '',
  emoji       text,
  filter      text,
  photo_path  text,
  entry_time  timestamptz not null,
  deleted     boolean     not null default false,
  updated_at  bigint      not null,
  synced_at   timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists entries_user_day_idx on public.entries (user_id, day);

alter table public.entries enable row level security;

drop policy if exists "entries are private to their owner" on public.entries;
create policy "entries are private to their owner"
  on public.entries
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Table-level privileges. Creating tables over a direct psql connection skips
-- the default grants the dashboard would apply, so they're explicit here.
-- 'anon' is deliberately granted nothing: a signed-out visitor cannot even
-- reach the table, let alone a row. RLS then narrows 'authenticated' to self.
revoke all on public.entries from anon;
grant select, insert, update, delete on public.entries to authenticated;
grant all on public.entries to service_role;

-- Remember the journal owner's display name across devices.
create table if not exists public.profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  name        text,
  updated_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profile is private to its owner" on public.profiles;
create policy "profile is private to its owner"
  on public.profiles
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

revoke all on public.profiles from anon;
grant select, insert, update, delete on public.profiles to authenticated;
grant all on public.profiles to service_role;

-- ---- Photo storage ----
-- Private bucket. Every object lives under <user_id>/... and the policies below
-- pin access to that prefix, so one account can never read another's photos.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types,
      public = false;

drop policy if exists "own photos read"   on storage.objects;
drop policy if exists "own photos write"  on storage.objects;
drop policy if exists "own photos update" on storage.objects;
drop policy if exists "own photos delete" on storage.objects;

create policy "own photos read" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "own photos write" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "own photos update" on storage.objects for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "own photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
