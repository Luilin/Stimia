import { describe, expect, it } from 'vitest';
import { classifySyncError, membersSignature } from './syncUtils';

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
