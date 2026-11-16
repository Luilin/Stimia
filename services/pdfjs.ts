import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/**
 * Carica PDF.js una sola volta e configura il worker.
 *
 * Il worker viene importato con `?url`: Vite lo emette come asset con hash,
 * quindi resta allineato alla versione di pdfjs-dist installata e non serve
 * copiarlo a mano in `public/`.
 */
let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

export function loadPdfJs(): Promise<typeof import('pdfjs-dist')> {
  pdfjsPromise ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
    return pdfjs;
  });
  return pdfjsPromise;
}
