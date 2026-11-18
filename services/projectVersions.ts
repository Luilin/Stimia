import { Project, WBSNode } from '../types';
import {
  STORE_VERSION_META,
  STORE_VERSIONS,
  idbDelete,
  idbDeleteMany,
  idbGet,
  idbGetAllByIndex,
  idbPut,
} from './idb';

export interface ProjectVersion {
  id: string;
  projectId: string;
  createdAt: number;
  reason: string;
  hash: string;
  snapshot: Project;
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

const MAX_VERSIONS_PER_PROJECT = 20;
const AUTO_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

const makeId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `ver_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

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

export async function listProjectVersions(projectId: string): Promise<ProjectVersion[]> {
  const versions = await idbGetAllByIndex<ProjectVersion>(STORE_VERSIONS, 'projectId', projectId);
  return versions.sort((a, b) => b.createdAt - a.createdAt);
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
    snapshot: JSON.parse(JSON.stringify(project)) as Project,
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

  return version;
}

export async function restoreProjectVersion(version: ProjectVersion): Promise<Project> {
  return JSON.parse(JSON.stringify(version.snapshot)) as Project;
}

export async function deleteProjectVersions(projectId: string): Promise<void> {
  const meta = await idbGet<VersionMeta>(STORE_VERSION_META, projectId);
  if (meta && meta.ids.length > 0) {
    // Gli id sono nei metadati: non serve caricare gli snapshot completi.
    await idbDeleteMany(STORE_VERSIONS, meta.ids);
  } else {
    const versions = await listProjectVersions(projectId);
    await idbDeleteMany(STORE_VERSIONS, versions.map(item => item.id));
  }
  await idbDelete(STORE_VERSION_META, projectId);
}

export async function deleteProjectVersion(projectId: string, id: string): Promise<void> {
  await idbDelete(STORE_VERSIONS, id);

  const meta = await idbGet<VersionMeta>(STORE_VERSION_META, projectId);
  if (!meta) return;

  const wasLatest = meta.ids[0] === id;
  await idbPut<VersionMeta>(STORE_VERSION_META, {
    ...meta,
    ids: meta.ids.filter(item => item !== id),
    // Se è stata eliminata la versione più recente, il prossimo salvataggio
    // deve crearne una nuova invece di confrontarsi con un'impronta sparita.
    ...(wasLatest ? { hash: '', createdAt: 0 } : {}),
  });
}
