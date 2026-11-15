import React, { Component } from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Evita la schermata bianca se un componente lancia un errore durante il render.
 * Mostra un messaggio recuperabile e i dettagli tecnici copiabili.
 */
export class ErrorBoundary extends Component<Props, State> {
  declare props: Readonly<Props>;

  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Errore applicazione:', error, info.componentStack);
  }

  private reload = () => {
    window.location.reload();
  };

  private copyDetails = async () => {
    const { error } = this.state;
    if (!error) return;
    const details = `${error.name}: ${error.message}\n\n${error.stack || ''}`;
    try {
      await navigator.clipboard.writeText(details);
    } catch {
      /* clipboard non disponibile */
    }
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
        <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
          <div className="mb-3 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
              !
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-900">Si è verificato un errore</h1>
              <p className="text-xs text-slate-500">I dati salvati non sono stati toccati.</p>
            </div>
          </div>

          <p className="mb-4 text-sm text-slate-600">
            Ricarica l’app per continuare. Se l’errore si ripete, copia i dettagli e segnalalo.
          </p>

          <pre className="mb-4 max-h-40 overflow-auto rounded-lg bg-slate-50 p-3 text-[11px] text-slate-600">
            {error.message}
          </pre>

          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={this.copyDetails} className="btn btn-neutral">
              Copia dettagli
            </button>
            <button type="button" onClick={this.reload} className="btn btn-primary">
              Ricarica
            </button>
          </div>
        </div>
      </div>
    );
  }
}
