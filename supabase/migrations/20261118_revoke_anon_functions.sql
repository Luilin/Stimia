-- ============================================================
-- Stimia - revoca EXECUTE ad anon (2026-11-18)
--
-- Supabase concede EXECUTE sui nuovi function del schema public anche al
-- ruolo `anon`. Le funzioni granulari devono essere richiamabili solo dagli
-- utenti autenticati.
--
-- Da eseguire una volta se la migrazione 20261118_granular_permissions.sql
-- era già stata applicata prima di questo aggiornamento. È idempotente.
-- ============================================================

revoke all on function public.is_project_writer(text) from anon;
revoke all on function public.is_project_price_book_editor(text) from anon;
revoke all on function public.save_project_parts(text, jsonb, jsonb) from anon;
