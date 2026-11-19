import React, { useEffect, useState } from 'react';
import { KeyRound, LogOut, MailCheck, ShieldAlert, Trash2, X, Loader2, HardDrive } from 'lucide-react';
import { SUPABASE_MODE } from '../services/mode';
import { prefetchOfflineDependencies } from '../services/offlinePrefetch';
import {
  deleteAccount,
  resendConfirmation,
  signOutEverywhere,
  updatePassword,
} from '../services/auth';

interface Props {
  email: string;
  onClose: () => void;
  onSignedOut: () => void;
}

type Message = { type: 'ok' | 'error'; text: string } | null;

export const AccountModal: React.FC<Props> = ({ email, onClose, onSignedOut }) => {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [offlineMessage, setOfflineMessage] = useState<string | null>(null);
  const [storageLabel, setStorageLabel] = useState('');

  useEffect(() => {
    let cancelled = false;
    navigator.storage?.estimate?.()
      .then(({ usage, quota }) => {
        if (cancelled || !quota) return;
        const used = ((usage || 0) / 1024 / 1024).toFixed(1);
        const total = (quota / 1024 / 1024).toFixed(0);
        setStorageLabel(`${used} MB usati su circa ${total} MB disponibili`);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage(null);
    if (newPassword.length < 6) {
      setMessage({ type: 'error', text: 'La password deve avere almeno 6 caratteri.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage({ type: 'error', text: 'Le due password non coincidono.' });
      return;
    }
    setBusy('password');
    try {
      await updatePassword(newPassword);
      setNewPassword('');
      setConfirmPassword('');
      setMessage({ type: 'ok', text: 'Password aggiornata.' });
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Impossibile aggiornare la password.' });
    } finally {
      setBusy(null);
    }
  };

  const handleResend = async () => {
    setMessage(null);
    setBusy('resend');
    try {
      await resendConfirmation(email);
      setMessage({ type: 'ok', text: 'Email di conferma inviata (controlla anche lo spam).' });
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Invio non riuscito.' });
    } finally {
      setBusy(null);
    }
  };

  const handleSignOutEverywhere = async () => {
    if (!window.confirm('Uscire da tutti i dispositivi collegati?')) return;
    setBusy('logout');
    try {
      await signOutEverywhere();
      onSignedOut();
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Uscita non riuscita.' });
      setBusy(null);
    }
  };

  const handleOfflinePrefetch = async () => {
    setBusy('offline');
    setOfflineMessage(null);
    try {
      const results = await prefetchOfflineDependencies();
      const failed = results.filter(result => !result.ok).map(result => result.label);
      setOfflineMessage(
        failed.length === 0
          ? 'Tutti i componenti sono pronti per l’uso offline.'
          : `Non precaricati: ${failed.join(', ')}. Riprova con una connessione stabile.`,
      );
    } catch {
      setOfflineMessage('Precaricamento offline non riuscito.');
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    if (deleteConfirm.trim().toUpperCase() !== 'ELIMINA') {
      setMessage({ type: 'error', text: 'Scrivi ELIMINA per confermare.' });
      return;
    }
    setBusy('delete');
    try {
      await deleteAccount();
      onSignedOut();
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Eliminazione non riuscita.' });
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[170] flex items-center justify-center bg-slate-900/60 p-3 backdrop-blur-sm sm:p-6">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-slate-900">Account</h2>
            <p className="truncate text-xs text-slate-500">{email || 'Utente locale'}</p>
          </div>
          <button onClick={onClose} className="btn btn-ghost btn-icon" aria-label="Chiudi" title="Chiudi">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-4 sm:p-5">
          {message && (
            <div className={`rounded-lg border p-2.5 text-xs ${
              message.type === 'ok'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-red-200 bg-red-50 text-red-700'
            }`}>
              {message.text}
            </div>
          )}

          {storageLabel && (
            <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <HardDrive size={13} /> {storageLabel}
            </p>
          )}

          <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <h3 className="mb-1 flex items-center gap-2 text-sm font-bold text-slate-800">
              <HardDrive size={15} className="text-emerald-600" /> Uso offline
            </h3>
            <p className="mb-2 text-[11px] text-slate-500">
              Precarica Excel, PDF, backup ZIP e il motore di stampa per usarli anche senza connessione.
            </p>
            <button type="button" onClick={handleOfflinePrefetch} disabled={busy !== null} className="btn btn-neutral w-full">
              {busy === 'offline' ? <Loader2 size={16} className="animate-spin" /> : <HardDrive size={16} />}
              Prepara uso offline
            </button>
            {offlineMessage && (
              <p className="mt-2 text-[11px] text-slate-600">{offlineMessage}</p>
            )}
          </section>

          {!SUPABASE_MODE ? (
            <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              Modalità locale: l’account è simulato e i dati restano in questo browser.
            </p>
          ) : (
            <>
              <section>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-800">
                  <KeyRound size={15} className="text-emerald-600" /> Cambia password
                </h3>
                <form onSubmit={handlePassword} className="space-y-2">
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    className="field"
                    placeholder="Nuova password (min. 6 caratteri)"
                    minLength={6}
                    autoComplete="new-password"
                  />
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    className="field"
                    placeholder="Ripeti la nuova password"
                    minLength={6}
                    autoComplete="new-password"
                  />
                  <button type="submit" disabled={busy !== null} className="btn btn-primary w-full">
                    {busy === 'password' ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}
                    Aggiorna password
                  </button>
                </form>
              </section>

              <section className="border-t border-slate-100 pt-4">
                <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-800">
                  <MailCheck size={15} className="text-emerald-600" /> Email
                </h3>
                <button type="button" onClick={handleResend} disabled={busy !== null} className="btn btn-neutral w-full">
                  {busy === 'resend' ? <Loader2 size={16} className="animate-spin" /> : <MailCheck size={16} />}
                  Reinvia email di conferma
                </button>
              </section>

              <section className="border-t border-slate-100 pt-4">
                <button type="button" onClick={handleSignOutEverywhere} disabled={busy !== null} className="btn btn-neutral w-full">
                  {busy === 'logout' ? <Loader2 size={16} className="animate-spin" /> : <LogOut size={16} />}
                  Esci da tutti i dispositivi
                </button>
              </section>

              <section className="rounded-xl border border-red-200 bg-red-50/60 p-3">
                <h3 className="mb-1 flex items-center gap-2 text-sm font-bold text-red-700">
                  <ShieldAlert size={15} /> Elimina account
                </h3>
                <p className="mb-2 text-[11px] text-red-600">
                  Elimina definitivamente account, progetti, allegati e prezzari. L’operazione non può essere annullata.
                </p>
                <input
                  value={deleteConfirm}
                  onChange={(event) => setDeleteConfirm(event.target.value)}
                  className="field mb-2"
                  placeholder="Scrivi ELIMINA per confermare"
                />
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={busy !== null || deleteConfirm.trim().toUpperCase() !== 'ELIMINA'}
                  className="btn w-full bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {busy === 'delete' ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                  Elimina account
                </button>
              </section>
            </>
          )}
        </div>

        <div className="flex justify-end border-t border-slate-200 px-4 py-3 sm:px-5">
          <button onClick={onClose} className="btn btn-neutral">Chiudi</button>
        </div>
      </div>
    </div>
  );
};
