/**
 * Funzioni pure usate dalla sincronizzazione con Supabase.
 *
 * Sono separate dai servizi che usano IndexedDB/Storage per poter essere
 * testate senza browser.
 */

import type { MemberPermission } from '../types';

export interface MemberEntry {
  email: string;
  role: 'editor' | 'viewer';
}

/** Chiave localStorage con l'impronta dei membri già sincronizzati. */
export const MEMBER_SIGNATURE_PREFIX = 'stimia_members_sig_';

/**
 * Impronta stabile di elenco email + ruoli: permette di evitare di
 * cancellare e reinserire `project_members` a ogni autosave.
 */
export function membersSignature(members: MemberEntry[]): string {
  const payload = members
    .map(member => `${member.email.trim().toLowerCase()}:${member.role}`)
    .sort()
    .join('|');

  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Ruolo da salvare in `project_members`: il database conosce solo editor/viewer,
 * quindi anche i ruoli con permessi parziali di scrittura (SAL, prezzari, ditta)
 * devono poter aggiornare la riga.
 */
export function databaseRole(
  permission: MemberPermission | undefined,
  legacyRole?: 'editor' | 'viewer' | 'ditta',
): 'editor' | 'viewer' {
  if (permission) {
    const canEdit = permission.role === 'ditta'
      || permission.canWrite
      || permission.canEditSAL
      || permission.canEditPriceBooks;
    return canEdit ? 'editor' : 'viewer';
  }
  return legacyRole === 'editor' || legacyRole === 'ditta' ? 'editor' : 'viewer';
}

export type SyncErrorKind = 'permanent' | 'offline' | 'retry';

const PERMANENT_PATTERN =
  /row-level security|non disponibile sul cloud|violates row-level|42501/i;
const NETWORK_PATTERN =
  /failed to fetch|networkerror|network error|fetch failed|load failed|timed? ?out|enotfound|econn|offline/i;

/**
 * Classifica un errore di sincronizzazione:
 * - `permanent`: permessi o progetto rimosso, inutile riprovare;
 * - `offline`: rete assente, si riprova al prossimo giro senza consumare tentativi;
 * - `retry`: errore transitorio, si ritenta un numero limitato di volte.
 */
export function classifySyncError(message: string, online: boolean): SyncErrorKind {
  if (PERMANENT_PATTERN.test(message)) return 'permanent';
  if (!online || NETWORK_PATTERN.test(message)) return 'offline';
  return 'retry';
}
