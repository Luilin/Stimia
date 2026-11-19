import {
  STORE_SYNC_CONFLICTS,
  STORE_SYNC_QUEUE,
  STORE_VERSION_SYNC_QUEUE,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
} from './idb';
import { SYNC_CONFLICT_EVENT } from './syncUtils';

export interface SyncConflictRecord {
  projectId: string;
  detectedAt: number;
}

export interface SyncStatusSnapshot {
  online: boolean;
  pendingProjects: number;
  pendingVersions: number;
  conflicts: number;
  lastSync: number | null;
}

const LAST_SYNC_KEY = 'stimia_last_sync';
export const SYNC_STATUS_EVENT = 'stimia:sync-status';

export function notifySyncStatus(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT));
  }
}

export function markSyncCompleted(): void {
  try {
    window.localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
  } catch {
    /* ignora */
  }
  notifySyncStatus();
}

export async function recordSyncConflict(projectId: string): Promise<void> {
  await idbPut<SyncConflictRecord>(STORE_SYNC_CONFLICTS, {
    projectId,
    detectedAt: Date.now(),
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SYNC_CONFLICT_EVENT, { detail: { projectId } }));
  }
  notifySyncStatus();
}

export async function clearSyncConflict(projectId: string): Promise<void> {
  await idbDelete(STORE_SYNC_CONFLICTS, projectId);
  notifySyncStatus();
}

export async function listSyncConflicts(): Promise<SyncConflictRecord[]> {
  return idbGetAll<SyncConflictRecord>(STORE_SYNC_CONFLICTS);
}

export async function getSyncConflict(projectId: string): Promise<SyncConflictRecord | undefined> {
  return idbGet<SyncConflictRecord>(STORE_SYNC_CONFLICTS, projectId);
}

export async function getSyncStatus(): Promise<SyncStatusSnapshot> {
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;

  try {
    const [projects, versions, conflicts] = await Promise.all([
      idbGetAll(STORE_SYNC_QUEUE),
      idbGetAll(STORE_VERSION_SYNC_QUEUE),
      idbGetAll(STORE_SYNC_CONFLICTS),
    ]);

    let lastSync: number | null = null;
    try {
      const raw = window.localStorage.getItem(LAST_SYNC_KEY);
      lastSync = raw ? Number(raw) : null;
    } catch {
      /* localStorage non disponibile */
    }

    return {
      online,
      pendingProjects: projects.length,
      pendingVersions: versions.length,
      conflicts: conflicts.length,
      lastSync,
    };
  } catch {
    return { online, pendingProjects: 0, pendingVersions: 0, conflicts: 0, lastSync: null };
  }
}

export function subscribeSyncStatus(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const handler = () => listener();
  window.addEventListener(SYNC_STATUS_EVENT, handler);
  window.addEventListener('online', handler);
  window.addEventListener('offline', handler);

  return () => {
    window.removeEventListener(SYNC_STATUS_EVENT, handler);
    window.removeEventListener('online', handler);
    window.removeEventListener('offline', handler);
  };
}
