-- Stimia - RPC salvataggio offerta e grants
-- Estratto da supabase/migrations/20261119_data_safety.sql (righe 333-430).
-- Eseguire questo blocco nel SQL Editor di Supabase, poi il successivo.


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

