import { openAppDb } from './idb';

/**
 * Cancella i dati dell'app salvati su questo dispositivo: IndexedDB e chiavi
 * `stimia_*` in localStorage. Usato quando l'utente elimina il proprio account.
 */
export async function clearLocalData(): Promise<void> {
  try {
    const db = await openAppDb();
    const stores = Array.from(db.objectStoreNames);
    await Promise.all(
      stores.map(store => new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })),
    );
  } catch (error) {
    console.warn('Pulizia del database locale non riuscita:', error);
  }

  try {
    Object.keys(window.localStorage)
      .filter(key => key.startsWith('stimia_'))
      .forEach(key => window.localStorage.removeItem(key));
  } catch {
    /* localStorage non disponibile */
  }
}
