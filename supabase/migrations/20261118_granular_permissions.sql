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
        (storage.foldername(name))[2] = 'attachments'
        and exists (
          select 1 from public.projects p
          where p.id = (storage.foldername(name))[1]
            and (p.owner_id = auth.uid() or public.is_project_writer(p.id))
        )
      )
      or (
        (storage.foldername(name))[2] = 'price-books'
        and exists (
          select 1 from public.projects p
          where p.id = (storage.foldername(name))[1]
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
        (storage.foldername(name))[2] = 'attachments'
        and exists (
          select 1 from public.projects p
          where p.id = (storage.foldername(name))[1]
            and (p.owner_id = auth.uid() or public.is_project_writer(p.id))
        )
      )
      or (
        (storage.foldername(name))[2] = 'price-books'
        and exists (
          select 1 from public.projects p
          where p.id = (storage.foldername(name))[1]
            and (p.owner_id = auth.uid() or public.is_project_price_book_editor(p.id))
        )
      )
    )
  )
  with check (
    bucket_id = 'stimia-files'
    and (
      (
        (storage.foldername(name))[2] = 'attachments'
        and exists (
          select 1 from public.projects p
          where p.id = (storage.foldername(name))[1]
            and (p.owner_id = auth.uid() or public.is_project_writer(p.id))
        )
      )
      or (
        (storage.foldername(name))[2] = 'price-books'
        and exists (
          select 1 from public.projects p
          where p.id = (storage.foldername(name))[1]
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
        (storage.foldername(name))[2] = 'attachments'
        and exists (
          select 1 from public.projects p
          where p.id = (storage.foldername(name))[1]
            and (p.owner_id = auth.uid() or public.is_project_writer(p.id))
        )
      )
      or (
        (storage.foldername(name))[2] = 'price-books'
        and exists (
          select 1 from public.projects p
          where p.id = (storage.foldername(name))[1]
            and (p.owner_id = auth.uid() or public.is_project_price_book_editor(p.id))
        )
      )
    )
  );
