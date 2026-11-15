# Login con Google

Il codice è già pronto: pulsante, redirect OAuth e ripresa della sessione al
ritorno. Manca solo l'attivazione del provider, che richiede le credenziali del
**tuo** account Google (Client ID e Client Secret). Senza quelle Supabase non può
avviare il flusso OAuth.

> Il pulsante **Accedi con Google** viene mostrato automaticamente solo quando il
> provider è attivo: finché è disattivato resta nascosto, così nessuno incontra un
> pulsante che restituisce errore.

## 1. Google Cloud Console

1. Apri <https://console.cloud.google.com/apis/credentials>.
2. Seleziona (o crea) un progetto, ad esempio **Stimia**.
3. Configura la schermata di consenso: **OAuth consent screen**
   - tipo **External**;
   - nome app **Stimia**, email di supporto e email dello sviluppatore;
   - scope: `openid`, `email`, `profile` (sono già quelli predefiniti).
   - In **Testing** possono accedere solo gli utenti di test che aggiungi;
     per aprirlo a tutti pubblica l'app (**Publish app**). Gli scope richiesti
     non sono sensibili, quindi non serve la verifica Google.
4. **Create credentials → OAuth client ID → Web application**.
   - Nome: `Stimia Web`
   - **Authorized JavaScript origins**:
     - `https://luilin.github.io`
     - `http://localhost:3000`
   - **Authorized redirect URIs**:
     - `https://kywyqxbncqmwhroyucdq.supabase.co/auth/v1/callback`
5. Copia **Client ID** e **Client Secret**.

## 2. Supabase

1. Apri <https://supabase.com/dashboard/project/kywyqxbncqmwhroyucdq/auth/providers>.
2. **Google** → attiva **Enable Sign In with Google**.
3. Incolla **Client ID** e **Client Secret** → **Save**.
4. Vai in **Authentication → URL Configuration**:
   - **Site URL**: `https://luilin.github.io/Stimia/`
   - **Redirect URLs**, aggiungi:
     - `https://luilin.github.io/Stimia/`
     - `http://localhost:3000/`
     - `http://localhost:4173/`
5. Salva.

## 3. Verifica

Non serve rifare la build: al primo caricamento l'app legge la configurazione del
provider e mostra il pulsante.

Controllo rapido da terminale:

```powershell
$k = 'sb_publishable_t9GR1CkUT9XE5cPv76PiRA_uG4Egwz0'
(Invoke-RestMethod -Uri 'https://kywyqxbncqmwhroyucdq.supabase.co/auth/v1/settings' -Headers @{ apikey = $k }).external.google
```

Deve restituire `True`. Poi apri <https://luilin.github.io/Stimia/>, clicca
**Accedi con Google** e verifica di tornare sull'app già autenticato.

## Se vuoi che lo configuri io

Serve un **Personal Access Token** Supabase
(<https://supabase.com/dashboard/account/tokens>) e le credenziali OAuth Google.
Non incollarle in chat: salvale in un file locale `.env.google.local` nella
cartella del progetto (è ignorato da Git):

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SUPABASE_ACCESS_TOKEN=...
```

Poi chiedimi di configurare il provider: uso la Management API di Supabase, non
salvo i segreti nel repository e cancello il file al termine.
