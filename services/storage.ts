import { Project } from '../types';
import { SUPABASE_MODE } from './mode';
import * as localProjects from './localProjects';
import * as supabaseProjects from './supabaseProjects';

/**
 * Punto unico di accesso ai progetti.
 *
 * - Con Supabase configurato i dati vivono su Postgres, con IndexedDB come
 *   cache offline e coda di sincronizzazione.
 * - Senza Supabase l'archivio è interamente locale (IndexedDB).
 *
 * I salvataggi dello stesso progetto vengono accodati: se due autosave si
 * sovrappongono, la scrittura più recente non può essere superata da quella
 * più vecchia arrivata in ritardo.
 */

const saveChains = new Map<string, Promise<unknown>>();

function runSerialized(projectId: string, task: () => Promise<void>): Promise<void> {
  const previous = saveChains.get(projectId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);

  saveChains.set(projectId, next);
  void next
    .catch(() => undefined)
    .then(() => {
      if (saveChains.get(projectId) === next) saveChains.delete(projectId);
    });

  return next;
}

export const getProjects = async (): Promise<{ data: Project[]; error: any }> => {
  if (SUPABASE_MODE) return supabaseProjects.getProjectsWithCache();
  return localProjects.getProjects();
};

export const saveProject = (project: Project): Promise<void> =>
  runSerialized(project.id, () =>
    SUPABASE_MODE
      ? supabaseProjects.saveProjectWithCache(project)
      : localProjects.saveProject(project),
  );

export const deleteProject = (projectId: string): Promise<void> =>
  runSerialized(projectId, () =>
    SUPABASE_MODE
      ? supabaseProjects.deleteProjectWithCache(projectId)
      : localProjects.deleteProject(projectId),
  );

/** Attende i salvataggi ancora in corso (utile prima di chiudere o ricaricare). */
export const flushPendingSaves = async (): Promise<void> => {
  await Promise.allSettled(Array.from(saveChains.values()));
};
