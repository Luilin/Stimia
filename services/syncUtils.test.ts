import { describe, expect, it } from 'vitest';
import type { MemberPermission, Project } from '../types';
import {
  classifySyncError,
  databaseRole,
  membersSignature,
  memberDbPermissions,
  normalizeOfferTree,
  projectSaveMode,
} from './syncUtils';

const permission = (overrides: Partial<MemberPermission> = {}): MemberPermission => ({
  email: 'a@b.it',
  role: 'viewer',
  canRead: true,
  canWrite: false,
  canManageMembers: false,
  canEditSAL: false,
  canEditPriceBooks: false,
  canExport: true,
  ...overrides,
});

const baseProject = {
  id: 'p1',
  name: 'Progetto',
  description: '',
  lastModified: 0,
  createdBy: 'owner@example.com',
  userId: 'owner-uid',
  rootWBS: { id: 'root', code: '', name: 'Root', level: 0, items: [], children: [] },
} as unknown as Project;

describe('memberDbPermissions', () => {
  it('mantiene separati scrittura completa e permessi parziali', () => {
    expect(memberDbPermissions(permission({ canWrite: true }))).toEqual({
      role: 'editor', canWrite: true, canEditSAL: false, canEditPriceBooks: false, canEditOffer: false,
    });

    expect(memberDbPermissions(permission({ canEditSAL: true }))).toEqual({
      role: 'editor', canWrite: false, canEditSAL: true, canEditPriceBooks: false, canEditOffer: false,
    });

    expect(memberDbPermissions(permission({ canEditPriceBooks: true }))).toEqual({
      role: 'editor', canWrite: false, canEditSAL: false, canEditPriceBooks: true, canEditOffer: false,
    });
  });

  it('tratta la ditta come editor solo per l’offerta', () => {
    expect(memberDbPermissions(permission({ role: 'ditta' }))).toEqual({
      role: 'editor', canWrite: false, canEditSAL: false, canEditPriceBooks: false, canEditOffer: true,
    });
  });

  it('mappa i vecchi ruoli', () => {
    expect(memberDbPermissions(undefined, 'editor').canWrite).toBe(true);
    expect(memberDbPermissions(undefined, 'ditta').canWrite).toBe(false);
    expect(memberDbPermissions(undefined, 'ditta').canEditOffer).toBe(true);
    expect(memberDbPermissions(undefined, 'viewer').canWrite).toBe(false);
  });
});

describe('databaseRole', () => {
  it('considera editor chi può scrivere, gestire SAL o prezzari', () => {
    expect(databaseRole(permission({ canWrite: true }))).toBe('editor');
    expect(databaseRole(permission({ canEditSAL: true }))).toBe('editor');
    expect(databaseRole(permission({ canEditPriceBooks: true }))).toBe('editor');
  });

  it('considera editor la ditta, che deve salvare la propria offerta', () => {
    expect(databaseRole(permission({ role: 'ditta' }))).toBe('editor');
    expect(databaseRole(undefined, 'ditta')).toBe('editor');
  });

  it('lascia viewer chi ha solo lettura/export', () => {
    expect(databaseRole(permission())).toBe('viewer');
    expect(databaseRole(undefined, 'viewer')).toBe('viewer');
    expect(databaseRole(undefined)).toBe('viewer');
  });
});

describe('membersSignature', () => {
  it('è stabile rispetto all’ordine e alle maiuscole', () => {
    const a = membersSignature([
      { email: 'Mario@Example.com ', role: 'editor' },
      { email: 'anna@example.com', role: 'viewer' },
    ]);
    const b = membersSignature([
      { email: 'anna@example.com', role: 'viewer' },
      { email: 'mario@example.com', role: 'editor' },
    ]);

    expect(a).toBe(b);
  });

  it('cambia quando cambia un ruolo', () => {
    const editor = membersSignature([{ email: 'a@b.it', role: 'editor' }]);
    const viewer = membersSignature([{ email: 'a@b.it', role: 'viewer' }]);

    expect(editor).not.toBe(viewer);
  });

  it('cambia quando cambiano i permessi granulari', () => {
    const base = membersSignature([{ email: 'a@b.it', role: 'editor', canEditSAL: true }]);
    const changed = membersSignature([{ email: 'a@b.it', role: 'editor', canEditSAL: false }]);

    expect(base).not.toBe(changed);
  });

  it('normalizza un elenco vuoto', () => {
    expect(membersSignature([])).toBe(membersSignature([]));
  });
});

describe('projectSaveMode', () => {
  it('tratta il proprietario come scrittura completa', () => {
    expect(projectSaveMode(baseProject, 'owner-uid', 'owner@example.com')).toBe('full');
  });

  it('usa la scrittura completa per un editor completo', () => {
    const project = {
      ...baseProject,
      memberPermissions: { 'a@b.it': permission({ canWrite: true }) },
    };
    expect(projectSaveMode(project, 'member-uid', 'a@b.it')).toBe('full');
  });

  it('usa il percorso parziale per SAL o prezzari', () => {
    const sal = {
      ...baseProject,
      memberPermissions: { 'a@b.it': permission({ canEditSAL: true }) },
    };
    const priceBooks = {
      ...baseProject,
      memberPermissions: { 'a@b.it': permission({ canEditPriceBooks: true }) },
    };

    expect(projectSaveMode(sal, 'member-uid', 'a@b.it')).toBe('parts');
    expect(projectSaveMode(priceBooks, 'member-uid', 'a@b.it')).toBe('parts');
  });

  it('non salva un viewer', () => {
    const project = {
      ...baseProject,
      memberPermissions: { 'a@b.it': permission() },
    };
    expect(projectSaveMode(project, 'member-uid', 'a@b.it')).toBe('viewer');
  });

  it('riconosce il proprietario dal createdBy quando manca userId', () => {
    const project = { ...baseProject, userId: undefined };
    expect(projectSaveMode(project, 'owner-uid', 'OWNER@example.com')).toBe('full');
  });

  it('tratta il ruolo ditta come offerta', () => {
    const legacy = { ...baseProject, collaborators: { 'a@b.it': 'ditta' as const } };
    const granular = {
      ...baseProject,
      memberPermissions: { 'a@b.it': permission({ role: 'ditta' }) },
    };
    expect(projectSaveMode(legacy, 'member-uid', 'a@b.it')).toBe('offer');
    expect(projectSaveMode(granular, 'member-uid', 'a@b.it')).toBe('offer');
  });

  it('per un progetto legacy senza permessi lascia decidere il database', () => {
    expect(projectSaveMode(baseProject, 'member-uid', 'a@b.it')).toBe('full');
  });
});

describe('normalizeOfferTree', () => {
  it('rende espliciti i campi offerta vuoti, anche nelle sottocategorie', () => {
    const tree = {
      id: 'root',
      code: '',
      name: 'Root',
      level: 0,
      items: [],
      children: [
        {
          id: 'cat',
          code: '1',
          name: 'Categoria',
          level: 1,
          children: [],
          items: [{ id: 'item1', code: '1.1', description: 'Voce', uom: 'm', qty: 1, price: 10, amount: 10 }],
        },
      ],
    } as unknown as Project['rootWBS'];

    const normalized = normalizeOfferTree(tree);
    expect(normalized.items).toEqual([]);
    expect(normalized.children[0].items[0]).toMatchObject({
      offerPrice: null,
      offerMaterialPrice: null,
      offerLaborPrice: null,
      offerDays: null,
      offerNotes: null,
      description: 'Voce',
    });
  });
});

describe('classifySyncError', () => {
  it('riconosce gli errori di permesso come permanenti', () => {
    expect(classifySyncError('new row violates row-level security policy', true)).toBe('permanent');
    expect(classifySyncError('Progetto non disponibile sul cloud.', true)).toBe('permanent');
  });

  it('tratta la rete assente come offline', () => {
    expect(classifySyncError('TypeError: Failed to fetch', false)).toBe('offline');
    expect(classifySyncError('qualsiasi errore', false)).toBe('offline');
    expect(classifySyncError('fetch failed', true)).toBe('offline');
  });

  it('lascia ritentare gli errori transitori', () => {
    expect(classifySyncError('duplicate key value', true)).toBe('retry');
    expect(classifySyncError('internal server error', true)).toBe('retry');
  });
});
