import { supabase } from './supabase';

/**
 * File di progetto su Supabase Storage (bucket privato `stimia-files`).
 *
 * Percorsi:
 *   <projectId>/attachments/<attachmentId>
 *   <projectId>/price-books/<priceBookId>.json
 *
 * Se Supabase non è configurato (modalità locale) le funzioni restituiscono
 * null/errore e l'app continua a usare IndexedDB.
 */
export const FILES_BUCKET = 'stimia-files';

export const cloudFilesEnabled = (): boolean => Boolean(supabase);

export function projectStoragePath(
  projectId: string,
  kind: 'attachments' | 'price-books',
  fileName: string,
): string {
  return `${projectId}/${kind}/${fileName}`;
}

async function ensureClient() {
  if (!supabase) throw new Error('Cloud Storage non configurato.');
  return supabase;
}

export async function uploadCloudFile(
  path: string,
  blob: Blob,
  contentType?: string,
): Promise<string> {
  const client = await ensureClient();
  const { error } = await client.storage.from(FILES_BUCKET).upload(path, blob, {
    upsert: true,
    contentType: contentType || blob.type || 'application/octet-stream',
    cacheControl: '3600',
  });
  if (error) throw new Error(error.message);
  return path;
}

export async function downloadCloudFile(path: string): Promise<Blob> {
  const client = await ensureClient();
  const { data, error } = await client.storage.from(FILES_BUCKET).download(path);
  if (error || !data) throw new Error(error?.message || 'File non trovato nello Storage.');
  return data;
}

export async function deleteCloudFile(path: string): Promise<void> {
  if (!supabase || !path) return;
  const { error } = await supabase.storage.from(FILES_BUCKET).remove([path]);
  if (error) throw new Error(error.message);
}

/** Elimina tutti i file di una cartella (es. prezzari di un progetto). */
export async function deleteCloudFolder(projectId: string, kind: 'attachments' | 'price-books'): Promise<void> {
  if (!supabase) return;
  const prefix = `${projectId}/${kind}`;
  const { data, error } = await supabase.storage.from(FILES_BUCKET).list(prefix, { limit: 1000 });
  if (error || !data || data.length === 0) return;

  const paths = data.filter(entry => entry.name).map(entry => `${prefix}/${entry.name}`);
  if (paths.length === 0) return;

  const { error: removeError } = await supabase.storage.from(FILES_BUCKET).remove(paths);
  if (removeError) throw new Error(removeError.message);
}
