import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PwaUpdateBanner } from './components/PwaUpdateBanner';
import { migrateLegacyStorageKeys } from './services/storageMigration';

// Rinomina le preferenze salvate prima del rebrand (una volta sola).
migrateLegacyStorageKeys();

// Chiede al browser di non eliminare IndexedDB quando lo spazio è poco.
if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
  navigator.storage.persist().catch(() => undefined);
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
      <PwaUpdateBanner />
    </ErrorBoundary>
  </React.StrictMode>
);
