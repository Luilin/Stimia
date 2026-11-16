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
 */
export const getProjects = async (): Promise<{ data: Project[]; error: any }> => {
  if (SUPABASE_MODE) return supabaseProjects.getProjectsWithCache();
  return localProjects.getProjects();
};

export const saveProject = async (project: Project): Promise<void> => {
  if (SUPABASE_MODE) return supabaseProjects.saveProjectWithCache(project);
  return localProjects.saveProject(project);
};

export const deleteProject = async (projectId: string): Promise<void> => {
  if (SUPABASE_MODE) return supabaseProjects.deleteProjectWithCache(projectId);
  return localProjects.deleteProject(projectId);
};
