import { Project, WBSNode } from '../types';
import {
  STORE_VERSION_META,
  STORE_VERSION_SYNC_QUEUE,
  STORE_VERSIONS,
  idbDelete,
  idbDeleteMany,
  idbGet,
  idbGetAll,
  idbGetAllByIndex,
  idbPut,
} from './idb';
import { supabase } from './supabase';
import { classifySyncError } from './syncUtils';
import { notifySyncStatus } from './syncStatus';

export interface ProjectVersion {
  id: string;
  projectId: string;
  createdAt: number;
  reason: string;
  hash: string;
  /** Presente per le versioni locali; per quelle cloud viene caricato al ripristino. */
  snapshot?: Project;
  stats: {
    categories: number;
    items: number;
    total: number;
  };
}

/**
 * Metadati dell'ultima versione, separati dagli snapshot.
 * Evita di rileggere da IndexedDB tutti i progetti salvati ogni volta che
 * si controlla se creare uno snapshot automatico.
 */
interface VersionMeta {
  projectId: string;
  hash: string;
  createdAt: number;
  /** Id delle versioni conservate, dalla più recente alla più vecchia. */
  ids: string[];
}

interface VersionSyncEntry {
  id: string;
  action: 'upsert' | 'delete';
  attempts?: number;
}

interface RemoteVersionRow {
  id: string;
  project_id: string;
  created_at: string;
  reason: string | null;
  hash: string | null;
  stats: ProjectVersion['stats'] | null;
}

const MAX_VERSIONS_PER_PROJECT = 20;
const AUTO_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const MAX_SYNC_ATTEMPTS = 5;
/** null = non verificato; false = tabella project_versions non ancora migrata. */
let cloudVersionsAvailable: boolean | null = null;

const isMissingVersionTableError = (message: string): boolean =>
  /project_versions/i.test(message)
  && /does not exist|not find the table|schema cache/i.test(message);

const makeId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `ver_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

const cloneProject = (project: Project): Project =>
  JSON.parse(JSON.stringify(project)) as Project;

const statsFor = (root: WBSNode) => {
  let categories = 0;
  let items = 0;
  let total = 0;
  const walk = (node: WBSNode) => {
    if (node.level > 0) categories += 1;
    items += node.items.length;
    total += node.items.reduce((sum, item) => sum + (item.amount || 0), 0);
    node.children.forEach(walk);
  };
  walk(root);
  return { categories, items, total };
};

// Impronta stabile: esclude i campi che cambiano a ogni salvataggio.
const fingerprint = (project: Project): string => {
  const payload = JSON.stringify({
    name: project.name,
    description: project.description,
    rootWBS: project.rootWBS,
    sals: project.sals || [],
    priceBooks: project.priceBooks || [],
    offers: project.offers || [],
    offerComparisonSettings: project.offerComparisonSettings || null,
    schedule: project.schedule || null,
    variants: project.variants || [],
    contractorDetails: project.contractorDetails || null,
    quadroEconomico: project.quadroEconomico || null,
    cloudFolderUrl: project.cloudFolderUrl || '',
    companyLogo: project.companyLogo || '',
    rfqRequests: project.rfqRequests || [],
    suppliers: project.suppliers || [],
    signatures: project.signatures || [],
    invoiceSettings: project.invoiceSettings || null,
  });

  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
};

const mapRemoteVersion = (row: RemoteVersionRow): ProjectVersion => ({
  id: row.id,
  projectId: row.project_id,
  createdAt: Date.parse(row.created_at) || Date.now(),
  reason: row.reason || 'Automatica',
  hash: row.hash || '',
  stats: row.stats || { categories: 0, items: 0, total: 0 },
});

async function uploadVersion(version: ProjectVersion): Promise<void> {
  if (!supabase || !version.snapshot || cloudVersionsAvailable === false) return;

  const { error } = await supabase.from('project_versions').upsert({
    id: version.id,
    project_id: version.projectId,
    created_at: new Date(version.createdAt).toISOString(),
    reason: version.reason,
    hash: version.hash,
    stats: version.stats,
    snapshot: version.snapshot,
  });

  if (error) {
    if (isMissingVersionTableError(error.message)) {
      cloudVersionsAvailable = false;
    }
    throw new Error(error.message);
  }

  cloudVersionsAvailable = true;
}

async function enqueueVersionSync(id: string, action: 'upsert' | 'delete'): Promise<void> {
  const existing = await idbGet<VersionSyncEntry>(STORE_VERSION_SYNC_QUEUE, id);
  await idbPut<VersionSyncEntry>(STORE_VERSION_SYNC_QUEUE, {
    id,
    action,
    attempts: existing?.attempts ?? 0,
  });
  notifySyncStatus();
}

/** Riprova le versioni rimaste in coda (creazioni/cancellazioni offline). */
export async function flushVersionQueue(): Promise<void> {
  if (!supabase || cloudVersionsAvailable === false) return;

  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  const entries = await idbGetAll<VersionSyncEntry>(STORE_VERSION_SYNC_QUEUE);

  for (const entry of entries) {
    try {
      if (entry.action === 'delete') {
        const { error } = await supabase.from('project_versions').delete().eq('id', entry.id);
        if (error) throw new Error(error.message);
      } else {
        const version = await idbGet<ProjectVersion>(STORE_VERSIONS, entry.id);
        if (version?.snapshot) await uploadVersion(version);
      }
      await idbDelete(STORE_VERSION_SYNC_QUEUE, entry.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isMissingVersionTableError(message)) {
        cloudVersionsAvailable = false;
        break;
      }
      const kind = classifySyncError(message, online);

      if (kind === 'permanent') {
        console.warn('Versione non sincronizzata:', entry.id, message);
        await idbDelete(STORE_VERSION_SYNC_QUEUE, entry.id);
        continue;
      }

      if (kind === 'offline') {
        break;
      }

      const attempts = (entry.attempts || 0) + 1;
      if (attempts >= MAX_SYNC_ATTEMPTS) {
        console.warn('Versione abbandonata dopo troppi tentativi:', entry.id, message);
        await idbDelete(STORE_VERSION_SYNC_QUEUE, entry.id);
        continue;
      }

      await idbPut<VersionSyncEntry>(STORE_VERSION_SYNC_QUEUE, { ...entry, attempts });
    }
  }

  notifySyncStatus();
}

export async function listProjectVersions(projectId: string): Promise<ProjectVersion[]> {
  await flushVersionQueue().catch(() => undefined);

  const local = await idbGetAllByIndex<ProjectVersion>(STORE_VERSIONS, 'projectId', projectId);
  const merged = new Map<string, ProjectVersion>(local.map(version => [version.id, version]));

  if (supabase && cloudVersionsAvailable !== false) {
    try {
      const { data, error } = await supabase
        .from('project_versions')
        .select('id, project_id, created_at, reason, hash, stats')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false })
        .limit(MAX_VERSIONS_PER_PROJECT);

      if (error) throw new Error(error.message);

      for (const row of (data as RemoteVersionRow[] | null) || []) {
        const version = mapRemoteVersion(row);
        if (!merged.has(version.id)) {
          merged.set(version.id, version);
          await idbPut(STORE_VERSIONS, version);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isMissingVersionTableError(message)) {
        cloudVersionsAvailable = false;
      }
      console.warn('Cronologia cloud non disponibile, uso la cache locale:', error);
    }
  }

  const versions = Array.from(merged.values())
    .sort((a, b) => b.createdAt - a.createdAt);

  if (versions.length > MAX_VERSIONS_PER_PROJECT) {
    const excess = versions.slice(MAX_VERSIONS_PER_PROJECT);
    await idbDeleteMany(STORE_VERSIONS, excess.map(item => item.id));
    return versions.slice(0, MAX_VERSIONS_PER_PROJECT);
  }

  return versions;
}

export async function saveProjectVersion(
  project: Project,
  reason = 'Automatica',
  force = false
): Promise<ProjectVersion | null> {
  const hash = fingerprint(project);
  const now = Date.now();

  let meta = await idbGet<VersionMeta>(STORE_VERSION_META, project.id);

  if (!meta) {
    // Primo uso dopo l'aggiornamento: ricostruisce i metadati una sola volta
    // leggendo la cronologia esistente.
    const versions = await listProjectVersions(project.id);
    const latest = versions[0];
    meta = {
      projectId: project.id,
      hash: latest?.hash || '',
      createdAt: latest?.createdAt || 0,
      ids: versions.map(item => item.id),
    };
  }

  if (!force) {
    if (meta.hash === hash) return null;
    if (meta.createdAt && now - meta.createdAt < AUTO_SNAPSHOT_INTERVAL_MS) return null;
  }

  const version: ProjectVersion = {
    id: makeId(),
    projectId: project.id,
    createdAt: now,
    reason,
    hash,
    snapshot: cloneProject(project),
    stats: statsFor(project.rootWBS),
  };

  await idbPut(STORE_VERSIONS, version);

  const ids = [version.id, ...meta.ids.filter(id => id !== version.id)]
    .slice(0, MAX_VERSIONS_PER_PROJECT);
  const removed = meta.ids.filter(id => !ids.includes(id));
  if (removed.length > 0) {
    await idbDeleteMany(STORE_VERSIONS, removed);
  }

  await idbPut<VersionMeta>(STORE_VERSION_META, {
    projectId: project.id,
    hash,
    createdAt: now,
    ids,
  });

  try {
    await uploadVersion(version);
  } catch (error) {
    if (cloudVersionsAvailable !== false) {
      console.warn('Versione salvata solo in locale:', error);
      await enqueueVersionSync(version.id, 'upsert');
    }
  }

  return version;
}

export async function restoreProjectVersion(version: ProjectVersion): Promise<Project> {
  if (version.snapshot) {
    return cloneProject(version.snapshot);
  }

  if (!supabase) {
    throw new Error('Questa versione non è disponibile offline.');
  }

  const { data, error } = await supabase
    .from('project_versions')
    .select('snapshot')
    .eq('id', version.id)
    .single();

  if (error || !data?.snapshot) {
    throw new Error(error?.message || 'Snapshot della versione non disponibile.');
  }

  const snapshot = typeof data.snapshot === 'string'
    ? JSON.parse(data.snapshot) as Project
    : data.snapshot as Project;

  await idbPut(STORE_VERSIONS, { ...version, snapshot });
  return cloneProject(snapshot);
}

export async function deleteProjectVersions(projectId: string): Promise<void> {
  const meta = await idbGet<VersionMeta>(STORE_VERSION_META, projectId);
  const versions = meta?.ids.length
    ? null
    : await idbGetAllByIndex<ProjectVersion>(STORE_VERSIONS, 'projectId', projectId);
  const ids = meta?.ids.length ? meta.ids : (versions || []).map(item => item.id);

  if (ids.length > 0) {
    await idbDeleteMany(STORE_VERSIONS, ids);
  }
  await idbDelete(STORE_VERSION_META, projectId);

  if (supabase && cloudVersionsAvailable !== false) {
    try {
      const { error } = await supabase.from('project_versions').delete().eq('project_id', projectId);
      if (error) throw new Error(error.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isMissingVersionTableError(message)) {
        cloudVersionsAvailable = false;
      } else {
        console.warn('Versioni cloud non rimosse:', error);
        for (const id of ids) {
          await enqueueVersionSync(id, 'delete');
        }
      }
    }
  }
}

export async function deleteProjectVersion(projectId: string, id: string): Promise<void> {
  await idbDelete(STORE_VERSIONS, id);

  const meta = await idbGet<VersionMeta>(STORE_VERSION_META, projectId);
  if (meta) {
    const wasLatest = meta.ids[0] === id;
    await idbPut<VersionMeta>(STORE_VERSION_META, {
      ...meta,
      ids: meta.ids.filter(item => item !== id),
      // Se è stata eliminata la versione più recente, il prossimo salvataggio
      // deve crearne una nuova invece di confrontarsi con un'impronta sparita.
      ...(wasLatest ? { hash: '', createdAt: 0 } : {}),
    });
  }

  if (supabase && cloudVersionsAvailable !== false) {
    try {
      const { error } = await supabase.from('project_versions').delete().eq('id', id);
      if (error) throw new Error(error.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isMissingVersionTableError(message)) {
        cloudVersionsAvailable = false;
      } else {
        console.warn('Versione cloud non rimossa:', error);
        await enqueueVersionSync(id, 'delete');
      }
    }
  }
}

/** Accoda una versione importata da un backup per l'invio al cloud. */
export async function queueVersionUpload(id: string): Promise<void> {
  await enqueueVersionSync(id, 'upsert');
}
