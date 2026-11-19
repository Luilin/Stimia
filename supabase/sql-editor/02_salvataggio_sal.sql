-- Stimia - RPC SAL/prezzari con concorrenza
-- Estratto da supabase/migrations/20261119_data_safety.sql (righe 114-220).
-- Eseguire questo blocco nel SQL Editor di Supabase, poi il successivo.

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

