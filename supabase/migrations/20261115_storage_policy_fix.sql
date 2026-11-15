-- ============================================================
-- Stimia — correzione policy Storage (2026-11-15)
--
-- La prima versione della migrazione usava `storage.foldername(name)`
-- dentro una sottoquery con alias `p` su public.projects: PostgreSQL
-- risolveva `name` come `p.name` (nome del progetto) invece del percorso
-- dell'oggetto, quindi ogni upload veniva rifiutato dalla RLS.
--
-- Questa patch sostituisce le policy con la forma `IN (select p.id ...)`,
-- dove `name` resta riferito alla riga di storage.objects.
--
-- Da eseguire solo se hai già applicato la versione precedente della
-- migrazione 20261115_security_storage.sql. È idempotente.
-- ============================================================

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
