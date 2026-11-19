-- Stimia - Fusione sicura dell'offerta ditta
-- Estratto da supabase/migrations/20261119_data_safety.sql (righe 221-332).
-- Eseguire questo blocco nel SQL Editor di Supabase, poi il successivo.

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
