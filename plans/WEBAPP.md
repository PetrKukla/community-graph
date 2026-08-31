# community-graph — Navazující fáze: Webové observability rozhraní

## Zařazení

Samostatná fáze **navazující na M6** z [`PLAN.md`](../PLAN.md) — staví na hotové, ručně ověřené pipeline a stabilním HTTP API. Nemění chování fáze 1: přidává jen **read-only** pohled na to, co se v systému děje, plus instrumentaci (persistované LLM volání, in-process event bus). Žádný krok pipeline se z UI ve v1 nespouští.

**Závislosti:**

- HTTP API a `apiKeyAuth` middleware (M1–M4)
- job systém + `jobRunner` (M2+)
- naplněné Neo4j (M4) — bez něj funguje vše kromě grafového pohledu
- `LoggingLLMProvider` jako jediné místo, kudy tečou LLM volání (už existuje) — rozšíří se o sink

## Cíl

Lehké, moderní, realtime webové rozhraní, na kterém je přehledně vidět celý provoz `community-graph`:

- **aktuální jobs** — fronta i historie, stav, progress, výsledek/chyba
- **AI požadavky** — stream LLM volání: provider, model, kontext, doba generace, stav, tokeny
- **statistiky**
  - počty zpráv podle kanálů
  - průměrná (a p50/p95) doba generace LLM, celkově i podle modelu
  - clusterizace: kolik diskuzí, rozložení velikostí clusterů, a **per kanál** kolik zpráv je rozděleno do kolika clusterů
  - rozpad podle `discussion_type` a `sentiment`, top témata/entity
  - pipeline funnel: `raw → clustered → enriched → graph-written` (počty zpráv v každém stavu)
- **vizualizace Neo4j grafu** — animovaný force layout, klik na uzel → detail + rozbalení sousedů

Vše se aktualizuje **realtime přes WebSocket**. Stack drží „maximum muziky s minimem špaget": server state výhradně přes TanStack Query, WS jen patchuje cache.

## Tech stack

| Oblast                | Volba                                                                                                                                    | Proč                                                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jazyk                 | **TypeScript** všude — `<script lang="ts">` v každé komponentě, sdílená logika v `.ts` / `.svelte.ts`, `vite.config.ts`                  | Stejný jazyk i typy jako backend; tvary API odpovědí a WS eventů se sdílejí/zrcadlí z `src/`, ne opisují.                                                                                                                                                   |
| Framework             | **Svelte 5** (runes) + **Vite**, čistá SPA (žádný SvelteKit)                                                                             | Pro tak malý RO náhled je SvelteKit (routing, SSR, adaptery, vlastní `package.json`) zbytečná váha. Vite SPA = jeden `index.html`, jeden bundle, klientský routing. Runy dělají realtime stav čitelný. **Výhradně Svelte 5 idiom, ne Svelte 4** — viz níže. |
| Umístění v repu       | adresář `web/` **uvnitř projektu `community-graph`**, žádné druhé `package.json`                                                         | Není to monorepo ani samostatný balík — je to jen část služby. Frontend devDeps jdou do kořenového `package.json`, build řídí jeden `vite build`.                                                                                                           |
| Build/servírování     | `vite build` → `web/dist/` (statické `index.html` + JS/CSS), servíruje **stávající Hono app** přes `serveStatic` s SPA fallbackem        | Žádné SSR, žádný build adapter. Jeden origin, jeden proces, jeden kontejner, žádné CORS v produkci.                                                                                                                                                         |
| Klientský routing     | malý hash/history router (`svelte-spa-router`, ~1 KB) nebo pár `{#if}` větví                                                             | Šest pohledů, nic víc není potřeba.                                                                                                                                                                                                                         |
| Server state          | **TanStack Query** (`@tanstack/svelte-query`)                                                                                            | Cache, background refetch, dedup, retry. WS události jen volají `setQueryData`/`invalidateQueries`. Polling jako fallback při výpadku WS.                                                                                                                   |
| Realtime              | Nativní `WebSocket` klient + malý reconnect store; server přes `Bun.serve` websocket                                                     | Bez Socket.IO. Server má in-process `EventEmitter` bus, WS handler jen forwarduje.                                                                                                                                                                          |
| Komponentová knihovna | **shadcn-svelte** — přes `components.json` + CLI (`bunx shadcn-svelte@latest add …`), komponenty se kopírují do `web/lib/components/ui/` | Zdroják vlastníme, styl se ladí přímo v komponentě, žádný runtime lock-in. Používané: `card`, `badge`, `table`, `tabs`, `dialog`, `sheet`, `button`, `skeleton`, `tooltip`, `dropdown-menu`. Funguje i mimo SvelteKit (Vite + Svelte).                      |
| Styling               | **TailwindCSS v4** (`@import "tailwindcss"` + `@theme` tokeny — paleta, radii, font — v `app.css`; Vite plugin `@tailwindcss/vite`)      | Veškeré stylování přes utility třídy přímo v markupu. Žádné velké `<style>` bloky, žádný ručně psaný CSS soubor mimo `app.css`. Rychlé, konzistentní, lehké.                                                                                                |
| Grafy                 | **LayerChart** (Svelte-native, nad d3) pro bar/line/funnel; `uPlot` pokud bude časová řada LLM časů velká                                | Svelte-native, malé, animovatelné, žádný React-wrapper balast.                                                                                                                                                                                              |
| Graf viz              | **graphology** + **sigma.js v3** (WebGL), layout `graphology-layout-forceatlas2` ve `Worker`                                             | Zvládne velký graf, WebGL render, plynulé animace kamery i uzlů. Force layout běží mimo hlavní vlákno.                                                                                                                                                      |
| Ikony                 | `@tabler/icons-svelte`                                                                                                                   | Neutrální, konzistentní, široká sada.                                                                                                                                                                                                                       |

### Skills při implementaci

Frontend se nepíše „od ruky" — použijí se instalované Svelte skills:

- **`svelte-code-writer`** — povinně při každém vytváření/editaci/analýze `.svelte` a `.svelte.ts` (lookup Svelte 5 docs + analýza kódu). Ideálně spouštět v agentu `svelte-file-editor`, pokud je k dispozici.
- **`svelte-core-bestpractices`** — řídí reaktivitu (runy), event handling, styling a integraci s knihovnami (TanStack Query, sigma.js).
- **`shadcn-svelte`** — přidávání, aktualizace a skládání komponent z knihovny, práce s `components.json` a CLI.
- **`dataviz`** — načíst před psaním jakéhokoli grafu / stat dlaždice: volba typu grafu, paleta (light i dark), osy, legendy, layout dashboardu.

### Svelte 5 — povinný idiom (ne Svelte 4)

Celý frontend se píše moderním Svelte 5 idiomem. Svelte 4 vzory se nepoužívají ani „ze zvyku".

- **Používat:** runy `$state` / `$derived` / `$effect` / `$props` / `$bindable`; `$state.raw` pro velké neměnné struktury (graf, velké seznamy); snippety (`{#snippet}` / `{@render}`) místo slotů; callback props a `onclick={…}` (atributový event) místo `createEventDispatcher`; sdílený stav v `.svelte.ts` modulech s runami místo `writable()` stores; `$effect` s cleanup pro WS/`sigma` lifecycle.
- **Nepoužívat:** `export let` (→ `$props`), `$:` reaktivní deklarace/bloky (→ `$derived` / `$effect`), `on:click` a spol. direktivy (→ `onclick`), `<slot>` / `<svelte:fragment>` (→ snippety), `createEventDispatcher` (→ callback props), `svelte/store` `writable`/`readable` jako primární nástroj stavu, `beforeUpdate` / `afterUpdate`.
- Verze: `svelte` ^5, `@tanstack/svelte-query` ve verzi s podporou Svelte 5, `svelte-spa-router` kompatibilní se Svelte 5. Skill `svelte-code-writer` ověří API proti Svelte 5 docs u každé komponenty.

## Realtime architektura

```
ingest route ─┐
jobRunner ────┼──> core/events/bus.ts  (typed EventEmitter)  ──> WS /api/v1/stream ──> klient ──> TanStack Query cache
LLM sink ─────┘                                                                          (setQueryData / invalidate)
```

**Události na busu (typované):**

| Event          | Kdy                                         | Payload                                                                                                               |
| -------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `job.created`  | nový job zařazen                            | `{ id, type, channel_id, created_at }`                                                                                |
| `job.updated`  | změna stavu/progressu/výsledku              | `{ id, status, progress, result?, error?, updated_at }`                                                               |
| `llm.call`     | dokončené (i chybové) LLM volání            | `{ id, provider, model, context, duration_ms, status, prompt_tokens?, completion_tokens?, channel_id?, job_id?, at }` |
| `ingest.batch` | přijatý batch                               | `{ batch_id, channel_id, message_count, inserted_count, duplicate_count, at }`                                        |
| `stats.tick`   | throttlovaný přepočet agregátů (max 1×/2 s) | `{ funnel, totals }` — jen to, co je levné spočítat                                                                   |

**Klient:** jedno WS spojení, reconnect s exponenciálním backoffem (max ~15 s), při reconnectu `queryClient.invalidateQueries()` pro dorovnání zmeškaného. Každý event má tenký handler, který cíleně upraví relevantní query klíč — žádný globální store, žádné ruční slévání stavu.

**Auth:** `apiKeyAuth` chrání `/api/v1/*`. WS se autentizuje `?token=<API_KEY>` v query (hlavičky u WS handshake z prohlížeče nejdou). REST volání z frontendu posílají `x-api-key`. V devu se klíč bere z kořenového `.env` přes Vite (`VITE_API_KEY`, `VITE_API_BASE`, prefix `VITE_` je nutný, aby se hodnota dostala do klientského bundlu). V produkci běží frontend na stejném originu jako API za reverse proxy — klíč drží proxy, nebo se zadá jednou v UI a uloží do `localStorage`.

## Nová backend práce

Vše v existující Bun/Hono službě, za stávajícím API-key middlewarem.

### Endpointy

```
GET  /api/v1/stream                      # WebSocket, forwarduje bus události; ?token=<API_KEY>

GET  /api/v1/stats                       # agregáty pro dashboard (Drizzle + pár Neo4j countů)
  -> {
       totals: { channels, messages, users, discussions, topics, entities, last_ingested_at },
       funnel: { raw, clustered, enriched, graph_written },      # počty messages podle processed
       messages_per_channel: [{ channel_id, name, count }],
       clusters_per_channel: [{ channel_id, name, discussions, messages, avg_messages_per_discussion }],
       cluster_size_histogram: [{ bucket, count }],
       discussion_types: [{ type, count }],
       sentiment: [{ label, count }],
       llm: { total_calls, error_rate, avg_ms, p50_ms, p95_ms, by_model: [{ model, calls, avg_ms, p95_ms }] },
       llm_timeseries: [{ ts_bucket, calls, avg_ms }]            # posledních N minut, bucket po minutě
     }

GET  /api/v1/ai/calls?limit=&status=&model=&cursor=   # stránkovaný výpis llm_calls, newest-first

GET  /api/v1/graph/overview?channel_id=&limit=        # navzorkovaný podgraf pro první vykreslení
  -> { nodes: [{ id, label, caption, props, degree }], edges: [{ id, source, target, type, props }] }
GET  /api/v1/graph/node/:id/neighbors?limit=          # rozbalení sousedů uzlu (expand-on-click)
GET  /api/v1/graph/search?q=                          # fulltext přes Topic.name / Entity.name / Discussion.title / User.username
```

`GET /api/v1/stats` route PLAN.md zmiňuje, ale v `src/http/app.ts` zatím není zaregistrovaná — tady se dodělá a rozšíří.

### Schéma (Drizzle) — nová tabulka

```typescript
export const llmCalls = sqliteTable(
  'llm_calls',
  {
    id: text('id').primaryKey(), // uuid
    provider: text('provider').notNull(), // anthropic|openai-compatible|gemini
    model: text('model').notNull(),
    context: text('context'), // request.context label (např. "enrich discussion abc")
    channelId: text('channel_id'),
    jobId: text('job_id'),
    startedAt: text('started_at').notNull(),
    durationMs: integer('duration_ms').notNull(),
    status: text('status').notNull(), // ok|error
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    error: text('error')
  },
  (table) => [
    index('idx_llm_calls_started').on(table.startedAt),
    index('idx_llm_calls_model').on(table.model)
  ]
);
```

Migrace přes `drizzle-kit generate`. Retence: prostý strop — při zápisu jednou za čas smazat řádky starší než `web.llm_calls_retention_days` (default 14) nebo nad `web.llm_calls_max_rows` (default 50 000). Tabulka je čistě pro dashboard, ne pro audit promptů (ten drží `discussion_enrichment.raw_llm_response`).

### Instrumentace

- **`src/core/events/bus.ts`** — malý typovaný `EventEmitter` (žádná závislost na Hono), jediná instance importovaná napříč.
- **`LoggingLLMProvider`** — přidat volitelný `sink: (record: LLMCallRecord) => void` (injektovaný ve factory vedle `label`). Po dokončení/chybě volání sink zavolá: zapíše řádek do `llm_calls` a `bus.emit("llm.call", …)`. Jádro (`enrichmentPipeline`) zůstává nedotčené — instrumentace žije v adaptérové vrstvě. Tokeny se plní, pokud je `LLMStructuredResult` nese (jinak `null`).
- **`jobRepository`** — funkce, co mění job (`createJob`, `updateJobStatus`, `updateJobProgress`, `finishJob`), po commitu emitnou `job.created` / `job.updated`. Alternativa, pokud je repo záměrně „hloupé": emitovat z `jobRunner` na hranicích fází.
- **ingest route** — po uložení batche `bus.emit("ingest.batch", …)`.
- **`stats.tick`** — malý interval v `src/index.ts` (nebo lazy on-connect), počítá jen levný funnel + totals; drahé agregáty se berou HTTP dotazem `GET /api/v1/stats` s TanStack Query cache + `staleTime`.

### Servírování frontendu

`src/http/app.ts` dostane na konci (po `/api/v1`) statické servírování `web/dist/` přes `hono/bun` `serveStatic` s SPA fallbackem na `index.html`. Žádný samostatný web server, žádná nová služba — jsou to tytéž Hono routy jako API. Dev běží zvlášť na Vite :5173 s proxy `/api` → `:3004`, takže CORS řešit netřeba; pro jistotu přidat `hono/cors` povolující `localhost:5173` jen když `NODE_ENV !== "production"`.

Kořenový `package.json` dostane frontend devDeps (`svelte` ^5, `vite`, `@sveltejs/vite-plugin-svelte`, `tailwindcss` ^4 + `@tailwindcss/vite`, `@tanstack/svelte-query`, `@tabler/icons-svelte`, `graphology`, `sigma`, `layerchart`, `svelte-spa-router`, `typescript`, `svelte-check`) a skripty `web:dev` (`vite`), `web:build` (`vite build`). `vite.config.ts` v rootu má `root: "web"`, `build.outDir: "web/dist"` a dev proxy na `[server].port` (default `:3004`).

## Neo4j dotazy pro graf

Read-only, přes existující `Neo4jGraphStore` driver (přidat metody, ne obcházet port).

- **overview** — navzorkovat: `MATCH (d:Discussion) [WHERE d.channel_id = $ch] WITH d ORDER BY d.started_at DESC LIMIT $limit MATCH (d)-[r]-(n) RETURN …` + dotáhnout `Channel`/`Topic` uzly s nejvyšším stupněm. Cíl ~300–500 uzlů pro první render, zbytek dolazit expandem.
- **neighbors** — `MATCH (n {id:$id})-[r]-(m) RETURN r, m LIMIT $limit`, typ uzlu se pozná z labelů.
- **search** — nad `Topic.name`, `Entity.name`, `Discussion.title`, `User.username`; vrací kandidáty pro „zoom to node".
- caption per label: `Topic.name`, `Entity.name`, `Discussion.title`, `Channel.name`, `User.display_name`.

## Frontend struktura

Vše pod `web/` v kořeni projektu `community-graph` (žádné `package.json`, žádný `svelte.config.js` — konfig je kořenový `vite.config.ts`):

```
web/                          # celý frontend v TypeScriptu (<script lang="ts">, .ts, .svelte.ts)
  index.html                  # jediný HTML entry, <div id="app">
  main.ts                     # mount App, QueryClientProvider, init socket
  app.css                     # Tailwind v4 @import, @theme tokeny (paleta, radii, font)
  components.json             # shadcn-svelte konfig (aliasy, cesta k ui/)
  App.svelte                  # AppShell + <Router> (svelte-spa-router)
  routes.ts                   # mapa cesta -> view komponenta
  types.ts                    # sdílené/zrcadlené tvary API odpovědí a WS eventů z src/
  lib/
    api/client.ts             # fetch wrapper: base URL + x-api-key, typed responses
    api/queries.ts            # useJobs, useJob, useStats, useAiCalls, useGraphOverview … (TanStack Query)
    realtime/socket.ts        # createSocket(): reconnect+backoff, typed onEvent
    realtime/patch.ts         # event -> queryClient mutace (jedna funkce na event typ)
    components/
      ui/                     # shadcn-svelte komponenty (kopírované přes CLI, editovatelné)
      AppShell.svelte         # nav, theme toggle, connection indikátor
      JobRow.svelte  JobProgress.svelte  StatCard.svelte
      charts/BarChart.svelte  LineChart.svelte  Funnel.svelte
      graph/GraphCanvas.svelte  NodeDetail.svelte  GraphControls.svelte
    graph/layoutWorker.ts     # forceatlas2 ve Worker
    stores/theme.svelte.ts
  views/
    Overview.svelte           # StatCards + Funnel + aktivní jobs + mini timeline
    Jobs.svelte               # živý seznam + filtr podle typu/stavu
    JobDetail.svelte          # progress, result JSON, chyba, navázaná LLM volání
    Ai.svelte                 # stream LLM volání + agregáty (avg/p50/p95, error rate, calls/min)
    Stats.svelte              # zprávy/kanál, LLM časová řada, histogram velikostí clusterů,
                              #   per-kanál tabulka (zprávy × clustery), sentiment, discussion_type, top témata
    Graph.svelte              # GraphCanvas + Controls + NodeDetail sheet
```

## Design principy

- **Lehký, jednoduchý, moderní.** Neutrální paleta (zinc/slate), **jeden** akcentní tón, systémový font stack, hodně bílého prostoru, jemné stíny, `border-radius` konzistentní z jednoho tokenu. Světlý i tmavý režim podle `prefers-color-scheme` + přepínač.
- **Data-forward.** Obrazovka = mřížka karet a tabulek. Čísla velká a čitelná, popisky malé. Grafy bez 3D, bez zbytečných legend, přímé popisky u řad.
- **Pohyb střídmý.** Animují se přechody stavu (job progress, nová řádka ve streamu → fade/slide ~150 ms), layout a kamera grafu. Žádné dekorativní loop animace, žádný parallax.
- **Vyhnout se AI klišé.** Žádné fialovo-modré gradienty přes celé pozadí, žádné „✨ Empower / Unleash / Supercharge" texty, žádné emoji v nadpisech, žádný chatbot maskot, žádné glassmorphism karty. Kopie je věcná a stručná: „Jobs", „LLM volání", „Zprávy podle kanálů". Prázdné stavy jsou jedna věta bez ilustrace.
- **Stavy vždy.** Každá query má loading skeleton, prázdný stav a chybový stav s retry. WS odpojení = nenápadný indikátor v hlavičce, ne modál.

## Graf — animace

- První render: uzly se objeví v aktuálních pozicích z workeru, `forceatlas2` doběhne pár set iterací a sigma průběžně překresluje → uzly „dosednou" plynule.
- Expand sousedů: nové uzly se přidají poloprůhledné u rodiče, layout se rozběhne jen na okolí, kamera plynule odzoomuje aby se vešly (`sigma.camera.animate`).
- Klik na uzel: kamera `animate` na uzel, zvýraznění ego-sítě (ostatní ztlumit na ~15 % opacity), `NodeDetail` sheet zprava.
- Velikost uzlu = `degree` (odmocninová škála), barva = label. Hover ukáže caption.
- Filtr podle kanálu / typu uzlu = re-fetch overview, ne klientské skrývání (drží graf malý).

## Konfigurace

Web část **nemá vlastní konfigurační mechanismus** — jede na stejném dvouvrstvém modelu jako zbytek `community-graph`: laditelné/necitlivé hodnoty v `config.toml`, secrety a prostředí-specifické v `.env` (viz [`PLAN.md` §1.8](../PLAN.md#18-konfigurace-env-vs-configtoml)).

- **`[server]`** (sdílená s Částí 1 — je to jeden proces, jeden port): `port` (default **3004**), `host` (default `"0.0.0.0"`). Obojí přebíjitelné přes `.env` (`PORT`, `HOSTNAME`) pro Docker/deploy. Dev Vite server jede na `[web].dev_port` (default 5173) a proxuje `/api` na `http://{host}:{port}`.
- **`[web]`** — parametry rozhraní a instrumentace:

```toml
[server]
port = 3004                    # HTTP port API i webového rozhraní; override PORT v .env
host = "0.0.0.0"               # bind adresa; override HOSTNAME v .env

[web]
enabled = true                # false = neservírovat web/dist ani /api/v1/stream|stats|graph
dev_port = 5173               # port Vite dev serveru
llm_calls_retention_days = 14
llm_calls_max_rows = 50000
stats_tick_seconds = 2
graph_overview_limit = 400
```

- **`.env`** — `API_KEY` (sdílený, chrání `/api/v1/*`); pro dev navíc `VITE_API_BASE` (default odvozeno z `[server]`) a `VITE_API_KEY` (aby klientský bundl mohl volat chráněné API).

Všechno podstatné kolem webového rozhraní — základní popis (co to je, co ukazuje), jak ho spustit v devu i produkci, a vysvětlení každého klíče v `[web]` a relevantních `.env` proměnných — se dopíše do českého `README.md` vedle stávající dokumentace `config.toml`/`.env`.

## Deployment

Žádná nová služba, žádný samostatný balík — jen build krok navíc a statické soubory ve stejném image.

- **Dev:** `bun run dev` (služba, :3004) + `bun run web:dev` (Vite, :5173, proxy `/api` → :3004).
- **Prod:** stávající `docker/Dockerfile` dostane před spuštěním `bun run web:build` (vzniká `web/dist/`, jde do image). Není potřeba samostatná build stage ani druhý `npm ci` — frontend devDeps jsou v kořenovém `package.json`. `docker-compose.yml` zůstává `app` + `neo4j` beze změny; port se mapuje z `[server].port` / `PORT`.

## Milníky

- **W0 — Scaffold.** `web/` (Svelte 5 runes + Vite SPA, vše v TS; **TailwindCSS v4** přes `@tailwindcss/vite` + `app.css`; `@tanstack/svelte-query` provider; shadcn-svelte init přes CLI; `svelte-spa-router`); frontend devDeps a skripty `web:dev`/`web:build` do kořenového `package.json`; kořenový `vite.config.ts` (`root: "web"`, `outDir: "web/dist"`, plugins `svelte` + `tailwindcss`, `server.port` z `[web].dev_port`, dev proxy `/api` → `[server].port` (default `:3004`)). `AppShell` s navigací, theme toggle, connection indikátor (zatím fake). Bun `serveStatic` na `web/dist/` + SPA fallback ve `src/http/app.ts`, dev CORS jen mimo produkci. **Ověření:** `bun run web:build` → služba servíruje prázdný shell na `/`, `/api/v1/*` dál funguje.
- **W1 — Instrumentace + stream.** `core/events/bus.ts`; `llm_calls` tabulka + migrace + retence; `LoggingLLMProvider` sink (zápis + `bus.emit`); job em ise z `jobRepository`/`jobRunner`; `ingest.batch` emit; `GET /api/v1/stream` WS (`?token`), forwarduje bus; `GET /api/v1/stats` route zaregistrovaná a naplněná; `GET /api/v1/ai/calls`. **Ověření:** `websocat` na stream, spustit `enrich` job → chodí `job.updated` + `llm.call`; `curl /api/v1/stats` vrací funnel a `llm` agregáty.
- **W2 — Overview + Jobs.** TanStack Query hooky, `realtime/patch.ts` (event → cache), Overview (StatCards + Funnel + aktivní jobs), `/jobs` živý seznam + filtr, `/jobs/:id` detail s result JSON a navázanými LLM voláními. **Ověření:** spuštěný job je vidět realtime bez reloadu; reconnect po killnutí služby dorovná stav.
- **W3 — AI + Statistiky.** `/ai` stream LLM volání + agregáty (avg/p50/p95, error rate, calls/min, per-model tabulka). `/stats`: bar zprávy/kanál, line LLM časová řada, histogram velikostí clusterů, per-kanál tabulka (zprávy × clustery × avg), sentiment a `discussion_type` rozpad, top témata/entity. **Ověření:** čísla sedí s přímými SQL dotazy do SQLite; grafy se překreslují na `stats.tick`.
- **W4 — Graf.** `GET /api/v1/graph/overview|node/:id/neighbors|search` (Neo4j reads přes `Neo4jGraphStore`). `GraphCanvas` (sigma v3 + graphology), `forceatlas2` ve Workeru, animovaná kamera, expand-on-click, `NodeDetail` sheet, filtr podle kanálu/labelu. **Ověření:** po `graph-write` na testovacím kanálu se graf vykreslí, klik rozbalí sousedy, search zoomne na uzel.
- **W5 — Polish + Docker.** Reconnect/backoff doladit, všechny loading/empty/error stavy, responzivita, `bun run web:build` krok ve stávajícím `docker/Dockerfile`, sekce v `README.md` (česky). **Ověření:** `docker compose up` → dashboard na `/`, realtime funguje proti pipeline běžící ve stejném compose.

## Verifikace

- **Realtime:** spustit `clusterize → enrich → graph-write` na testovacím kanálu, sledovat `/jobs` a `/ai` bez manuálního reloadu; každý přechod stavu jobu a každé LLM volání se objeví do ~1 s.
- **Konzistence statistik:** hodnoty na `/stats` porovnat s přímými dotazy — `SELECT channel_id, count(*) FROM messages GROUP BY 1`, `SELECT processed, count(*) FROM messages GROUP BY 1`, `SELECT count(*) FROM discussions_local`, agregáty nad `llm_calls`.
- **Graf:** počty uzlů/hran v overview odpovídají `MATCH (n) RETURN labels(n), count(*)`; expand nevytváří duplicitní uzly v grafologii (merge podle `id`).
- **Odolnost:** zabít Bun službu za běhu → UI ukáže „odpojeno", po restartu se spojení obnoví a data dorovnají; WS bez `?token` nebo se špatným → 401/close.
- **Zátěž:** `llm_calls` s ~50 k řádky — `/api/v1/stats` a `/api/v1/ai/calls` odpovídají do stovek ms (indexy na `started_at`, `model`); retence maže staré řádky.
- **Build:** `web/dist/` build servírovaný stávající Hono app funguje ze stejného originu bez CORS; hluboký odkaz (`/graph`) po reloadu spadne na SPA fallback.

## Mimo scope (v1)

- **Spouštění pipeline z UI** (tlačítka „clusterize" / „enrich" / „graph-write") — snadný fast-follow (POST na existující endpointy), ale v1 je čistě read-only observability.
- Editace `config.toml` z UI.
- Historické trendy nad rámec posledních N minut/hodin pro LLM časy (žádná time-series DB).
- Autentizace uživatelů dashboardu nad rámec sdíleného API klíče.
- Perzistence rozložení grafu, uživatelské anotace uzlů.
- Mobilní-first layout — cíl je desktop, jen ať se to nerozsype na tabletu.

## Otevřené otázky k potvrzení

1. **API klíč v prohlížeči** — v produkci spolehnout na reverse proxy (frontend bez klíče, proxy ho přidává), nebo klíč zadat v UI a držet v `localStorage`? Návrh: proxy pro prod, `localStorage` pro dev.
2. **Graf viz** — `sigma.js v3 + graphology` (škáluje, WebGL, doporučeno) vs. `d3-force` + SVG (hezčí enter/exit animace, ale strop ~1–2 k uzlů). Návrh: sigma.
3. **`stats.tick`** — počítat vždy na intervalu, nebo jen když je aspoň jeden WS klient připojený? Návrh: jen s připojeným klientem.
4. **Tokeny v `llm_calls`** — nese je aktuální `LLMStructuredResult` u všech tří adaptérů? Pokud ne, sloupce zůstanou `null` a v UI se skryjí, dokud se adaptéry nedoplní.
