/**
 * Modalità dell'applicazione.
 *
 * - **Supabase** (`VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`): login reale,
 *   progetti e allegati su Postgres/Storage con cache offline in IndexedDB.
 * - **Locale** (tutto il resto): login simulato e dati nel browser.
 *
 * `VITE_LOCAL_MODE` permette di forzare la modalità:
 *   VITE_LOCAL_MODE=true   -> locale anche con Supabase configurato
 *   VITE_LOCAL_MODE=false  -> Supabase anche in sviluppo (se configurato)
 *
 * In sviluppo il default resta locale, così non si toccano i dati cloud.
 * Senza configurazione Supabase la modalità locale è sempre attiva.
 */
const env = import.meta.env;

const forceLocal = env.VITE_LOCAL_MODE === 'true';
const forceCloud = env.VITE_LOCAL_MODE === 'false';

const supabaseConfigured = Boolean(
  (env.VITE_SUPABASE_URL || '').trim() && (env.VITE_SUPABASE_ANON_KEY || '').trim(),
);

/** Il database SQL remoto (Supabase) è attivo solo se configurato e abilitato. */
export const SUPABASE_MODE: boolean =
  supabaseConfigured && !forceLocal && (forceCloud || !env.DEV);
