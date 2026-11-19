-- Stimia - Permesso offerta ditta e helper dei permessi
-- Estratto da supabase/migrations/20261119_data_safety.sql (righe 1-113).
-- Eseguire questo blocco nel SQL Editor di Supabase, poi il successivo.

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

