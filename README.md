# Stimia

Applicazione web (PWA) per la gestione di computi metrici estimativi: struttura
WBS, voci di costo, prezzari, SAL (stati avanzamento lavori), condivisione con
team ed export Excel/PDF.

Il sito pubblicato è una SPA statica su **GitHub Pages**:
<https://luilin.github.io/Stimia/>

---

## Requisiti

- [Node.js](https://nodejs.org/) 22.13 o superiore (consigliata la versione LTS 24)
- npm (incluso in Node.js)

```bash
node -v
npm -v
```

---

## Avvio rapido (modalità locale)

```bash
npm install
npm run dev
```

Apri il browser su **http://localhost:3000**.

In modalità locale:

- puoi accedere con **qualsiasi email** e una password di almeno 6 caratteri;
- il pulsante **Accedi come utente demo** entra con `demo@locale.it`;
- i progetti sono salvati in **IndexedDB** (nessun dato viene inviato al cloud);
- i dati restano disponibili anche dopo aver riavviato il dev server, finché non
  svuoti i dati del sito.

> La modalità locale è attiva automaticamente con `npm run dev` e in tutte le
> build senza configurazione Supabase.

---

## Modalità cloud (Supabase)

L'app usa **Supabase** (Postgres + Auth + Storage) per sincronizzare i progetti
tra dispositivi e collaboratori. IndexedDB resta la cache offline e le modifiche
vengono inviate appena torna la connessione.

Attivazione: imposta `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`
(vedi `.env.example`).

- Guida completa e schema SQL: **[SUPABASE.md](./SUPABASE.md)**
- Schema: [`supabase/schema.sql`](supabase/schema.sql)
- Login Google: **[GOOGLE_LOGIN.md](./GOOGLE_LOGIN.md)**

---

## Build e deploy

```bash
npm run build            # build di produzione
npm run preview          # anteprima su http://localhost:4173
npm run build:local      # build forzata in modalità locale
npm run preview:local    # anteprima della build locale
```

La pubblicazione su GitHub Pages è automatica a ogni push su `main`
(workflow `.github/workflows/deploy.yml`). Istruzioni complete in
**[DEPLOY.md](./DEPLOY.md)**.

---

## Struttura del progetto

```
App.tsx                       Login, dashboard e routing tra le viste
index.tsx                     Entry point React
types.ts                      Tipi condivisi (Project, WBSNode, CostItem, SAL, ...)
components/
  Editor.tsx                  Editor principale del computo
  WBSTree.tsx                 Albero delle categorie WBS
  PriceBookPanel.tsx          Gestione prezzari (import PDF/Excel/JSON/XPWE)
  SALManager.tsx              Stati avanzamento lavori
  PrintPreview.tsx            Anteprima e stampa PDF
  TeamManagementModal.tsx     Condivisione e permessi
  siteManagement/             Cantiere: fornitori, RFQ, fatture, scadenze, firme
services/
  mode.ts                     Selezione modalità locale/Supabase
  auth.ts                     Autenticazione (locale o Supabase)
  storage.ts                  Accesso ai progetti (locale o Supabase)
  localProjects.ts            Archivio progetti in IndexedDB
  supabase.ts                 Client Supabase
  supabaseProjects.ts         CRUD progetti su Postgres + cache e coda offline
  cloudFiles.ts               Storage Supabase per allegati e prezzari
supabase/schema.sql           Tabelle, indici, trigger e policy RLS
supabase/migrations/          Migrazioni incrementali per progetti esistenti
.github/workflows/deploy.yml  Build e deploy su GitHub Pages
```

---

## Dati locali

I progetti sono salvati in **IndexedDB** (database `stimia_files`: store
`projects`, `priceBooks`, `attachments`, `versions`, `syncQueue`, `versionMeta`,
`syncMeta`, `syncConflicts`, `versionSyncQueue`). Al primo avvio i dati del
vecchio database vengono copiati automaticamente nel nuovo.

In `localStorage` restano solo sessione e preferenze:

| Chiave | Contenuto |
| --- | --- |
| `stimia_local_session` | Utente attualmente autenticato in locale |
| `stimia_editor_sidebar_width` | Larghezza della sidebar dell'editor |
| `stimia_uoms` | Unità di misura personalizzate |

Per cancellare tutto, dalla console del browser:

```js
localStorage.clear();
indexedDB.deleteDatabase('stimia_files');
location.reload();
```

---

## Comandi disponibili

| Comando | Descrizione |
| --- | --- |
| `npm run dev` | Dev server in modalità locale |
| `npm run dev:cloud` | Dev server collegato a Supabase (se configurato) |
| `npm run build` | Build di produzione (Supabase se configurato) |
| `npm run build:local` | Build di produzione in modalità locale |
| `npm run preview` | Anteprima della build |
| `npm run preview:local` | Anteprima della build locale |
| `npm run lint` | Controllo TypeScript (`tsc --noEmit`) |
| `npm test` | Test automatici (Vitest) |
| `npm run test:sql` | Test di funzioni, RPC e policy su Postgres WASM (PGlite) |
| `npm run test:e2e` | Test E2E autenticati (richiede un progetto Supabase di staging e la service role) |

---

## Note tecniche

- Tailwind CSS è compilato localmente tramite PostCSS.
- TypeScript è in modalità `strict` con i tipi di React (`@types/react`).
- PDF.js è installato come dipendenza npm e il worker viene servito da Vite:
  funziona offline.
- Le librerie pesanti (`xlsx`, `pdf.js`, `pdf-lib`, `pdfmake`) vengono caricate
  solo quando servono.
- `xlsx` è installato dal pacchetto ufficiale SheetJS 0.20.3 su CDN: il registro
  npm non riceve le versioni con le correzioni di sicurezza. `npm install` e
  `npm ci` richiedono accesso a `cdn.sheetjs.com`.
- `pdfjs-dist` 6.x richiede Node.js 22.13 o superiore per la build.
- Logo: `public/brand/stimia-lockup.png` (simbolo + wordmark) per login e
  intestazioni, `public/brand/stimia-badge.png` per header e interfaccia; le
  icone PWA hanno varianti `maskable` dedicate.
- L'editor salva automaticamente il progetto circa un secondo dopo ogni modifica,
  accoda i salvataggi per progetto e salva anche alla chiusura della scheda.
- I salvataggi cloud usano `updated_at` come token di concorrenza: se un altro
  utente ha modificato il progetto, il client non sovrascrive nulla e mostra le
  opzioni **Ricarica cloud / Sovrascrivi / Salva copia**.
- La cronologia versioni è condivisa nel cloud (max 20 per progetto) e ha una
  cache locale; gli snapshot completi vengono scaricati solo al ripristino.
- Il backup completo è in **ZIP** e include progetti, prezzari, allegati e
  versioni. Resta supportato anche l'import dei vecchi backup JSON.
- Il logo aziendale (PNG/JPEG, max 300 KB) si imposta dal pannello Stampa e
  viene usato nell'intestazione di anteprima e PDF.
- Il pulsante **Prepara uso offline** nell'Account precarica Excel, PDF,
  backup ZIP e motore di stampa.
- In modalità Supabase si scaricano solo i payload dei progetti nuovi o cambiati
  (`updated_at`); i metadati delle versioni evitano di rileggere gli snapshot.
- In modalità Supabase allegati e prezzari grandi vengono sincronizzati nel
  bucket privato `stimia-files`; IndexedDB resta la cache offline.

---

## Sicurezza

- Autenticazione e dati cloud usano Supabase Auth con policy **RLS**; il bucket
  `stimia-files` è privato e accessibile solo ai membri del progetto.
- Le policy distinguono proprietario, editor e viewer. Con le migrazioni
  [`20261118_granular_permissions.sql`](supabase/migrations/20261118_granular_permissions.sql)
  e [`20261119_data_safety.sql`](supabase/migrations/20261119_data_safety.sql)
  i permessi SAL/prezzari, la concorrenza, la cronologia versioni e l'offerta
  ditta sono applicati dal database; la ditta aggiorna solo i campi offerta e
  le proprie voci tramite una RPC dedicata, non il computo base.
- I documenti generati (HTML di stampa, XML FatturaPA, ICS, EML, PDF) passano
  da escape o sanitizzazione dei valori inseriti dall'utente.
- L'eliminazione dell'account cancella i dati cloud e la copia locale nel
  browser (IndexedDB e chiavi `stimia_*`).
- La chiave Supabase `anon`/publishable è pubblica per progettazione: la
  protezione dei dati dipende dalle policy RLS, non dalla segretezza della chiave.
- La build inietta una **Content-Security-Policy** (`script-src 'self'`, nessun
  script inline) compatibile con Supabase, PDF.js, PDFMake ed EmailJS. Le uniche
  eccezioni esterne sono i font opzionali dell'anteprima di stampa
  (`fonts.googleapis.com` / `fonts.gstatic.com`); senza rete si usano i font di
  sistema.
- La stampa HTML non carica più Tailwind da CDN: riutilizza il CSS compilato
  dell'app, quindi resta disponibile anche offline.

---

## Accessibilità

- I modali principali (progetti, team, allegati, strumenti, prezzario) usano
  `role="dialog"`, `aria-modal`, titoli collegati, etichette associate ai campi
  e nomi accessibili sui pulsanti icona.
- `Esc` chiude i modali di team, allegati, strumenti e anteprima allegati.
- I toggle usano `aria-pressed`; i messaggi di stato usano `aria-live`.
- Contrasto e focus da tastiera sono verificati: le schermate principali
  raggiungono **100** su Lighthouse Accessibility.

---

## Risoluzione problemi

**La porta 3000 è occupata**

Vite sceglie automaticamente la porta successiva (es. 3001). In alternativa
chiudi il processo che occupa la porta e riavvia.

**`node` o `npm` non riconosciuti**

Installa Node.js LTS da <https://nodejs.org/> e riapri il terminale.

**Il login Google non compare o non funziona**

Verifica la configurazione descritta in [GOOGLE_LOGIN.md](./GOOGLE_LOGIN.md).

**Spazio locale esaurito**

Svuota i dati locali (vedi sopra) o usa la modalità Supabase.
