# HTTP API

Všechny `/api/v1/*` endpointy vyžadují hlavičku `X-API-Key` (hodnota z `.env` → `API_KEY`);
jinak `401`. Platná cesta s nepodporovanou metodou → `405 method_not_allowed`.

| Endpoint                                                                 | Co dělá                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/batches`                                                   | Uloží dávku zpráv do SQLite (dedup podle `id`). **Jen ID** — názvová pole → `400`. Nic dalšího nespouští. `202`                                                                                                                                                                                                                         |
| `POST /api/v1/dictionary`                                                | **Část 4.1 — slovník jmen.** Přírůstkový upsert názvů guildy/kanálů/uživatelů do SQLite + propagace do Neo4j. `400` u prázdného těla / neznámých klíčů / přes limit.                                                                                                                                                                    |
| `POST /api/v1/dictionary/graph-resync`                                   | Znovu nasype všechny ne-`null` názvy ze SQLite do existujících Neo4j uzlů (job `name_sync`). `202` s `job_id`, `503` bez Neo4j.                                                                                                                                                                                                         |
| `POST /api/v1/pipeline`                                                  | **Část 4.2 — sjednocený běh.** Dávka (tvarově jako `/batches`) + `options?` → synchronní ingest + jeden job `pipeline` (clusterize → enrich → graph-write). `202` s `batch_id` i `job_id`.                                                                                                                                              |
| `POST /api/v1/channels/:id/pipeline`                                     | Totéž bez dávky — pipeline nad už naingestovanými `processed=0` zprávami kanálu. `202` s `job_id`.                                                                                                                                                                                                                                      |
| `POST /api/v1/channels/:id/clusterize`                                   | Spustí krok 1 na pozadí. `202` s `job_id`                                                                                                                                                                                                                                                                                               |
| `POST /api/v1/channels/:id/enrich`                                       | Spustí krok 2. Nepovinné tělo `{ "max_discussions": N }`. `202` s `job_id`                                                                                                                                                                                                                                                              |
| `POST /api/v1/channels/:id/graph-write`                                  | Spustí krok 3. Nepovinné tělo `{ "max_discussions": N }`. `202` s `job_id`                                                                                                                                                                                                                                                              |
| `GET /api/v1/jobs/:id`                                                   | Stav a `result` jednoho jobu                                                                                                                                                                                                                                                                                                            |
| `GET /api/v1/jobs?status=&channel_id=&type=`                             | Seznam jobů, volitelně filtrovaný                                                                                                                                                                                                                                                                                                       |
| `GET /api/v1/channels/:id/discussions?status=`                           | Debug: diskuze kanálu vč. zpráv a `enrichment` bloku                                                                                                                                                                                                                                                                                    |
| `GET /api/v1/discussions/:id/enrichment`                                 | Co AI k diskuzi vygenerovala; `404 not_found_or_not_enriched`                                                                                                                                                                                                                                                                           |
| `DELETE /api/v1/channels/:id/messages`                                   | Debug reset: smaže zprávy, staged diskuze, enrichment i checkpoint kanálu (historii jobů nechá)                                                                                                                                                                                                                                         |
| `GET /health`                                                            | Bez autentizace. `503` jen když selže SQLite; Neo4j je informativní                                                                                                                                                                                                                                                                     |
| `GET /api/v1/stream`                                                     | WebSocket, forwarduje bus události (`job.*`, `llm.call`, `ingest.batch`, `stats.tick`, `dictionary.synced`). Klíč jako `?token=<API_KEY>` (WS hlavičky z prohlížeče nejdou).                                                                                                                                                            |
| `GET /api/v1/stats`                                                      | Agregáty pro dashboard: `funnel`, `totals`, zprávy/kanál, histogram velikostí clusterů, sentiment/`discussion_type`, top témata/entity, LLM `avg`/`p50`/`p95` + per model + časová řada. Čistě SQLite.                                                                                                                                  |
| `GET /api/v1/ai/calls?limit=&status=&model=&job_id=&channel_id=&cursor=` | Stránkovaný výpis `llm_calls`, newest-first (keyset kurzor).                                                                                                                                                                                                                                                                            |
| `GET /api/v1/graph/overview?channel_id=&limit=`                          | Navzorkovaný podgraf pro první vykreslení. `503 neo4j_not_configured` bez Neo4j.                                                                                                                                                                                                                                                        |
| `GET /api/v1/graph/node/:id/neighbors?limit=`                            | Sousedé uzlu (expand-on-click). `id` je Neo4j `elementId`.                                                                                                                                                                                                                                                                              |
| `GET /api/v1/graph/search?q=`                                            | Fulltext přes `Topic.name` / `Entity.name` / `Discussion.title` / `User.username`.                                                                                                                                                                                                                                                      |
| `POST /api/v1/query`                                                     | **Část 3 — dotazování.** NL otázka → odpověď syntetizovaná z grafu + citace. Synchronní. `503 graph_unavailable` bez Neo4j, `422` u prázdné otázky.                                                                                                                                                                                     |
| `GET /api/v1/discussions/:id`                                            | **Část 4.3.** Bundle pro drawer: `discussions_local` řádek + `enrichment` + zprávy. Jen s `[web] enabled`.                                                                                                                                                                                                                              |
| `GET /api/v1/graph/node/by-domain-id?label=&id=`                         | **Část 4.3.** Doménové ID → Neo4j `elementId` pro deep-link z citace do grafu. Jen s `[web] enabled`.                                                                                                                                                                                                                                   |

**Obnova po restartu:** joby ve stavu `pending`/`running` se při startu appky znovu spustí
(stage jsou idempotentní, běží jen nad ještě nezpracovanými řádky). Vstupy, které nejsou
v řádku jobu (options, `name_sync` payload), drží sloupec `jobs.params`. `name_sync` bez
uloženého payloadu → `failed` s odkazem na `graph-resync`.

Endpointy `stream` / `stats` / `ai/calls` / `graph/*` / `discussions/:id` / `graph/node/by-domain-id`
existují jen když `config.toml` má `[web] enabled = true`.

## `POST /api/v1/batches` — tvar vstupu

> **Breaking change (Část 4.1):** dávka nese **jen ID**. `guild.name`, `channel.name`,
> `author.username` / `display_name` už nejsou povolené — objekty jsou `.strict()` a jejich
> přítomnost vrací `400`. Názvy se posílají zvlášť přes `POST /api/v1/dictionary` (níže).

```bash
curl -X POST http://localhost:3004/api/v1/batches \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "guild":   { "id": "g1" },
    "channel": { "id": "c1", "type": "text" },
    "messages": [
      { "id": "m1",
        "author": { "id": "u1" },
        "content": "Ahoj, sledoval někdo ten nový trailer?",
        "created_at": "2026-08-24T10:00:00.000Z",
        "mentions": [], "attachments_count": 0 }
    ]
  }'
# → 202 { "batch_id": "...", "message_count": 1, "inserted_count": 1, "duplicate_count": 0 }
```

`reply_to_message_id`, `thread_id`, `mentions`, `attachments_count` jsou nepovinné — když
neplatí, pole z JSONu **vynech** (neposílej `null`, validace to odmítne). Ingest zakládá
kostry řádků `guilds` / `channels` / `users` (jen ID + časy aktivity); názvy zůstanou `null`,
dokud nedorazí `dictionary` sync.

## Slovník jmen — `POST /api/v1/dictionary` (Část 4.1)

Názvy (guild / kanál / uživatel) se udržují mimo dávku zpráv, přírůstkově. Jediný zdroj
pravdy jsou sloupce v SQLite (`guilds.name`, `channels.name` / `type`, `users.username` /
`display_name`) a tento endpoint je jejich jediný zapisovatel.

```bash
curl -X POST http://localhost:3004/api/v1/dictionary \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "guild":    { "id": "g1", "name": "Moje komunita" },
    "channels": [{ "id": "c1", "name": "obecna", "type": "text" }],
    "users":    [{ "id": "u1", "username": "adam", "display_name": "Adam" }]
  }'
# → 200 {
#     "guild":    { "updated": 1 },
#     "channels": { "received": 1, "created": 1, "updated": 0, "unchanged": 0 },
#     "users":    { "received": 1, "created": 1, "updated": 0, "unchanged": 0 },
#     "graph":    { "configured": true, "propagated": true, "updated_nodes": 2 }
#   }
```

- **Přírůstkové:** posílá se jen to, co se změnilo. Chybějící sekce / ID = beze změny;
  opakované poslání stejných hodnot nic nezapíše (`updated: 0`).
- **`null` maže, chybějící pole nechává být:** `"display_name": null` vynuluje jméno;
  když pole v JSONu není, hodnota se nemění.
- **Pre-seed:** sync uživatele, který ještě nemá zprávu, založí `users` řádek s
  `first_seen_at` / `last_seen_at` `NULL`; první pozdější zpráva je dorovná.
- Strop na `channels + users` v jednom requestu je `[dictionary].max_ids_per_request`.
- **Propagace do Neo4j:** názvy se hned přepíšou na už existujících uzlech `User` / `Channel`
  / `Guild` (`MATCH ... SET`, nové uzly se nevytvářejí). Do
  `[dictionary].inline_graph_propagation_max` změněných ID se to udělá přímo v requestu
  (`graph.propagated: true`, `graph.updated_nodes`), nad limit se založí job `name_sync`
  (`graph.job_id`). Neo4j nedostupné → `graph.propagated: false`, SQLite je přesto zapsané;
  obnova přes `POST /api/v1/dictionary/graph-resync`.
- Po syncu jde na `/api/v1/stream` událost `dictionary.synced` (`guild_changed`,
  `channel_ids`, `user_ids`), na kterou web invaliduje grafové dotazy.

## Sjednocený běh pipeline — `POST /api/v1/pipeline` (Část 4.2)

Jedno volání provede celý řetězec, aby volající nemusel orchestrovat čtyři requesty a polling
mezi nimi. Granulární endpointy (`/batches`, `/clusterize`, `/enrich`, `/graph-write`) zůstávají.

```bash
curl -X POST http://localhost:3004/api/v1/pipeline \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "guild":   { "id": "g1" },
    "channel": { "id": "c1", "type": "text" },
    "messages": [ { "id": "m1", "author": { "id": "u1" },
                   "content": "...", "created_at": "2026-08-24T10:00:00.000Z" } ],
    "options": { "max_discussions": 50, "skip_graph_write": false }
  }'
# → 202 { "batch_id": "...", "inserted_count": 1, "duplicate_count": 0,
#         "job_id": "...", "type": "pipeline", "status": "queued" }
```

- **Ingest je synchronní** (fail-fast na špatné tělo, hned `inserted` / `duplicate` počty),
  zbytek je jeden job `type: "pipeline"`, který sekvenčně spustí `clusterize → enrich →
  graph-write`. Sleduje se přes `GET /api/v1/jobs/:id` jako každý jiný job.
- `result` má bloky `ingest` / `cluster` / `enrich` / `graphWrite`, plněné průběžně po každé
  stage (`progress` jde 0→3, resp. 0→2 při `skip_graph_write`).
- **Spadne-li stage**, job je `failed` a `error` je `"<stage>: <zpráva>"` (např. `"enrich: …"`);
  `result` drží stage, které stihly doběhnout. Data z `ingest` + `cluster` zůstávají v SQLite,
  stage jsou idempotentní → dá se dokončit granulárními endpointy.
- `options.skip_graph_write` (default = `![pipeline].include_graph_write`) skončí po enrichmentu
  a Neo4j se nesáhne. `options.max_messages` → `clusterize`, `max_discussions` → `enrich` i
  `graph-write`.
- Bez dávky: `POST /api/v1/channels/:id/pipeline` s tělem `{ "options": { … } }` spustí totéž
  nad už naingestovanými `processed=0` zprávami kanálu.
- **Souběžné pipeline joby:** LLM volání jsou serializovaná procesně (jedno v jednu chvíli,
  ostatní stojí ve FIFO frontě). Druhý job spuštěný během prvního tedy u enrichmentu **počká,
  až se model uvolní**, a pak sám pokračuje — nespadne kvůli rate-limitu. Clusterizace (bez
  LLM) běží paralelně; dvě pipeline nad **stejným** kanálem naráz ale nespouštěj (obě by
  clusterovaly tytéž `processed=0` zprávy).

## Výsledky jobů (`GET /jobs/:id` → `result`)

```jsonc
// cluster
{ "processedMessageCount": 10, "newDiscussionCount": 2,
  "extendedDiscussionCount": 0, "skippedOpenBlockMessageCount": 1 }
// enrich
{ "enrichedDiscussionCount": 8, "splitDiscussionCount": 2, "createdSegmentCount": 5,
  "skippedEmptyCount": 0, "failedCount": 0, "batchCount": 2, "individualRetryCount": 0,
  "errors": [] }
// graph_write
{ "writtenDiscussionCount": 10, "skippedNoEnrichmentCount": 0,
  "failedCount": 0, "errors": [] }
```

`skippedOpenBlockMessageCount` = zprávy v ještě neuzavřeném koncovém bloku (normální, doclusterují
se příště).

## `GET /discussions/:id/enrichment` — tvar výstupu

Diskuze obohacená vcelku vrací `enrichment` objekt (`title`, `summary`, `topics`, `entities`
`[{ name, type }]`, `key_points`, `sentiment` + `sentiment_score`, `language`, `discussion_type`,
`resolved`, `enriched_at`). Rozdělená diskuze vrací rodiče se `status = "split"`, `enrichment: null`
a polem `segments` (jeden záznam za každou dětskou diskuzi).

## Dotazování nad grafem — `POST /api/v1/query` (Část 3)

Položí otázku v přirozeném jazyce a vrátí odpověď syntetizovanou z relevantních diskuzí.
Vyžaduje naplněné Neo4j (proběhlý `graph-write`) a stejný `[llm]` adapter jako enrichment.
Běží synchronně; jeden request = 1 lokální embedding dávka + pár Neo4j čtení + **2 LLM volání**
(plánovač dotazu + syntéza odpovědi).

Pipeline: porozumění dotazu (LLM → přeformulování, témata, intent, filtry) → retrieval
(vektorový index + shoda názvů `Topic`/`Entity` přes fulltext) → grafová expanze
(`CONTINUATION_OF` / sdílené téma nebo entita / `COOCCURS_WITH`, re-rank podle podobnosti
k otázce) → sestavení kontextu (shrnutí + `key_points` + syrové zprávy u top diskuzí) →
ukotvená syntéza s citacemi `[D#]`. Detailní návrh: [`../plans/QUERYING.md`](../plans/QUERYING.md).

```bash
curl -X POST http://localhost:3004/api/v1/query \
  -H "X-API-Key: $API_KEY" -H "content-type: application/json" \
  -d '{ "question": "Jaký mají lidé názor na Smarty?" }'
```

```jsonc
{
  "answer": "Lidé jsou na Smarty spíš negativní kvůli cenám [D1][D3]. ...",
  "confidence": "high", // high | medium | low
  "citations": [
    {
      "ref": "D1",
      "discussion_id": "…",
      "title": "…",
      "channel": "hardware",
      "discussion_type": "discussion",
      "sentiment": "negative",
      "started_at": "…",
      "score": 0.83,
      "used": true
    }
  ],
  "used_discussion_count": 2,
  "intent": "opinion",
  "answer_language": "cs"
}
```

- Nepovinné tělo: `filters.channel_ids[]`, `filters.discussion_types[]`, `filters.since`
  (ISO datum). Tohle jsou **jediné tvrdé filtry** — plánovač žádné netvoří, jen měkce
  ovlivní řazení (`preferred_discussion_types`). Když tvrdý filtr na typ/datum nic nevrátí,
  pipeline to zkusí ještě jednou bez něj (kanály nechá) a přidá k odpovědi poznámku.
- `?debug=1` přidá objekt `debug` s plánem dotazu, kandidáty (skóre + zdroj) a časy fází.
- Když po fúzi neprojde nic nad `query.min_candidate_score`, vrátí se `confidence: "low"`
  a věcné „nenašel jsem dost podkladů" — **bez** volání LLM syntézy (a bez fabulace).
- Když selže plánovací LLM volání, pipeline spadne zpět na vyhledávání podle syrové otázky
  a odpoví i tak.
