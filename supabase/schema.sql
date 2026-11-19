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
    and (storage.foldername(name))[1] in (
      select p.id from public.projects p
      where p.owner_id = auth.uid() or public.is_project_member(p.id)
    )
  );

drop policy if exists stimia_files_insert on storage.objects;
create policy stimia_files_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'stimia-files'
    and (storage.foldername(name))[1] in (
      select p.id from public.projects p
      where p.owner_id = auth.uid() or public.is_project_editor(p.id)
    )
  );

drop policy if exists stimia_files_update on storage.objects;
create policy stimia_files_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'stimia-files'
    and (storage.foldername(name))[1] in (
      select p.id from public.projects p
      where p.owner_id = auth.uid() or public.is_project_editor(p.id)
    )
  )
  with check (
    bucket_id = 'stimia-files'
    and (storage.foldername(name))[1] in (
      select p.id from public.projects p
      where p.owner_id = auth.uid() or public.is_project_editor(p.id)
    )
  );

drop policy if exists stimia_files_delete on storage.objects;
create policy stimia_files_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'stimia-files'
    and (storage.foldername(name))[1] in (
      select p.id from public.projects p
      where p.owner_id = auth.uid() or public.is_project_editor(p.id)
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

-- ============================================================
-- Stimia - permessi granulari (2026-11-18)
--
-- Obiettivo: un collaboratore che può modificare solo SAL o prezzari non deve
-- poter aggiornare l'intero payload del progetto tramite API.
--
-- Da eseguire una volta nel SQL Editor di Supabase. È idempotente.
-- Dopo la migrazione il client usa una RPC dedicata per SAL/prezzari; i client
-- precedenti continuano a funzionare tramite il fallback "editor legacy".
-- ============================================================

-- ------------------------------------------------------------
-- 1. Colonne permessi
-- ------------------------------------------------------------
alter table public.project_members
  add column if not exists can_write boolean not null default false,
  add column if not exists can_edit_sal boolean not null default false,
  add column if not exists can_edit_price_books boolean not null default false;

-- ------------------------------------------------------------
-- 2. Backfill dai permessi già salvati nel payload del progetto
-- ------------------------------------------------------------
update public.project_members m
set can_write = coalesce((perm.value ->> 'canWrite')::boolean, false),
    can_edit_sal = coalesce((perm.value ->> 'canEditSAL')::boolean, false),
    can_edit_price_books = coalesce((perm.value ->> 'canEditPriceBooks')::boolean, false)
from public.projects p,
  jsonb_each(coalesce(p.payload -> 'memberPermissions', '{}'::jsonb)) as perm(key, value)
where p.id = m.project_id
  and lower(perm.key) = lower(m.email);

-- La ditta deve poter salvare la propria offerta: è un editor applicativo.
update public.project_members m
set can_write = true,
    can_edit_sal = false,
    can_edit_price_books = false
from public.projects p,
  jsonb_each(coalesce(p.payload -> 'memberPermissions', '{}'::jsonb)) as perm(key, value)
where p.id = m.project_id
  and lower(perm.key) = lower(m.email)
  and perm.value ->> 'role' = 'ditta';

-- Vecchi ruoli in collaborators, per progetti senza memberPermissions.
update public.project_members m
set can_write = true
from public.projects p,
  jsonb_each(coalesce(p.payload -> 'collaborators', '{}'::jsonb)) as coll(key, value)
where p.id = m.project_id
  and lower(coll.key) = lower(m.email)
  and (coll.value #>> '{}') in ('editor', 'ditta')
  and not exists (
    select 1
    from jsonb_object_keys(coalesce(p.payload -> 'memberPermissions', '{}'::jsonb)) as existing(key)
    where lower(existing.key) = lower(m.email)
  );

-- Righe senza dati nel payload: preserva l'accesso come editor completo.
update public.project_members m
set can_write = true
where m.role = 'editor'
  and m.can_write = false
  and m.can_edit_sal = false
  and m.can_edit_price_books = false
  and not exists (
    select 1
    from public.projects p
    where p.id = m.project_id
      and (
        exists (
          select 1
          from jsonb_object_keys(coalesce(p.payload -> 'memberPermissions', '{}'::jsonb)) as k(key)
          where lower(k.key) = lower(m.email)
        )
        or exists (
          select 1
          from jsonb_object_keys(coalesce(p.payload -> 'collaborators', '{}'::jsonb)) as k(key)
          where lower(k.key) = lower(m.email)
        )
      )
  );

-- ------------------------------------------------------------
-- 3. Helper di autorizzazione
-- ------------------------------------------------------------
create or replace function public.is_project_writer(p_project_id text)
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
        -- Compatibilità con righe create da un client precedente alla migrazione.
        or (m.role = 'editor' and not m.can_edit_sal and not m.can_edit_price_books)
      )
  );
$$;

create or replace function public.is_project_price_book_editor(p_project_id text)
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
        or m.can_edit_price_books
        or (m.role = 'editor' and not m.can_edit_sal and not m.can_edit_price_books)
      )
  );
$$;

revoke all on function public.is_project_writer(text) from public;
revoke all on function public.is_project_price_book_editor(text) from public;
revoke all on function public.is_project_writer(text) from anon;
revoke all on function public.is_project_price_book_editor(text) from anon;
grant execute on function public.is_project_writer(text) to authenticated;
grant execute on function public.is_project_price_book_editor(text) to authenticated;

-- ------------------------------------------------------------
-- 4. Aggiornamento progetti: solo scrittura completa (o editor legacy)
-- ------------------------------------------------------------
drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects
  for update to authenticated
  using (owner_id = auth.uid() or public.is_project_writer(id))
  with check (owner_id = auth.uid() or public.is_project_writer(id));

-- ------------------------------------------------------------
-- 5. RPC per SAL e prezzari
-- ------------------------------------------------------------
create or replace function public.save_project_parts(
  p_project_id text,
  p_sals jsonb default null,
  p_price_books jsonb default null
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

  -- PostgREST può inviare JSON null: equivale a parametro assente.
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
   returning updated_at into v_updated;

  return v_updated;
end;
$$;

revoke all on function public.save_project_parts(text, jsonb, jsonb) from public;
revoke all on function public.save_project_parts(text, jsonb, jsonb) from anon;
grant execute on function public.save_project_parts(text, jsonb, jsonb) to authenticated;

-- ------------------------------------------------------------
-- 6. Allegati: scrittura solo con permesso completo
-- ------------------------------------------------------------
drop policy if exists attachments_write on public.project_attachments;
create policy attachments_write on public.project_attachments
  for all to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = project_id
        and (p.owner_id = auth.uid() or public.is_project_writer(p.id))
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      where p.id = project_id
        and (p.owner_id = auth.uid() or public.is_project_writer(p.id))
    )
  );

-- ------------------------------------------------------------
-- 7. Storage: allegati -> writer, prezzari -> price book editor
-- ------------------------------------------------------------
drop policy if exists stimia_files_insert on storage.objects;
create policy stimia_files_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'stimia-files'
    and (
      (
        (storage.foldername(storage.objects.name))[2] = 'attachments'
        and exists (
          select 1 from public.projects p
          where p.id = (storage.foldername(storage.objects.name))[1]
            and (p.owner_id = auth.uid() or public.is_project_writer(p.id))
        )
      )
      or (
        (storage.foldername(storage.objects.name))[2] = 'price-books'
        and exists (
          select 1 from public.projects p
          where p.id = (storage.foldername(storage.objects.name))[1]
            and (p.owner_id = auth.uid() or public.is_project_price_book_editor(p.id))
        )
      )
    )
  );

drop policy if exists stimia_files_update on storage.objects;
create policy stimia_files_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'stimia-files'
    and (
      (
        (storage.foldername(storage.objects.name))[2] = 'attachments'
        and exists (
          select 1 from public.projects p
          where p.id = (storage.foldername(storage.objects.name))[1]
            and (p.owner_id = auth.uid() or public.is_project_writer(p.id))
        )
      )
      or (
        (storage.foldername(storage.objects.name))[2] = 'price-books'
        and exists (
          select 1 from public.projects p
          where p.id = (storage.foldername(storage.objects.name))[1]
            and (p.owner_id = auth.uid() or public.is_project_price_book_editor(p.id))
        )
      )
    )
  )
  with check (
    bucket_id = 'stimia-files'
    and (
      (
        (storage.foldername(storage.objects.name))[2] = 'attachments'
        and exists (
          select 1 from public.projects p
          where p.id = (storage.foldername(storage.objects.name))[1]
            and (p.owner_id = auth.uid() or public.is_project_writer(p.id))
        )
      )
      or (
        (storage.foldername(storage.objects.name))[2] = 'price-books'
        and exists (
          select 1 from public.projects p
          where p.id = (storage.foldername(storage.objects.name))[1]
            and (p.owner_id = auth.uid() or public.is_project_price_book_editor(p.id))
        )
      )
    )
  );

drop policy if exists stimia_files_delete on storage.objects;
create policy stimia_files_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'stimia-files'
    and (
      (
        (storage.foldername(storage.objects.name))[2] = 'attachments'
        and exists (
          select 1 from public.projects p
          where p.id = (storage.foldername(storage.objects.name))[1]
            and (p.owner_id = auth.uid() or public.is_project_writer(p.id))
        )
      )
      or (
        (storage.foldername(storage.objects.name))[2] = 'price-books'
        and exists (
          select 1 from public.projects p
          where p.id = (storage.foldername(storage.objects.name))[1]
            and (p.owner_id = auth.uid() or public.is_project_price_book_editor(p.id))
        )
      )
    )
  );

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
-- 0. Permesso offerta ditta
-- ------------------------------------------------------------
alter table public.project_members
  add column if not exists can_edit_offer boolean not null default false;

update public.project_members m
set can_edit_offer = true,
    can_write = false
from public.projects p,
     jsonb_each(coalesce(p.payload -> 'memberPermissions', '{}'::jsonb)) as perm(key, value)
where p.id = m.project_id
  and lower(perm.key) = lower(m.email)
  and perm.value ->> 'role' = 'ditta';

update public.project_members m
set can_edit_offer = true,
    can_write = false
from public.projects p,
     jsonb_each(coalesce(p.payload -> 'collaborators', '{}'::jsonb)) as coll(key, value)
where p.id = m.project_id
  and lower(coll.key) = lower(m.email)
  and (coll.value #>> '{}') = 'ditta'
  and not exists (
    select 1
    from jsonb_object_keys(coalesce(p.payload -> 'memberPermissions', '{}'::jsonb)) as k(key)
    where lower(k.key) = lower(m.email)
  );

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
        or m.can_edit_offer
        or (m.role = 'editor' and not m.can_edit_sal and not m.can_edit_price_books and not m.can_edit_offer)
      )
  );
$$;

revoke all on function public.is_project_contributor(text) from public, anon;
grant execute on function public.is_project_contributor(text) to authenticated;

-- Un ditta non è uno scrittore completo: aggiorna solo l'offerta via RPC.
create or replace function public.is_project_writer(p_project_id text)
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
        or (m.role = 'editor' and not m.can_edit_sal and not m.can_edit_price_books and not m.can_edit_offer)
      )
  );
$$;

revoke all on function public.is_project_writer(text) from public, anon;
grant execute on function public.is_project_writer(text) to authenticated;

create or replace function public.is_project_price_book_editor(p_project_id text)
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
        or m.can_edit_price_books
        or (m.role = 'editor' and not m.can_edit_sal and not m.can_edit_price_books and not m.can_edit_offer)
      )
  );
$$;

revoke all on function public.is_project_price_book_editor(text) from public, anon;
grant execute on function public.is_project_price_book_editor(text) to authenticated;

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
      (m.role = 'editor' and not m.can_edit_sal and not m.can_edit_price_books and not m.can_edit_offer)
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
-- 2b. Offerta ditta: fonde solo campi offerta e voci aggiunte
-- ------------------------------------------------------------
create or replace function public.merge_offer_item(server_item jsonb, submitted_item jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  result jsonb := server_item;
begin
  if server_item is null then
    return submitted_item;
  end if;

  if coalesce((server_item ->> 'isContractorItem')::boolean, false) then
    result := jsonb_set(submitted_item, '{isContractorItem}', 'true'::jsonb);
    result := jsonb_set(result, '{id}', server_item -> 'id');
    return result;
  end if;

  if submitted_item ? 'offerPrice' then
    result := jsonb_set(result, '{offerPrice}', submitted_item -> 'offerPrice');
  end if;
  if submitted_item ? 'offerMaterialPrice' then
    result := jsonb_set(result, '{offerMaterialPrice}', submitted_item -> 'offerMaterialPrice');
  end if;
  if submitted_item ? 'offerLaborPrice' then
    result := jsonb_set(result, '{offerLaborPrice}', submitted_item -> 'offerLaborPrice');
  end if;
  if submitted_item ? 'offerDays' then
    result := jsonb_set(result, '{offerDays}', submitted_item -> 'offerDays');
  end if;
  if submitted_item ? 'offerNotes' then
    result := jsonb_set(result, '{offerNotes}', submitted_item -> 'offerNotes');
  end if;

  return result;
end;
$$;

create or replace function public.merge_offer_node(server_node jsonb, submitted_node jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  result jsonb := server_node;
  server_items jsonb := coalesce(server_node -> 'items', '[]'::jsonb);
  submitted_items jsonb := coalesce(submitted_node -> 'items', '[]'::jsonb);
  merged_items jsonb := '[]'::jsonb;
  item jsonb;
  sub jsonb;
  children jsonb := '[]'::jsonb;
  child jsonb;
  sub_child jsonb;
begin
  if server_node is null then
    return submitted_node;
  end if;
  if submitted_node is null then
    return server_node;
  end if;

  for item in select value from jsonb_array_elements(server_items) loop
    sub := null;
    select value into sub
    from jsonb_array_elements(submitted_items)
    where value ->> 'id' = item ->> 'id'
    limit 1;

    if sub is null and coalesce((item ->> 'isContractorItem')::boolean, false) then
      continue;
    end if;

    merged_items := merged_items || jsonb_build_array(public.merge_offer_item(item, sub));
  end loop;

  for sub in select value from jsonb_array_elements(submitted_items) loop
    if not exists (
      select 1 from jsonb_array_elements(server_items) as existing
      where existing ->> 'id' = sub ->> 'id'
    ) and coalesce((sub ->> 'isContractorItem')::boolean, false) then
      if coalesce(sub ->> 'id', '') = '' or coalesce(sub ->> 'description', '') = '' then
        raise exception 'Voce offerta non valida';
      end if;
      if exists (
        select 1 from jsonb_array_elements(merged_items) as added
        where added ->> 'id' = sub ->> 'id'
      ) then
        continue;
      end if;
      merged_items := merged_items || jsonb_build_array(jsonb_set(sub, '{isContractorItem}', 'true'::jsonb));
    end if;
  end loop;

  result := jsonb_set(result, '{items}', merged_items);

  for child in select value from jsonb_array_elements(coalesce(server_node -> 'children', '[]'::jsonb)) loop
    sub_child := null;
    select value into sub_child
    from jsonb_array_elements(coalesce(submitted_node -> 'children', '[]'::jsonb))
    where value ->> 'id' = child ->> 'id'
    limit 1;

    children := children || jsonb_build_array(public.merge_offer_node(child, sub_child));
  end loop;

  result := jsonb_set(result, '{children}', children);
  return result;
end;
$$;

create or replace function public.save_project_offer(
  p_project_id text,
  p_offer_tree jsonb,
  p_contractor_details jsonb default null,
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
  v_can_offer boolean := false;
  v_legacy_editor boolean := false;
  v_tree jsonb;
  v_updated timestamptz;
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if p_offer_tree is null or jsonb_typeof(p_offer_tree) <> 'object' then
    raise exception 'Albero offerta non valido';
  end if;

  if p_contractor_details is not null and jsonb_typeof(p_contractor_details) <> 'object' then
    raise exception 'Dati ditta non validi';
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
      coalesce(m.can_edit_offer, false),
      (m.role = 'editor' and not m.can_edit_sal and not m.can_edit_price_books and not m.can_edit_offer)
    into v_can_write, v_can_offer, v_legacy_editor
    from public.project_members m
    where m.project_id = p_project_id
      and lower(m.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    limit 1;

    if v_legacy_editor then
      v_can_write := true;
    end if;

    if not v_can_write and not v_can_offer then
      raise exception 'Permessi insufficienti per l''offerta';
    end if;
  end if;

  v_tree := public.merge_offer_node(
    coalesce(v_payload -> 'rootWBS', '{}'::jsonb),
    p_offer_tree
  );

  v_payload := v_payload
    || jsonb_build_object(
      'rootWBS', v_tree,
      'contractorDetails', p_contractor_details,
      'lastModified', v_now
    );

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

revoke all on function public.merge_offer_item(jsonb, jsonb) from public, anon;
revoke all on function public.merge_offer_node(jsonb, jsonb) from public, anon;
revoke all on function public.save_project_offer(text, jsonb, jsonb, timestamptz) from public, anon;
grant execute on function public.merge_offer_item(jsonb, jsonb) to authenticated;
grant execute on function public.merge_offer_node(jsonb, jsonb) to authenticated;
grant execute on function public.save_project_offer(text, jsonb, jsonb, timestamptz) to authenticated;

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
