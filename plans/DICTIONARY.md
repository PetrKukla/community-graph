# community-graph — Slovník jmen (názvy mimo batch)

## Zařazení

Součást **Části 4 — Propojení** — detailní rozpad §4.1 z [`plans/INTEGRATION.md`](INTEGRATION.md).
Mění kontrakt `POST /api/v1/batches` z Části 1 a přidává endpoint `POST /api/v1/dictionary`.
Navazuje na hotovou pipeline (M1–M4): ingest → clusterize → enrich → graph-write.

**Motivace.** Dnes názvy (`guild.name`, `channel.name`, `author.username` / `display_name`)
tečou **společně s každou dávkou zpráv**. To má tři problémy:

1. Dávka zpráv nese redundantní data — u milionu zpráv se stejné jméno pošle tisíckrát.
2. Když se někdo přejmenuje, není jak to do systému dostat jinak než další dávkou zpráv
   z daného kanálu.
3. Není jasné, kdo je „vlastníkem pravdy“ o názvu — poslední dávka? První? Ruční oprava?

**Cílový stav.** Názvy se posílají zvlášť, přírůstkově (jen to, co se změnilo), přes
`POST /api/v1/dictionary`. Dávky zpráv nesou **jen ID**. Jediný zdroj pravdy o názvech jsou
sloupce v SQLite (`guilds.name`, `channels.name`, `users.username` / `display_name`), plněné
výhradně tímto endpointem. Názvy se propíšou do Neo4j, takže jsou vidět v grafové vizualizaci.

## Výchozí stav — kde dnes názvy žijí

| Vrstva                                        | Co drží název      | Kdo to zapisuje                                            |
| --------------------------------------------- | ------------------ | ---------------------------------------------------------- |
| SQLite `guilds.name`                          | název serveru      | `ingestBatch()` — `onConflictDoUpdate` z `req.guild.name`  |
| SQLite `channels.name`, `channels.type`       | název + typ kanálu | `ingestBatch()` z `req.channel`                            |
| SQLite `users.username`, `users.display_name` | jména uživatele    | `ingestBatch()` z `req.messages[].author`                  |
| Neo4j `Channel.name`                          | název kanálu       | `graph-write` (`MERGE_DISCUSSION_AND_CHANNEL`), z payloadu |
| Neo4j `User.username`, `User.display_name`    | jména uživatele    | `graph-write` (`MERGE_PARTICIPANTS`), z participantů       |
| Neo4j — **server nemá vlastní uzel**          | —                  | jen `Channel.guild_id` jako property                       |

Web (`nodeCaption` v `Neo4jGraphStore`) už dnes preferuje `display_name` → `username` u `User`
a `name` u `Channel`; při `null` padá na `"(uživatel)"` / `"(kanál)"`. Server se v grafu
nikde nezobrazuje.

Klíčový důsledek: **`graph-write` bere názvy z SQLite v okamžiku zápisu diskuze.** Jakmile je
diskuze `written`, pozdější změna názvu v SQLite se do Neo4j sama nedostane — `graph-write`
už tu diskuzi znovu nesáhne. Propagaci změn do už zapsaného grafu musíme řešit zvlášť.

## Klíčová rozhodnutí

- **Žádná nová tabulka.** Autoritativními sloupci pro názvy zůstávají `guilds.name`,
  `channels.name` / `type`, `users.username` / `display_name`. `dictionary` endpoint je jen
  jediný povolený zapisovatel do nich; ingest tyto sloupce přestane sahat. Alternativa
  (samostatné `dictionary_*` tabulky nebo jedna polymorfní `names(kind,id,name)`) je čistší
  v oddělení „slovník vs. aktivita“, ale rozbila by desítky existujících čtení
  (`graphWriteRepository`, `statsRepository`, web) — nevyplácí se.
- **Přírůstkový upsert, ne replace.** Tělo požadavku obsahuje jen záznamy, které se změnily.
  Chybějící sekce / chybějící ID = beze změny. Idempotentní: opakované poslání stejných
  názvů nic nezapíše.
- **`null` maže, chybějící pole nechává být.** `name: null` explicitně vynuluje název (oprava
  špatně nasypaného jména). Když pole není v JSONu vůbec, hodnota se nemění.
- **Server (guild) dostane vlastní uzel `Guild` v Neo4j** + hranu `(Channel)-[:IN_GUILD]->(Guild)`.
  Bez toho není kam název serveru v grafu pověsit. Menší alternativa: property
  `Channel.guild_name` (bez uzlu) — server by ale nešel v grafu rozkliknout ani vyhledat.
- **SQLite se aktualizuje synchronně (HTTP 200), propagace do Neo4j zvlášť.** Zdroj pravdy
  musí být konzistentní hned. Propagace do Neo4j:
  - malý sync (do `[dictionary].inline_graph_propagation_max` změněných ID) → v tomtéž
    requestu, `MATCH (n {id}) SET n.name = …` po ID;
  - velký sync → job typu `name_sync` (stejný vzor jako `graph_write`), request vrátí `job_id`.
  - Neo4j nedostupné → SQLite se stejně zapíše, odpověď má `graph.propagated: false`;
    obnova přes `POST /api/v1/dictionary/graph-resync`.
- **`MATCH ... SET`, ne `MERGE`.** Propagace aktualizuje jen uzly, které v grafu už jsou.
  Uzly pro uživatele/kanály, které se zatím nezúčastnily žádné zapsané diskuze, nevytváříme —
  název dostanou standardně při `graph-write`.
- **`POST /api/v1/batches` je breaking change.** Nové schéma: `guild {id}`, `channel {id, type?}`,
  `messages[].author {id}`. Pole s názvy se odmítají (`.strict()`), aby odesílatel neprodleně
  zjistil, že je posílá zbytečně. (Měkčí varianta: přijmout a ignorovat + deprecation hláška
  v README — viz [Otevřené otázky](#otevřené-otázky).)

## Datový model (SQLite)

Změny ve `src/db/sqlite/schema.ts`, migrace přes `bun run db:generate`:

```typescript
export const guilds = sqliteTable('guilds', {
  id: text('id').primaryKey(),
  name: text('name'),
  createdAt: text('created_at').notNull(),
  namesSyncedAt: text('names_synced_at') // NOVÉ: kdy dictionary naposledy sáhl na name
});

export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),
  guildId: text('guild_id').references(() => guilds.id),
  name: text('name'),
  type: text('type'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  namesSyncedAt: text('names_synced_at') // NOVÉ
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username'),
  displayName: text('display_name'),
  firstSeenAt: text('first_seen_at'), // ZMĚNA: notNull -> nullable (pre-seed jmen před 1. zprávou)
  lastSeenAt: text('last_seen_at'), // ZMĚNA: notNull -> nullable
  messageCount: integer('message_count').notNull().default(0),
  namesSyncedAt: text('names_synced_at') // NOVÉ
});
```

- `names_synced_at` je čistě pozorovací (debug „dorazil sync?“, web může hlásit stáří názvů).
  Když se nechce migrace tří sloupců, jde vypustit — endpoint pak nemá jak reportovat
  `unchanged` vs `updated`, jen upsertuje.
- `first_seen_at` / `last_seen_at` se uvolňují na nullable, protože „pošli všechna jména
  jednou dopředu“ vytvoří `users` řádek dřív, než přijde první zpráva. Ingest je při první
  zprávě dorovná (`first_seen_at = least(existing, now)`, `last_seen_at = greatest(...)`).

### `dictionaryRepository.ts` (nový)

```typescript
interface DictionarySyncRequest {
  guild?: { id: string; name?: string | null };
  channels?: { id: string; name?: string | null; type?: string | null }[];
  users?: {
    id: string;
    username?: string | null;
    display_name?: string | null;
  }[];
}

interface DictionarySyncResult {
  guild: { updated: number }; // 0 | 1
  channels: {
    received: number;
    created: number;
    updated: number;
    unchanged: number;
  };
  users: {
    received: number;
    created: number;
    updated: number;
    unchanged: number;
  };
  changedIds: {
    guildId: string | null;
    channelIds: string[];
    userIds: string[];
  };
}

export function syncDictionary(
  req: DictionarySyncRequest
): DictionarySyncResult;
```

- Jedna transakce. Pro každý řádek `insert(...).onConflictDoUpdate(...)`; „změněno“ se pozná
  porovnáním se současnou hodnotou (načíst existující řádky jedním `inArray` dotazem, pak
  diffovat) — kvůli `unchanged` počtu a hlavně kvůli `changedIds`, které jdou do propagace,
  aby se do Neo4j netlačily no-op `SET`.
- Vytvořené `users` řádky: `first_seen_at = last_seen_at = null`, `message_count = 0`.
- Vynechané pole (`name` není v objektu) → do `set` se nezahrne. `name: null` → `set` na `null`.
- Prázdné tělo (žádná ze tří sekcí) → volající vrstva odpoví `400`.

### `ingestRepository.ts` (změna)

- `guilds`: `insert(...).onConflictDoNothing()` — jen skeleton `{ id, createdAt: now }`, žádné `name`.
- `channels`: skeleton `{ id, guildId, type: null, createdAt, updatedAt }` na create;
  `onConflictDoUpdate` set **jen** `{ updatedAt: now }` (aktivita kanálu), žádné `name` / `type`.
  _(Pokud `type` zůstane v batchi — viz otevřené otázky — tady se drží.)_
- `users`: create `{ id, firstSeenAt: now, lastSeenAt: now, messageCount: 0 }` bez jmen;
  `onConflictDoUpdate` set `{ lastSeenAt: greatest, firstSeenAt: least }`, žádné `username` / `display_name`.
- Přepočet `messageCount` beze změny.

## HTTP API

### `POST /api/v1/dictionary`

```
body: {
  guild?:    { id: string, name?: string | null },
  channels?: [{ id: string, name?: string | null, type?: string | null }],
  users?:    [{ id: string, username?: string | null, display_name?: string | null }]
}
# aspoň jedna z sekcí musí být neprázdná; strop [dictionary].max_ids_per_request na
# součet channels + users

-> 200 {
  guild:    { updated: 0 | 1 },
  channels: { received, created, updated, unchanged },
  users:    { received, created, updated, unchanged },
  graph: {
    configured: boolean,          # je Neo4j nakonfigurované?
    propagated: boolean,          # proběhla inline propagace v tomto requestu?
    updated_nodes?: number,       # kolik Neo4j uzlů dostalo nový název (inline větev)
    job_id?: string              # u velkého syncu místo inline propagace
  }
}
-> 400 { error: "invalid_request", details }   # prázdné tělo, neznámé klíče, přes limit
```

Chování:

1. `syncDictionary(body)` → SQLite (synchronně, v transakci).
2. `bus.emit("dictionary.synced", { guildChanged, channelIds, userIds, at })`.
3. Pokud Neo4j nakonfigurované a `changedIds` ≤ `inline_graph_propagation_max`:
   `graphStore.syncDictionaryNames({ guild, channels, users })` teď hned → `graph.updated_nodes`.
   Jinak `createJob("name_sync", null)` + `runNameSyncJob(jobId, changedIds)` → `graph.job_id`.
4. Neo4j hodí chybu → zaloguje se, `graph.propagated: false`, HTTP zůstává `200` (SQLite je
   zdroj pravdy a ten prošel).

### `POST /api/v1/dictionary/graph-resync`

Obnova po výpadku Neo4j nebo po ručním zásahu do SQLite. Vezme **všechny** ne-`null` názvy
z `guilds` / `channels` / `users` a přes `name_sync` job je nasype do existujících Neo4j uzlů
(`MATCH ... SET`). Vrací `{ job_id }`. Bez těla.

### `POST /api/v1/batches` (změna kontraktu)

```
# PŘED
{ guild: {id, name?}, channel: {id, name?, type?},
  messages: [{ id, author: {id, username?, display_name?}, content, created_at, ... }] }

# PO
{ guild: {id}, channel: {id, type?},
  messages: [{ id, author: {id}, content, created_at, reply_to_message_id?, thread_id?,
              mentions?, attachments_count? }] }
```

- Zod schémata v `ingest.ts` + typy v `core/domain/types.ts` (`IngestBatchRequest`,
  `IngestMessage`) zbavit názvových polí. `.strict()` na objektech `guild` / `channel` / `author`
  → přítomnost `name` / `username` / `display_name` je `400` s jasnou hláškou.
- `mentions` zůstává (jsou to ID) i `attachments_count`.
- Skeleton řádky pro `guild` / `channel` / `author` se pořád zakládají (viz `ingestRepository`
  výše), aby prošly FK a `graph-write`. Název u nich je `null`, dokud nedorazí `dictionary` sync;
  v grafu se zatím kreslí jako `"(uživatel)"` / `"(kanál)"`.

## Propagace do Neo4j

### Nový uzel `Guild`

- `src/adapters/graph/Neo4jGraphStore.ts`:
  - `CONSTRAINTS` += `CREATE CONSTRAINT guild_id IF NOT EXISTS FOR (g:Guild) REQUIRE g.id IS UNIQUE`.
  - `KNOWN_LABELS` += `"Guild"`; `nodeCaption` case `Guild` → `pick("name") ?? "(server)"`.
  - `MERGE_DISCUSSION_AND_CHANNEL` rozšířit: když `payload.channel.guildId`, přidat
    `MERGE (g:Guild {id: $channel.guildId}) ON CREATE SET g.name = $channel.guildName
 ON MATCH SET g.name = coalesce($channel.guildName, g.name)` a `MERGE (c)-[:IN_GUILD]->(g)`.
  - `searchNodes` += větev `(n:Guild AND toLower(n.name) CONTAINS $q)`.
  - `graph_labels_fts` fulltext index rozšířit na `:Guild` (dobrovolné, kvůli
    dotazovacímu pipelinu Části 3).
- `src/core/graphBuilder/types.ts` — `DiscussionGraphPayload.channel` += `guildName: string | null`.
- `src/core/graphBuilder/discussionWriter.ts` — protáhnout `guildName` z inputu do payloadu.
- `src/db/sqlite/repositories/graphWriteRepository.ts` — `loadDiscussionWriteInput` doplní
  `SELECT guilds.name` podle `channel.guildId` a předá jako `channel.guildName`.
- `graphOverview` (dobrovolné) — přitáhnout `(d)-[:OCCURRED_IN]->(c)-[:IN_GUILD]->(g)`, aby
  se `Guild` uzel objevil i v prvním vykreslení, ne až po rozkliknutí kanálu.

### `GraphStore.syncDictionaryNames`

```typescript
// src/core/ports/GraphStore.ts
interface DictionaryNames {
  guild?: { id: string; name: string | null };
  channels?: { id: string; name: string | null }[];
  users?: { id: string; username: string | null; displayName: string | null }[];
}
interface GraphStore {
  // ...
  /** Aktualizuje name-property na EXISTUJÍCÍCH uzlech (MATCH ... SET). Vrací počet dotčených uzlů. */
  syncDictionaryNames(
    names: DictionaryNames
  ): Promise<{ updatedNodes: number }>;
}
```

Implementace v `Neo4jGraphStore` — jedna write transakce, tři `UNWIND ... MATCH ... SET`:

```cypher
UNWIND $users AS u
  MATCH (n:User {id: u.id})
  SET n.username = u.username, n.display_name = u.displayName
```

```cypher
UNWIND $channels AS ch
  MATCH (n:Channel {id: ch.id}) SET n.name = ch.name
```

```cypher
WITH $guild AS g WHERE g IS NOT NULL
  MATCH (n:Guild {id: g.id}) SET n.name = g.name
```

`updatedNodes` = součet `count(n)` z jednotlivých kroků (pro odpověď / job result).

### Job `name_sync`

- `src/jobs/nameSyncStage.ts` + `runNameSyncJob` v `jobRunner.ts` (stejný vzor jako
  `runGraphWriteJob`: `bootstrap()` → načíst názvy z SQLite podle `changedIds` (nebo všechny
  u `graph-resync`) → `store.syncDictionaryNames(...)` → `markJobCompleted(jobId, { updatedNodes })`).
- `jobs.type` dostane novou hodnotu `name_sync`; `channelId` je `null`.
- Web „Jobs“ pohled ho zobrazí bez úprav (typ je volný text), jen se přidá do případných
  filtrů typu na frontendu.

### Bus event

```typescript
// src/core/events/bus.ts
interface DictionarySyncedEvent {
  guild_changed: boolean;
  channel_ids: string[];
  user_ids: string[];
  at: string;
}
// BusEventMap += "dictionary.synced": DictionarySyncedEvent
```

`/api/v1/stream` ho forwardne beze změny (posílá vše přes `onAny`).

## Web / zobrazení v grafu

- **Bez propagace není co dělat** — `graphOverview` / `nodeNeighbors` čtou caption z Neo4j
  properties, takže po `syncDictionaryNames` se názvy objeví při dalším načtení / rozbalení.
- `web/` — TanStack Query: subscribe na `dictionary.synced` z WS a `invalidateQueries` pro
  klíče grafu (`graph/overview`, `graph/node/*`), ať se přejmenování projeví bez ručního
  reloadu. Volitelně malý indikátor „názvy synchronizovány před …“ z `names_synced_at`.
- `Guild` uzel: přidat barvu / ikonu do legendy grafu (stejné místo, kde se rozlišuje
  `User` / `Channel` / `Topic` / `Entity` / `Discussion`).
- Fulltextové hledání v grafu (`/api/v1/graph/search`) začne vracet i servery.

## Konfigurace

`config.example.toml` + `src/config/config.ts` (`configSchema`, sekce `prefault({})` +
všechny klíče `.default(...)`, aby starý `config.toml` bez `[dictionary]` nabootoval):

```toml
[dictionary] # synchronizace názvů (POST /api/v1/dictionary)
max_ids_per_request = 5000          # strop na součet channels + users v jednom requestu
inline_graph_propagation_max = 200  # do tolika změněných ID se propagace do Neo4j udělá
                                    # v requestu; nad = job name_sync
```

Popis obou klíčů do českého `README.md` k ostatním `config.toml` klíčům; nová sekce
„Slovník jmen“ vedle „HTTP API“ s příkladem `curl` a s upozorněním na breaking change
`POST /api/v1/batches`.

## Milníky

Detailní kroky §4.1 z [`plans/INTEGRATION.md`](INTEGRATION.md). Každý končí ručně
otestovatelným stavem.

- **D0 — SQLite + endpoint (bez Neo4j).** Migrace (`names_synced_at`, nullable
  `first_seen_at` / `last_seen_at`), `dictionaryRepository.syncDictionary`,
  `src/http/routes/dictionary.ts` (`POST /api/v1/dictionary` — jen SQLite větev + `400` na
  prázdné tělo / limit), registrace v `app.ts` za `apiKeyAuth`, `[dictionary]` config,
  `bus` event. **Test:** `curl` sync jen `users` → `updated` / `created` / `unchanged` počty
  sedí; druhý identický `curl` → vše `unchanged`; `name: null` vynuluje; prázdné tělo → `400`.
- **D1 — Odpojení názvů od batche.** Zod + `core/domain/types.ts` + `ingestRepository`
  (skeleton-only, `least`/`greatest` na `first_seen_at` / `last_seen_at`). README breaking-change
  sekce. **Test:** batch jen s ID projde; batch s `author.username` → `400`; po
  `dictionary` syncu + batchi má `users` řádek jméno ze syncu a `message_count` z batche;
  batch na neznámý kanál založí skeleton s `name = null`.
- **D2 — `Guild` uzel + guild name v graph-write.** Constraint, `KNOWN_LABELS`, `nodeCaption`,
  `MERGE ... IN_GUILD`, `guildName` skrz `graphWriteRepository` → `discussionWriter` → payload,
  `searchNodes`. **Test:** `graph-write` na kanálu s naplněným `guilds.name` → v Neo4j je
  `(:Channel)-[:IN_GUILD]->(:Guild {name})`, web overview / search ho ukáže.
- **D3 — Propagace názvů do Neo4j.** `GraphStore.syncDictionaryNames` + impl, `nameSyncStage` +
  `runNameSyncJob` + `jobs.type = "name_sync"`, inline vs. job větev v `dictionary` routě,
  `graph.updated_nodes` / `graph.job_id` v odpovědi. **Test:** `graph-write`, pak
  `dictionary` přejmenuje uživatele → do `inline_graph_propagation_max` se `User.display_name`
  v Neo4j změní hned; nad limit → `job_id`, po doběhnutí jobu změněno; Neo4j vypnuté →
  `graph.propagated: false`, SQLite přesto změněno.
- **D4 — `graph-resync` + web.** `POST /api/v1/dictionary/graph-resync` (job nad všemi ne-`null`
  názvy), frontend invalidace grafových dotazů na `dictionary.synced`, legenda `Guild`,
  volitelný indikátor stáří názvů. **Test:** rozbití názvu přímo v SQLite → `graph-resync` →
  graf srovnán; přejmenování za běhu → graf v UI se překreslí bez reloadu.
- **D5 — Zpevnění + dokumentace.** README (sekce Slovník jmen, `[dictionary]` klíče, `curl`
  příklady, breaking change), integrační test `dictionary → batches(jen ID) → clusterize →
enrich → graph-write → dictionary(rename) → assert Neo4j caption`, poznámka o pořadí
  (sync × batch je zaměnitelné, oboje upsert podle ID).

## Verifikace

- **Přírůstkovost:** sync jen se sekcí `users` nesmí sáhnout na `guilds` / `channels`.
- **Idempotence:** dvakrát stejné tělo → druhý běh `updated = 0`, žádný `dictionary.synced`
  s neprázdnými `*_ids` (nebo event s prázdnými poli), žádný Neo4j zápis.
- **`null` vs. chybějící:** `{ id, name: null }` → sloupec `NULL`; `{ id }` → sloupec beze změny.
- **Zdroj pravdy:** po `dictionary` syncu a následném batchi (jen ID) má DB jméno ze syncu;
  batch ho nepřepíše. Po `graph-write` má Neo4j uzel jméno z DB.
- **Pre-seed:** `dictionary` sync uživatele, který ještě nemá žádnou zprávu → `users` řádek
  vznikne s `first_seen_at = NULL`; první pozdější zpráva `first_seen_at` / `last_seen_at`
  dorovná.
- **Propagace po zápisu:** diskuze ve stavu `written`, `dictionary` přejmenuje účastníka →
  `User` uzel v Neo4j má nový název (inline nebo přes job), `Discussion` a `Topic` uzly
  nedotčené.
- **Odolnost:** Neo4j zabité během `dictionary` → `200`, `graph.propagated: false`, SQLite
  změněno; `graph-resync` po nastartování Neo4j graf dorovná.
- **Breaking change:** `POST /api/v1/batches` s `channel.name` → `400` s hláškou ukazující na
  `/api/v1/dictionary`.
- **Limit:** `channels + users` nad `max_ids_per_request` → `400`, nic se nezapíše.
- **Neznámé ID v grafu:** `dictionary` sync uživatele, který není v žádné zapsané diskuzi →
  `syncDictionaryNames` ho v Neo4j nevytvoří (`updated_nodes` ho nepočítá), SQLite ano.

## Známá omezení / edge cases

- **Přejmenování `Topic` / `Entity` / `Discussion` tento endpoint neřeší** — ty názvy generuje
  LLM při enrichmentu, ne slovník.
- **`Guild` uzel v overview** se objeví jen pokud se doplní expanze `IN_GUILD` do
  `graphOverview` (jinak až po rozkliknutí kanálu). Vědomě volitelné v D2.
- **Historie názvů se nedrží** — sloupec je vždy jen aktuální hodnota. Verzování jmen
  („jak se kdo jmenoval v době diskuze“) je mimo rozsah.
- **`name_sync` job a `graph_write` job běžící souběžně** nad stejným uzlem — poslední `SET`
  vyhrává; obě píšou stejnou hodnotu z SQLite, takže výsledek je konzistentní bez ohledu na
  pořadí. Zámek není potřeba.

## Otevřené otázky

1. **`channel.type` — batch, nebo dictionary?** Je to pomalu se měnící metadata kanálu jako
   název. Návrh: přesunout do `dictionary` (`channels[].type`), z batche pryč. Menší zásah:
   nechat v batchi.
2. **Breaking cut vs. přechodné období.** `.strict()` (tvrdé `400` na názvová pole) vs.
   „přijmout a ignorovat + deprecation hláška v odpovědi“ po jednu verzi. Návrh: tvrdý cut —
   projekt je pre-release, jediný odesílatel je vlastní bot.
3. **Endpoint metoda.** `POST /api/v1/dictionary` (konzistentní s `POST /api/v1/batches`) vs.
   `PATCH` (sémanticky přesnější pro částečný upsert). Návrh: `POST` — codebase `PATCH`
   nikde nepoužívá.
4. **`names_synced_at`** — přidat (levné pozorování, potřebné pro `unchanged` počty a UI
   indikátor stáří) vs. vynechat (o migraci tří sloupců míň). Návrh: přidat.
