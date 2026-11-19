-- ============================================================
-- Stimia - protezione dati (2026-11-19)
--
-- - Concorrenza ottimistica per i salvataggi parziali (SAL/prezzari).
-- - Cronologia versioni condivisa nel cloud.
-- - Versione dello schema leggibile dall'app.
--
-- Idempotente. Da eseguire nel SQL Editor di Supabase.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Helper: membro che può creare versioni (qualsiasi permesso di modifica)
-- ------------------------------------------------------------
create or replace function public.is_project_contributor(p_project_id text)
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
      and (
        m.can_write
        or m.can_edit_sal
        or m.can_edit_price_books
        or (m.role = 'editor' and not m.can_edit_sal and not m.can_edit_price_books)
      )
  );
$$;

revoke all on function public.is_project_contributor(text) from public, anon;
grant execute on function public.is_project_contributor(text) to authenticated;

-- ------------------------------------------------------------
-- 2. RPC SAL/prezzari con concorrenza ottimistica
--    (v2: la v1 resta per i client precedenti)
-- ------------------------------------------------------------
create or replace function public.save_project_parts_v2(
  p_project_id text,
  p_sals jsonb default null,
  p_price_books jsonb default null,
  p_expected_updated_at timestamptz default null
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_payload jsonb;
  v_can_write boolean := false;
  v_can_sal boolean := false;
  v_can_pb boolean := false;
  v_legacy_editor boolean := false;
  v_updated timestamptz;
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if p_sals is not null and jsonb_typeof(p_sals) = 'null' then
    p_sals := null;
  end if;
  if p_price_books is not null and jsonb_typeof(p_price_books) = 'null' then
    p_price_books := null;
  end if;

  select owner_id, coalesce(payload, '{}'::jsonb)
    into v_owner, v_payload
  from public.projects
  where id = p_project_id;

  if v_owner is null then
    raise exception 'Progetto non trovato';
  end if;

  if v_owner <> v_uid then
    select
      coalesce(m.can_write, false),
      coalesce(m.can_edit_sal, false),
      coalesce(m.can_edit_price_books, false),
      (m.role = 'editor' and not m.can_edit_sal and not m.can_edit_price_books)
    into v_can_write, v_can_sal, v_can_pb, v_legacy_editor
    from public.project_members m
    where m.project_id = p_project_id
      and lower(m.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    limit 1;

    if v_legacy_editor then
      v_can_write := true;
    end if;

    if not v_can_write then
      if p_sals is not null and not v_can_sal then
        raise exception 'Permessi insufficienti per i SAL';
      end if;
      if p_price_books is not null and not v_can_pb then
        raise exception 'Permessi insufficienti per i prezzari';
      end if;
    end if;
  end if;

  if p_sals is null and p_price_books is null then
    raise exception 'Nessun dato da salvare';
  end if;

  if p_sals is not null and jsonb_typeof(p_sals) <> 'array' then
    raise exception 'Formato SAL non valido';
  end if;

  if p_price_books is not null and jsonb_typeof(p_price_books) <> 'array' then
    raise exception 'Formato prezzari non valido';
  end if;

  v_payload := v_payload
    || case when p_sals is not null then jsonb_build_object('sals', p_sals) else '{}'::jsonb end
    || case when p_price_books is not null then jsonb_build_object('priceBooks', p_price_books) else '{}'::jsonb end
    || jsonb_build_object('lastModified', v_now);

  update public.projects
     set payload = v_payload,
         last_modified = v_now
   where id = p_project_id
     and (p_expected_updated_at is null or updated_at = p_expected_updated_at)
   returning updated_at into v_updated;

  if v_updated is null then
    raise exception 'Conflitto di sincronizzazione' using errcode = '40001';
  end if;

  return v_updated;
end;
$$;

revoke all on function public.save_project_parts_v2(text, jsonb, jsonb, timestamptz) from public, anon;
grant execute on function public.save_project_parts_v2(text, jsonb, jsonb, timestamptz) to authenticated;

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
values ('stimia', 4)
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
