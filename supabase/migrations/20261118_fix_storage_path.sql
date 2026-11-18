-- ============================================================
-- Stimia - correzione policy Storage (2026-11-18)
--
-- La migrazione granulare usava storage.foldername(name) dentro una
-- sottoquery con alias projects p: PostgreSQL risolveva name come
-- p.name (nome del progetto), non come percorso dell'oggetto Storage.
-- Risultato: upload di allegati/prezzari bloccati dalle policy.
--
-- Da eseguire una volta se la migrazione 20261118_granular_permissions.sql
-- era gia stata applicata. E idempotente.
-- ============================================================
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
