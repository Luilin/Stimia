import type * as FirebaseServices from './firebase';

/**
 * Firebase serve solo alla vecchia modalità cloud. Con Supabase o in locale
 * non viene mai usato: caricarlo on-demand evita di scaricare ~550 kB
 * all'avvio.
 */
let firebasePromise: Promise<typeof FirebaseServices> | null = null;

export function loadFirebaseServices(): Promise<typeof FirebaseServices> {
  return (firebasePromise ??= import('./firebase'));
}
