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
import { MEMBER_SIGNATURE_PREFIX, classifySyncError, databaseRole, membersSignature } from './syncUtils';

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

export async function upsertRemoteProject(project: Project): Promise<void> {
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

  if (isOwner) {
    const { data, error } = await client
      .from('projects')
      .upsert(row, { onConflict: 'id' })
      .select('updated_at')
      .single();
    if (error) throw new Error(error.message);
    if (data?.updated_at) {
      await idbPut<SyncMeta>(STORE_SYNC_META, { projectId: project.id, updatedAt: data.updated_at });
    }
  } else {
    // Un collaboratore non può creare il progetto (né diventarne proprietario):
    // può solo aggiornare una riga già condivisa.
    const { data, error } = await client
      .from('projects')
      .update(row)
      .eq('id', project.id)
      .select('updated_at');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      throw new Error('Progetto non disponibile sul cloud.');
    }
    const updatedAt = (data[0] as { updated_at?: string } | undefined)?.updated_at;
    if (updatedAt) {
      await idbPut<SyncMeta>(STORE_SYNC_META, { projectId: project.id, updatedAt });
    }
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

  // Il ruolo nel database deve rispecchiare i permessi dell'interfaccia:
  // altrimenti un "viewer" potrebbe comunque scrivere via API.
  const roleFor = (email: string): 'editor' | 'viewer' => {
    const permissionKey = Object.keys(project.memberPermissions || {})
      .find((key) => key.toLowerCase() === email);
    const permission = permissionKey ? project.memberPermissions?.[permissionKey] : undefined;

    const collaboratorKey = Object.keys(project.collaborators || {})
      .find((key) => key.toLowerCase() === email);
    const collaboratorRole = collaboratorKey ? project.collaborators?.[collaboratorKey] : undefined;

    return databaseRole(permission, collaboratorRole);
  };

  const members = emails.map(email => ({ email, role: roleFor(email) }));
  const signature = membersSignature(members);

  // L'autosave non deve cancellare e reinserire i membri a ogni modifica:
  // lo fa solo quando condivisione o ruoli cambiano davvero.
  if (readMembersSignature(project.id) === signature) return;

  const { error: deleteError } = await client
    .from('project_members')
    .delete()
    .eq('project_id', project.id);
  if (deleteError) throw new Error(deleteError.message);

  if (members.length > 0) {
    const { error: insertError } = await client
      .from('project_members')
      .insert(members.map(member => ({ project_id: project.id, email: member.email, role: member.role })));
    if (insertError) throw new Error(insertError.message);
  }

  writeMembersSignature(project.id, signature);
}

export async function deleteRemoteProject(projectId: string): Promise<void> {
  const client = requireClient();
  const { error } = await client.from('projects').delete().eq('id', projectId);
  if (error) throw new Error(error.message);

  clearMembersSignature(projectId);
  await idbDelete(STORE_SYNC_META, projectId);
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
    try {
      if (entry.op === 'delete') {
        await deleteRemoteProject(entry.projectId);
      } else {
        const project = await idbGet<Project>(STORE_PROJECTS, entry.projectId);
        if (project) await upsertRemoteProject(project);
      }
      await idbDelete(STORE_SYNC_QUEUE, entry.projectId);
    } catch (error) {
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
  // Prima in locale (immediato e funziona offline)...
  await localProjects.saveProject(project);

  try {
    // ...poi sul database SQL.
    await upsertRemoteProject(project);
    await idbDelete(STORE_SYNC_QUEUE, project.id);
  } catch (error) {
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
