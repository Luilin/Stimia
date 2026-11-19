import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Cloud, CloudOff, RefreshCw, X } from 'lucide-react';
import { flushSyncQueue } from '../services/supabaseProjects';
import { flushVersionQueue } from '../services/projectVersions';
import {
  SyncConflictRecord,
  SyncStatusSnapshot,
  getSyncStatus,
  listSyncConflicts,
  subscribeSyncStatus,
} from '../services/syncStatus';

interface SyncStatusBadgeProps {
  projects: Array<{ id: string; name: string }>;
  onOpenProject?: (projectId: string) => void;
}

const formatLastSync = (timestamp: number | null): string => {
  if (!timestamp) return 'mai';
  const date = new Date(timestamp);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export const SyncStatusBadge: React.FC<SyncStatusBadgeProps> = ({ projects, onOpenProject }) => {
  const [status, setStatus] = useState<SyncStatusSnapshot | null>(null);
  const [conflicts, setConflicts] = useState<SyncConflictRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    const [nextStatus, nextConflicts] = await Promise.all([
      getSyncStatus(),
      listSyncConflicts(),
    ]);
    setStatus(nextStatus);
    setConflicts(nextConflicts);
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = subscribeSyncStatus(() => { void refresh(); });
    const interval = window.setInterval(() => { void refresh(); }, 15000);
    return () => {
      unsubscribe();
      window.clearInterval(interval);
    };
  }, [refresh]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      await flushSyncQueue();
      await flushVersionQueue();
    } catch (error) {
      console.warn('Sincronizzazione manuale non riuscita:', error);
    } finally {
      await refresh();
      setSyncing(false);
    }
  };

  const online = status?.online ?? (typeof navigator === 'undefined' ? true : navigator.onLine);
  const conflictCount = status?.conflicts ?? 0;
  const pending = (status?.pendingProjects ?? 0) + (status?.pendingVersions ?? 0);

  const tone = !online
    ? 'border-slate-200 bg-slate-50 text-slate-600'
    : conflictCount > 0
      ? 'border-amber-300 bg-amber-50 text-amber-800'
      : pending > 0
        ? 'border-sky-200 bg-sky-50 text-sky-700'
        : 'border-emerald-200 bg-emerald-50 text-emerald-700';

  const label = !online
    ? 'Offline'
    : conflictCount > 0
      ? `${conflictCount} ${conflictCount === 1 ? 'conflitto' : 'conflitti'}`
      : pending > 0
        ? `${pending} in coda`
        : 'Sincronizzato';

  const Icon = !online ? CloudOff : conflictCount > 0 ? AlertTriangle : pending > 0 ? RefreshCw : Cloud;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`hidden items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold sm:inline-flex ${tone}`}
        title="Stato di sincronizzazione"
        aria-label="Stato di sincronizzazione"
      >
        <Icon size={12} /> {label}
      </button>

      {open && (
        <div className="fixed inset-0 z-[180] flex items-center justify-center bg-slate-900/50 p-4" onClick={() => setOpen(false)}>
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-2xl" onClick={event => event.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">Sincronizzazione</h3>
              <button type="button" onClick={() => setOpen(false)} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Chiudi">
                <X size={16} />
              </button>
            </div>

            <dl className="space-y-1.5 text-xs text-slate-600">
              <div className="flex justify-between"><dt>Rete</dt><dd className="font-semibold text-slate-800">{online ? 'Online' : 'Offline'}</dd></div>
              <div className="flex justify-between"><dt>Ultima sincronizzazione</dt><dd className="font-semibold text-slate-800">{formatLastSync(status?.lastSync ?? null)}</dd></div>
              <div className="flex justify-between"><dt>Progetti in coda</dt><dd className="font-semibold text-slate-800">{status?.pendingProjects ?? 0}</dd></div>
              <div className="flex justify-between"><dt>Versioni in coda</dt><dd className="font-semibold text-slate-800">{status?.pendingVersions ?? 0}</dd></div>
              <div className="flex justify-between"><dt>Conflitti</dt><dd className="font-semibold text-slate-800">{conflictCount}</dd></div>
            </dl>

            {conflicts.length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-2.5">
                <p className="text-[11px] font-semibold text-amber-800">Progetti da risolvere</p>
                <ul className="mt-1 space-y-1">
                  {conflicts.map(conflict => {
                    const project = projects.find(item => item.id === conflict.projectId);
                    return (
                      <li key={conflict.projectId} className="flex items-center justify-between gap-2 text-[11px] text-amber-800">
                        <span className="truncate">{project?.name || conflict.projectId}</span>
                        {onOpenProject && project && (
                          <button
                            type="button"
                            className="shrink-0 font-semibold underline"
                            onClick={() => { setOpen(false); onOpenProject(project.id); }}
                          >
                            Apri
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="btn btn-neutral h-8 px-3 text-xs">Chiudi</button>
              <button type="button" onClick={syncNow} disabled={syncing || !online} className="btn btn-primary h-8 px-3 text-xs">
                {syncing ? 'Sincronizzazione…' : 'Sincronizza ora'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
