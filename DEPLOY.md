# Deploy — GitHub Pages

Stimia è una SPA (Vite + React) senza backend: viene pubblicata come sito
statico su **GitHub Pages**. I dati e l'autenticazione sono gestiti da
**Supabase** quando le relative variabili sono configurate, altrimenti l'app
funziona in **modalità locale** con i dati nel browser.

---

## 1. Modalità dati

La modalità si sceglie in fase di **build**.

| Modalità | Comportamento | Cosa serve |
| --- | --- | --- |
| **Supabase** (consigliata) | Login reale, dati su Postgres, cache offline e sincronizzazione | `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` |
| **Locale** | Login simulato, dati in IndexedDB nel browser | niente |

Con le due variabili Supabase presenti la build usa il cloud SQL; senza di esse
usa automaticamente la modalità locale. Non esistono altre modalità dati.

La configurazione Supabase è descritta in **[SUPABASE.md](./SUPABASE.md)**, il
login Google in **[GOOGLE_LOGIN.md](./GOOGLE_LOGIN.md)**.

> I dati locali e quelli Supabase sono archivi separati: cambiare modalità non
> migra i progetti.

---

## 2. Deploy automatico

Il workflow `.github/workflows/deploy.yml` esegue a ogni push su `main`:

1. `npm ci`
2. `npm run lint` (TypeScript)
3. `npm test` (Vitest)
4. `npm run build`
5. pubblicazione della cartella `dist` su GitHub Pages

### Segreti del repository

In **Settings → Secrets and variables → Actions** aggiungi:

| Nome | Valore |
| --- | --- |
| `VITE_SUPABASE_URL` | URL del progetto Supabase |
| `VITE_SUPABASE_ANON_KEY` | Chiave publishable/anon |

Se i segreti Supabase non sono presenti, il workflow compila una build in
modalità locale.

### Base path

Su GitHub Pages il sito vive in `https://<utente>.github.io/<repository>/`.
Il workflow imposta automaticamente `VITE_BASE_PATH` usando il nome del
repository. Per un dominio personalizzato o un percorso diverso, crea la
variabile di repository `VITE_BASE_PATH` (es. `/` per la radice).

---

## 3. Verifica in locale

```bash
npm install
npm run dev              # sviluppo in modalità locale
npm run dev:cloud        # sviluppo collegato a Supabase (se configurato)
npm run build            # build di produzione
npm run preview          # anteprima della build
npm run build:local      # build forzata in modalità locale
npm run preview:local    # anteprima della build locale
```

---

## 4. PWA e aggiornamenti

Il service worker (`public/sw.js`) mette in cache l'app shell e gli asset con
hash. Dopo un deploy:

1. il nuovo `index.html` viene preso dalla rete (navigazione network-first);
2. i nuovi asset hanno nomi con hash, quindi non restano versioni vecchie;
3. se l'app è installata, compare il banner **“Nuova versione disponibile”**.

Per distribuire modifiche al service worker, incrementa `CACHE_NAME` in
`public/sw.js`: l'attivazione elimina le cache precedenti.
