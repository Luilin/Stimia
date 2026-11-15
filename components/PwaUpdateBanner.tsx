import React, { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';

/**
 * Avvisa quando il service worker ha una nuova versione pronta e permette
 * di attivarla senza restare su codice vecchio.
 */
export const PwaUpdateBanner: React.FC = () => {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [reloading, setReloading] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

    let cancelled = false;
    const onControllerChange = () => {
      if (!cancelled) window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .then((registration) => {
        if (cancelled) return;
        if (registration.waiting) setWaiting(registration.waiting);

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          installing?.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              setWaiting(registration.waiting || installing);
            }
          });
        });
      })
      .catch((error) => console.warn('Service worker non registrato:', error));

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  if (!waiting || dismissed) return null;

  const applyUpdate = () => {
    setReloading(true);
    waiting.postMessage({ type: 'SKIP_WAITING' });
  };

  return (
    <div className="fixed bottom-4 right-4 z-[200] w-[calc(100%-2rem)] max-w-sm rounded-xl border border-emerald-200 bg-white p-3 shadow-xl">
      <div className="flex items-start gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
          <RefreshCw size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-slate-900">Nuova versione disponibile</p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Aggiorna per usare l’ultima versione di Stimia. I dati salvati non vengono toccati.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button onClick={applyUpdate} disabled={reloading} className="btn btn-primary h-8 px-3 text-xs">
              {reloading ? 'Aggiornamento…' : 'Aggiorna ora'}
            </button>
            <button
              onClick={() => setDismissed(true)}
              className="text-[11px] font-semibold text-slate-500 hover:text-slate-700 hover:underline"
            >
              Più tardi
            </button>
          </div>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          aria-label="Chiudi avviso"
          title="Chiudi"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
};
