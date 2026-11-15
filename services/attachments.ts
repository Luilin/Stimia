import { idbDelete, idbDeleteMany, idbGet, idbGetAllByIndex, idbPut, STORE_ATTACHMENTS } from './idb';
import {
  cloudFilesEnabled,
  deleteCloudFile,
  deleteCloudFolder,
  downloadCloudFile,
  projectStoragePath,
  uploadCloudFile,
} from './cloudFiles';
import { supabase } from './supabase';

export interface ProjectAttachment {
  id: string;
  projectId: string;
  nodeId?: string;
  name: string;
  type: string;
  size: number;
  blob: Blob;
  createdAt: number;
  notes?: string;
  /** Percorso nello Storage Supabase (se sincronizzato). */
  cloudPath?: string;
  cloudState?: 'pending' | 'synced' | 'failed';
}

interface AttachmentRow {
  id: string;
  project_id: string;
  name: string;
  type: string;
  size: number | string | null;
  node_id: string | null;
  notes: string | null;
  storage_path: string;
  created_at: string;
}

const TABLE = 'project_attachments';

const makeId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `att_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, index);
  return `${value.toLocaleString('it-IT', { maximumFractionDigits: index === 0 ? 0 : 1 })} ${units[index]}`;
}

const sortByDate = (items: ProjectAttachment[]) => items.sort((a, b) => b.createdAt - a.createdAt);

async function uploadAttachment(attachment: ProjectAttachment): Promise<ProjectAttachment> {
  if (!cloudFilesEnabled() || !supabase) return attachment;

  const path = attachment.cloudPath
    || projectStoragePath(attachment.projectId, 'attachments', attachment.id);

  await uploadCloudFile(path, attachment.blob, attachment.type);

  const { error } = await supabase.from(TABLE).upsert(
    {
      id: attachment.id,
      project_id: attachment.projectId,
      name: attachment.name,
      type: attachment.type,
      size: attachment.size,
      node_id: attachment.nodeId || null,
      notes: attachment.notes || null,
      storage_path: path,
      created_at: new Date(attachment.createdAt).toISOString(),
    },
    { onConflict: 'id' },
  );
  if (error) {
    // Non lasciare file orfani nello Storage se i metadati non sono salvabili.
    await deleteCloudFile(path).catch(() => undefined);
    throw new Error(error.message);
  }

  const updated: ProjectAttachment = { ...attachment, cloudPath: path, cloudState: 'synced' };
  await idbPut(STORE_ATTACHMENTS, updated);
  return updated;
}

export async function listAttachments(projectId: string): Promise<ProjectAttachment[]> {
  const local = await idbGetAllByIndex<ProjectAttachment>(STORE_ATTACHMENTS, 'projectId', projectId);

  if (!cloudFilesEnabled() || !supabase) return sortByDate(local);

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('project_id', projectId);
    if (error) throw new Error(error.message);

    const rows = (data || []) as AttachmentRow[];
    const remoteIds = new Set(rows.map(row => row.id));
    const localById = new Map(local.map(item => [item.id, item]));
    const result: ProjectAttachment[] = [];

    for (const row of rows) {
      const cached = localById.get(row.id);
      if (cached?.blob) {
        result.push({ ...cached, cloudPath: row.storage_path, cloudState: 'synced' });
        continue;
      }

      try {
        const blob = await downloadCloudFile(row.storage_path);
        const item: ProjectAttachment = {
          id: row.id,
          projectId: row.project_id,
          nodeId: row.node_id || undefined,
          name: row.name,
          type: row.type || blob.type || 'application/octet-stream',
          size: Number(row.size) || blob.size,
          blob,
          createdAt: new Date(row.created_at).getTime() || Date.now(),
          notes: row.notes || undefined,
          cloudPath: row.storage_path,
          cloudState: 'synced',
        };
        await idbPut(STORE_ATTACHMENTS, item);
        result.push(item);
      } catch (downloadError) {
        console.warn('Allegato cloud non scaricato:', row.name, downloadError);
      }
    }

    // File creati offline o con upload fallito: prova a inviarli ora.
    for (const item of local) {
      if (remoteIds.has(item.id)) continue;
      result.push(item);
      try {
        await uploadAttachment(item);
      } catch (uploadError) {
        console.warn('Allegato non sincronizzato:', item.name, uploadError);
        await idbPut(STORE_ATTACHMENTS, { ...item, cloudState: 'pending' });
      }
    }

    return sortByDate(result);
  } catch (error) {
    console.warn('Elenco allegati cloud non disponibile, uso la cache locale.', error);
    return sortByDate(local);
  }
}

export async function addAttachment(
  projectId: string,
  file: File,
  nodeId?: string
): Promise<ProjectAttachment> {
  const attachment: ProjectAttachment = {
    id: makeId(),
    projectId,
    nodeId,
    name: file.name || 'allegato',
    type: file.type || 'application/octet-stream',
    size: file.size,
    blob: file,
    createdAt: Date.now(),
    cloudState: cloudFilesEnabled() ? 'pending' : undefined,
  };
  await idbPut(STORE_ATTACHMENTS, attachment);

  if (!cloudFilesEnabled()) return attachment;

  try {
    return await uploadAttachment(attachment);
  } catch (error) {
    console.warn('Allegato salvato solo in locale:', error);
    return attachment;
  }
}

export async function deleteAttachment(id: string): Promise<void> {
  const attachment = await idbGet<ProjectAttachment>(STORE_ATTACHMENTS, id);

  if (cloudFilesEnabled() && supabase) {
    try {
      if (attachment?.cloudPath) await deleteCloudFile(attachment.cloudPath);
      await supabase.from(TABLE).delete().eq('id', id);
    } catch (error) {
      console.warn('Allegato cloud non rimosso:', error);
    }
  }

  await idbDelete(STORE_ATTACHMENTS, id);
}

export async function deleteProjectAttachments(projectId: string): Promise<void> {
  if (cloudFilesEnabled() && supabase) {
    try {
      await deleteCloudFolder(projectId, 'attachments');
      await supabase.from(TABLE).delete().eq('project_id', projectId);
    } catch (error) {
      console.warn('Allegati cloud non rimossi:', error);
    }
  }

  const attachments = await idbGetAllByIndex<ProjectAttachment>(STORE_ATTACHMENTS, 'projectId', projectId);
  await idbDeleteMany(STORE_ATTACHMENTS, attachments.map(item => item.id));
}

export function downloadAttachment(attachment: ProjectAttachment): void {
  const url = URL.createObjectURL(attachment.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = attachment.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
