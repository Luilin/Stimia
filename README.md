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
`syncMeta`). Al primo avvio i dati del vecchio database vengono copiati
automaticamente nel nuovo.

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
- In modalità Supabase si scaricano solo i payload dei progetti nuovi o cambiati
  (`updated_at`); i metadati delle versioni evitano di rileggere gli snapshot.
- In modalità Supabase allegati e prezzari grandi vengono sincronizzati nel
  bucket privato `stimia-files`; IndexedDB resta la cache offline.

---

## Sicurezza

- Autenticazione e dati cloud usano Supabase Auth con policy **RLS**; il bucket
  `stimia-files` è privato e accessibile solo ai membri del progetto.
- Le policy distinguono proprietario, editor e viewer. I permessi più fini
  (SAL, prezzari, offerta ditta) sono applicati dall'interfaccia; a livello di
  database un membro abilitato alla scrittura può aggiornare il payload del
  progetto. È un compromesso noto del modello attuale.
- I documenti generati (HTML di stampa, XML FatturaPA, ICS, EML, PDF) passano
  da escape o sanitizzazione dei valori inseriti dall'utente.
- L'eliminazione dell'account cancella i dati cloud e la copia locale nel
  browser (IndexedDB e chiavi `stimia_*`).
- La chiave Supabase `anon`/publishable è pubblica per progettazione: la
  protezione dei dati dipende dalle policy RLS, non dalla segretezza della chiave.

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
