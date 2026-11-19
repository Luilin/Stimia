import { Project } from '../types';
import { ProjectAttachment, listAttachments } from './attachments';
import { externalizePriceBooks, hydratePriceBooks } from './priceBooksStorage';
import {
  ProjectVersion,
  listProjectVersions,
  queueVersionUpload,
  restoreProjectVersion,
} from './projectVersions';
import { STORE_ATTACHMENTS, STORE_VERSIONS, idbGet, idbPut } from './idb';
import { saveProject } from './storage';
import { getCurrentUser } from './auth';

/**
 * Backup completo in ZIP: progetti, prezzari, allegati e cronologia versioni.
 * Il formato JSON storico resta supportato in importazione.
 */

export interface BackupManifest {
  app: 'Stimia';
  version: 2;
  exportedAt: string;
  projects: Array<{ id: string; name: string; file: string }>;
  attachments: Array<{
    id: string;
    projectId: string;
    name: string;
    type: string;
    size: number;
    createdAt: number;
    notes?: string;
    file: string;
  }>;
  versions: Array<{ id: string; projectId: string; file: string }>;
}

export interface BackupImportResult {
  projects: number;
  attachments: number;
  versions: number;
}

const safeName = (value: string, fallback: string): string => {
  const cleaned = String(value || '')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
};

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export async function exportFullBackup(projects: Project[]): Promise<Blob> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();

  const manifest: BackupManifest = {
    app: 'Stimia',
    version: 2,
    exportedAt: new Date().toISOString(),
    projects: [],
    attachments: [],
    versions: [],
  };

  for (const project of projects) {
    const fullProject: Project = {
      ...clone(project),
      priceBooks: await hydratePriceBooks(project.id, project.priceBooks || []),
    };
    const projectFile = `projects/${safeName(project.id, 'progetto')}.json`;
    zip.file(projectFile, JSON.stringify(fullProject, null, 2));
    manifest.projects.push({ id: project.id, name: project.name, file: projectFile });

    const attachments = await listAttachments(project.id);
    for (const attachment of attachments) {
      const fileName = `${safeName(attachment.id, 'allegato')}__${safeName(attachment.name, 'file')}`;
      const filePath = `attachments/${safeName(project.id, 'progetto')}/${fileName}`;
      zip.file(filePath, attachment.blob);
      manifest.attachments.push({
        id: attachment.id,
        projectId: project.id,
        name: attachment.name,
        type: attachment.type,
        size: attachment.size,
        createdAt: attachment.createdAt,
        notes: attachment.notes,
        file: filePath,
      });
    }

    const versions = await listProjectVersions(project.id);
    for (const version of versions) {
      let snapshot = version.snapshot;
      if (!snapshot) {
        try {
          snapshot = await restoreProjectVersion(version);
        } catch (error) {
          console.warn('Versione non inclusa nel backup (snapshot non disponibile):', version.id, error);
          continue;
        }
      }
      const payload: ProjectVersion = { ...version, snapshot };
      const versionFile = `versions/${safeName(project.id, 'progetto')}/${safeName(version.id, 'versione')}.json`;
      zip.file(versionFile, JSON.stringify(payload, null, 2));
      manifest.versions.push({ id: version.id, projectId: project.id, file: versionFile });
    }
  }

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

function legacyAttachmentId(fileName: string): string {
  const base = fileName.split('__')[0];
  return base || `att_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function legacyAttachmentName(fileName: string): string {
  const parts = fileName.split('__');
  return parts.length > 1 ? parts.slice(1).join('__') : fileName;
}

export async function importFullBackup(file: File): Promise<BackupImportResult> {
  if (file.size > 500 * 1024 * 1024) {
    throw new Error('Il backup supera il limite di 500 MB.');
  }

  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(file);
  const result: BackupImportResult = { projects: 0, attachments: 0, versions: 0 };

  for (const entry of zip.file(/^projects\/[^/]+\.json$/)) {
    try {
      const project = JSON.parse(await entry.async('string')) as Project;
      if (!project?.id || !project.rootWBS) continue;

      const user = getCurrentUser();
      const restored: Project = {
        ...project,
        userId: user?.uid || project.userId,
        createdBy: user?.email || project.createdBy,
        lastModified: Date.now(),
      };
      restored.priceBooks = await externalizePriceBooks(restored.id, restored.priceBooks || []);
      await saveProject(restored);
      result.projects += 1;
    } catch (error) {
      console.warn('Progetto non importato dal backup:', entry.name, error);
    }
  }

  for (const entry of zip.file(/^attachments\/[^/]+\/[^/]+$/)) {
    try {
      const match = /^attachments\/([^/]+)\/([^/]+)$/.exec(entry.name);
      if (!match) continue;
      const [, projectId, fileName] = match;
      const id = legacyAttachmentId(fileName);
      if (await idbGet(STORE_ATTACHMENTS, id)) continue;

      const blob = await entry.async('blob');
      const attachment: ProjectAttachment = {
        id,
        projectId,
        name: legacyAttachmentName(fileName),
        type: blob.type || 'application/octet-stream',
        size: blob.size,
        blob,
        createdAt: Date.now(),
      };
      await idbPut(STORE_ATTACHMENTS, attachment);
      result.attachments += 1;
    } catch (error) {
      console.warn('Allegato non importato dal backup:', entry.name, error);
    }
  }

  for (const entry of zip.file(/^versions\/[^/]+\/[^/]+\.json$/)) {
    try {
      const version = JSON.parse(await entry.async('string')) as ProjectVersion;
      if (!version?.id || !version.projectId) continue;
      await idbPut(STORE_VERSIONS, version);
      await queueVersionUpload(version.id);
      result.versions += 1;
    } catch (error) {
      console.warn('Versione non importata dal backup:', entry.name, error);
    }
  }

  return result;
}
