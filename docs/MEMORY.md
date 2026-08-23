# Memoria cognitiva nativa

Zelari Code può condividere conoscenza di progetto tra AgentHarness, Council,
tentacoli Kraken, missioni e sessioni successive. La V2 è locale, non richiede
MCP né un servizio esterno e conserva la provenienza di ogni informazione.

## Attivazione

Il comportamento storico JSONL resta il default. Per attivare SQLite V2:

```powershell
$env:ZELARI_MEMORY_V2 = '1'
zelari-code
```

È equivalente impostare `ZELARI_MEMORY_BACKEND=sqlite`. Quando V2 è attiva,
le scritture automatiche sono abilitate; `ZELARI_MEMORY_AUTO_WRITE=0` mantiene
il recall ma disabilita le nuove memorie prodotte dagli agenti.

| Variabile | Effetto |
|---|---|
| `ZELARI_MEMORY=0` | Disabilita ogni backend di memoria |
| `ZELARI_MEMORY_V2=1` | Attiva il servizio nativo SQLite |
| `ZELARI_MEMORY_BACKEND=sqlite` | Seleziona esplicitamente SQLite V2 |
| `ZELARI_MEMORY_BACKEND=file` | Forza il backend JSONL compatibile |
| `ZELARI_MEMORY_AUTO_WRITE=0` | Recall attivo, auto-write disattivato |
| `ZELARI_MEMORY_SEMANTIC=1` | Abilita indice e recall semantico ibrido |
| `ZELARI_EMBED_MODEL=<id>` | Modello embedding (default `text-embedding-3-small`) |
| `ZELARI_EMBED_TIMEOUT_MS=<ms>` | Timeout embedding, limitato a 1–120 secondi |
| `ZELARI_MEMORY_SEMANTIC_MIN_SCORE=<0..1>` | Soglia semantica (default `0.15`) |
| `ZELARI_MEMORY_MCP=1` | Abilita il server MCP esterno opzionale |
| `ZELARI_MEMORY_MCP_ADMIN=1` | Consente mutazioni MCP non owner (sconsigliato) |
| `ZELARI_MEMORY_STRICT=1` | Rende fatale l'errore di inizializzazione V2 |

Un uso esplicito di `/memory` inizializza il backend SQLite per ispezionarlo,
anche senza flag, a meno che `ZELARI_MEMORY=0` sia impostata.

## Persistenza e modello

Il database si trova in `.zelari/memory/memory.db`. SQLite usa WAL e un worker
dedicato, quindi query e scritture non bloccano l'event loop dell'agente. Ogni
progetto riceve uno scope derivato dal path reale canonico: il recall non
attraversa automaticamente i confini tra repository.

Il database usa migrazioni forward-only con `PRAGMA user_version`. Una
migrazione da un database esistente acquisisce un lock, esegue un checkpoint
WAL e crea prima un backup `memory.db.v<origine>.bak`. Un runtime meno recente
rifiuta uno schema futuro; una migrazione fallita viene rollbackata.

Una memoria contiene:

- kind controllato (`fact`, `decision`, `finding`, `failure`, `verification`,
  `outcome`, ecc.);
- importance, confidence e stato del ciclo di vita;
- visibilità `project` oppure `private` (owner esterno);
- provenienza strutturata (agente, sessione, missione, slice, tentacolo, file,
  simbolo, commit e verifica);
- tag e metadata limitati;
- revisioni immutabili per update, retraction e supersession;
- archi tipizzati come `supports`, `derived_from`, `validated_by`,
  `invalidated_by` e `supersedes`.

Il vecchio `.zelari/memory/log.jsonl` viene importato una volta in modo
idempotente, mantenendo timestamp e riferimenti legacy. Il file sorgente non
viene cancellato.

## Recall e sicurezza

Il recall combina FTS lessicale, filtri, importance, confidence, recency e
prossimità nel grafo. Se non esiste un indice semantico, il suo peso viene
redistribuito: gli embedding non sono necessari. `buildContext()` produce un
blocco `[ZELARI MEMORY]` con budget caratteri rigido e provenienza visibile;
nodi retratti, archiviati o superseduti non vengono iniettati come conoscenza
corrente.

Contenuto, source e metadata attraversano un secret scanner. Chiavi private
sono rifiutate; token noti, assegnazioni di credenziali e stringhe ad alta
entropia vengono redatti. La telemetria contiene solo identificatori e misure,
mai il testo delle memorie.

### Indice semantico opzionale

Con `ZELARI_MEMORY_SEMANTIC=1`, Zelari riusa il provider embedding configurato
ma mantiene un indice memoria indipendente. Ogni vettore conserva model ID,
dimensioni e SHA-256 del contenuto: un update invalida il vettore precedente e
impedisce l'uso di dati stale. Il recall indicizza pigramente un piccolo lotto;
una ricostruzione esplicita e interrompibile è disponibile con:

```text
/memory index
/memory index --force
```

Errori di provider, vettori corrotti o modello assente degradano sempre al
recall FTS/lessicale deterministico.
Scansione vettoriale, validazione dell'indice e hashing avvengono nel worker
SQLite; al processo agente tornano soltanto i migliori candidati, evitando di
bloccare l'event loop o trasferire l'intero indice.
L'attivazione è esplicita anche perché il provider configurato può essere
remoto: il contenuto già sanitizzato delle memorie viene inviato al suo endpoint
embedding. Per dati che non devono uscire dalla macchina usare un provider
locale oppure lasciare il semantic recall disabilitato.

## Comandi

```text
/memory
/memory stats
/memory search <query>
/memory show <id>
/memory related <id>
/memory history <id>
/memory retract <id> [reason]
/memory forget <id> --yes
/memory consolidate [query]
/memory index [--force]
/memory promote <id>
/memory doctor
/memory export [path-relativo-al-progetto]
```

`retract` mantiene revisioni e provenienza ed è la scelta normale. `forget`
esegue una cancellazione fisica (nodo, archi e storia) e richiede `--yes`.
L'export non può scrivere fuori dal progetto.
`promote` accetta soltanto conoscenza durevole e attiva (`fact`, `decision`,
`constraint`, `preference`, `procedure`) e la inserisce in un blocco gestito e
idempotente di `AGENTS.md`; la consolidazione non modifica mai quel file da
sola.

## MCP esterno (opzionale)

MCP non è usato da AgentHarness, Council, Kraken, missioni, headless o Desktop.
Per esporre lo stesso servizio a un client esterno:

```powershell
$env:ZELARI_MEMORY_V2 = '1'
$env:ZELARI_MEMORY_MCP = '1'
zelari-code --trust .
zelari-code --memory-mcp --cwd . --client-id cursor-local
```

Il server stdio espone `zelari_memory_search`, `get`, `add`, `link`, `history`
e `retract`, oltre alle risorse `zelari://memory/...`. Le scritture richiedono
il `project_id` esatto, ricevono sempre `source.client`, attraversano lo stesso
secret scanner e sono limitate per minuto. Le memorie MCP sono `private` per
default; un altro client vede soltanto memorie `project` e le proprie private.
Retraction e relazioni con effetti di lifecycle sono owner-only, salvo opt-in
amministrativo esplicito.
`--client-id` (o `ZELARI_MEMORY_MCP_CLIENT_ID`) rende stabile l'ownership tra
riavvii. È un confine locale fra client dello stesso utente, non un sistema di
autenticazione remoto; il folder trust e i permessi del filesystem restano il
confine di sicurezza principale.

## Desktop

Il pannello progetto di Zelari Desktop include il tab **Memory**: ricerca e
filtri per tipo, indicatori importance/confidence, stato corrente, visibilità,
provenienza, relazioni e timeline delle revisioni. Desktop usa il bridge JSON
di sola lettura della CLI e non accede mai direttamente al database.

## Separazione dagli altri livelli

- `.zelari/state/` resta lo stato verificato e ripristinabile.
- `.zelari/sessions/` resta la cronologia event-sourced.
- `AGENTS.MD` resta il livello curato e stabile per umani e agenti.
- MCP è opzionale e, quando disponibile, deve adattare `MemoryService`; non è
  il trasporto usato internamente da Zelari.

In caso di errore, il default è warning e continuazione senza memoria. Esegui
`/memory doctor` per integrità, foreign key, versione schema e disponibilità
FTS; usa `ZELARI_MEMORY_STRICT=1` soltanto negli ambienti che richiedono la
memoria come precondizione.

Per il gate mirato: `npm run test:memory`. La suite include restart,
supersession, migrazione/rollback, indice semantico corrotto, privacy MCP,
round-trip MCP↔nativo e metriche Recall@K/precision/stale/duplicate/p95.
