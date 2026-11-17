import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import {
  deleteProjectVersion,
  deleteProjectVersions,
  listProjectVersions,
  saveProjectVersion,
} from './projectVersions';

const makeProject = (id: string, name = 'Progetto di prova'): Project => ({
  id,
  name,
  description: '',
  lastModified: Date.now(),
  createdBy: 'test@example.com',
  rootWBS: {
    id: `${id}_root`,
    code: '',
    name: 'Root',
    level: 0,
    children: [
      {
        id: `${id}_cat`,
        code: '1',
        name: 'Categoria',
        level: 1,
        children: [],
        items: [
          {
            id: `${id}_item`,
            code: '1.1',
            description: 'Voce',
            uom: 'm',
            factor: 1,
            length: 1,
            area: 1,
            height: 1,
            weight: 1,
            activeDimensions: { length: false, area: false, height: false, weight: false },
            qty: 1,
            price: 10,
            amount: 10,
          },
        ],
      },
    ],
    items: [],
  },
});

describe('cronologia versioni con metadati', () => {
  it('evita snapshot identici e rispetta il limite di 20', async () => {
    const project = makeProject('proj_meta_limit');

    const first = await saveProjectVersion(project, 'Manuale', true);
    expect(first).not.toBeNull();

    // Stesso contenuto: nessun nuovo snapshot.
    const duplicate = await saveProjectVersion(project, 'Automatica', false);
    expect(duplicate).toBeNull();

    for (let index = 0; index < 24; index++) {
      const changed = makeProject(project.id, `Progetto ${index}`);
      await saveProjectVersion(changed, 'Automatica', true);
    }

    const versions = await listProjectVersions(project.id);
    expect(versions).toHaveLength(20);

    // Le versioni conservate sono le più recenti.
    const names = versions.map(version => version.snapshot.name);
    expect(names).toContain('Progetto 23');
    expect(names).not.toContain('Progetto di prova');
  });

  it('dopo aver eliminato la versione più recente ne crea una nuova', async () => {
    const project = makeProject('proj_meta_delete');
    await saveProjectVersion(project, 'Manuale', true);
    const [latest] = await listProjectVersions(project.id);

    await deleteProjectVersion(project.id, latest.id);
    expect(await listProjectVersions(project.id)).toHaveLength(0);

    const recreated = await saveProjectVersion(project, 'Automatica', false);
    expect(recreated).not.toBeNull();
    expect(await listProjectVersions(project.id)).toHaveLength(1);
  });

  it('cancella cronologia e metadati del progetto', async () => {
    const project = makeProject('proj_meta_clear');
    await saveProjectVersion(project, 'Manuale', true);
    await saveProjectVersion(makeProject(project.id, 'Cambiato'), 'Manuale', true);

    await deleteProjectVersions(project.id);
    expect(await listProjectVersions(project.id)).toHaveLength(0);

    // I metadati sono stati rimossi: il salvataggio successivo ricomincia da zero.
    const afterClear = await saveProjectVersion(project, 'Automatica', false);
    expect(afterClear).not.toBeNull();
  });
});
