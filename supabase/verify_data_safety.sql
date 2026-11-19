-- ============================================================
-- Stimia - verifica protezione dati (2026-11-19)
--
-- Eseguire nel SQL Editor dopo la migrazione 20261119_data_safety.sql.
-- Controllo read-only con esito PASS/FAIL.
-- ============================================================

with checks(controllo, esito) as (
  select
    'Funzione save_project_parts_v2',
    exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'save_project_parts_v2'
    )

  union all
  select
    'Funzione is_project_contributor',
    exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'is_project_contributor'
    )

  union all
  select
    'anon non può eseguire save_project_parts_v2',
    not has_function_privilege('anon', 'public.save_project_parts_v2(text, jsonb, jsonb, timestamptz)', 'execute')

  union all
  select
    'anon non può eseguire is_project_contributor',
    not has_function_privilege('anon', 'public.is_project_contributor(text)', 'execute')

  union all
  select
    'anon non può leggere la versione schema',
    not has_function_privilege('anon', 'public.stimia_schema_version()', 'execute')

  union all
  select
    'Colonna can_edit_offer',
    (
      select count(*) = 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'project_members'
        and column_name = 'can_edit_offer'
    )

  union all
  select
    'Ditta senza scrittura completa',
    not exists (
      select 1
      from public.project_members m
      join public.projects p on p.id = m.project_id
      where m.can_write
        and (
          exists (
            select 1
            from jsonb_each(coalesce(p.payload -> 'memberPermissions', '{}'::jsonb)) as perm(key, value)
            where lower(perm.key) = lower(m.email)
              and perm.value ->> 'role' = 'ditta'
          )
          or (
            exists (
              select 1
              from jsonb_each(coalesce(p.payload -> 'collaborators', '{}'::jsonb)) as coll(key, value)
              where lower(coll.key) = lower(m.email)
                and (coll.value #>> '{}') = 'ditta'
            )
            and not exists (
              select 1
              from jsonb_object_keys(coalesce(p.payload -> 'memberPermissions', '{}'::jsonb)) as k(key)
              where lower(k.key) = lower(m.email)
            )
          )
        )
    )

  union all
  select
    'Funzione save_project_offer',
    exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'save_project_offer'
    )

  union all
  select
    'Funzione merge_offer_node',
    exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'merge_offer_node'
    )

  union all
  select
    'anon non può eseguire save_project_offer',
    not has_function_privilege('anon', 'public.save_project_offer(text, jsonb, jsonb, timestamptz)', 'execute')

  union all
  select
    'Tabella project_versions presente',
    to_regclass('public.project_versions') is not null

  union all
  select
    'RLS attiva su project_versions',
    coalesce((select relrowsecurity from pg_class where oid = 'public.project_versions'::regclass), false)

  union all
  select
    'Policy project_versions presenti',
    (
      select count(*) = 3
      from pg_policies
      where schemaname = 'public'
        and tablename = 'project_versions'
        and policyname in ('project_versions_select', 'project_versions_insert', 'project_versions_delete')
    )

  union all
  select
    'Grant versioni ad authenticated',
    has_table_privilege('authenticated', 'public.project_versions', 'SELECT')
    and has_table_privilege('authenticated', 'public.project_versions', 'INSERT')
    and has_table_privilege('authenticated', 'public.project_versions', 'DELETE')

  union all
  select
    'Trigger limite versioni',
    exists (
      select 1 from pg_trigger
      where tgname = 'project_versions_prune'
        and tgrelid = 'public.project_versions'::regclass
    )

  union all
  select
    'Tabella schema_meta presente',
    to_regclass('public.schema_meta') is not null

  union all
  select
    'Versione schema >= 5',
    public.stimia_schema_version() >= 5
)
select controllo, case when esito then 'PASS' else 'FAIL' end as risultato
from checks
order by controllo;
