import { SUPABASE_MODE } from './mode';
import { supabase } from './supabase';

/**
 * Utente semplificato usato dall'interfaccia. In modalità Supabase viene
 * mappato dall'utente autenticato, in modalità locale viene salvato nel browser.
 */
export interface AuthUser {
  uid: string;
  email: string;
  displayName?: string | null;
}

type AuthListener = (user: AuthUser | null) => void;

const SESSION_KEY = 'stimia_local_session';

/**
 * Supabase reindirizza qui dopo il link di recupero password con
 * `#...&type=recovery`. Va letto prima che il client rimuova l'hash.
 */
const passwordRecoveryRedirect =
  typeof window !== 'undefined' && /(?:^|[#&])type=recovery(?:$|[&])/.test(window.location.hash);

export const isPasswordRecoveryRedirect = (): boolean => passwordRecoveryRedirect;

function appRedirectUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const base = import.meta.env.BASE_URL || '/';
  return window.location.origin + base;
}

const localListeners = new Set<AuthListener>();

/** Utente Supabase correntemente autenticato (aggiornato dagli eventi auth). */
let cloudUser: AuthUser | null = null;

function mapSupabaseUser(user: {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, any> | null;
}): AuthUser {
  const metadata = user.user_metadata || {};
  return {
    uid: user.id,
    email: user.email || '',
    displayName: metadata.full_name || metadata.name || null,
  };
}

// Recupera subito la sessione salvata, così la dashboard non "sfarfalla"
// al primo render.
if (SUPABASE_MODE && supabase) {
  supabase.auth
    .getSession()
    .then(({ data }) => {
      cloudUser = data.session?.user ? mapSupabaseUser(data.session.user) : null;
      emitLocal(cloudUser);
    })
    .catch(() => {
      cloudUser = null;
    });
}

function emitLocal(user: AuthUser | null) {
  localListeners.forEach((listener) => listener(user));
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function localUidForEmail(email: string): string {
  // UID stabile e leggibile, sufficiente per la modalità locale.
  let hash = 0;
  const value = normalizeEmail(email);
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return `local-${Math.abs(hash).toString(36)}-${value.length}`;
}

function readLocalSession(): AuthUser | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthUser;
    if (!parsed || typeof parsed.email !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLocalSession(user: AuthUser | null) {
  if (typeof window === 'undefined') return;
  if (user) {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  } else {
    window.localStorage.removeItem(SESSION_KEY);
  }
}

export function getCurrentUser(): AuthUser | null {
  if (SUPABASE_MODE) return cloudUser;
  return readLocalSession();
}

export function onAuthStateChanged(listener: AuthListener): () => void {
  if (SUPABASE_MODE) {
    localListeners.add(listener);
    let unsubscribe: (() => void) | null = null;

    if (supabase) {
      supabase.auth
        .getSession()
        .then(({ data }) => {
          cloudUser = data.session?.user ? mapSupabaseUser(data.session.user) : null;
          if (localListeners.has(listener)) listener(cloudUser);
        })
        .catch(() => {
          if (localListeners.has(listener)) listener(null);
        });

      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        cloudUser = session?.user ? mapSupabaseUser(session.user) : null;
        if (localListeners.has(listener)) listener(cloudUser);
      });
      unsubscribe = () => data.subscription.unsubscribe();
    } else {
      Promise.resolve().then(() => {
        if (localListeners.has(listener)) listener(null);
      });
    }

    return () => {
      localListeners.delete(listener);
      unsubscribe?.();
    };
  }

  localListeners.add(listener);
  // Chiamata asincrona per imitare il comportamento del cloud.
  Promise.resolve().then(() => {
    if (localListeners.has(listener)) listener(readLocalSession());
  });
  return () => {
    localListeners.delete(listener);
  };
}

export async function signInWithEmail(
  email: string,
  password: string,
  register = false,
): Promise<AuthUser> {
  if (SUPABASE_MODE) {
    if (!supabase) throw new Error('Supabase non configurato.');
    if (!email.trim() || password.length < 6) {
      throw new Error('Inserisci una email valida e una password di almeno 6 caratteri.');
    }

    if (register) {
      const { data, error } = await supabase.auth.signUp({
        email: normalizeEmail(email),
        password,
      });
      if (error) throw new Error(error.message);
      if (!data.session || !data.user) {
        throw new Error('Registrazione inviata: conferma l’indirizzo dalla mail, poi accedi.');
      }
      const user = mapSupabaseUser(data.user);
      cloudUser = user;
      emitLocal(user);
      return user;
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email: normalizeEmail(email),
      password,
    });
    if (error) throw new Error(error.message);
    if (!data.user) throw new Error('Accesso non riuscito.');
    const user = mapSupabaseUser(data.user);
    cloudUser = user;
    emitLocal(user);
    return user;
  }

  if (!email.trim() || password.length < 6) {
    throw new Error('Inserisci una email valida e una password di almeno 6 caratteri.');
  }
  const user: AuthUser = {
    uid: localUidForEmail(email),
    email: normalizeEmail(email),
    displayName: null,
  };
  writeLocalSession(user);
  emitLocal(user);
  return user;
}

export async function signInWithGoogle(): Promise<AuthUser> {
  if (SUPABASE_MODE) {
    if (!supabase) throw new Error('Supabase non configurato.');
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: appRedirectUrl(),
        queryParams: { prompt: 'select_account' },
      },
    });
    if (error) throw new Error(error.message);
    // Il browser viene reindirizzato a Google: la sessione arriva al ritorno.
    return cloudUser || { uid: '', email: '', displayName: null };
  }

  // In locale non serve un popup: si entra con un account demo.
  const user: AuthUser = {
    uid: localUidForEmail('demo@locale.it'),
    email: 'demo@locale.it',
    displayName: 'Utente Demo',
  };
  writeLocalSession(user);
  emitLocal(user);
  return user;
}

export async function signOut(): Promise<void> {
  if (SUPABASE_MODE) {
    if (supabase) await supabase.auth.signOut();
    cloudUser = null;
    emitLocal(null);
    return;
  }

  writeLocalSession(null);
  emitLocal(null);
}

export async function sendPasswordReset(email: string): Promise<void> {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error('Inserisci la tua email.');

  if (SUPABASE_MODE) {
    if (!supabase) throw new Error('Supabase non configurato.');
    const { error } = await supabase.auth.resetPasswordForEmail(normalized, {
      redirectTo: appRedirectUrl(),
    });
    if (error) throw new Error(error.message);
    return;
  }

  throw new Error('In modalità locale non serve recuperare la password: puoi entrare con una email qualsiasi.');
}

export async function updatePassword(password: string): Promise<void> {
  if (password.length < 6) {
    throw new Error('La password deve avere almeno 6 caratteri.');
  }

  if (SUPABASE_MODE) {
    if (!supabase) throw new Error('Supabase non configurato.');
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw new Error(error.message);
    return;
  }

  throw new Error('La password è simulata in modalità locale.');
}

export async function resendConfirmation(email: string): Promise<void> {
  const normalized = normalizeEmail(email);

  if (SUPABASE_MODE) {
    if (!supabase) throw new Error('Supabase non configurato.');
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: normalized,
      options: { emailRedirectTo: appRedirectUrl() },
    });
    if (error) throw new Error(error.message);
    return;
  }

  throw new Error('Non serve in modalità locale.');
}

export async function signOutEverywhere(): Promise<void> {
  if (SUPABASE_MODE) {
    if (supabase) await supabase.auth.signOut({ scope: 'global' });
    cloudUser = null;
    emitLocal(null);
    return;
  }

  await signOut();
}

export async function deleteAccount(): Promise<void> {
  if (SUPABASE_MODE) {
    if (!supabase) throw new Error('Supabase non configurato.');
    const { error } = await supabase.rpc('delete_own_account');
    if (error) throw new Error(error.message);
    await supabase.auth.signOut();
    cloudUser = null;
    emitLocal(null);
    return;
  }

  throw new Error('Eliminazione account non disponibile in modalità locale.');
}

export function onPasswordRecovery(listener: () => void): () => void {
  if (!SUPABASE_MODE || !supabase) return () => {};

  const { data } = supabase.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') listener();
  });

  return () => data.subscription.unsubscribe();
}
