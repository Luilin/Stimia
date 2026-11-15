-- ============================================================
-- Stimia — schema database SQL (Supabase / Postgres)
--
-- Come usarlo:
--   1. Apri il progetto su https://supabase.com
--   2. Menu "SQL Editor" → "New query"
--   3. Incolla tutto questo file e premi "Run"
--
-- Lo script è idempotente: puoi rieseguirlo senza perdere dati.
-- ============================================================

create table if not exists public.projects (
  id            text primary key,
  owner_id      uuid not null references auth.users (id) on delete cascade,
  owner_email   text,
  name          text not null default '',
  last_modified bigint not null default 0,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists projects_owner_idx on public.projects (owner_id);
create index if not exists projects_last_modified_idx on public.projects (last_modified desc);

-- Condivisione dei progetti per email (sostituisce sharedWithEmails).
create table if not exists public.project_members (
  project_id text not null references public.projects (id) on delete cascade,
  email      text not null,
  role       text not null default 'editor' check (role in ('viewer', 'editor')),
  created_at timestamptz not null default now(),
  primary key (project_id, email)
);

create index if not exists project_members_email_idx on public.project_members (lower(email));

-- updated_at automatico
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projects_touch_updated_at on public.projects;
create trigger projects_touch_updated_at
before update on public.projects
for each row execute function public.touch_updated_at();

-- Verifica appartenenza: SECURITY DEFINER evita la ricorsione delle policy.
create or replace function public.is_project_member(p_project_id text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.project_members m
    where m.project_id = p_project_id
      and lower(m.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

alter table public.projects enable row level security;
alter table public.project_members enable row level security;

-- ------------------------- PROGETTI -------------------------
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects
  for select to authenticated
  using (owner_id = auth.uid() or public.is_project_member(id));

drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects
  for insert to authenticated
  with check (owner_id = auth.uid());

drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects
  for update to authenticated
  using (owner_id = auth.uid() or public.is_project_member(id))
  with check (owner_id = auth.uid() or public.is_project_member(id));

drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects
  for delete to authenticated
  using (owner_id = auth.uid());

-- ------------------------- MEMBRI ---------------------------
drop policy if exists members_select on public.project_members;
create policy members_select on public.project_members
  for select to authenticated
  using (
    exists (
      select 1
      from public.projects p
      where p.id = project_id
        and (p.owner_id = auth.uid() or public.is_project_member(p.id))
    )
  );

drop policy if exists members_write on public.project_members;
create policy members_write on public.project_members
  for all to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = project_id and p.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      where p.id = project_id and p.owner_id = auth.uid()
    )
  );


-- ============================================================
-- Sicurezza ruoli, Storage e account (migrazione 2026-11-15)
-- Inclusa qui per le installazioni nuove.
-- ============================================================

-- ============================================================
-- Stimia — migrazione 2026-11-15
-- Sicurezza ruoli, protezione proprietà, Storage allegati/prezzari,
-- eliminazione account.
--
-- Da eseguire una volta su un progetto già creato:
--   Supabase Dashboard → SQL Editor → New query → incolla → Run
-- È idempotente: puoi rieseguirla senza perdere dati.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Ruolo "editor" applicato anche a livello di database
-- ------------------------------------------------------------
create or replace function public.is_project_editor(p_project_id text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.project_members m
    where m.project_id = p_project_id
      and lower(m.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and m.role = 'editor'
  );
$$;

drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects
  for update to authenticated
  using (owner_id = auth.uid() or public.is_project_editor(id))
  with check (owner_id = auth.uid() or public.is_project_editor(id));

-- Un collaboratore non può diventare proprietario cambiando owner_id.
create or replace function public.prevent_project_owner_change()
returns trigger
language plpgsql
as $$
begin
  if new.owner_id is distinct from old.owner_id then
    raise exception 'owner_id non modificabile';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_prevent_owner_change on public.projects;
create trigger projects_prevent_owner_change
before update on public.projects
for each row execute function public.prevent_project_owner_change();

-- ------------------------------------------------------------
-- 2. Metadati allegati (i file veri stanno in Storage)
-- ------------------------------------------------------------
create table if not exists public.project_attachments (
  id           text primary key,
  project_id   text not null references public.projects (id) on delete cascade,
  name         text not null,
  type         text not null default 'application/octet-stream',
  size         bigint not null default 0,
  node_id      text,
  notes        text,
  storage_path text not null,
  created_at   timestamptz not null default now()
);

create index if not exists project_attachments_project_idx
  on public.project_attachments (project_id, created_at desc);

alter table public.project_attachments enable row level security;

drop policy if exists attachments_select on public.project_attachments;
create policy attachments_select on public.project_attachments
  for select to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = project_id
        and (p.owner_id = auth.uid() or public.is_project_member(p.id))
    )
  );

drop policy if exists attachments_write on public.project_attachments;
create policy attachments_write on public.project_attachments
  for all to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = project_id
        and (p.owner_id = auth.uid() or public.is_project_editor(p.id))
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      where p.id = project_id
        and (p.owner_id = auth.uid() or public.is_project_editor(p.id))
    )
  );

-- ------------------------------------------------------------
-- 3. Bucket privato per allegati e prezzari
--    Percorso: <project_id>/attachments/<id>
--              <project_id>/price-books/<id>.json
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('stimia-files', 'stimia-files', false)
on conflict (id) do nothing;

drop policy if exists stimia_files_select on storage.objects;
create policy stimia_files_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'stimia-files'
    and exists (
      select 1 from public.projects p
      where p.id = (storage.foldername(name))[1]
        and (p.owner_id = auth.uid() or public.is_project_member(p.id))
    )
  );

drop policy if exists stimia_files_insert on storage.objects;
create policy stimia_files_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'stimia-files'
    and exists (
      select 1 from public.projects p
      where p.id = (storage.foldername(name))[1]
        and (p.owner_id = auth.uid() or public.is_project_editor(p.id))
    )
  );

drop policy if exists stimia_files_update on storage.objects;
create policy stimia_files_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'stimia-files'
    and exists (
      select 1 from public.projects p
      where p.id = (storage.foldername(name))[1]
        and (p.owner_id = auth.uid() or public.is_project_editor(p.id))
    )
  )
  with check (
    bucket_id = 'stimia-files'
    and exists (
      select 1 from public.projects p
      where p.id = (storage.foldername(name))[1]
        and (p.owner_id = auth.uid() or public.is_project_editor(p.id))
    )
  );

drop policy if exists stimia_files_delete on storage.objects;
create policy stimia_files_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'stimia-files'
    and exists (
      select 1 from public.projects p
      where p.id = (storage.foldername(name))[1]
        and (p.owner_id = auth.uid() or public.is_project_editor(p.id))
    )
  );

-- ------------------------------------------------------------
-- 4. Eliminazione del proprio account (GDPR)
-- ------------------------------------------------------------
create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  delete from storage.objects
  where bucket_id = 'stimia-files'
    and (storage.foldername(name))[1] in (
      select id from public.projects where owner_id = uid
    );

  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_own_account() from public;
grant execute on function public.delete_own_account() to authenticated;
