# community-graph

Dockerizovaná (zatím lokálně spouštěná) služba, která z historie Discord chatu postupně
buduje znalostní graf komunity — kdo o čem mluvil, jaká témata spolu souvisí a jak na sebe
diskuze v čase navazují. Graf jde kdykoliv doplnit novou dávkou zpráv, aniž by vznikaly
duplicity.

Podrobný návrh (architektura, zdůvodnění rozhodnutí, budoucí kroky) je v [`PLAN.md`](./PLAN.md).

## Jak to funguje

Proces má tři samostatné, nezávisle spustitelné kroky, aby šel každý zvlášť vyladit:

| # | Krok | Co dělá | Kde končí |
|---|---|---|---|
| 1 | **ingest + clusterizace** | zprávy se uloží a rozdělí do tematických diskuzí (time-gapy, Discord thready/replies, embeddingy) | SQLite |
| 2 | **AI enrichment** | každá diskuze projde LLM (title, summary, topics, entities, sentiment, key points) — model ji může i rozdělit na menší | SQLite |
| 3 | **graph write** | obohacené diskuze se idempotentně zapíšou do Neo4j jako knowledge graph | Neo4j |

SQLite drží syrová data a mezistavy, Neo4j je jediný výstupní store.

## Rychlý start

Vyžaduje [Bun](https://bun.com) (testováno na `1.3.x`).

```bash
bun install
cp .env.example .env                  # uprav aspoň API_KEY
cp config.example.toml config.toml    # laditelné parametry (config.toml je gitignored)
bun run dev                           # server s auto-reloadem (nebo `bun run start` bez watch)
```

Server naslouchá na portu z `config.toml` (`[server] port`, výchozí 3004). Při startu se
automaticky aplikují SQLite migrace z `migrations/`. Embedding model
(`Xenova/multilingual-e5-small`) se stáhne a zacachuje při prvním `/clusterize`.

Webové rozhraní (Část 2) běží ve vývoji zvlášť na Vite:

```bash
bun run web:dev               # Vite na :5173, proxuje /api na běžící službu (:3004)
```

V produkci se frontend nebuildí zvlášť — `bun run web:build` vytvoří `web/dist/`, které
servíruje stejná Hono app na `/` (jeden origin, jeden proces). Viz [Webové rozhraní](#webové-rozhraní).

**Krok 2** potřebuje přístup k LLM — Anthropic/Gemini API klíč, nebo lokální
OpenAI-kompatibilní server (Ollama, vLLM, LM Studio). Provider se volí v `config.toml`
(`[llm] provider`), kredence jdou do `.env`.

**Krok 3** potřebuje běžící Neo4j:

```bash
docker compose up -d neo4j    # Browser na :7474, Bolt na :7687
```

Kroky 1 a 2 běží i bez Neo4j. Bez `NEO4J_PASSWORD` selže jen `graph-write` job (s jasnou
hláškou) a `/health` hlásí `neo4j: "not_configured"`.

### Změna DB schématu

Schéma je v `src/db/sqlite/schema.ts` ([Drizzle ORM](https://orm.drizzle.team/), žádné ruční
SQL). Po úpravě spusť `bun run db:generate` — migrace se vygeneruje do `migrations/` a aplikuje
při dalším startu.

## Konfigurace

Dvě oddělené vrstvy:

- **`.env`** — credentials a prostředí-specifické hodnoty, necommitují se. Vzor v `.env.example`.
- **`config.toml`** — laditelné necitlivé parametry, commitnuté s rozumnými defaulty. Čte se
  jen při startu (po změně restartuj server), validuje se přes zod.

### `.env`

| Proměnná | Popis |
|---|---|
| `SQLITE_PATH` | Cesta k SQLite souboru (výchozí `./data/community-graph.sqlite`). Adresář se vytvoří sám. |
| `API_KEY` | Musí ho klient posílat v hlavičce `X-API-Key` na všech `/api/v1/*` endpointech. |
| `LLM_ANTHROPIC_API_KEY` / `LLM_GEMINI_API_KEY` | API klíč — jen pro odpovídajícího providera. |
| `LLM_OPENAI_COMPATIBLE_BASE_URL` / `_API_KEY` | Base URL a klíč OpenAI-kompatibilního serveru (lokální Ollama/LM Studio klíč většinou nechtějí). |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | Připojení k Neo4j (krok 3). Výchozí hodnoty sedí na `docker-compose.yml`. |
| `PORT` / `HOSTNAME` | Volitelný override `[server].port` / `[server].host` pro deploy (Docker, PaaS). |
| `VITE_API_BASE` | **Jen dev.** Base URL API pro Vite dev server (výchozí odvozeno z `[server].port`). V produkci je frontend na stejném originu, nenastavuj. |
| `VITE_API_KEY` | **Jen dev.** Hodnota `API_KEY`, aby klientský bundl mohl volat chráněné `/api/v1/*`. V produkci klíč přidává reverzní proxy, nebo se zadá jednou v UI (uloží se do `localStorage`). |

Vyplňuj jen klíče pro providera zvoleného v `config.toml`. Chybějící LLM klíč → `enrich` job
skončí `failed`; chybějící `NEO4J_PASSWORD` → totéž pro `graph-write`. Proměnné s prefixem
`VITE_` čte jen Vite dev server, ne služba samotná.

### `config.toml` — laditelné parametry

| Klíč | Význam |
|---|---|
| `server.port` | Port HTTP serveru. |
| `clustering.silence_gap_minutes` (**M**) | Mezera ticha, po které se časový blok považuje za uzavřený. Vyšší = diskuze se míň tříští na kusy kvůli krátkým pauzám. |
| `clustering.short_message_word_limit` (**W**) | Pod tímto počtem slov se pro zprávu negeneruje embedding — jen se přilepí k předchozí diskuzi nebo k reply cíli. |
| `clustering.similarity_threshold` (**τ**) | Práh cosine similarity (0–1) pro přiřazení zprávy k existujícímu sub-clusteru. Nižší = míň roztříštěné; vyšší = míň slévání různých témat. |
| `clustering.active_subcluster_idle_minutes` | Po jaké neaktivitě v bloku se sub-cluster přestane porovnávat. Vyšší = přesnější, ale pomalejší. |
| `clustering.continuation_similarity_threshold` (**θ**), `continuation_lookback_days` | Pro sémantické `CONTINUATION_OF`. *Zatím nevyužito (patří ke kroku 3).* |
| `embedding.model` / `embedding.dimensions` | Model pro `@huggingface/transformers` (lokální ONNX, in-process) a jeho dimenze. Musí si odpovídat (`e5-small` = 384, `e5-base` = 768). |
| `llm.provider` | `anthropic` \| `openai-compatible` \| `gemini`. Cílový stav je vlastní lokální `openai-compatible`. |
| `llm.model` | Název modelu u zvoleného providera. |
| `llm.max_tokens` | Strop na délku odpovědi. Zvyš, když se odpověď u velkých rozdělených diskuzí ořezává. |
| `llm.temperature` | **Anthropic adaptér ji ignoruje** (Claude 4.5+ ji odmítá); platí pro `openai-compatible` a `gemini`. |
| `llm.max_messages_per_call` | Kolik zpráv nejvýš jde do jedné výzvy (ochrana kontextu); delší diskuze se ořízne na prvních N. |
| `llm.request_timeout_ms` | Timeout jednoho volání LLM. Zvyš u pomalých lokálních modelů. |
| `web.enabled` | `false` = neservírovat `web/dist` ani endpointy `/api/v1/stream\|stats\|ai/calls\|graph/*`. |
| `web.dev_port` | Port Vite dev serveru (`bun run web:dev`); ten proxuje `/api` na `[server].port`. |
| `web.llm_calls_retention_days` / `web.llm_calls_max_rows` | Retence tabulky `llm_calls` (dashboard buffer): při zápisu se občas smažou řádky starší než N dní nebo nad limitem řádků. |
| `web.stats_tick_seconds` | Interval přepočtu levného `funnel`/`totals` agregátu, který jde WS klientům jako `stats.tick`. Počítá se jen když je aspoň jeden klient připojený. |
| `web.graph_overview_limit` | Cílový horní počet uzlů v prvním vykreslení grafu; zbytek se dolazí rozbalením sousedů. |
| `query.vector_top_k` | Kolik kandidátů z vektorového indexu se vezme na jednu variantu dotazu. |
| `query.search_query_variants` | Strop na počet přeformulování otázky, které vygeneruje plánovač. |
| `query.anchor_limit` | Strop diskuzí dotažených přes shodu názvu tématu/entity (Neo4j fulltext). |
| `query.expansion_seed_count` / `query.expansion_fanout` | Kolik nejlepších kandidátů jde do grafové expanze a kolik sousedů se z každého vezme. |
| `query.evidence_set_size` | Kolik diskuzí se pošle do syntézy odpovědi. |
| `query.raw_message_discussions` / `query.raw_messages_per_discussion` | U kolika top diskuzí a kolik syrových zpráv z SQLite se přidá do kontextu (`0` = jen shrnutí). |
| `query.context_token_budget` | Odhadovaný strop kontextu; ořezává se od nejníže skórujících diskuzí (nejdřív syrové zprávy, pak celé bloky). |
| `query.min_candidate_score` | Práh skóre. Když po fúzi nic neprojde, endpoint vrátí `confidence: "low"` bez volání LLM syntézy. |
| `query.recency_half_life_days` | Po kolika dnech klesne recency bonus na polovinu. |
| `query.weight_vector` / `weight_anchor` / `weight_expansion` / `weight_recency` | Váhy složek finálního skóre kandidáta. |
| `query.weight_type_preference` | Měkký bonus, když typ diskuze sedí na `preferred_discussion_types` z plánovače. Nefiltruje — jen řadí. |
| `query.opinion_sentiment_diversity` | U názorových otázek držet v evidence setu i menšinový sentiment (pozitivní/negativní). |
| `query.vocab_sample_size` | Kolik nejčastějších názvů `Topic`/`Entity` se dá plánovači jako slovník grafu. |

## Webové rozhraní

Lehké **read-only realtime** rozhraní zabudované přímo do služby (Část 2 plánu) — ukazuje, co
se v systému děje. Nespouští žádný krok pipeline; jen instrumentace navíc: persistovaná LLM
volání (tabulka `llm_calls`) a in-process event bus, který přes WebSocket teče do prohlížeče.

**Co ukazuje:**

- **Přehled** — stat karty, pipeline funnel (`raw → clustered → enriched → graph-written`),
  aktivní jobs, poslední LLM volání.
- **Jobs** — živý seznam s filtrem podle typu/stavu; detail jobu s `result` JSON a navázanými
  LLM voláními.
- **LLM volání** — stream volání (provider, model, kontext, doba, tokeny, stav) + agregáty
  (průměr, p50/p95, chybovost, volání/min, tabulka podle modelu).
- **Statistiky** — zprávy podle kanálů, histogram velikostí clusterů, LLM časová řada,
  rozpad podle `sentiment` a `discussion_type`, top témata/entity, per-kanál tabulka.
- **Graf** — vizualizace Neo4j přes sigma.js + forceatlas2 (WebGL): klik na uzel rozbalí
  sousedy, hledání zoomne na uzel, filtr podle kanálu a typu uzlu. Vyžaduje běžící Neo4j
  a proběhlý `graph-write`.

**Stack:** Svelte 5 (runes) + Vite jako čistá SPA v `web/`, TanStack Query pro server state,
nativní WebSocket s reconnectem, TailwindCSS v4. Žádné druhé `package.json` — frontend devDeps
jsou v kořenovém, build řídí jeden `vite build`.

### Spuštění

**Vývoj** (dva procesy):

```bash
bun run dev            # služba na :3004
bun run web:dev        # Vite na :5173, proxuje /api → :3004
```

Klíč pro dev volání API dej do `.env` jako `VITE_API_KEY` (= hodnota `API_KEY`).

**Produkce** — jeden proces, jeden origin:

```bash
bun run web:build      # → web/dist/
bun run start          # Hono app servíruje web/dist/ na / (SPA fallback) i /api/v1/*
```

Nebo přes Docker: `docker compose up` postaví image (`docker/Dockerfile`, multi-stage Bun —
obsahuje krok `bun run web:build`) a spustí `app` + `neo4j`. Lokální `config.toml` se do
kontejneru bind-mountuje.

### Autentizace

`apiKeyAuth` chrání celé `/api/v1/*`. REST volání posílají `X-API-Key`, WebSocket `?token=`
(hlavičky u WS handshake z prohlížeče nejdou). V produkci za reverzní proxy může klíč držet
proxy (frontend bez klíče); jinak se zadá jednou v UI a uloží do `localStorage`.

### Poznámka k UI komponentám

Plán počítá se `shadcn-svelte`. Aktuálně jsou v `web/lib/components/ui/` lehké vlastní
primitivy (Card, Badge, Button, Skeleton) na Tailwind tokenech; po `bunx --bun
shadcn-svelte@latest init` + `add` je lze nahradit z registru beze změny cest importů.

## Datový model (SQLite, `src/db/sqlite/schema.ts`)

| Tabulka | Obsah |
|---|---|
| `guilds`, `channels`, `users` | základní entity z Discordu |
| `messages` | syrové zprávy; `processed` (`0` raw → `1` clustered → `3` v grafu), `discussion_id` |
| `ingestion_batches` | evidence `POST /batches` volání (vložené / duplicitní počty) |
| `discussions_local` | clustery z kroku 1 (staging); `parent_discussion_id` u dětských diskuzí ze split |
| `discussion_enrichment` | výstup kroku 2: `title`, `summary`, `topics`, `entities`, `key_points`, `sentiment` (+ skóre), `language`, `discussion_type`, `resolved`, embedding pro krok 3, `raw_llm_response` |
| `channel_checkpoints` | informativní: kam clusterizace v kanálu chronologicky došla |
| `jobs` | stav asynchronních běhů (`cluster` \| `enrich` \| `graph_write`) |

### Životní cyklus diskuze (`discussions_local.status`)

- **`clustering`** — čerstvě založená, ještě neprošla enrichmentem.
- **`needs_reenrichment`** — už existovala a tento běh do ní dopsal zprávy (rozšíření vlákna
  nebo reply reassignment), takže staré title/summary jsou zastaralé a čeká na nový enrichment.
- **`enriched`** — má záznam v `discussion_enrichment`. Platí i pro dětské diskuze ze split.
- **`split`** — LLM ji rozdělil; sama už nenese zprávy (přesunuly se do dětských diskuzí),
  slouží jen jako rodičovský uzel.
- **`written`** — zapsaná do Neo4j; zprávy mají `processed = 3`. `graph-write` ji přeskakuje.

## Krok 1 — clusterizace

Pro kanál se při `/clusterize` vezmou všechny nezpracované zprávy (`processed = 0`) a rozdělí:

1. **Thready** — zprávy se stejným `thread_id` tvoří jednu diskuzi bez ohledu na čas; další
   zprávy do existujícího vlákna se k ní připojí i v pozdějším běhu.
2. **Časové bloky** — zbylé zprávy se chronologicky rozdělí podle mezery ticha > `M` minut.
3. **Uzavřené vs. otevřené bloky** — zpracuje se jen blok, u kterého je jisté, že už žádnou
   zprávu nedostane. Poslední „živý" blok zůstane `processed = 0` a počká na další volání
   (počet takto vynechaných zpráv je `skippedOpenBlockMessageCount` v odpovědi jobu).
4. **Reply reassignment** — reply na zprávu z už finalizované diskuze se do ní přesune, nebo
   se založí vazba `continuation_of` (když na reply naváže víc zpráv a vznikne sub-cluster).
5. **Krátké zprávy** (< `W` slov) — bez embeddingu, přilepí se k reply cíli nebo k předchozí
   zprávě ve stejném bloku.
6. **Delší zprávy** — embeddují se a přiřadí k aktivnímu sub-clusteru podle cosine similarity
   (práh `τ`) s malými heuristickými bonusy (nedávný stejný autor, zmínka účastníka clusteru).

**Známé zjednodušení:** reply se rozpozná, jen když cílová zpráva už má v DB přiřazenou diskuzi.
Reply na zprávu ze stále otevřeného bloku zatím zachycena není.

## Krok 2 — AI enrichment

`POST /channels/:id/enrich` vezme diskuze kanálu ve stavu `clustering` / `needs_reenrichment`
a jednu po druhé prožene přes LLM. Model dostane text zpráv a vrátí **pole segmentů** — každý
segment je souvislá (pod)diskuze s vlastním enrichmentem a seznamem `message_ids`.

- **Jeden segment** → enrichment se zapíše přímo k diskuzi (`status = 'enriched'`).
  `message_ids` se ignorují.
- **Víc segmentů** → diskuze se rozdělí: původní řádek dostane `status = 'split'` a stane se
  rodičem, každý segment se stane novou dětskou diskuzí (`parent_discussion_id`,
  `status = 'enriched'`). Zprávy mimo segmenty se přilepí k časově nejbližšímu; když jsou
  `message_ids` samá neplatná, rozdělí se zprávy chronologicky na tolik částí, kolik je segmentů.

Pro každou (pod)diskuzi se z `„title. summary. topics"` spočítá embedding pro krok 3.

- **Re-enrichment:** u `needs_reenrichment` se předchozí běh zahodí (dětské diskuze se zruší,
  zprávy se vrátí rodiči, staré `discussion_enrichment` se smaže) a diskuze se obohatí načisto.
- **Odolnost:** job nikdy nespadne kvůli jedné diskuzi — chyby jdou do pole `errors` výsledku.
- **Logování:** ke každému volání LLM jeden řádek při odeslání (`[llm →] …`) a jeden při
  odpovědi/chybě (`[llm ←] … · <ms>`). Dělá to wrapper `LoggingLLMProvider`, takže všichni
  provideři logují stejně.

## Krok 3 — graph write

`POST /channels/:id/graph-write` vezme diskuze ve stavu `enriched` (rodiče `split` přeskočí)
a jednu po druhé zapíše do Neo4j. Při prvním volání se vytvoří constraints a vektorový index
(`IF NOT EXISTS`).

Každá diskuze se píše v jedné transakci samými `MERGE … ON CREATE SET / ON MATCH SET`, takže
opakované volání nikdy nevytvoří duplicity. Počítadla jsou bezpečná díky tomu, že se diskuze
po zápisu označí `written` a příště přeskočí — přispěje do nich právě jednou.

### Uzly

| Label | Klíč | Vlastnosti |
|---|---|---|
| `User` | `id` | `username`, `display_name`, `first_seen_at`, `last_seen_at`, `message_count` |
| `Channel` | `id` | `name`, `guild_id` |
| `Discussion` | `id` | `channel_id`, `started_at`, `ended_at`, `message_count`, `participant_count`, `title`, `summary`, `topics[]`, `sentiment` (+ `_score`), `language`, `discussion_type`, `resolved`, `embedding` (index `discussion_embedding_idx`) |
| `Topic` | `name` (kanonizované: trim, sražené mezery, dedup case-insensitive) | `discussion_count`, `created_at` |
| `Entity` | `key` = `typ:název` | `name`, `type` (`person`/`product`/`technology`/`organization`/`place`/`event`/`other`), `mention_count`, `created_at` |

### Hrany

| Hrana | Vlastnosti | Poznámka |
|---|---|---|
| `(User)-[:PARTICIPATED_IN]->(Discussion)` | `message_count`, `first_message_at`, `last_message_at` | agregace nad `messages` diskuze |
| `(Discussion)-[:OCCURRED_IN]->(Channel)` | — | |
| `(Discussion)-[:DISCUSSES]->(Topic)` | — | |
| `(Discussion)-[:MENTIONS]->(Entity)` | `count` | |
| `(Topic)-[:COOCCURS_WITH]->(Topic)` | `count`, `last_seen_at` | v abecedním pořadí názvů (bez opačné duplicity); přeskočí se u diskuze s > 12 topiců |
| `(Entity)-[:COOCCURS_WITH]->(Entity)` | `count`, `last_seen_at` | totéž podle `key` |
| `(User)-[:INTERESTED_IN]->(Topic)` | `weight`, `discussion_count`, `last_interaction_at` | pro každého účastníka × topic; `weight +=` počet jeho zpráv v diskuzi |
| `(Discussion)-[:CONTINUATION_OF]->(Discussion)` | `reason`, `similarity_score`, `created_at` | novější → starší; zatím jen `reason = 'explicit_reply'` z clusteringu |

**Zjednodušené oproti PLAN.md:** kanonizace topiců/entit je jen přesná shoda po normalizaci
(žádné slučování přes embedding index), `Topic`/`Entity` nedostávají `embedding`/`category`.
Posun `channel_checkpoints` a sémantické `CONTINUATION_OF` patří k dalšímu kroku.

## HTTP API

Všechny `/api/v1/*` endpointy vyžadují hlavičku `X-API-Key` (hodnota z `.env` → `API_KEY`);
jinak `401`. Platná cesta s nepodporovanou metodou → `405 method_not_allowed`.

| Endpoint | Co dělá |
|---|---|
| `POST /api/v1/batches` | Uloží dávku zpráv do SQLite (dedup podle `id`). Nic dalšího nespouští. `202` |
| `POST /api/v1/channels/:id/clusterize` | Spustí krok 1 na pozadí. `202` s `job_id` |
| `POST /api/v1/channels/:id/enrich` | Spustí krok 2. Nepovinné tělo `{ "max_discussions": N }`. `202` s `job_id` |
| `POST /api/v1/channels/:id/graph-write` | Spustí krok 3. Nepovinné tělo `{ "max_discussions": N }`. `202` s `job_id` |
| `GET /api/v1/jobs/:id` | Stav a `result` jednoho jobu |
| `GET /api/v1/jobs?status=&channel_id=&type=` | Seznam jobů, volitelně filtrovaný |
| `GET /api/v1/channels/:id/discussions?status=` | Debug: diskuze kanálu vč. zpráv a `enrichment` bloku |
| `GET /api/v1/discussions/:id/enrichment` | Co AI k diskuzi vygenerovala; `404 not_found_or_not_enriched` |
| `DELETE /api/v1/channels/:id/messages` | Debug reset: smaže zprávy, staged diskuze, enrichment i checkpoint kanálu (historii jobů nechá) |
| `GET /health` | Bez autentizace. `503` jen když selže SQLite; Neo4j je informativní |
| `GET /api/v1/stream` | WebSocket, forwarduje bus události (`job.*`, `llm.call`, `ingest.batch`, `stats.tick`). Klíč jako `?token=<API_KEY>` (WS hlavičky z prohlížeče nejdou). |
| `GET /api/v1/stats` | Agregáty pro dashboard: `funnel`, `totals`, zprávy/kanál, histogram velikostí clusterů, sentiment/`discussion_type`, top témata/entity, LLM `avg`/`p50`/`p95` + per model + časová řada. Čistě SQLite. |
| `GET /api/v1/ai/calls?limit=&status=&model=&job_id=&channel_id=&cursor=` | Stránkovaný výpis `llm_calls`, newest-first (keyset kurzor). |
| `GET /api/v1/graph/overview?channel_id=&limit=` | Navzorkovaný podgraf pro první vykreslení. `503 neo4j_not_configured` bez Neo4j. |
| `GET /api/v1/graph/node/:id/neighbors?limit=` | Sousedé uzlu (expand-on-click). `id` je Neo4j `elementId`. |
| `GET /api/v1/graph/search?q=` | Fulltext přes `Topic.name` / `Entity.name` / `Discussion.title` / `User.username`. |
| `POST /api/v1/query` | **Část 3 — dotazování.** NL otázka → odpověď syntetizovaná z grafu + citace. Synchronní. `503 graph_unavailable` bez Neo4j, `422` u prázdné otázky. |

Endpointy `stream` / `stats` / `ai/calls` / `graph/*` existují jen když `config.toml` má `[web] enabled = true`.

### `POST /api/v1/batches` — tvar vstupu

```bash
curl -X POST http://localhost:3004/api/v1/batches \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "guild":   { "id": "g1", "name": "Moje komunita" },
    "channel": { "id": "c1", "name": "obecna", "type": "text" },
    "messages": [
      { "id": "m1",
        "author": { "id": "u1", "username": "adam" },
        "content": "Ahoj, sledoval někdo ten nový trailer?",
        "created_at": "2026-08-24T10:00:00.000Z",
        "mentions": [], "attachments_count": 0 }
    ]
  }'
# → 202 { "batch_id": "...", "message_count": 1, "inserted_count": 1, "duplicate_count": 0 }
```

`reply_to_message_id`, `thread_id`, `mentions`, `attachments_count` jsou nepovinné — když
neplatí, pole z JSONu **vynech** (neposílej `null`, validace to odmítne).

### Výsledky jobů (`GET /jobs/:id` → `result`)

```jsonc
// cluster
{ "processedMessageCount": 10, "newDiscussionCount": 2,
  "extendedDiscussionCount": 0, "skippedOpenBlockMessageCount": 1 }
// enrich
{ "enrichedDiscussionCount": 8, "splitDiscussionCount": 2, "createdSegmentCount": 5,
  "skippedEmptyCount": 0, "failedCount": 0, "errors": [] }
// graph_write
{ "writtenDiscussionCount": 10, "skippedNoEnrichmentCount": 0,
  "failedCount": 0, "errors": [] }
```

`skippedOpenBlockMessageCount` = zprávy v ještě neuzavřeném koncovém bloku (normální, doclusterují
se příště).

### `GET /discussions/:id/enrichment` — tvar výstupu

Diskuze obohacená vcelku vrací `enrichment` objekt (`title`, `summary`, `topics`, `entities`
`[{ name, type }]`, `key_points`, `sentiment` + `sentiment_score`, `language`, `discussion_type`,
`resolved`, `enriched_at`). Rozdělená diskuze vrací rodiče se `status = "split"`, `enrichment: null`
a polem `segments` (jeden záznam za každou dětskou diskuzi).

## Dotazování nad grafem (Část 3)

`POST /api/v1/query` položí otázku v přirozeném jazyce a vrátí odpověď syntetizovanou
z relevantních diskuzí. Vyžaduje naplněné Neo4j (proběhlý `graph-write`) a stejný `[llm]`
adapter jako enrichment. Běží synchronně; jeden request = 1 lokální embedding dávka + pár
Neo4j čtení + **2 LLM volání** (plánovač dotazu + syntéza odpovědi).

Pipeline: porozumění dotazu (LLM → přeformulování, témata, intent, filtry) → retrieval
(vektorový index + shoda názvů `Topic`/`Entity` přes fulltext) → grafová expanze
(`CONTINUATION_OF` / sdílené téma nebo entita / `COOCCURS_WITH`, re-rank podle podobnosti
k otázce) → sestavení kontextu (shrnutí + `key_points` + syrové zprávy u top diskuzí) →
ukotvená syntéza s citacemi `[D#]`. Detailní návrh: [`plans/QUERYING.md`](plans/QUERYING.md).

```bash
curl -X POST http://localhost:3004/api/v1/query \
  -H "X-API-Key: $API_KEY" -H "content-type: application/json" \
  -d '{ "question": "Jaký mají lidé názor na Smarty?" }'
```

```jsonc
{
  "answer": "Lidé jsou na Smarty spíš negativní kvůli cenám [D1][D3]. ...",
  "confidence": "high",              // high | medium | low
  "citations": [
    { "ref": "D1", "discussion_id": "…", "title": "…", "channel": "hardware",
      "discussion_type": "discussion", "sentiment": "negative", "started_at": "…",
      "score": 0.83, "used": true }
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

## Doporučený postup ladění

1. Ingestni testovací dávku (`POST /batches`).
2. `POST /channels/:id/clusterize`, počkej na job.
3. Zkontroluj `GET /channels/:id/discussions` — dává rozdělení smysl? Neslévají se / netříští se?
4. Uprav `M` / `W` / `τ` v `config.toml`, restartuj, zkus znovu — na nové dávce nebo na stejných
   datech po `DELETE /api/v1/channels/:id/messages`.
5. Když je clustering OK: `POST /channels/:id/enrich` (klidně s `max_discussions`), projdi
   výsledky, dolaď prompt (`src/core/enrichment/prompt.ts`) nebo model v `config.toml`, opakuj.
6. `docker compose up -d neo4j`, pak `POST /channels/:id/graph-write` a graf projdi v Neo4j
   Browseru:

```cypher
MATCH (d:Discussion)-[:OCCURRED_IN]->(c:Channel) RETURN d, c LIMIT 25;
MATCH (u:User)-[r:INTERESTED_IN]->(t:Topic) RETURN u.username, t.name, r.weight ORDER BY r.weight DESC LIMIT 20;
MATCH (t1:Topic)-[r:COOCCURS_WITH]->(t2:Topic) RETURN t1.name, t2.name, r.count ORDER BY r.count DESC LIMIT 20;
```

Přepsat od nuly: smaž graf (`MATCH (n) DETACH DELETE n`) a v SQLite vrať diskuze ze stavu
`written` na `enriched` — nebo celý kanál přes `DELETE /api/v1/channels/:id/messages`.
