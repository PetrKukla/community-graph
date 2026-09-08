# community-graph

![Bun](https://img.shields.io/badge/Bun-1.3-000000?logo=bun&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Hono](https://img.shields.io/badge/Hono-4-E36002?logo=hono&logoColor=white)
![Svelte 5](https://img.shields.io/badge/Svelte-5-FF3E00?logo=svelte&logoColor=white)
![Drizzle ORM](https://img.shields.io/badge/Drizzle-ORM-C5F74F?logo=drizzle&logoColor=black)
![SQLite](https://img.shields.io/badge/SQLite-staging-003B57?logo=sqlite&logoColor=white)
![Neo4j](https://img.shields.io/badge/Neo4j-graph-4581C3?logo=neo4j&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-4-06B6D4?logo=tailwindcss&logoColor=white)

Dockerizovaná (zatím lokálně spouštěná) služba, která z historie Discord chatu postupně
buduje znalostní graf komunity — kdo o čem mluvil, jaká témata spolu souvisí a jak na sebe
diskuze v čase navazují. Graf jde kdykoliv doplnit novou dávkou zpráv, aniž by vznikaly
duplicity.

Zpracování má tři samostatné, nezávisle spustitelné kroky: **ingest + clusterizace** (zprávy
se rozdělí do tematických diskuzí, mezistav v SQLite) → **AI enrichment** (každá diskuze
projde LLM: title, summary, topics, entities, sentiment) → **graph write** (idempotentní
zápis do Neo4j). Součástí je read-only realtime webové rozhraní a endpoint pro dotazování
nad grafem v přirozeném jazyce. Detaily kroků jsou v [`docs/PIPELINE.md`](./docs/PIPELINE.md),
kompletní návrh v [`PLAN.md`](./PLAN.md).

## Instalace

Vyžaduje Docker. `docker compose up` postaví image (`docker/Dockerfile`, multi-stage Bun —
včetně `web:build`) a spustí `app` + `neo4j` jako jeden origin.

```bash
cp .env.example .env                  # vyplň aspoň API_KEY
cp config.example.toml config.toml    # laditelné parametry (config.toml je gitignored)
docker compose up                     # app na SERVER_PORT z .env (default 3004), Neo4j :7474 / :7687
```

- Lokální `config.toml` se do kontejneru bind-mountuje.
- SQLite migrace z `migrations/` se aplikují automaticky při startu.
- Embedding model (`Xenova/multilingual-e5-small`) se stáhne a zacachuje při prvním `/clusterize`.
- **Krok 2** potřebuje LLM — Anthropic/Gemini API klíč, lokální OpenAI-kompatibilní server
  (Ollama, vLLM, LM Studio) nebo `geek-ai-scheduler` (viz [`AI_INTEGRATION.md`](./AI_INTEGRATION.md)).
  Provider se volí v `config.toml` (`[llm] provider`), kredence jdou do `.env`.
- Kroky 1 a 2 běží i bez Neo4j. Bez `NEO4J_PASSWORD` selže jen `graph-write` job (s jasnou
  hláškou) a `/health` hlásí `neo4j: "not_configured"`.

Lokální běh přes Bun (hot-reload, samostatný Vite dev server, testy): viz
[`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md).

## Rychlý start

Po `docker compose up` běží služba na `http://localhost:3004` (API i webové rozhraní).
Celý řetězec jedním voláním (ingest → clusterize → enrich → graph-write):

```bash
curl -X POST http://localhost:3004/api/v1/pipeline \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "guild":   { "id": "g1" },
    "channel": { "id": "c1", "type": "text" },
    "messages": [
      { "id": "m1", "author": { "id": "u1" },
        "content": "Sledoval někdo ten nový trailer?",
        "created_at": "2026-08-24T10:00:00.000Z" }
    ],
    "options": { "skip_graph_write": true }
  }'
# → 202 { "batch_id": "...", "job_id": "...", "type": "pipeline", "status": "queued" }

curl -H "X-API-Key: $API_KEY" http://localhost:3004/api/v1/jobs/<job_id>
```

Průběh je vidět i v přehledu webového rozhraní. Doporučený postup ladění clusteru/promptu je
v [`docs/PIPELINE.md`](./docs/PIPELINE.md#doporučený-postup-ladění).

## Konfigurace

Dvě oddělené vrstvy:

- **`.env`** — credentials a prostředí-specifické hodnoty, necommitují se. Vzor v `.env.example`.
- **`config.toml`** — laditelné necitlivé parametry, commitnuté s rozumnými defaulty. Čte se
  jen při startu (po změně restartuj server), validuje se přes zod.

Vyplňuj jen klíče pro providera zvoleného v `config.toml`. Chybějící LLM klíč → `enrich` job
skončí `failed`; chybějící `NEO4J_PASSWORD` → totéž pro `graph-write`. Proměnné s prefixem
`VITE_` čte jen Vite dev server, ne služba samotná.

### `.env`

| Proměnná                                        | Popis                                                                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `SQLITE_PATH`                                   | Cesta k SQLite souboru (výchozí `./data/community-graph.sqlite`). Adresář se vytvoří sám.                                               |
| `API_KEY`                                       | Klient ho musí posílat v hlavičce `X-API-Key` na všech `/api/v1/*` endpointech.                                                         |
| `LLM_ANTHROPIC_API_KEY` / `LLM_GEMINI_API_KEY`  | API klíč — jen pro odpovídajícího providera.                                                                                            |
| `LLM_OPENAI_COMPATIBLE_BASE_URL` / `_API_KEY`   | Base URL a klíč OpenAI-kompatibilního serveru (lokální Ollama/LM Studio klíč většinou nechtějí).                                        |
| `LLM_GEEK_AI_SCHEDULER_BASE_URL` / `_NODE`      | Adresa, kde `geek-ai-scheduler` poslouchá (bez `/v1/schedule`), a povinný identifikátor tohoto uzlu (`node`). Viz `AI_INTEGRATION.md`.  |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD`   | Připojení k Neo4j (krok 3). Výchozí hodnoty sedí na `docker-compose.yml`.                                                               |
| `SERVER_HOST` / `SERVER_PORT`                   | Bind adresa a port HTTP serveru (výchozí `0.0.0.0` / `3004`). Vlastní názvy schválně — `HOSTNAME` si v Dockeru drží runtime.            |
| `WEB_EMBED_ORIGINS`                             | Čárkou oddělené originy, kterým se povolí vložit web do `<iframe>` (CSP `frame-ancestors`) a CORS na `/api/v1/*`. Viz `COMMUNITY_GRAPH_INTEGRATION.md`. |
| `VITE_API_BASE` / `VITE_API_KEY`                | **Jen dev.** Base URL API a hodnota `API_KEY` pro Vite dev server. V produkci je frontend na stejném originu — nenastavuj.              |

### `config.toml`

| Klíč                                                                           | Význam                                                                                                                                             |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clustering.silence_gap_minutes` (**M**)                                    | Mezera ticha, po které se časový blok považuje za uzavřený. Vyšší = diskuze se míň tříští kvůli krátkým pauzám.                                    |
| `clustering.short_message_word_limit` (**W**)                               | Pod tímto počtem slov se pro zprávu negeneruje embedding — jen se přilepí k předchozí diskuzi / reply cíli.                                        |
| `clustering.similarity_threshold` (**τ**)                                   | Práh cosine similarity (0–1) pro přiřazení zprávy k sub-clusteru. Nižší = míň roztříštěné; vyšší = míň slévání témat.                              |
| `clustering.active_subcluster_idle_minutes`                                 | Po jaké neaktivitě v bloku se sub-cluster přestane porovnávat. Vyšší = přesnější, pomalejší.                                                       |
| `clustering.continuation_similarity_threshold` (**θ**) / `_lookback_days`   | Pro sémantické `CONTINUATION_OF`. _Zatím nevyužito._                                                                                               |
| `embedding.model` / `embedding.dimensions`                                  | Model pro `@huggingface/transformers` (lokální ONNX, in-process) a jeho dimenze — musí si odpovídat (`e5-small` = 384).                            |
| `llm.provider`                                                              | `anthropic` \| `openai-compatible` \| `gemini` \| `geek-ai-scheduler`. Cílový stav je vlastní lokální `openai-compatible`.                        |
| `llm.model`                                                                 | Název modelu u zvoleného providera (u `geek-ai-scheduler` model stažený v Ollamě).                                                                |
| `llm.max_tokens`                                                            | Strop na délku odpovědi LLM. Zvyš, když se odpověď u velkých rozdělených diskuzí ořezává.                                                          |
| `llm.temperature`                                                           | **Anthropic adaptér ji ignoruje** (Claude 4.5+ ji odmítá); platí pro ostatní providery.                                                           |
| `llm.max_messages_per_call`                                                 | Kolik zpráv nejvýš jde do jedné výzvy; při batchování je to strop na **součet** zpráv za celý batch.                                              |
| `llm.request_timeout_ms`                                                    | Timeout jednoho volání LLM. U `geek-ai-scheduler` musí být **delší** než serverový `request_timeout_ms` scheduleru (výchozí 300 000 ms).         |
| `llm.enrichment_batch_target_tokens`                                        | **Část 4.4.** Cílový rozpočet promptu na jedno enrichment volání — malé clustery se sbalí dohromady. `0` = batching vypnutý.                       |
| `llm.enrichment_batch_max_discussions`                                      | Tvrdý strop na počet clusterů v jednom enrichment volání.                                                                                         |
| `llm.enrichment_batch_retry_individually`                                   | Spadne-li batch, zkusit každou diskuzi zvlášť (`true`) místo označit celý batch za `failed` (`false`).                                             |
| `web.enabled`                                                               | `false` = neservírovat `web/dist` ani endpointy `/api/v1/stream\|stats\|ai/calls\|graph/*`.                                                       |
| `web.dev_port`                                                              | Port Vite dev serveru (`bun run web:dev`); proxuje `/api` na `SERVER_PORT` z `.env`.                                                              |
| `web.llm_calls_retention_days` / `web.llm_calls_max_rows`                   | Retence tabulky `llm_calls` (dashboard buffer): při zápisu se občas ořežou staré řádky / řádky nad limitem.                                        |
| `web.stats_tick_seconds`                                                    | Interval přepočtu `funnel`/`totals` agregátu pro WS klienty (jen když je aspoň jeden připojený).                                                  |
| `web.graph_overview_limit`                                                  | Cílový horní počet uzlů v prvním vykreslení grafu; zbytek se dolazí rozbalením sousedů.                                                           |
| `dictionary.max_ids_per_request`                                            | Strop na součet `channels + users` v jednom `POST /api/v1/dictionary`.                                                                            |
| `dictionary.inline_graph_propagation_max`                                   | Do tolika změněných ID se propagace názvů do Neo4j udělá přímo v requestu; nad = job `name_sync`.                                                  |
| `pipeline.include_graph_write`                                              | Default pro `POST /api/v1/pipeline`, když tělo nemá `options.skip_graph_write`. `false` = běh končí po enrichmentu.                               |
| `query.vector_top_k` / `search_query_variants` / `anchor_limit`             | Retrieval: kandidátů z vektorového indexu na variantu, počet přeformulování otázky, strop diskuzí přes shodu názvu tématu/entity.                  |
| `query.expansion_seed_count` / `expansion_fanout`                           | Kolik nejlepších kandidátů jde do grafové expanze a kolik sousedů se z každého vezme.                                                             |
| `query.evidence_set_size`                                                   | Kolik diskuzí se pošle do syntézy odpovědi.                                                                                                       |
| `query.raw_message_discussions` / `raw_messages_per_discussion`             | U kolika top diskuzí a kolik syrových zpráv z SQLite se přidá do kontextu (`0` = jen shrnutí).                                                     |
| `query.context_token_budget`                                               | Odhadovaný strop kontextu; ořezává se od nejníže skórujících diskuzí.                                                                             |
| `query.min_candidate_score`                                                 | Práh skóre. Když po fúzi nic neprojde, endpoint vrátí `confidence: "low"` bez volání LLM syntézy.                                                  |
| `query.recency_half_life_days`                                             | Po kolika dnech klesne recency bonus na polovinu.                                                                                                 |
| `query.weight_*`                                                            | Váhy složek finálního skóre kandidáta (`vector`, `anchor`, `expansion`, `recency`, `type_preference`).                                            |
| `query.opinion_sentiment_diversity`                                        | U názorových otázek držet v evidence setu i menšinový sentiment.                                                                                   |
| `query.vocab_sample_size`                                                   | Kolik nejčastějších názvů `Topic`/`Entity` se dá plánovači jako slovník grafu.                                                                     |

## Použití

Autentizace: všechny `/api/v1/*` vyžadují hlavičku `X-API-Key` (WebSocket `?token=`).
Kompletní seznam endpointů, tvary vstupů/výstupů a příklady jsou v [`docs/API.md`](./docs/API.md).

### Zpracování dávky

**Sjednocený běh** — `POST /api/v1/pipeline` (s dávkou) nebo `POST /api/v1/channels/:id/pipeline`
(nad už naingestovanými zprávami): jedno volání provede `ingest → clusterize → enrich →
graph-write`, sleduje se přes `GET /api/v1/jobs/:id`. `options.skip_graph_write` běh ukončí
po enrichmentu.

**Granulárně** — každý krok zvlášť, pro ladění:

```bash
POST /api/v1/batches                       # ingest (jen ID; názvy zvlášť přes /dictionary)
POST /api/v1/channels/:id/clusterize       # krok 1
POST /api/v1/channels/:id/enrich           # krok 2   { "max_discussions": N }
POST /api/v1/channels/:id/graph-write      # krok 3   { "max_discussions": N }
```

Názvy guildy/kanálů/uživatelů se posílají mimo dávku, přírůstkově přes `POST /api/v1/dictionary`
(jediný zapisovatel `*.name` sloupců + propagace do Neo4j).

### Webové rozhraní

Lehké **read-only realtime** rozhraní zabudované do služby — nespouští žádný krok pipeline,
jen instrumentace (persistovaná LLM volání + in-process event bus přes WebSocket). Ukazuje:

- **Přehled** — stat karty, pipeline funnel (`raw → clustered → enriched → graph-written`),
  aktivní jobs, poslední LLM volání.
- **Jobs** — živý seznam s filtrem podle typu/stavu; detail s `result` JSON a navázanými voláními.
- **LLM volání** — stream volání (provider, model, doba, tokeny, stav) + agregáty (p50/p95,
  chybovost, volání/min, tabulka podle modelu).
- **Statistiky** — zprávy podle kanálů, histogram velikostí clusterů, LLM časová řada, rozpad
  podle `sentiment` / `discussion_type`, top témata a entity.
- **Graf** — vizualizace Neo4j přes sigma.js + forceatlas2 (WebGL): klik rozbalí sousedy,
  hledání zoomne, filtr podle kanálu a typu uzlu. Vyžaduje běžící Neo4j a proběhlý `graph-write`.
- **Zeptat se** — pole na otázku nad `POST /api/v1/query`: ukotvená odpověď s `confidence`
  badgem, značky `[D#]` skrolují na karty citací, klik otevře drawer s detailem diskuze.
  Klientská historie dotazů v `localStorage`.

V Docker image je frontend už sestavený a servíruje ho stejná Hono app na `/` (SPA fallback).
Ve vývoji běží zvlášť na Vite dev serveru — viz [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md).

### Dotazování nad grafem

`POST /api/v1/query` — otázka v přirozeném jazyce → odpověď syntetizovaná z relevantních
diskuzí + citace `[D#]`. Synchronní, 2 LLM volání (plánovač + syntéza). Vyžaduje naplněné Neo4j.

```bash
curl -X POST http://localhost:3004/api/v1/query \
  -H "X-API-Key: $API_KEY" -H "content-type: application/json" \
  -d '{ "question": "Jaký mají lidé názor na Smarty?" }'
```

Nepovinné `filters.{channel_ids,discussion_types,since}` jsou jediné tvrdé filtry; `?debug=1`
přidá plán dotazu, kandidáty a časy fází. Podrobnosti a tvar odpovědi v
[`docs/API.md`](./docs/API.md#dotazování-nad-grafem--post-apiv1query-část-3).

## Další dokumentace

- [`PLAN.md`](./PLAN.md) — kompletní návrh: architektura, zdůvodnění rozhodnutí, budoucí kroky.
- [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) — lokální běh přes Bun (dev), Vite dev server, testy, migrace.
- [`docs/PIPELINE.md`](./docs/PIPELINE.md) — kroky 1–3 detailně + postup ladění.
- [`docs/DATA_MODEL.md`](./docs/DATA_MODEL.md) — SQLite schéma, životní cyklus diskuze, Neo4j uzly a hrany.
- [`docs/API.md`](./docs/API.md) — všechny HTTP endpointy, tvary vstupů/výstupů, příklady.
- [`AI_INTEGRATION.md`](./AI_INTEGRATION.md) — integrace `geek-ai-scheduler` jako LLM provideru.
- [`plans/`](./plans/) — dílčí návrhy: `QUERYING.md`, `DICTIONARY.md`, `WEBAPP.md`, `INTEGRATION.md`.
