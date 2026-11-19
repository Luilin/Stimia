# Applicazione manuale su Supabase

Il file canonico resta
[`../migrations/20261119_data_safety.sql`](../migrations/20261119_data_safety.sql).
Questi blocchi sono la stessa migrazione divisa in parti sotto i 5 KB, per il
SQL Editor di Supabase, che in alcuni browser tronca gli incollaggi lunghi.

Eseguili **in ordine**, uno alla volta, aspettando `Success` prima del
successivo:

1. `01_permessi_ditta.sql`
2. `02_salvataggio_sal.sql`
3. `03_fusione_offerta.sql`
4. `04_rpc_offerta.sql`
5. `05_versioni_e_schema.sql`

Sono idempotenti: puoi rieseguirli senza duplicare dati.

Alla fine esegui [`../verify_data_safety.sql`](../verify_data_safety.sql): tutti
i controlli devono risultare `PASS`, in particolare:

- `Colonna can_edit_offer`
- `Funzione save_project_offer`
- `Ditta senza scrittura completa`
- `Versione schema >= 5`

Se modifichi la migrazione canonica, rigenera questi blocchi con lo stesso
taglio:
`1-113`, `114-220`, `221-332`, `333-430`, `431-546`.
