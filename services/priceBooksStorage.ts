import { PriceBook, PriceBookCategory } from '../types';
import {
  STORE_PRICE_BOOKS,
  idbDelete,
  idbDeleteMany,
  idbGet,
  idbGetAllByIndex,
  idbPut,
} from './idb';
import {
  cloudFilesEnabled,
  deleteCloudFile,
  deleteCloudFolder,
  downloadCloudFile,
  projectStoragePath,
  uploadCloudFile,
} from './cloudFiles';

/**
 * I prezzari piccoli restano dentro il progetto (IndexedDB/Supabase).
 * Quelli grandi (es. prezzari regionali) vengono salvati in IndexedDB e nel
 * progetto resta solo un riferimento leggero.
 */
const LARGE_BOOK_THRESHOLD = 300;

type StoredBook = PriceBook & { projectId: string };

/** Evita di ricaricare lo stesso JSON a ogni salvataggio. */
const uploadedSnapshots = new Map<string, string>();

async function uploadPriceBook(projectId: string, book: PriceBook): Promise<string | undefined> {
  if (!cloudFilesEnabled()) return undefined;

  const path = projectStoragePath(projectId, 'price-books', `${book.id}.json`);
  const payload = JSON.stringify(book);

  if (uploadedSnapshots.get(path) === payload) return path;

  await uploadCloudFile(path, new Blob([payload], { type: 'application/json' }), 'application/json');
  uploadedSnapshots.set(path, payload);
  return path;
}

const countItems = (book: PriceBook): number => {
  let count = 0;
  const walk = (node: PriceBookCategory) => {
    count += node.items.length;
    node.children.forEach(walk);
  };
  walk(book.rootCategory);
  return count;
};

const emptyRoot = (bookId: string): PriceBookCategory => ({
  id: `root_${bookId}`,
  code: '',
  name: 'Root',
  items: [],
  children: [],
});

const makeId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `pb_${crypto.randomUUID()}`
    : `pb_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

export async function externalizePriceBooks(projectId: string, books: PriceBook[]): Promise<PriceBook[]> {
  const metadata: PriceBook[] = [];

  for (const book of books) {
    const itemCount = countItems(book);

    if (book.external) {
      if (itemCount > 0) {
        const storedBook = { ...book, projectId, external: false };
        await idbPut<StoredBook>(STORE_PRICE_BOOKS, storedBook);
        let cloudPath = book.cloudPath;
        try {
          cloudPath = await uploadPriceBook(projectId, storedBook);
        } catch (error) {
          console.warn('Prezzario non caricato sul cloud:', error);
        }
        metadata.push({
          ...book,
          rootCategory: emptyRoot(book.id),
          external: true,
          itemCount,
          cloudPath,
        });
      } else {
        metadata.push({
          ...book,
          external: true,
          itemCount: book.itemCount || 0,
          cloudPath: book.cloudPath,
        });
      }
      continue;
    }

    if (itemCount > LARGE_BOOK_THRESHOLD) {
      const storedBook = { ...book, projectId, external: false };
      await idbPut<StoredBook>(STORE_PRICE_BOOKS, storedBook);
      let cloudPath: string | undefined;
      try {
        cloudPath = await uploadPriceBook(projectId, storedBook);
      } catch (error) {
        console.warn('Prezzario non caricato sul cloud:', error);
      }
      metadata.push({
        ...book,
        rootCategory: emptyRoot(book.id),
        external: true,
        itemCount,
        cloudPath,
      });
    } else {
      await idbDelete(STORE_PRICE_BOOKS, book.id);
      if (book.cloudPath) {
        try {
          await deleteCloudFile(book.cloudPath);
        } catch (error) {
          console.warn('Prezzario cloud non rimosso:', error);
        }
      }
      metadata.push({ ...book, external: false, itemCount });
    }
  }

  // Rimuove eventuali prezzari esterni non più presenti nel progetto.
  const keepIds = new Set(books.map(book => book.id));
  const stored = await idbGetAllByIndex<StoredBook>(STORE_PRICE_BOOKS, 'projectId', projectId);
  const orphans = stored.filter(book => !keepIds.has(book.id));
  if (orphans.length > 0) {
    await idbDeleteMany(STORE_PRICE_BOOKS, orphans.map(book => book.id));
    for (const orphan of orphans) {
      try {
        await deleteCloudFile(projectStoragePath(projectId, 'price-books', `${orphan.id}.json`));
      } catch (error) {
        console.warn('Prezzario cloud orfano non rimosso:', error);
      }
    }
  }

  return metadata;
}

export async function hydratePriceBooks(projectId: string, books: PriceBook[]): Promise<PriceBook[]> {
  return Promise.all(books.map(async book => {
    if (!book.external) return book;

    const stored = await idbGet<StoredBook>(STORE_PRICE_BOOKS, book.id);
    if (stored) {
      const { projectId: _projectId, ...rest } = stored;
      return {
        ...rest,
        external: true,
        cloudPath: book.cloudPath,
        itemCount: book.itemCount ?? countItems(rest as PriceBook),
      };
    }

    // Il prezzario non è in questo browser: prova a scaricarlo dallo Storage.
    if (book.cloudPath && cloudFilesEnabled()) {
      try {
        const blob = await downloadCloudFile(book.cloudPath);
        const full = JSON.parse(await blob.text()) as PriceBook;
        const storedBook = { ...full, id: book.id, projectId, external: false };
        await idbPut<StoredBook>(STORE_PRICE_BOOKS, storedBook);
        return {
          ...full,
          external: true,
          cloudPath: book.cloudPath,
          itemCount: book.itemCount ?? countItems(full),
        };
      } catch (error) {
        console.warn('Prezzario cloud non disponibile:', error);
      }
    }

    return book;
  }));
}

export async function deleteProjectPriceBooks(projectId: string): Promise<void> {
  const stored = await idbGetAllByIndex<StoredBook>(STORE_PRICE_BOOKS, 'projectId', projectId);
  await idbDeleteMany(STORE_PRICE_BOOKS, stored.map(book => book.id));
  try {
    await deleteCloudFolder(projectId, 'price-books');
  } catch (error) {
    console.warn('Prezzari cloud non rimossi:', error);
  }
}

export async function duplicateProjectPriceBooks(
  _sourceProjectId: string,
  targetProjectId: string,
  books: PriceBook[]
): Promise<PriceBook[]> {
  const result: PriceBook[] = [];

  for (const book of books) {
    if (!book.external) {
      result.push(book);
      continue;
    }

    const stored = await idbGet<StoredBook>(STORE_PRICE_BOOKS, book.id);
    if (!stored) {
      result.push({ ...book });
      continue;
    }

    const newId = makeId();
    const { projectId: _source, external: _external, ...bookData } = stored;
    const newBook = {
      ...bookData,
      id: newId,
      projectId: targetProjectId,
      external: false,
    };
    await idbPut<StoredBook>(STORE_PRICE_BOOKS, newBook);

    let cloudPath: string | undefined;
    try {
      cloudPath = await uploadPriceBook(targetProjectId, newBook);
    } catch (error) {
      console.warn('Copia del prezzario non caricata sul cloud:', error);
    }

    result.push({
      ...book,
      id: newId,
      rootCategory: emptyRoot(newId),
      external: true,
      itemCount: book.itemCount,
      cloudPath,
    });
  }

  return result;
}
