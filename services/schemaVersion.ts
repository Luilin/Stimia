import { supabase } from './supabase';

/** Versione minima dello schema attesa dal client. */
export const EXPECTED_SCHEMA_VERSION = 5;

/**
 * Legge la versione dello schema dal database.
 * Restituisce null se la funzione non esiste (migrazione non applicata) o se
 * il database non è raggiungibile.
 */
export async function getRemoteSchemaVersion(): Promise<number | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.rpc('stimia_schema_version');
    if (error) return null;
    return typeof data === 'number' ? data : null;
  } catch {
    return null;
  }
}
