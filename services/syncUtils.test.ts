import { describe, expect, it } from 'vitest';
import type { MemberPermission } from '../types';
import { classifySyncError, databaseRole, membersSignature } from './syncUtils';

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

  it('normalizza un elenco vuoto', () => {
    expect(membersSignature([])).toBe(membersSignature([]));
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
