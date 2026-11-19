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
    'Versione schema >= 4',
    public.stimia_schema_version() >= 4
)
select controllo, case when esito then 'PASS' else 'FAIL' end as risultato
from checks
order by controllo;
