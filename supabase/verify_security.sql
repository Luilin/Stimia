-- ============================================================
-- Stimia - verifica sicurezza e permessi granulari
--
-- Eseguire nel SQL Editor di Supabase. È un controllo read-only:
-- restituisce PASS/FAIL per ogni requisito.
-- ============================================================

with checks(controllo, esito) as (
  select
    'Colonne granulari in project_members',
    (
      select count(*) = 3
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'project_members'
        and column_name in ('can_write', 'can_edit_sal', 'can_edit_price_books')
    )

  union all
  select
    'Funzioni granulari presenti',
    (
      select count(*) = 3
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('is_project_writer', 'is_project_price_book_editor', 'save_project_parts')
    )

  union all
  select
    'anon non può eseguire is_project_writer',
    not has_function_privilege('anon', 'public.is_project_writer(text)', 'execute')

  union all
  select
    'anon non può eseguire is_project_price_book_editor',
    not has_function_privilege('anon', 'public.is_project_price_book_editor(text)', 'execute')

  union all
  select
    'anon non può eseguire save_project_parts',
    not has_function_privilege('anon', 'public.save_project_parts(text, jsonb, jsonb)', 'execute')

  union all
  select
    'RLS attiva su projects',
    coalesce((select relrowsecurity from pg_class where oid = 'public.projects'::regclass), false)

  union all
  select
    'RLS attiva su project_members',
    coalesce((select relrowsecurity from pg_class where oid = 'public.project_members'::regclass), false)

  union all
  select
    'RLS attiva su project_attachments',
    coalesce((select relrowsecurity from pg_class where oid = 'public.project_attachments'::regclass), false)

  union all
  select
    'RLS attiva su storage.objects',
    coalesce((select relrowsecurity from pg_class where oid = 'storage.objects'::regclass), false)

  union all
  select
    'Policy projects_update aggiornata',
    exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = 'projects'
        and policyname = 'projects_update'
        and coalesce(qual, '') like '%is_project_writer%'
    )

  union all
  select
    'Policy allegati solo per writer',
    exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = 'project_attachments'
        and policyname = 'attachments_write'
        and coalesce(with_check, '') like '%is_project_writer%'
    )

  union all
  select
    'Policy Storage usa il percorso corretto',
    (
      select count(*) = 3
      from pg_policies
      where schemaname = 'storage'
        and tablename = 'objects'
        and policyname in ('stimia_files_insert', 'stimia_files_update', 'stimia_files_delete')
        and (coalesce(qual, '') || coalesce(with_check, '')) like '%storage.foldername%'
        and (coalesce(qual, '') || coalesce(with_check, '')) not like '%storage.foldername(p.name)%'
    )
)
select controllo, case when esito then 'PASS' else 'FAIL' end as risultato
from checks
order by controllo;
