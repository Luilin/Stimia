import { loadPdfJs, pdfWorkerUrl } from './pdfjs';
import { prefetchPdfMake } from './vectorPdf';

export interface OfflinePrefetchResult {
  label: string;
  ok: boolean;
}

/**
 * Scarica in anticipo le librerie pesanti usate da export e stampa.
 * Il service worker le conserva, così restano disponibili offline.
 */
export async function prefetchOfflineDependencies(): Promise<OfflinePrefetchResult[]> {
  const tasks: Array<{ label: string; run: () => Promise<unknown> }> = [
    { label: 'Excel', run: () => import('xlsx') },
    { label: 'Backup ZIP', run: () => import('jszip') },
    { label: 'PDF.js', run: () => loadPdfJs() },
    { label: 'Worker PDF', run: () => fetch(pdfWorkerUrl, { cache: 'force-cache' }) },
    { label: 'Motore PDF', run: () => prefetchPdfMake() },
  ];

  const results = await Promise.allSettled(tasks.map(task => task.run()));
  return results.map((result, index) => ({
    label: tasks[index].label,
    ok: result.status === 'fulfilled',
  }));
}
