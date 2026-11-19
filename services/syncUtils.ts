/**
 * Funzioni pure usate dalla sincronizzazione con Supabase.
 *
 * Sono separate dai servizi che usano IndexedDB/Storage per poter essere
 * testate senza browser.
 */

import type { CostItem, MemberPermission, Project, WBSNode } from '../types';

export interface MemberEntry {
  email: string;
  role: 'editor' | 'viewer';
  canWrite?: boolean;
  canEditSAL?: boolean;
  canEditPriceBooks?: boolean;
  canEditOffer?: boolean;
}

export interface DbMemberPermissions {
  role: 'editor' | 'viewer';
  canWrite: boolean;
  canEditSAL: boolean;
  canEditPriceBooks: boolean;
  canEditOffer: boolean;
}

/** Chiave localStorage con l'impronta dei membri già sincronizzati. */
export const MEMBER_SIGNATURE_PREFIX = 'stimia_members_sig_';

/**
 * Impronta stabile di elenco email + ruoli + permessi granulari: permette di
 * evitare di cancellare e reinserire `project_members` a ogni autosave.
 */
export function membersSignature(members: MemberEntry[]): string {
  const payload = members
    .map(member => [
      member.email.trim().toLowerCase(),
      member.role,
      member.canWrite ? '1' : '0',
      member.canEditSAL ? '1' : '0',
      member.canEditPriceBooks ? '1' : '0',
      member.canEditOffer ? '1' : '0',
    ].join(':'))
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
 * Permessi da salvare in `project_members`.
 *
 * La ditta ha bisogno di aggiornare la propria offerta; il database non ha un
 * ruolo dedicato, quindi viene trattata come editor (la UI limita i campi).
 */
export function memberDbPermissions(
  permission: MemberPermission | undefined,
  legacyRole?: 'editor' | 'viewer' | 'ditta',
): DbMemberPermissions {
  if (permission) {
    if (permission.role === 'ditta') {
      return { role: 'editor', canWrite: false, canEditSAL: false, canEditPriceBooks: false, canEditOffer: true };
    }

    const canEditSAL = Boolean(permission.canEditSAL);
    const canEditPriceBooks = Boolean(permission.canEditPriceBooks);
    const canWrite = Boolean(permission.canWrite);
    return {
      role: canWrite || canEditSAL || canEditPriceBooks ? 'editor' : 'viewer',
      canWrite,
      canEditSAL,
      canEditPriceBooks,
      canEditOffer: false,
    };
  }

  if (legacyRole === 'ditta') {
    return { role: 'editor', canWrite: false, canEditSAL: false, canEditPriceBooks: false, canEditOffer: true };
  }

  const isLegacyEditor = legacyRole === 'editor';
  return {
    role: isLegacyEditor ? 'editor' : 'viewer',
    canWrite: isLegacyEditor,
    canEditSAL: isLegacyEditor,
    canEditPriceBooks: isLegacyEditor,
    canEditOffer: false,
  };
}

/** Ruolo sintetico usato dalle policy esistenti (editor/viewer). */
export function databaseRole(
  permission: MemberPermission | undefined,
  legacyRole?: 'editor' | 'viewer' | 'ditta',
): 'editor' | 'viewer' {
  return memberDbPermissions(permission, legacyRole).role;
}

/** Permessi effettivi di un'email sul progetto (dai dati salvati nel payload). */
export function projectMemberPermissions(project: Project, email: string): DbMemberPermissions {
  const normalized = email.trim().toLowerCase();
  const permissionKey = Object.keys(project.memberPermissions || {})
    .find(key => key.toLowerCase() === normalized);
  const permission = permissionKey ? project.memberPermissions?.[permissionKey] : undefined;

  const collaboratorKey = Object.keys(project.collaborators || {})
    .find(key => key.toLowerCase() === normalized);
  const collaboratorRole = collaboratorKey ? project.collaborators?.[collaboratorKey] : undefined;

  return memberDbPermissions(permission, collaboratorRole);
}

export type ProjectSaveMode = 'full' | 'parts' | 'offer' | 'viewer';

/**
 * Decide come salvare il progetto: completo (proprietario/editor), solo parti
 * consentite (SAL/prezzari) oppure nessun salvataggio.
 */
export function projectSaveMode(project: Project, userId: string, email: string): ProjectSaveMode {
  const normalized = email.trim().toLowerCase();
  const isOwner = project.userId
    ? project.userId === userId
    : (project.createdBy || '').trim().toLowerCase() === normalized;
  if (isOwner) return 'full';

  const hasPermissionEntry = Object.keys(project.memberPermissions || {})
    .some(key => key.toLowerCase() === normalized)
    || Object.keys(project.collaborators || {})
      .some(key => key.toLowerCase() === normalized);

  // Progetto legacy senza permessi nel payload: prova il salvataggio completo,
  // sarà il database a decidere (policy RLS).
  if (!hasPermissionEntry) return 'full';

  const permissions = projectMemberPermissions(project, normalized);
  if (permissions.canWrite) return 'full';
  if (permissions.canEditOffer) return 'offer';
  if (permissions.canEditSAL || permissions.canEditPriceBooks) return 'parts';
  return 'viewer';
}

/**
 * Rende espliciti i campi offerta prima della RPC ditta: `null` significa
 * "campo cancellato". Senza questo, JSON omette i campi vuoti e il server
 * manterrebbe il vecchio valore.
 */
export function normalizeOfferTree(node: WBSNode): WBSNode {
  const normalizeItem = (item: CostItem) => ({
    ...item,
    offerPrice: item.offerPrice ?? null,
    offerMaterialPrice: item.offerMaterialPrice ?? null,
    offerLaborPrice: item.offerLaborPrice ?? null,
    offerDays: item.offerDays ?? null,
    offerNotes: item.offerNotes ?? null,
  });

  return {
    ...node,
    items: node.items.map(normalizeItem),
    children: node.children.map(normalizeOfferTree),
  } as unknown as WBSNode;
}

export type SyncErrorKind = 'permanent' | 'offline' | 'retry';

/** Evento emesso quando un salvataggio è stato rifiutato per concorrenza. */
export const SYNC_CONFLICT_EVENT = 'stimia:sync-conflict';

export class SyncConflictError extends Error {
  readonly projectId: string;

  constructor(projectId: string) {
    super('Conflitto di sincronizzazione');
    this.name = 'SyncConflictError';
    this.projectId = projectId;
  }
}

export function isSyncConflictError(error: unknown): error is SyncConflictError {
  return error instanceof SyncConflictError
    || (error instanceof Error && /conflitto di sincronizzazione/i.test(error.message));
}

const PERMANENT_PATTERN =
  /row-level security|non disponibile sul cloud|violates row-level|42501|permessi insufficienti|foreign key/i;
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
