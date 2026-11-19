import { Project } from '../types';
import { getCurrentUser } from './auth';
import {
  STORE_PROJECTS,
  STORE_SYNC_META,
  STORE_SYNC_QUEUE,
  idbDelete,
  idbDeleteMany,
  idbGet,
  idbGetAll,
  idbPut,
} from './idb';
import { supabase } from './supabase';
import * as localProjects from './localProjects';
import {
  MEMBER_SIGNATURE_PREFIX,
  SyncConflictError,
  classifySyncError,
  isSyncConflictError,
  membersSignature,
  normalizeOfferTree,
  projectMemberPermissions,
  projectSaveMode,
} from './syncUtils';
import type { DbMemberPermissions } from './syncUtils';
import { flushVersionQueue, saveProjectVersion } from './projectVersions';
import { clearSyncConflict, markSyncCompleted, recordSyncConflict } from './syncStatus';

/**
 * Archivio progetti su Supabase (Postgres).
 *
 * - I progetti vivono nella tabella `projects` (payload completo in jsonb,
 *   colonne indicizzate per query e RLS).
 * - La condivisione per email usa la tabella `project_members`.
 * - IndexedDB resta la cache locale: si può lavorare offline e le modifiche
 *   vengono inviate appena torna la connessione (coda persistente).
 */

interface ProjectRowMeta {
  id: string;
  owner_id: string;
  owner_email: string | null;
  name: string;
  last_modified: number | string | null;
  updated_at: string;
}

interface ProjectRow extends Omit<ProjectRowMeta, 'updated_at'> {
  payload: Project | null;
}

interface SyncMeta {
  projectId: string;
  updatedAt: string;
}

interface SyncQueueEntry {
  projectId: string;
  op: 'upsert' | 'delete';
  queuedAt: number;
  /** Tentativi già falliti, per non bloccare la coda all'infinito. */
  attempts?: number;
}

const MAX_SYNC_ATTEMPTS = 5;

const requireClient = () => {
  if (!supabase) throw new Error('Supabase non configurato.');
  return supabase;
};

const toProject = (row: ProjectRow): Project => {
  const base = (row.payload || {}) as Project;
  return {
    ...base,
    id: row.id,
    userId: row.owner_id,
    lastModified: Number(row.last_modified) || base.lastModified || 0,
  };
};

export async function fetchRemoteProjects(): Promise<Project[]> {
  const client = requireClient();
  const user = getCurrentUser();
  if (!user) throw new Error('Not authenticated');

  // Le policy RLS restituiscono solo i progetti dell'utente e quelli condivisi.
  // Prima si scaricano i soli metadati: i payload completi servono solo per i
  // progetti nuovi o modificati dall'ultima sincronizzazione.
  const { data: metaData, error } = await client
    .from('projects')
    .select('id, owner_id, owner_email, name, last_modified, updated_at')
    .order('last_modified', { ascending: false });

  if (error) throw new Error(error.message);

  const rows = (metaData as ProjectRowMeta[] | null) || [];
  const cached = await idbGetAll<Project>(STORE_PROJECTS);
  const cachedById = new Map(cached.map(project => [project.id, project]));
  const knownMeta = await idbGetAll<SyncMeta>(STORE_SYNC_META);
  const knownById = new Map(knownMeta.map(meta => [meta.projectId, meta]));

  const changedIds = rows
    .filter((row) => {
      const project = cachedById.get(row.id);
      if (!project) return true;

      const known = knownById.get(row.id);
      if (!known || known.updatedAt !== row.updated_at) return true;

      return Number(row.last_modified) > (project.lastModified || 0);
    })
    .map(row => row.id);

  const payloads = new Map<string, Project>();
  const CHUNK_SIZE = 40;

  for (let index = 0; index < changedIds.length; index += CHUNK_SIZE) {
    const chunk = changedIds.slice(index, index + CHUNK_SIZE);
    const { data, error: payloadError } = await client
      .from('projects')
      .select('id, owner_id, owner_email, name, last_modified, payload')
      .in('id', chunk);

    if (payloadError) throw new Error(payloadError.message);

    for (const row of (data as ProjectRow[] | null) || []) {
      payloads.set(row.id, toProject(row));
    }
  }

  const projects: Project[] = [];

  for (const row of rows) {
    const downloaded = payloads.get(row.id);
    const project = downloaded || cachedById.get(row.id);
    if (!project) continue;

    // Se il payload non è stato scaricato si usa la copia locale, allineando
    // comunque i metadati che possono essere cambiati sul server.
    const merged: Project = downloaded
      ? { ...downloaded, id: row.id, userId: row.owner_id }
      : {
          ...project,
          id: row.id,
          userId: row.owner_id,
          name: row.name || project.name,
          lastModified: Number(row.last_modified) || project.lastModified || 0,
        };

    projects.push(merged);

    if (downloaded) {
      await idbPut(STORE_PROJECTS, JSON.parse(JSON.stringify(downloaded)) as Project);
    }
    const previousMeta = knownById.get(row.id);
    if (!previousMeta || previousMeta.updatedAt !== row.updated_at) {
      await idbPut<SyncMeta>(STORE_SYNC_META, { projectId: row.id, updatedAt: row.updated_at });
    }
  }

  // Ripulisce i metadati di progetti non più visibili (eliminati o condivisione revocata).
  const remoteIds = new Set(rows.map(row => row.id));
  const staleIds = knownMeta
    .filter(meta => !remoteIds.has(meta.projectId))
    .map(meta => meta.projectId);
  if (staleIds.length > 0) {
    await idbDeleteMany(STORE_SYNC_META, staleIds);
  }

  return projects;
}

const signatureKey = (projectId: string) => `${MEMBER_SIGNATURE_PREFIX}${projectId}`;

/**
 * Ultima firma dei membri scritta con successo in questa sessione. Serve a non
 * ripetere delete/insert quando lo schema del database forza un fallback.
 */
let lastMembersSignature: string | null = null;

function readMembersSignature(projectId: string): string | null {
  try {
    return window.localStorage.getItem(signatureKey(projectId));
  } catch {
    return null;
  }
}

function writeMembersSignature(projectId: string, signature: string): void {
  try {
    window.localStorage.setItem(signatureKey(projectId), signature);
  } catch {
    /* localStorage non disponibile: si risincronizza al prossimo salvataggio */
  }
}

function clearMembersSignature(projectId: string): void {
  try {
    window.localStorage.removeItem(signatureKey(projectId));
  } catch {
    /* ignora */
  }
}

export async function upsertRemoteProject(
  project: Project,
  expectedUpdatedAt: string | null = null,
): Promise<void> {
  const client = requireClient();
  const user = getCurrentUser();
  if (!user) throw new Error('Not authenticated');

  const ownerId = project.userId || user.uid;
  const isOwner = ownerId === user.uid;

  const row: Record<string, unknown> = {
    id: project.id,
    name: project.name,
    last_modified: project.lastModified,
    payload: project,
  };
  // Solo il proprietario imposta owner_id/owner_email: un collaboratore non
  // deve poter cambiare proprietario né sovrascrivere l'email del titolare.
  if (isOwner) {
    row.owner_id = ownerId;
    row.owner_email = user.email || null;
  }

  const storeUpdatedAt = async (updatedAt?: string) => {
    if (!updatedAt) return;
    await idbPut<SyncMeta>(STORE_SYNC_META, { projectId: project.id, updatedAt });
  };

  if (isOwner) {
    if (expectedUpdatedAt) {
      const { data, error } = await client
        .from('projects')
        .update(row)
        .eq('id', project.id)
        .eq('updated_at', expectedUpdatedAt)
        .select('updated_at');
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) throw new SyncConflictError(project.id);
      await storeUpdatedAt((data[0] as { updated_at?: string } | undefined)?.updated_at);
    } else {
      const { data, error } = await client
        .from('projects')
        .insert(row)
        .select('updated_at')
        .single();
      if (error) {
        if (error.code === '23505') throw new SyncConflictError(project.id);
        throw new Error(error.message);
      }
      await storeUpdatedAt(data?.updated_at);
    }
  } else {
    // Un collaboratore non può creare il progetto: senza token si rischia di
    // sovrascrivere modifiche altrui.
    if (!expectedUpdatedAt) throw new SyncConflictError(project.id);

    const { data, error } = await client
      .from('projects')
      .update(row)
      .eq('id', project.id)
      .eq('updated_at', expectedUpdatedAt)
      .select('updated_at');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) throw new SyncConflictError(project.id);
    await storeUpdatedAt((data[0] as { updated_at?: string } | undefined)?.updated_at);
  }

  // I membri possono essere gestiti solo dal proprietario del progetto.
  if (!isOwner) return;

  const emails = Array.from(
    new Set(
      (project.sharedWithEmails || [])
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  );

  // Il ruolo e i permessi nel database devono rispecchiare l'interfaccia:
  // altrimenti un "viewer" potrebbe comunque scrivere via API.
  const members = emails.map(email => {
    const db = projectMemberPermissions(project, email);
    return {
      email,
      role: db.role,
      can_write: db.canWrite,
      can_edit_sal: db.canEditSAL,
      can_edit_price_books: db.canEditPriceBooks,
      can_edit_offer: db.canEditOffer,
    };
  });

  const signature = membersSignature(members.map(member => ({
    email: member.email,
    role: member.role,
    canWrite: member.can_write,
    canEditSAL: member.can_edit_sal,
    canEditPriceBooks: member.can_edit_price_books,
    canEditOffer: member.can_edit_offer,
  })));

  // L'autosave non deve cancellare e reinserire i membri a ogni modifica:
  // lo fa solo quando condivisione, ruoli o permessi cambiano davvero.
  const granularKey = `g:${signature}`;
  const storedSignature = readMembersSignature(project.id);
  if (storedSignature === granularKey) return;
  // Evita delete/insert ripetuti nella stessa sessione quando il database non
  // accetta lo schema completo (fallback legacy).
  if (lastMembersSignature === signature) return;

  const { error: deleteError } = await client
    .from('project_members')
    .delete()
    .eq('project_id', project.id);
  if (deleteError) throw new Error(deleteError.message);

  if (members.length > 0) {
    const { error: insertError } = await client
      .from('project_members')
      .insert(members.map(member => ({ project_id: project.id, ...member })));

    if (insertError) {
      // Compatibilità con un database non ancora migrato: memorizza una firma
      // "legacy" per evitare di ripetere delete/insert a ogni autosave.
      // Al prossimo avvio si riproverà con lo schema completo.
      const missingColumns = /can_write|can_edit_sal|can_edit_price_books|can_edit_offer/i.test(insertError.message)
        && /does not exist|schema cache|column/i.test(insertError.message);

      if (!missingColumns) throw new Error(insertError.message);

      // Caso intermedio: manca solo `can_edit_offer`. Conserva gli altri
      // permessi granulari, così un utente SAL/prezzari non diventa scrittore
      // completo per effetto del fallback.
      const { error: withoutOfferError } = await client
        .from('project_members')
        .insert(members.map(member => ({
          project_id: project.id,
          email: member.email,
          role: member.role,
          can_write: member.can_write,
          can_edit_sal: member.can_edit_sal,
          can_edit_price_books: member.can_edit_price_books,
        })));

      if (!withoutOfferError) {
        lastMembersSignature = signature;
        writeMembersSignature(project.id, `l:${signature}`);
        return;
      }

      const stillMissingGranularColumns = /can_write|can_edit_sal|can_edit_price_books/i.test(withoutOfferError.message)
        && /does not exist|schema cache|column/i.test(withoutOfferError.message);
      if (!stillMissingGranularColumns) throw new Error(withoutOfferError.message);

      // Schema solo ruoli: senza colonne granulari l'unico ruolo sicuro per
      // ditta e permessi parziali è viewer. Solo `can_write` resta editor.
      const { error: legacyError } = await client
        .from('project_members')
        .insert(members.map(member => ({
          project_id: project.id,
          email: member.email,
          role: member.can_write ? 'editor' : 'viewer',
        })));
      if (legacyError) throw new Error(legacyError.message);

      lastMembersSignature = signature;
      writeMembersSignature(project.id, `l:${signature}`);
      return;
    }
  }

  lastMembersSignature = signature;
  writeMembersSignature(project.id, granularKey);
}

export async function deleteRemoteProject(projectId: string): Promise<void> {
  const client = requireClient();
  const { error } = await client.from('projects').delete().eq('id', projectId);
  if (error) throw new Error(error.message);

  clearMembersSignature(projectId);
  await idbDelete(STORE_SYNC_META, projectId);
  await clearSyncConflict(projectId);
}

const isMissingFunctionError = (
  error: { code?: string; message?: string } | null,
  functionName: string,
): boolean =>
  Boolean(error && (error.code === 'PGRST202' || new RegExp(functionName, 'i').test(error.message || '')));

const isMissingRpcError = (error: { code?: string; message?: string } | null): boolean =>
  isMissingFunctionError(error, 'save_project_parts');

/**
 * Aggiorna solo le parti consentite (SAL e/o prezzari) tramite RPC.
 * Il database controlla i permessi e non sovrascrive il resto del progetto.
 */
async function saveRestrictedParts(
  project: Project,
  permissions: DbMemberPermissions,
  expectedUpdatedAt: string | null,
): Promise<void> {
  const client = requireClient();
  const sals = permissions.canEditSAL ? (project.sals ?? null) : null;
  const priceBooks = permissions.canEditPriceBooks ? (project.priceBooks ?? null) : null;

  if (sals === null && priceBooks === null) {
    // Nessuna delle parti che questo utente può modificare è cambiata.
    return;
  }

  const baseArgs = {
    p_project_id: project.id,
    p_sals: sals,
    p_price_books: priceBooks,
  };

  let data: unknown;
  let error: { code?: string; message?: string } | null = null;

  const v2 = await client.rpc('save_project_parts_v2', {
    ...baseArgs,
    p_expected_updated_at: expectedUpdatedAt,
  });
  data = v2.data;
  error = v2.error;

  if (error && isMissingRpcError(error)) {
    // Database non ancora migrato alla v2: usa la v1 senza controllo versione.
    const v1 = await client.rpc('save_project_parts', baseArgs);
    data = v1.data;
    error = v1.error;
  }

  if (error) {
    if (error.code === '40001' || /conflitto di sincronizzazione/i.test(error.message || '')) {
      throw new SyncConflictError(project.id);
    }

    if (isMissingRpcError(error)) {
      // Distingue "database non migrato" (nessuna colonna granulare) da una
      // semplice cache PostgREST non aggiornata: nel secondo caso si ritenta.
      const { error: columnsError } = await client
        .from('project_members')
        .select('can_write')
        .eq('project_id', project.id)
        .limit(1);

      if (!columnsError) {
        throw new Error('Funzione di salvataggio in aggiornamento. Riprova tra poco.');
      }

      // Database non ancora migrato: il vecchio ruolo "editor" permette ancora
      // l'aggiornamento completo. Si continua a funzionare fino alla migrazione.
      await upsertRemoteProject(project, expectedUpdatedAt);
      return;
    }

    throw new Error(error.message);
  }

  const updatedAt = typeof data === 'string'
    ? data
    : (data as { updated_at?: string } | null)?.updated_at;
  if (updatedAt) {
    await idbPut<SyncMeta>(STORE_SYNC_META, { projectId: project.id, updatedAt });
  }
}

/**
 * Salva il progetto sul cloud scegliendo il percorso consentito: aggiornamento
 * completo per proprietario/editor, RPC dedicata per chi può modificare solo
 * SAL o prezzari.
 */
export async function saveRemoteProject(
  project: Project,
  expectedUpdatedAt: string | null = null,
): Promise<void> {
  const user = getCurrentUser();
  if (!user) throw new Error('Not authenticated');

  const mode = projectSaveMode(project, user.uid, user.email);

  if (mode === 'full') {
    await upsertRemoteProject(project, expectedUpdatedAt);
    return;
  }

  if (mode === 'parts') {
    await saveRestrictedParts(
      project,
      projectMemberPermissions(project, user.email),
      expectedUpdatedAt,
    );
    return;
  }

  if (mode === 'offer') {
    await saveOfferProject(project, expectedUpdatedAt);
    return;
  }

  throw new Error('Permessi insufficienti per salvare il progetto.');
}

async function saveOfferProject(
  project: Project,
  expectedUpdatedAt: string | null,
): Promise<void> {
  const client = requireClient();

  const { data, error } = await client.rpc('save_project_offer', {
    p_project_id: project.id,
    p_offer_tree: normalizeOfferTree(project.rootWBS),
    p_contractor_details: project.contractorDetails ?? null,
    p_expected_updated_at: expectedUpdatedAt,
  });

  if (error) {
    if (error.code === '40001' || /conflitto di sincronizzazione/i.test(error.message || '')) {
      throw new SyncConflictError(project.id);
    }

    if (isMissingFunctionError(error, 'save_project_offer')) {
      // Senza la RPC dedicata non è possibile salvare la sola offerta: un
      // fallback a scrittura completa concederebbe alla ditta l'intero computo.
      throw new Error('Salvataggio offerta in aggiornamento. Riprova dopo l’aggiornamento del database.');
    }

    throw new Error(error.message);
  }

  const updatedAt = typeof data === 'string'
    ? data
    : (data as { updated_at?: string } | null)?.updated_at;
  if (updatedAt) {
    await idbPut<SyncMeta>(STORE_SYNC_META, { projectId: project.id, updatedAt });
  }
}

async function handleSyncConflict(project: Project): Promise<void> {
  await recordSyncConflict(project.id);
  try {
    // Conserva comunque la modifica locale nella cronologia.
    await saveProjectVersion(project, 'Conflitto locale', true);
  } catch (error) {
    console.warn('Versione locale di conflitto non salvata:', error);
  }
}

/** Usa l'ultima versione cloud come base e sovrascrive il progetto. */
export async function forceSaveProject(project: Project): Promise<void> {
  const client = requireClient();
  const { data, error } = await client
    .from('projects')
    .select('updated_at')
    .eq('id', project.id)
    .maybeSingle();

  if (error) throw new Error(error.message);

  const latest = (data as { updated_at?: string } | null)?.updated_at ?? null;
  await saveRemoteProject(project, latest);
  await clearSyncConflict(project.id);
  markSyncCompleted();
}

/** Scarica il progetto aggiornato dal cloud e aggiorna la cache locale. */
export async function fetchRemoteProject(projectId: string): Promise<Project | null> {
  const client = requireClient();
  const { data, error } = await client
    .from('projects')
    .select('id, owner_id, owner_email, name, last_modified, updated_at, payload')
    .eq('id', projectId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  const row = data as ProjectRow & { updated_at?: string };
  const project = toProject(row);
  await idbPut(STORE_PROJECTS, JSON.parse(JSON.stringify(project)) as Project);
  if (row.updated_at) {
    await idbPut<SyncMeta>(STORE_SYNC_META, { projectId, updatedAt: row.updated_at });
  }
  return project;
}

export async function enqueueSync(projectId: string, op: 'upsert' | 'delete'): Promise<void> {
  // Una nuova modifica riparte da zero con i tentativi: il dato è aggiornato.
  const entry: SyncQueueEntry = { projectId, op, queuedAt: Date.now(), attempts: 0 };
  await idbPut(STORE_SYNC_QUEUE, entry);
}

/** Invia le modifiche rimaste in coda (dopo un periodo offline). */
export async function flushSyncQueue(): Promise<void> {
  if (!supabase) return;

  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  const entries = await idbGetAll<SyncQueueEntry>(STORE_SYNC_QUEUE);

  for (const entry of entries) {
    let project: Project | undefined;
    try {
      if (entry.op === 'delete') {
        await deleteRemoteProject(entry.projectId);
      } else {
        project = await idbGet<Project>(STORE_PROJECTS, entry.projectId);
        if (project) {
          const expected = (await idbGet<SyncMeta>(STORE_SYNC_META, entry.projectId))?.updatedAt ?? null;
          await saveRemoteProject(project, expected);
        }
      }
      await idbDelete(STORE_SYNC_QUEUE, entry.projectId);
      markSyncCompleted();
    } catch (error) {
      if (isSyncConflictError(error) && project) {
        await handleSyncConflict(project);
        await idbDelete(STORE_SYNC_QUEUE, entry.projectId);
        continue;
      }

      const message = error instanceof Error ? error.message : String(error);
      const kind = classifySyncError(message, online);

      if (kind === 'permanent') {
        // Errore non recuperabile (permessi o progetto rimosso/condivisione
        // revocata): non ha senso riprovare a ogni avvio.
        console.warn('Sincronizzazione annullata:', entry.projectId, message);
        await idbDelete(STORE_SYNC_QUEUE, entry.projectId);
        continue;
      }

      if (kind === 'offline') {
        // Rete assente: si riprova al prossimo giro senza consumare tentativi.
        console.warn('Sincronizzazione rimandata:', error);
        break;
      }

      const attempts = (entry.attempts || 0) + 1;
      if (attempts >= MAX_SYNC_ATTEMPTS) {
        // Una singola voce "avvelenata" non deve bloccare gli altri progetti.
        console.warn('Sincronizzazione abbandonata dopo troppi tentativi:', entry.projectId, message);
        await idbDelete(STORE_SYNC_QUEUE, entry.projectId);
        continue;
      }

      await idbPut<SyncQueueEntry>(STORE_SYNC_QUEUE, { ...entry, attempts });
      console.warn(`Sincronizzazione rimandata (tentativo ${attempts}/${MAX_SYNC_ATTEMPTS}):`, error);
    }
  }

  await flushVersionQueue().catch(() => undefined);
}

export async function getProjectsWithCache(): Promise<{ data: Project[]; error: any }> {
  const user = getCurrentUser();
  if (!user) return { data: [], error: 'Not authenticated' };

  await flushSyncQueue();

  try {
    const remote = await fetchRemoteProjects();

    // Primo collegamento al cloud: se il database è vuoto, carica i progetti
    // che esistono già in locale (una sola volta per utente).
    const migrationKey = `stimia_cloud_migrated_${user.uid}`;
    const alreadyMigrated = typeof window !== 'undefined'
      && window.localStorage.getItem(migrationKey) === '1';

    if (remote.length === 0 && !alreadyMigrated) {
      const cached = await localProjects.getProjects();
      if (cached.data.length === 0) {
        if (typeof window !== 'undefined') window.localStorage.setItem(migrationKey, '1');
      } else {
        const migrated: Project[] = [];
        let failed = false;
        for (const project of cached.data) {
          try {
            const clone = {
              ...(JSON.parse(JSON.stringify(project)) as Project),
              userId: user.uid,
            };
            await upsertRemoteProject(clone);
            await idbPut(STORE_PROJECTS, clone);
            migrated.push(clone);
          } catch (migrationError) {
            failed = true;
            console.warn('Migrazione progetto non riuscita:', project.id, migrationError);
          }
        }
        if (!failed) {
          if (typeof window !== 'undefined') window.localStorage.setItem(migrationKey, '1');
        }
        if (migrated.length > 0) {
          return { data: migrated, error: null };
        }
      }
    }

    return { data: remote, error: null };
  } catch (error) {
    console.warn('Database cloud non raggiungibile, uso la cache locale.', error);
    const cached = await localProjects.getProjects();
    return { data: cached.data, error: null };
  }
}

export async function saveProjectWithCache(project: Project): Promise<void> {
  const expected = (await idbGet<SyncMeta>(STORE_SYNC_META, project.id))?.updatedAt ?? null;

  // Prima in locale (immediato e funziona offline)...
  await localProjects.saveProject(project);

  try {
    // ...poi sul database SQL.
    await saveRemoteProject(project, expected);
    await idbDelete(STORE_SYNC_QUEUE, project.id);
    markSyncCompleted();
  } catch (error) {
    if (isSyncConflictError(error)) {
      await handleSyncConflict(project);
      return;
    }
    console.warn('Salvataggio sul cloud rimandato:', error);
    await enqueueSync(project.id, 'upsert');
  }
}

export async function deleteProjectWithCache(projectId: string): Promise<void> {
  await localProjects.deleteProject(projectId);

  try {
    await deleteRemoteProject(projectId);
    await idbDelete(STORE_SYNC_QUEUE, projectId);
  } catch (error) {
    console.warn('Cancellazione sul cloud rimandata:', error);
    await enqueueSync(projectId, 'delete');
  }
}
