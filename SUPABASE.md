# Database SQL con Supabase

L'app può salvare i computi su un database **Postgres** gestito da Supabase, restando
ospitata su GitHub Pages. GitHub Pages serve solo file statici: il database è un
servizio esterno raggiunto via HTTPS, protetto da login e Row Level Security.

## Come funziona

- **Login**: Supabase Auth (email + password; Google se il provider è abilitato:
  il pulsante compare solo in quel caso).
- **Progetti**: tabella `projects` con i dati indicizzati (`owner_id`, `name`,
  `last_modified`) e il computo completo in `payload` (jsonb).
- **Condivisione**: tabella `project_members` (email e ruolo `editor`/`viewer`).
  Il ruolo è applicato anche dalle policy RLS, non solo dall'interfaccia.
- **Allegati e prezzari**: i file stanno nel bucket privato `stimia-files`
  (`<project>/attachments/...`, `<project>/price-books/...`), con cache locale
  in IndexedDB per l'uso offline.
- **Sicurezza**: Row Level Security: ogni utente vede solo i propri progetti e
  quelli condivisi con la sua email; solo gli editor possono scrivere. Il
  proprietario non può essere cambiato da un collaboratore. La chiave `anon`
  può stare nel frontend perché da sola non dà accesso a nulla senza login.
- **Account**: cambio password, recupero via email, eliminazione account
  (`delete_own_account`) e uscita da tutti i dispositivi.
- **Offline**: IndexedDB resta la cache locale. Ogni modifica viene salvata subito
  in locale e inviata a Supabase; se sei offline finisce in una coda persistente
  (`syncQueue`) e viene inviata al ritorno della connessione.

## Migrazioni

Le modifiche allo schema sono in `supabase/migrations/`. Per un progetto già
esistente esegui la migrazione più recente dal **SQL Editor**:

- [`20261115_security_storage.sql`](supabase/migrations/20261115_security_storage.sql)
  — ruoli RLS, protezione proprietario, tabella allegati, bucket
  `stimia-files` e funzione di eliminazione account.
- [`20261115_storage_policy_fix.sql`](supabase/migrations/20261115_storage_policy_fix.sql)
  — correzione delle policy Storage per i percorsi con più livelli.
- [`20261118_granular_permissions.sql`](supabase/migrations/20261118_granular_permissions.sql)
  — permessi granulari: colonne `can_write`, `can_edit_sal`,
  `can_edit_price_books`, RPC `save_project_parts` per SAL/prezzari e policy
  aggiornate. Il client funziona anche prima di applicarla (fallback
  compatibile); dopo l'esecuzione i permessi parziali sono applicati dal DB.
- [`20261118_revoke_anon_functions.sql`](supabase/migrations/20261118_revoke_anon_functions.sql)
  — revoca `EXECUTE` al ruolo `anon` sulle funzioni granulari (Supabase lo
  concede per default). Da eseguire se la migrazione precedente era già stata
  applicata prima di questo aggiornamento.
- [`20261118_fix_storage_path.sql`](supabase/migrations/20261118_fix_storage_path.sql)
  — corregge le policy Storage: il percorso va qualificato come
  `storage.objects.name`, altrimenti `name` viene risolto come
  `projects.name` e gli upload vengono bloccati. Da eseguire se la migrazione
  granulare era già stata applicata.
- [`20261119_data_safety.sql`](supabase/migrations/20261119_data_safety.sql)
  — concorrenza ottimistica per SAL/prezzari (`save_project_parts_v2`),
  cronologia versioni condivisa (`project_versions`), limite server-side a 20
  versioni e versione schema leggibile dall'app.

`supabase/schema.sql` contiene già tutto per le installazioni nuove.

## Verifica

Dopo aver applicato le migrazioni, esegui
[`supabase/verify_security.sql`](supabase/verify_security.sql) e
[`supabase/verify_data_safety.sql`](supabase/verify_data_safety.sql) nel **SQL
Editor**: sono controlli read-only che restituiscono `PASS`/`FAIL` per colonne
granulari, funzioni, privilegi `anon`, RLS, policy Storage, versioni e
concorrenza.

## Configurazione (una volta sola)

1. Crea un progetto gratuito su <https://supabase.com>.
2. Apri **SQL Editor → New query**, incolla il contenuto di
   [`supabase/schema.sql`](supabase/schema.sql) e premi **Run**.
3. Vai in **Authentication → Sign In / Providers → Email**:
   - tieni attivo *Enable email provider*;
   - per provare subito, disattiva *Confirm email* (altrimenti devi confermare
     l'indirizzo prima del primo accesso).
4. Per il login con Google: **Authentication → Providers → Google**, inserisci
   Client ID e Secret del progetto Google Cloud e aggiungi tra i redirect
   `https://<tuo-progetto>.supabase.co/auth/v1/callback`.
   Procedura dettagliata: **[GOOGLE_LOGIN.md](./GOOGLE_LOGIN.md)**.
5. Copia **Project URL** e **anon public key** da **Project Settings → API**.

## In locale

Copia `.env.example` in `.env.local` e compila:

```bash
VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

Poi esegui `npm run dev:cloud` per usare Supabase in sviluppo. Senza
`VITE_LOCAL_MODE=false` il dev server resta in modalità locale (IndexedDB), così
non si toccano i dati cloud durante lo sviluppo.

## Su GitHub Pages

Il build deve ricevere le due variabili. Due modi:

**A. Repository secrets (consigliato)** — in *Settings → Secrets and variables →
Actions* crea `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`. Il workflow in
`.github/workflows/deploy.yml` le passa al build.

**B. Variabili nel workflow** — scrivile direttamente nella sezione `env:` del
workflow (sono comunque pubbliche: la chiave `anon` è pensata per il browser).

Se il sito sta in `https://utente.github.io/nome-repository/`, imposta anche:

```bash
VITE_BASE_PATH=/nome-repository/
```

altrimenti lascia `/`.

> ⚠️ Non usare mai la chiave `service_role` nel frontend: bypassa la RLS.

## Verifica rapida

- Dopo il login, crea un computo: deve comparire in **Table Editor → projects**.
- Apri l'app da un altro dispositivo con lo stesso account: il computo c'è.
- Stacca la rete e modifica un computo: il badge in alto diventa **Offline**;
  riattiva la rete e la modifica viene inviata da sola.
