-- Stimia - Cronologia versioni e versione schema
-- Estratto da supabase/migrations/20261119_data_safety.sql (righe 431-546).
-- Eseguire questo blocco nel SQL Editor di Supabase, poi il successivo.

-- ------------------------------------------------------------
-- 3. Cronologia versioni condivisa
-- ------------------------------------------------------------
create table if not exists public.project_versions (
  id           text primary key,
  project_id   text not null references public.projects (id) on delete cascade,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  reason       text not null default 'Automatica',
  hash         text not null default '',
  stats        jsonb not null default '{}'::jsonb,
  snapshot     jsonb not null
);

create index if not exists project_versions_project_idx
  on public.project_versions (project_id, created_at desc);

grant select, insert, delete on public.project_versions to authenticated;
revoke all on public.project_versions from public, anon;

alter table public.project_versions enable row level security;

drop policy if exists project_versions_select on public.project_versions;
create policy project_versions_select on public.project_versions
  for select to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = project_id
        and (p.owner_id = auth.uid() or public.is_project_member(p.id))
    )
  );

drop policy if exists project_versions_insert on public.project_versions;
create policy project_versions_insert on public.project_versions
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.projects p
      where p.id = project_id
        and (p.owner_id = auth.uid() or public.is_project_contributor(p.id))
    )
  );

drop policy if exists project_versions_delete on public.project_versions;
create policy project_versions_delete on public.project_versions
  for delete to authenticated
  using (
    created_by = auth.uid()
    or exists (
      select 1 from public.projects p
      where p.id = project_id
        and (p.owner_id = auth.uid() or public.is_project_writer(p.id))
    )
  );

-- Mantiene al massimo 20 versioni per progetto, lato server.
create or replace function public.prune_project_versions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.project_versions
  where project_id = new.project_id
    and id not in (
      select id
      from public.project_versions
      where project_id = new.project_id
      order by created_at desc, id desc
      limit 20
    );
  return new;
end;
$$;

drop trigger if exists project_versions_prune on public.project_versions;
create trigger project_versions_prune
after insert on public.project_versions
for each row execute function public.prune_project_versions();

revoke all on function public.prune_project_versions() from public, anon;

-- ------------------------------------------------------------
-- 4. Versione dello schema leggibile dall'app
-- ------------------------------------------------------------
create table if not exists public.schema_meta (
  id         text primary key,
  version    integer not null,
  applied_at timestamptz not null default now()
);

insert into public.schema_meta (id, version)
values ('stimia', 5)
on conflict (id) do update
  set version = greatest(public.schema_meta.version, excluded.version),
      applied_at = now();

alter table public.schema_meta enable row level security;

create or replace function public.stimia_schema_version()
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(max(version), 0)
  from public.schema_meta
  where id = 'stimia';
$$;

revoke all on function public.stimia_schema_version() from public, anon;
grant execute on function public.stimia_schema_version() to authenticated;
