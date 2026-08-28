# community-graph — plán

Dokerizovaná služba, která převádí historii Discord komunity (kanály, zprávy, uživatele) na inkrementálně aktualizovatelný knowledge graph, staví nad ním realtime přehled a — výhledově — dotazování v přirozeném jazyce.

Práce je rozdělená do tří částí:

| Část | Náplň | Stav |
|---|---|---|
| **[1 — Generace grafu](#část-1--generace-grafu)** | ingest → clustering → AI enrichment → zápis do Neo4j | navrženo (většina tohoto dokumentu) |
| **[2 — Webová aplikace a zobrazení grafu](#část-2--webová-aplikace-a-zobrazení-grafu)** | read-only realtime dashboard + vizualizace grafu | navrženo, detail v [`plans/WEBAPP.md`](plans/WEBAPP.md) |
| **[3 — Dotazování nad grafem](#část-3--dotazování-nad-grafem-querying)** | NL dotaz → odpověď syntetizovaná z grafu | **zatím nenavrženo** |

---

## Původní zadání (verbatim)

> Tento nový projekt slouží jako dokerizovaná služba pro grafaci komunity, respektive Discord chatu nebo i třeba subredditu.
>
> Primárně to aktuálně vyvíjim pro použití právě na Discordu, takže se zaměříme hlavně na to.
>
> Vize je taková, že se s timhle bude komunikovat přes nějakej jednoduchej HTTP server. Nejprve se pošlou všechny zprávy (kterých může být taky klidně milion, takže to musí být robustní a stabilní) a ty se efektivně převedou na graf.
>
> Důležité prvky, které musíme dodržet:
> - graf půjde aktualizovat tím, že pošlu novou batch zpráv a graf se správně doplní
> - graf bude sloužit jako ultimátní databáze znalostí celé komunity - vše co kdo napsal je nová informace, kterou se náš graf naučí a já pak kdykoliv budu moci graf dotazovat a on podle svých znalostí odpoví
>
> Implementace:
> *Toto je pouze můj návrh některých částí - zbytek bude, stejně jako pospojování celku a implementace, na tobě.*
>
> Aktuálně se zaměříme na první část, kterou je generace grafu.
>
> Vstup:
> - to co přiteče nemůžeme držet v RAM, navrhuju SQLite s sqlite-vector pro ukládání zpráv, kanálů, uživatel i vektorů
>   - z databáze budeme číst detaily, jako konkrétní zprávy nebo data uživatelů při dotazu, abychom je nemíchali do grafu a nebyl zbytečně moc velký
>
> Budoucí aktualizace:
> - aby při příští aktualizaci grafu nevznikaly duplicitní nodes, bylo by fajn ukládat id zpráv do sqlite a příště tyto zprávy odfiltrovat
>
> Clusterizace:
> - musíme zprávy rozdělit do clusterů, než je proženeme AI modelem
> - první dělení bude podle channel_id
> - druhé dělení provedeme podle hluchých míst v konverzaci, prostě pokud někdo M minut nenapsal, bereme blok jako ukončený
> - pak provedeme přerozdělení odpovědí - pokud je zpráva odpovědí na zprávu v jiném clusteru (funkce Discord odpovědí), přesuneme ji tam
> - pro každou zprávu v bloku se budou muset vygenerovat embeddingy, podle kterých se rozdělí související správy do víceméně finálních clusterů
>   - pro krátké zprávy do délky W slov nebudeme generovat embeddingy, ale prostě je přilepíme ke clusteru předcházející zprávy, nebo pokud jsou odpovědí na zprávu z jiného clusteru, tak ji přesuneme tam (funkce Discord reply)
>   - embeddingy budeme generovat pomocí lokálního modelu, který spolehlivě podporuje češtinu, bude dostatečně přesný, ale zároveň bude generovat ideálně v řádu desítek ms
> - pokud máš další nápady, jak zajistit, že správně seskupíme zprávy správně k sobě do clusterů, tak řikej
>
> Generace a struktura grafu:
> - clustery postupně proženeme přes AI, které ke každému vygeneruje topic, entities, sentiment, summary a klidně hromadu dalších dat, které se budou hodit (v těchto věcech se snaž hodně přemýšlet i ty, chceme fakt pokročilou znalostní databázi, ze které čím víc vyčteme, tím líp)
> - graf se bude samozřejmě skládat z nodes User, Discussion (to je ten cluster), Topic, Channel (opět, pokud máš další návrhy, klidně je podej)
> - no a edges/relations budou:
>   - User-PARTICIPATED_IN-Discussion
>   - Discussion-DISCUSSES-Topic
>   - Discussion-OCCURED_IN-Channel
>   - Discussion-CONTINUATION_OF-Discussion (pokud diskuze pokračovala i po časové pauze nebo třeba pokud graf aktualizujeme a zpráva z nové diskuse odpovídá na starou diskusi)
>   - Topic-COOCCURS_WITH-Topic (jaká témata se objevují spolu, pro zjištění souvisejících témat)
>
> Příklady použití:
> - vede se v jedné roomce diskuze o tom, že na smarty mají zrovna levné grafiky, do toho někdo odpoví na zprávu z den staré diskuze, že zítra vychází trailer na GTA VI
>   - v grafu by se reakce na GTA VI cluster měla správně zařadit a já se pak budu moct dotazovat třeba: "Jaký mají lidé názor na Smarty?" a jeden z clusterů by mohl být i tento, jelikož bude třeba obsahovat pozitivní reakce na slevy, navíc bude obsahovat další clustery, kde jsou třeba přímo recenze
> - někdo řeší problém s Arch Linuxem, že mu nefunguje zvuk
>   - při dotazu: "Na Linuxu mi nefunguje zvuk po aktualizaci" najdeš mimo jiné tento cluster a z něj AI následně vygeneruje odpověď, která se dále zpracuje

---

## Část 1 — Generace grafu

`ingest → clustering → AI enrichment → graph write`

### 1.1 Cíl a rozsah

Robustní pipeline: přijme batch Discord zpráv přes HTTP → rozdělí je do tematických shluků (`Discussion`) → obohatí je LLM (topic / entities / sentiment / summary / …) → zapíše jako knowledge graph. Graf jde **inkrementálně doplňovat** dalšími batchi bez duplicit a bez držení celé historie v RAM.

**Mimo rozsah Části 1** (vědomě):
- Query/ask endpoint — jen placeholder `POST /api/v1/query` → `501` (řeší [Část 3](#část-3--dotazování-nad-grafem-querying)).
- Synchronizace editů/mazání zpráv z Discordu — jen batch-historické ingesty, ne live sync. Známé omezení.
- `(User)-[:MENTIONED]->(User)` sociální graf — nápad do budoucna, nestavět teď.
- Automatické zřetězení tří kroků do jednoho „full pipeline" volání — odloženo, dokud nebudou kroky ověřené.

### 1.2 Klíčová rozhodnutí

Rozhodnutí z ujasňování zadání, která mění/doplňují původní návrh:

- **Grafová DB = Neo4j** (ne „graph-on-SQLite"). Neo4j 5.11+ má nativní vektorový index → nahrazuje navrhovaný `sqlite-vector` pro Discussion-level embeddingy (budoucí sémantické dotazování + detekce `CONTINUATION_OF` napříč časem). SQLite zůstává pro syrová data (zprávy, uživatelé, kanály, dedup, job/checkpoint stav) a jen dočasnou pracovní cache message-level embeddingů během clusteringu.
- **Ports & adapters (hexagonal)** — tvrdý požadavek; uživatel chce později napojit vlastní lokální AI systém s ještě nefinálním API. Jádro (clustering, graph-building logika) proto nesmí importovat Anthropic/OpenAI/Gemini SDK ani konkrétní embedding knihovnu — jen porty `LLMProvider` a `EmbeddingProvider`. Implementace `LLMProvider`: OpenAI-compatible adapter (funguje rovnou s Ollama/vLLM/LM Studio a pravděpodobně i s budoucím vlastním systémem), Anthropic adapter, Google Gemini adapter — všechny přepínatelné konfigurací. Embeddingy běží vestavěně v procesu (transformers.js/ONNX), ne přes uživatelův AI systém.
- **Konfigurace ve dvou vrstvách**: `.env` = credentials/secrety, `config.toml` (nativní Bun TOML loader) = laditelné necitlivé parametry (M, W, τ, θ, výběr LLM providera, embedding model…). Obojí popsané v českém `README.md`.
- **SQLite přes Drizzle ORM** — žádné ruční SQL stringy. Schéma v TypeScriptu (`drizzle-orm/sqlite-core`), migrace generuje `drizzle-kit`.
- **Ingest endpoint chráněný API-key headerem od začátku**, ne až jako budoucí doporučení.
- **`(User)-[:INTERESTED_IN]->(Topic)` je součást v1** — jednoduchá agregace nad `PARTICIPATED_IN`/`DISCUSSES` počítaná přímo v kroku graph-write, nepřidává novou pipeline fázi.
- **Tři samostatně spustitelné a testovatelné kroky**, každý za vlastním HTTP endpointem, aby šel každý vyladit izolovaně, než se naváže na další:
  - **(a) ingest + clustering** — uložení zpráv a rozdělení do diskuzí (kroky 0–6), bez LLM a bez Neo4j. `POST /api/v1/channels/:id/clusterize`.
  - **(b) AI enrichment** — obohacení diskuzí přes `LLMProvider` (kroky 7–9), zápis jen do SQLite (`discussion_enrichment`). `POST /api/v1/channels/:id/enrich`.
  - **(c) graph write** — zápis obohacených diskuzí do Neo4j (kroky 10–11). `POST /api/v1/channels/:id/graph-write`.
  Žádný krok nespouští další automaticky — výstup každého jde ručně zkontrolovat (SQLite/debug endpoint, resp. Neo4j Browser) předtím, než se pustí další.

### 1.3 Tech stack

| Oblast | Volba | Proč |
|---|---|---|
| Runtime | Bun + TypeScript | Už naskafoldováno; `bun:sqlite` vestavěné (žádný nativní modul), rychlý start, `Worker` pro CPU-bound práci mimo hlavní event loop. |
| HTTP framework | Hono | Lehký, Bun-native, snadná zod validace, žádná zbytečná abstrakce pro pár endpointů. |
| Staging/raw store | SQLite (`bun:sqlite`) přes **Drizzle ORM** (`drizzle-orm` + `drizzle-kit`) | Zvládne miliony řádků bez problému, WAL mód pro souběžný přístup z Worker vlákna, snadno na Docker volume. Drizzle dává typované schema-as-code a generované migrace — žádné ruční SQL. |
| Graph store | **Neo4j** (Docker, oficiální image) | Nativní graph queries + nativní vektorový index (5.11+) pro Discussion embeddingy — nahrazuje potřebu druhé vektorové DB. |
| Embeddingy | transformers.js (`@huggingface/transformers`, ONNX, in-process) | Plně lokální, žádná závislost na externím AI, dobrá čeština přes `Xenova/multilingual-e5-small` (384 dim) nebo `-base` (768 dim, přesnější/pomalejší). Za `EmbeddingProvider` portem. |
| LLM enrichment | Adapter-based: `OpenAICompatibleLLMAdapter` + `AnthropicLLMAdapter` + `GeminiLLMAdapter` | Tvrdý požadavek na vyměnitelnost. Výběr přes `config.toml` (`llm.provider = "openai-compatible" \| "anthropic" \| "gemini"`), API klíče/base URL v `.env`. |
| Background zpracování | In-process async runner, stav v SQLite, embeddingy přes `Bun.Worker` | Bez Redis/BullMQ pro teď (osobní scale) — přesto resumable po restartu, protože progress žije v SQLite. Redis/BullMQ zmíněno jen jako budoucí škálovací krok. |
| Konfigurace | `.env` (secrets) + `config.toml` (laditelné parametry, nativní Bun TOML import) | Odděluje citlivé hodnoty od parametrů, které chce uživatel snadno ladit a mít verzované v repu (M/W/τ/θ, výběr LLM providera, embedding model). Popsáno v `README.md`. |
| Deployment | `docker-compose`: `app` + `neo4j`, SQLite na mountnutém volume | Externí AI systém uživatele není součástí compose, dostupný přes konfigurovatelnou base URL. |

### 1.4 Struktura repozitáře

Cílové rozložení (aktuální stav kódu se může lišit):

```
src/
  core/                          # doménová logika a porty, bez závislosti na konkrétních vendorech
    domain/types.ts              # Message, Discussion, Topic, Entity, User, Channel
    ports/
      EmbeddingProvider.ts       # embed(texts: string[]): Promise<Float32Array[]>
      LLMProvider.ts             # generateStructured<T>(input, schema: ZodSchema<T>): Promise<T>
      GraphStore.ts              # abstrakce nad Neo4j
    clustering/
      timeBlockSplitter.ts
      streamingClusterer.ts      # streaming agglomerative clustering (jádro algoritmu)
      replyReassignment.ts       # cross-block / cross-batch reply logika
      shortMessageAttachment.ts
      continuationInference.ts   # sémantické CONTINUATION_OF
    enrichment/
      enrichmentPipeline.ts
      topicCanonicalizer.ts
      entityCanonicalizer.ts
    graphBuilder/
      discussionWriter.ts        # idempotentní MERGE payloady
  adapters/
    embedding/LocalTransformersEmbeddingAdapter.ts
    llm/
      schemas.ts                 # zod EnrichmentSchema
      OpenAICompatibleLLMAdapter.ts
      AnthropicLLMAdapter.ts
      GeminiLLMAdapter.ts
    graph/Neo4jGraphStore.ts     # driver, constraint/index bootstrap, MERGE queries
  db/sqlite/
    schema.ts                    # Drizzle schema (sqliteTable definice)
    client.ts                    # bun:sqlite Database + drizzle() wrapper
    repositories/{message,channel,user,job,checkpoint,discussionStaging}Repository.ts
  http/
    app.ts
    routes/{ingest,jobs,stats,query,health}.ts
    middleware/{validation,apiKey}.ts   # apiKey aktivní od M1, ne volitelné
  jobs/
    worker.ts                    # Bun.Worker: čistý embedding compute, bez přístupu k SQLite
    jobRunner.ts                 # polluje jobs tabulku, orchestruje pipeline, resumable
    pipeline/{cluster,enrich,graphWrite}Stage.ts
  config/
    env.ts                       # zod-validovaný .env (secrets: API klíče, Neo4j creds, API_KEY pro auth)
    config.ts                    # načte config.toml (nativní Bun TOML import) + zod validace
  index.ts                       # boot Hono + jobRunner

drizzle.config.ts
migrations/                      # generováno drizzle-kit
docker/Dockerfile
docker-compose.yml
config.toml                      # laditelné parametry, viz README.md
.env.example
README.md                        # česky, popisuje config.toml + .env

tests/
  unit/clustering/*.test.ts
  integration/ingestion.integration.test.ts
```

### 1.5 SQLite schéma (staging / raw archiv)

Žádné ruční SQL — schéma je TypeScript (`src/db/sqlite/schema.ts`), migrace generuje `drizzle-kit generate` do `migrations/`, na startu appky běží `migrate()` z `drizzle-orm/bun-sqlite/migrator`. (Aktuální podobu drží vždy `src/db/sqlite/schema.ts`.)

```typescript
import { sqliteTable, text, integer, real, blob, index } from "drizzle-orm/sqlite-core";

export const guilds = sqliteTable("guilds", {
  id: text("id").primaryKey(),
  name: text("name"),
  createdAt: text("created_at"),
});

export const channels = sqliteTable("channels", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").references(() => guilds.id),
  name: text("name"),
  type: text("type"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username"),
  displayName: text("display_name"),
  firstSeenAt: text("first_seen_at"),
  lastSeenAt: text("last_seen_at"),
  messageCount: integer("message_count").notNull().default(0),
});

export const ingestionBatches = sqliteTable("ingestion_batches", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").references(() => channels.id),
  receivedAt: text("received_at").notNull(),
  messageCount: integer("message_count").notNull(),
  status: text("status").notNull().default("received"), // received|queued|processed|failed
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),                          // Discord message id
  channelId: text("channel_id").notNull(),
  guildId: text("guild_id"),
  authorId: text("author_id").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),               // ISO8601, indexováno pro chronologické scany
  replyToMessageId: text("reply_to_message_id"),
  threadId: text("thread_id"),
  mentions: text("mentions", { mode: "json" }).$type<string[]>(),
  attachmentsCount: integer("attachments_count").notNull().default(0),
  wordCount: integer("word_count").notNull(),            // předpočítáno, řídí short-message shortcut
  batchId: text("batch_id").references(() => ingestionBatches.id),
  ingestedAt: text("ingested_at").notNull(),
  processed: integer("processed").notNull().default(0),  // 0=raw 1=clustered 2=enriched 3=graph-written
  discussionId: text("discussion_id"),                   // FK -> discussionsLocal.id
}, (table) => [
  index("idx_messages_channel_time").on(table.channelId, table.createdAt),
  index("idx_messages_thread").on(table.threadId),
  index("idx_messages_reply_to").on(table.replyToMessageId),
  index("idx_messages_processed").on(table.processed),
]);

export const channelCheckpoints = sqliteTable("channel_checkpoints", {
  channelId: text("channel_id").primaryKey(),
  lastProcessedMessageId: text("last_processed_message_id"),
  lastProcessedCreatedAt: text("last_processed_created_at"),
  updatedAt: text("updated_at").notNull(),
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),                          // cluster|enrich|graph_write (full_pipeline: budoucí zřetězení, není v1)
  status: text("status").notNull().default("pending"),    // pending|running|completed|failed|partial
  channelId: text("channel_id"),
  batchId: text("batch_id"),
  cursor: text("cursor", { mode: "json" }),                // JSON: resume stav
  progressCurrent: integer("progress_current").notNull().default(0),
  progressTotal: integer("progress_total").notNull().default(0),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
});

export const discussionsLocal = sqliteTable("discussions_local", {
  id: text("id").primaryKey(),                            // uuid, stane se Neo4j Discussion.id
  channelId: text("channel_id").notNull(),
  threadId: text("thread_id"),
  blockStartAt: text("block_start_at").notNull(),
  blockEndAt: text("block_end_at").notNull(),
  status: text("status").notNull().default("clustering"),  // clustering|needs_reenrichment|enriched|written
  neo4jWritten: integer("neo4j_written").notNull().default(0),
  centroidEmbedding: blob("centroid_embedding", { mode: "buffer" }), // dočasné, mazatelné po enrichmentu
});

export const discussionEnrichment = sqliteTable("discussion_enrichment", {
  discussionId: text("discussion_id").primaryKey().references(() => discussionsLocal.id),
  title: text("title"),
  summary: text("summary"),
  topics: text("topics", { mode: "json" }).$type<string[]>(),
  entities: text("entities", { mode: "json" }).$type<{ name: string; type: string }[]>(),
  sentiment: text("sentiment"),
  sentimentScore: real("sentiment_score"),
  language: text("language"),
  discussionType: text("discussion_type"),
  resolved: integer("resolved", { mode: "boolean" }),
  rawLlmResponse: text("raw_llm_response"),                 // audit/debug
  enrichedAt: text("enriched_at"),
});

export const embeddingsCache = sqliteTable("embeddings_cache", {
  messageId: text("message_id").primaryKey().references(() => messages.id),
  embedding: blob("embedding", { mode: "buffer" }).notNull(),
  modelName: text("model_name").notNull(),
  createdAt: text("created_at").notNull(),
});
```

`mentions`/`topics`/`entities` využívají Drizzle `{ mode: "json" }` sloupce (žádný ruční `JSON.stringify`/`parse`). `embeddings_cache` je jen pracovní cache, ne trvalý vektorový index — bezpečně mazatelná po dokončení clusteringu daného kanálu.

### 1.6 Neo4j schéma

**Constraints/indexy** (bootstrap při startu appky):

```cypher
CREATE CONSTRAINT user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE;
CREATE CONSTRAINT channel_id IF NOT EXISTS FOR (c:Channel) REQUIRE c.id IS UNIQUE;
CREATE CONSTRAINT discussion_id IF NOT EXISTS FOR (d:Discussion) REQUIRE d.id IS UNIQUE;
CREATE CONSTRAINT topic_name IF NOT EXISTS FOR (t:Topic) REQUIRE t.name IS UNIQUE;
CREATE CONSTRAINT entity_key IF NOT EXISTS FOR (e:Entity) REQUIRE e.key IS UNIQUE; -- key = `${type}:${name}`

CREATE VECTOR INDEX discussion_embedding_idx IF NOT EXISTS
FOR (d:Discussion) ON d.embedding
OPTIONS { indexConfig: { `vector.dimensions`: 384, `vector.similarity_function`: 'cosine' } };
-- dimenze musí odpovídat konfigurovanému embedding modelu (384 pro e5-small, 768 pro e5-base)
```

**Nodes:**
- `User {id, username, display_name, first_seen_at, last_seen_at, message_count}` — bez obsahu zpráv, graf zůstává štíhlý.
- `Channel {id, name, guild_id}`
- `Discussion {id, channel_id, started_at, ended_at, message_count, participant_count, title, summary, topics[] /*denormalizované, jen pro pohodlí*/, sentiment, sentiment_score, language, discussion_type, resolved, embedding}`
- `Topic {name /*kanonizovaný*/, category, embedding, discussion_count, created_at}`
- `Entity {key /*type:name*/, name, type, embedding, mention_count, created_at}`

`discussion_type` (navíc k zadání) — enum `question|help-request|discussion|announcement|off-topic|banter|other`; `resolved` bool (LLM odvodí z pozdějších zpráv typu „diky, uz to funguje"). Cílí přímo na příklad s Arch Linuxem — umožní filtrovat na „help-request" clustery.

`Entity` node (navíc oproti zadání — uživatel žádal extrakci „entities", ne samostatný node typ) odděluje konkrétní pojmenované věci (produkt „RTX 4070", brand „Smarty", technologie „Arch Linux") od širších `Topic` (např. „grafické karty"). Bez tohoto rozlišení by `Topic` uzly rychle explodovaly a `COOCCURS_WITH` ztratilo smysl.

**Relationships:**
- `(User)-[:PARTICIPATED_IN {message_count, first_message_at, last_message_at}]->(Discussion)`
- `(Discussion)-[:DISCUSSES]->(Topic)`
- `(Discussion)-[:OCCURRED_IN]->(Channel)`
- `(Discussion)-[:CONTINUATION_OF {reason: 'explicit_reply'|'semantic_similarity', similarity_score, created_at}]->(Discussion)` — novější → starší.
- `(Topic)-[:COOCCURS_WITH {count, last_seen_at}]->(Topic)` — vytvářeno v abecedním pořadí názvů, aby nevznikaly duplicitní opačné hrany (vztah je fakticky neorientovaný).
- `(Discussion)-[:MENTIONS {count}]->(Entity)` (nová relace)
- `(Entity)-[:COOCCURS_WITH {count, last_seen_at}]->(Entity)` (nová relace, zrcadlí Topic-Topic)
- `(User)-[:INTERESTED_IN {weight, discussion_count, last_interaction_at}]->(Topic)` (nová relace, součást v1) — agregace nad `PARTICIPATED_IN`+`DISCUSSES`: pokaždé, když uživatel participuje v diskuzi, která `DISCUSSES` daný topic, se `weight` navýší o počet zpráv uživatele v té diskuzi (`PARTICIPATED_IN.message_count`) a `discussion_count` o 1. Počítá se přímo v kroku 10 (graph write), nepřidává extra pipeline fázi.

Všechny zápisy přes `MERGE` na unikátní klíč s `ON CREATE SET`/`ON MATCH SET` — kritické pro idempotenci při inkrementálních batchích.

**Budoucí/v2 nápady, vědomě nestavěné teď:** `(User)-[:MENTIONED]->(User)` sociální graf.

### 1.7 Clustering algoritmus — krok za krokem

Běží per kanál, per spuštění pipeline. Rozlišuje první ingest (bez checkpointu) od inkrementálního update.

- **Krok 0 — Scan okno.** Čte se `channel_checkpoints`. Bez checkpointu → okno = všechny nezpracované zprávy kanálu. S checkpointem → okno = nezpracované zprávy po checkpointu + read-only lookback buffer (posledních K už zpracovaných zpráv / nejbližší diskuze), použitý jen jako kontext pro reply/continuity matching, nikdy znovu nezpracovávaný.
- **Krok 1 — Thread split.** Discord nativní `thread_id` je tvrdý signál: zprávy se seskupí per-thread a obchází time-gap logiku níže. Zbylé zprávy kanálu = primární (non-threaded) proud.
- **Krok 2 — Time-block segmentace.** V rámci proudu chronologicky; mezera ticha > `M` minut začíná nový blok. `M` konfigurovatelné.
- **Krok 3 — Reply reassignment (cross-block / cross-batch).** Pro každou zprávu s `reply_to_message_id` se dohledá `discussion_id` cíle (z aktuálního batche i z už zapsané diskuze z dřívějšího běhu). Dvě cesty:
  - **(a) přesun jen té jedné zprávy** — pokud zpráva v kroku 5 zůstane lokálním outlierem (nic nového se s ní neshlukne), přesune se sama do cílové diskuze. Řeší „krátkou reakci do den staré diskuze" (příklad GTA VI).
  - **(b) CONTINUATION_OF na úrovni diskuze** — pokud se zpráva v kroku 5 shlukne s ≥2 dalšími novými zprávami do vlastního sub-clusteru, zůstane v nové diskuzi a graph-write (krok 10) místo přesunu vytvoří hranu `CONTINUATION_OF {reason:'explicit_reply'}` z nové diskuze na starou.
  Pořadí implementace: nejprve tentativně označit reply cíle → spustit krok 5 → finalizovat (a) vs (b) podle výsledného členství v sub-clusteru.
- **Krok 4 — Short-message shortcut.** Zprávy s `word_count < W` přeskočí embedding: přilepí se (a) k diskuzi svého reply cíle, jinak (b) k diskuzi chronologicky předcházející zprávy ve stejném bloku; první zpráva nového bloku založí novou diskuzi. `W` konfigurovatelné.
- **Krok 5 — Streaming clustering delších zpráv.** Per blok se drží seznam aktivních sub-clusterů `{id, centroid, lastMessageAt, recentAuthors, recentMentionedUsers}` (reset per blok per proud). Pro každou nevyřešenou zprávu v pořadí: batch-embedding přes `EmbeddingProvider`; cosine similarity vůči každému aktivnímu centroidu + malé heuristické bonusy (nedávno psal stejný autor; @mention nedávného participanta sub-clusteru); přiřazení k nejlepší shodě při skóre ≥ `τ`, jinak nový sub-cluster. Sub-clustery po delší neaktivitě (`active_subcluster_idle_minutes`) se vyřazují z aktivní sady → nikdy plné O(n²) přes celý kanál. `τ` konfigurovatelné.
- **Krok 6 — Finalizace `discussions_local`.** Nové sub-clustery → nové řádky; zprávy z 3(a) / reply / short-message shortcuts ukazují na existující řádky, které dostanou `status = 'needs_reenrichment'`.
- **Krok 7 — LLM enrichment.** Pro každou diskuzi ve stavu `clustering`/`needs_reenrichment`: celý text zpráv → `LLMProvider.generateStructured(input, EnrichmentSchema)` → `{title, summary, topics[], entities[], sentiment, sentiment_score, language, discussion_type, resolved}` → uložení do `discussion_enrichment`. Discussion-level embedding se počítá ze syntetizovaného řetězce `"title. summary. topics"` (konzistentní s budoucím sémantickým dotazováním).
- **Krok 8 — Kanonizace Topic/Entity.** Každý navržený label se embedduje, hledá se shoda s existujícími `Topic`/`Entity` uzly nad prahem kanonizace (lokální cache posledních labelů proti Neo4j round-tripu na každý label; autoritativní kontrola přes Neo4j vektorový index). Entity se párují v rámci svého `type`, aby nedocházelo ke kolizím jmen (např. „Docker" jako Topic vs Entity).
- **Krok 9 — Sémantická CONTINUATION_OF inference.** Po spočítání Discussion embeddingu dotaz na Neo4j vektorový index na top-K podobných `Discussion` uzlů (primárně stejný kanál, volitelně napříč kanály se slabším prahem) v rámci lookback okna; vynechají se páry už propojené přes krok 3(b). Nad prahem `θ` → `CONTINUATION_OF {reason:'semantic_similarity', similarity_score}`. `θ` konfigurovatelné.
- **Krok 10 — Graph write.** Pro každou hotovou diskuzi `MERGE`: `Discussion`/`Channel`/`User` uzly + `PARTICIPATED_IN`; `Topic`/`Entity` uzly + `DISCUSSES`/`MENTIONS`; `COOCCURS_WITH` hrany (abecední konvence) pro páry topiců/entit vyskytujících se spolu v diskuzi; `INTERESTED_IN` hrany mezi každým participantem a každým topicem diskuze (increment `weight`/`discussion_count`); `CONTINUATION_OF` hrany z kroků 3(b) a 9. Pak `discussions_local.neo4j_written = 1`, `messages.processed = 3`.
- **Krok 11 — Posun checkpointu.** Checkpoint se posouvá jen za **plně uzavřené** bloky — blok je uzavřený, jakmile je po jeho poslední zprávě pozorována mezera > `M` minut, nebo `max(timestamp batche) − M` přesáhne čas poslední zprávy bloku. Zprávy ve stále otevřeném koncovém bloku zůstávají `processed = 0` a znovu se zvažují s dalším batchem. **Nejkritičtější místo pro správnost inkrementálních updatů — musí mít vlastní testy.**

### 1.8 Konfigurace: `.env` vs `config.toml`

Dělení podle citlivosti/účelu:

- **`.env`** — jen credentials a prostředí-specifické hodnoty, nikdy ve verzovaném configu: `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `SQLITE_PATH`, `API_KEY` (auth ingest endpointu), `LLM_OPENAI_COMPATIBLE_BASE_URL`, `LLM_OPENAI_COMPATIBLE_API_KEY`, `LLM_ANTHROPIC_API_KEY`, `LLM_GEMINI_API_KEY`. Volitelně `PORT` a `HOSTNAME` jako override `[server]` pro deploy prostředí (Docker, PaaS). Validace přes zod v `src/config/env.ts`.
- **`config.toml`** — laditelné, necitlivé parametry, commitnuté v repu s rozumnými defaulty. Načítá se přes nativní Bun TOML import (`import raw from "../../config.toml"`, bez extra knihovny), validuje se přes zod v `src/config/config.ts`.

Návrh `config.toml`:

```toml
[server]
port = 3004                               # HTTP port služby (API i webové rozhraní z Části 2); override přes PORT v .env
host = "0.0.0.0"                          # bind adresa; override přes HOSTNAME v .env

[clustering]
silence_gap_minutes = 30                  # M — mezera ticha, po které se blok uzavírá
short_message_word_limit = 8              # W — pod tímto počtem slov se embedding negeneruje
similarity_threshold = 0.72               # τ — práh pro přiřazení zprávy k sub-clusteru
continuation_similarity_threshold = 0.80  # θ — práh pro sémantické CONTINUATION_OF
continuation_lookback_days = 14
active_subcluster_idle_minutes = 15       # po jak dlouhé neaktivitě se sub-cluster vyřadí z aktivní sady

[embedding]
model = "Xenova/multilingual-e5-small"
dimensions = 384

[llm]
provider = "openai-compatible"            # openai-compatible | anthropic | gemini
model = "..."                             # název modelu u zvoleného providera
```

Do českého `README.md` patří: účel projektu ve zkratce, jak spustit (`docker compose up`), vysvětlení každého klíče v `config.toml` (co dělá, default, kdy ho měnit) a jasné rozlišení, že `.env` (vzor v `.env.example`) drží credentials a `config.toml` laditelné parametry.

### 1.9 HTTP API

Ingest, clustering, enrichment a graph-write jsou čtyři oddělené kroky/endpointy — žádný nespouští další automaticky. Každý spouští `job` odpovídajícího `type` (`ingest` synchronní, zbylé tři přes `jobRunner`), takže progres/výsledek se sleduje stejným `GET /api/v1/jobs/:id`.

```
POST /api/v1/batches
  body: {
    guild: { id, name },
    channel: { id, name, type },
    messages: [{
      id, author: { id, username, display_name },
      content, created_at,
      reply_to_message_id?, thread_id?,
      mentions?: string[], attachments_count?
    }]
  }
  -> 202 { batch_id, message_count, inserted_count, duplicate_count }
  # jen uloží zprávy do SQLite (dedup na message id), nic dalšího nespouští

POST /api/v1/channels/:id/clusterize
  body: {} | { max_messages?: number }        # volitelný limit na jeden běh, pro postupné ladění na velkém kanálu
  -> 202 { job_id, type: 'cluster', status: 'queued' }
  # kroky 0-6: přiřadí nezpracované zprávy kanálu do discussions_local (bez LLM, bez Neo4j)

POST /api/v1/channels/:id/enrich
  body: {} | { max_discussions?: number }
  -> 202 { job_id, type: 'enrich', status: 'queued' }
  # kroky 7-9: LLM enrichment + topic/entity kanonizace + sémantická continuation inference nad
  # diskuzemi ve stavu 'clustering'/'needs_reenrichment'; zapisuje jen do discussion_enrichment

POST /api/v1/channels/:id/graph-write
  body: {} | { max_discussions?: number }
  -> 202 { job_id, type: 'graph_write', status: 'queued' }
  # krok 10-11: MERGE do Neo4j pro obohacené diskuze + posun checkpointu

GET /api/v1/jobs/:id
  -> { id, type, status, progress: { current, total }, error?, created_at, updated_at, started_at?, finished_at? }

GET /api/v1/jobs?status=&channel_id=&type=       # list/filter

GET /api/v1/channels/:id/discussions?status=      # debug/inspekční endpoint pro ladění kroků (a) a (b)
  -> [{ id, status, message_count, block_start_at, block_end_at, enrichment: { title, summary, topics, ... } | null }]
  # umožňuje zkontrolovat výsledek clusterize/enrich přímo přes SQLite bez nutnosti mít funkční Neo4j

GET /api/v1/stats
  -> { channels, messages, discussions, users, topics, entities, last_ingested_at }

GET /api/v1/channels/:id/stats             # volitelné, per-channel breakdown

POST /api/v1/query -> 501 Not Implemented  # explicitní placeholder pro Část 3

GET /health -> kontrola SQLite + Neo4j konektivity
```

### 1.10 Milníky implementace

Milníky odpovídají třem krokům (a/b/c) — každý končí funkčním, ručně otestovatelným HTTP endpointem, než se pokračuje dál.

- **M0 — Scaffolding & config.** `package.json` (hono, zod, `@huggingface/transformers`, `neo4j-driver`, `drizzle-orm`, `drizzle-kit` (dev), `@anthropic-ai/sdk`, `@google/genai`, uuid), `src/config/env.ts` (zod nad `.env`), `src/config/config.ts` (zod nad `config.toml`), `config.toml`, `.env.example`, `drizzle.config.ts`, `docker-compose.yml` skeleton (zatím jen `app` + volume; `neo4j` přibude v M4), `docker/Dockerfile`, `src/index.ts` (Hono + `/health`), český `README.md` (popis `config.toml`/`.env` a spuštění).
- **M1 — SQLite schéma (Drizzle) + ingest + dedup + auth.** `src/db/sqlite/schema.ts`, `client.ts`, migrace `drizzle-kit generate` → `migrations/`, repositories `message/channel/user/batch` (Drizzle query builder), `src/http/routes/ingest.ts` (`POST /api/v1/batches`, jen ukládá), `src/http/middleware/apiKey.ts` (aktivní na všech `/api/v1/*`, klíč z `.env`). Dedup přes `insert().onConflictDoNothing()`/upsert na message/user/channel id.
  *Test:* curl batch → počty řádků v SQLite + dedup při opakovaném odeslání; `401` bez/se špatným API klíčem.
- **M2 — Krok (a): embedding adapter + clustering + `/clusterize`.** `EmbeddingProvider.ts`, `LocalTransformersEmbeddingAdapter.ts`, `timeBlockSplitter.ts`, `streamingClusterer.ts`, `shortMessageAttachment.ts`, `replyReassignment.ts` (zatím jen intra-batch větev, cross-batch v M5), `src/jobs/worker.ts`, `clusterStage.ts`, `jobRunner.ts` (typ `cluster`), `src/http/routes/clusterize.ts`, `discussionStagingRepository.ts`, debug `GET /api/v1/channels/:id/discussions`. Bez LLM, bez Neo4j.
  *Test:* ingest testovacího batche → `/clusterize` → `/discussions` a ruční kontrola rozpadu (thread bypass, time-gap split, short-message attachment). Unit testy `streamingClusterer`/`timeBlockSplitter`/`shortMessageAttachment` nezávisle na HTTP vrstvě.
- **M3 — Krok (b): LLM adaptery + enrichment + `/enrich`.** `LLMProvider.ts`, `schemas.ts`, `OpenAICompatibleLLMAdapter.ts`, `AnthropicLLMAdapter.ts`, `GeminiLLMAdapter.ts` (`@google/genai`, structured JSON output), `enrichmentPipeline.ts`, `topicCanonicalizer.ts` (kanonizace zatím jen in-memory, proti Neo4j indexu až v M4), `enrichStage.ts`, `jobRunner.ts` + typ `enrich`, `src/http/routes/enrich.ts`. Provider přes `config.toml` `[llm]`, klíče přes `.env`.
  *Test:* na kanálu proklastrovaném v M2 `POST /enrich` → `/discussions` a kontrola title/summary/topics/sentiment bez zapnutého Neo4j.
- **M4 — Krok (c): Neo4j schéma + idempotentní writer + `/graph-write`.** `GraphStore.ts`, `Neo4jGraphStore.ts` (bootstrap constraints/vektorového indexu + MERGE queries), `discussionWriter.ts` (vč. `INTERESTED_IN` agregace User→Topic a `entityCanonicalizer.ts` proti Neo4j indexu), `graphWriteStage.ts`, `jobRunner.ts` + typ `graph_write`, `src/http/routes/graphWrite.ts`, dokončení `neo4j` service v `docker-compose.yml` (volume + healthcheck).
  *Test:* na kanálu obohaceném v M3 `POST /graph-write` → Neo4j Browser dotazy na `Discussion`/`User`/`Topic`/`INTERESTED_IN`.
- **M5 — Korektnost inkrementálních updatů napříč všemi třemi kroky.** `replyReassignment.ts` o cross-batch/cross-run větev (krok 3a/3b), `continuationInference.ts` (sémantické `CONTINUATION_OF` přes Neo4j vektorový index), `checkpointRepository.ts` (block-closure logika). Integrační testy dvou po sobě jdoucích cyklů `clusterize → enrich → graph-write`, vč. reply o několik dní později do už zapsané diskuze.
- **M6 — docker-compose + Dockerfile + e2e smoke test.** Finální `docker/Dockerfile` (multi-stage Bun build), `docker-compose.yml`, `.env.example`, README s instrukcemi, `tests/integration/ingestion.integration.test.ts` (prochází všechny čtyři endpointy v pořadí). Automatické zřetězení do jednoho „spusť všechno" volání je vědomě mimo scope — kroky se spouští ručně / orchestrací zvenčí.

### 1.11 Verifikace / testovací plán

- **Unit testy** (`tests/unit/clustering/*`) se syntetickými batchi: normální time-block splitting; explicitní `thread_id` bypass; short-message attachment (reply-target i preceding-message případ); prokládaná paralelní témata v jednom time-bloku (správnost streaming clustereru); hranice reply-reassignment (a) vs (b); edge-case uzavírání bloků v checkpointu (otevřený koncový blok se neposouvá).
- **Integrační test** (`tests/integration/ingestion.integration.test.ts`, buduje se postupně s M2/M3/M4): Neo4j přes docker-compose (nebo Testcontainers), `POST /api/v1/batches` malého syntetického Discord exportu (s platným `API_KEY` headerem), pak `clusterize → enrich → graph-write` s pollingem `/api/v1/jobs/:id` mezi kroky. Po `clusterize`/`enrich` ověření přes `GET /channels/:id/discussions` (bez závislosti na Neo4j). Po `graph-write` přímý dotaz do Neo4j na počty/tvary uzlů a hran (počet `Discussion`, `PARTICIPATED_IN` hrany, korektní agregace `INTERESTED_IN` vah, žádné duplicitní `Topic` uzly napříč dvěma běhy). Druhý cyklus: druhý batch odpovídající do prvního → dedup + vznik `CONTINUATION_OF` bez re-processingu starých zpráv.
- **Auth test:** request bez `API_KEY` headeru nebo se špatnou hodnotou na kterémkoliv `/api/v1/*` endpointu → `401`.
- **Manuální smoke test po každém kroku zvlášť** (pořadí M2 → M3 → M4, ne až na konci):
  1. `curl -X POST localhost:PORT/api/v1/batches -d @sample-batch.json` → zkontrolovat `inserted_count`/`duplicate_count`.
  2. `curl -X POST localhost:PORT/api/v1/channels/:id/clusterize`, počkat na job, `curl .../channels/:id/discussions` → posoudit rozpad do diskuzí, případně doladit `M`/`W`/`τ` v `config.toml` a spustit znovu.
  3. `curl -X POST localhost:PORT/api/v1/channels/:id/enrich`, počkat na job, znovu `GET /discussions` → posoudit kvalitu title/summary/topics/sentiment, případně doladit prompt/model.
  4. `curl -X POST localhost:PORT/api/v1/channels/:id/graph-write`, pak Neo4j Browser (`MATCH (d:Discussion)-[:OCCURRED_IN]->(c:Channel) RETURN d,c LIMIT 25` apod.) pro vizuální kontrolu grafu.

### 1.12 Klíčové soubory k implementaci

- `src/core/clustering/streamingClusterer.ts` — jádro algoritmu, na jeho správnosti závisí vše ostatní.
- `src/db/sqlite/schema.ts` (Drizzle) — dedup, checkpointing, resumability se odvíjí od tohoto schématu.
- `src/adapters/graph/Neo4jGraphStore.ts` — idempotentní MERGE writer, korektnost inkrementálních updatů.
- `src/core/ports/LLMProvider.ts` a `src/core/ports/EmbeddingProvider.ts` — hexagonální hranice, kterou uživatel explicitně vyžaduje.
- `src/jobs/jobRunner.ts` — resumable běh na pozadí (požadavek „ne blokující HTTP request").

---

## Část 2 — Webová aplikace a zobrazení grafu

Lehké **read-only realtime** webové rozhraní nad běžící službou Části 1. Navazuje na M6, nemění chování pipeline. **Není to samostatný projekt ani monorepo** — je to prostě jednoduchý náhled zabudovaný přímo do služby `community-graph`.

**Co ukazuje:**
- aktuální i historické **jobs** — stav, progress, výsledek/chyba
- **AI požadavky** — stream LLM volání: provider, model, kontext, doba generace, stav, tokeny
- **statistiky** — zprávy podle kanálů; průměrná a p50/p95 doba generace LLM (celkově i per model); clusterizace (kolik diskuzí, rozložení velikostí, per kanál kolik zpráv v kolika clusterech); rozpad podle `discussion_type`/`sentiment`; top témata/entity; pipeline funnel `raw → clustered → enriched → graph-written`
- **vizualizace Neo4j grafu** — animovaný force layout, klik na uzel → detail + rozbalení sousedů

**Stack:** **Svelte 5** (runes — výhradně Svelte 5 idiom, žádné Svelte 4 vzory jako `export let` / `$:` / `on:` / slots) + Vite jako čistá SPA (žádný SvelteKit), celé v **TypeScriptu**; TanStack Query pro veškerý server state; realtime přes WebSocket napojený na in-process event bus (`job.*`, `llm.call`, `ingest.batch`, `stats.tick`); **komponentová knihovna shadcn-svelte** (kopírované komponenty, ne runtime závislost); stylování výhradně přes **TailwindCSS v4** (utility třídy, `@theme` tokeny); ikony `@tabler/icons-svelte`; graf přes graphology + sigma.js v3 (WebGL, `forceatlas2` ve Workeru). Frontend se píše přes Svelte design skills (`svelte-code-writer`, `svelte-core-bestpractices`, `shadcn-svelte`, `dataviz`). Design lehký a moderní, bez AI klišé.

**Dopad na Část 1:** nové read-only endpointy `GET /api/v1/stats`, `/api/v1/graph/*`, `/api/v1/stream` (WS); nová SQLite tabulka `llm_calls` + migrace; instrumentace `LoggingLLMProvider` a `jobRunner`/`jobRepository` přes event bus. Frontend je adresář `web/` **uvnitř téhož projektu** — žádné druhé `package.json`, frontend devDeps v kořenovém `package.json`, jeden `vite build` do `web/dist/`, které servíruje stávající Hono app (jeden origin, jeden kontejner, žádná nová compose služba). Závisí na HTTP API (M1–M4), job systému (M2+) a naplněném Neo4j (M4).

**Konfigurace:** stejný dvouvrstvý model jako zbytek projektu — laditelné v `config.toml`, secrety/prostředí v `.env`. `[server].port` (default **3004**, override `PORT` v `.env`) a `[server].host` (override `HOSTNAME`) jsou sdílené s Částí 1 (jeden proces, jeden port). Sekce `[web]` drží parametry rozhraní (`enabled`, `dev_port`, retenční limity `llm_calls`, `graph_overview_limit`, `stats_tick_seconds`). Detail v [`plans/WEBAPP.md`](plans/WEBAPP.md).

**Dokumentace:** základní popis webového rozhraní a všechny jeho konfigurační klíče (`[web]` + související `.env`) se dopíší do českého `README.md` vedle stávající dokumentace `config.toml`/`.env`.

**Plná specifikace vč. milníků W0–W5, realtime architektury a design principů: [`plans/WEBAPP.md`](plans/WEBAPP.md).**

---

## Část 3 — Dotazování nad grafem (querying)

**Tato část zatím není navržená.** Detailní návrh — retrieval strategie nad grafem + vektorovým indexem, ranking relevantních clusterů, prompt pro syntézu odpovědi, tvar API — vznikne samostatně až po dokončení Části 2.

Co je ze zadání jisté už teď:

- **Cíl:** graf jako „ultimátní databáze znalostí komunity" — položit dotaz v přirozeném jazyce a dostat odpověď syntetizovanou z relevantních diskuzí (viz příklady „Jaký mají lidé názor na Smarty?" a „Na Linuxu mi nefunguje zvuk po aktualizaci" v [Původním zadání](#původní-zadání-verbatim)).
- **Co pro to Část 1 už připravuje:** Discussion-level embeddingy + Neo4j vektorový index (sémantické vyhledávání diskuzí); `discussion_type`/`resolved` (filtr na help-request clustery); `Topic`/`Entity` + `COOCCURS_WITH` (související témata); `CONTINUATION_OF` (vývoj diskuze v čase); syrové zprávy a data uživatelů v SQLite pro dotažení detailů při odpovědi, aby graf zůstal štíhlý.
- **Placeholder:** `POST /api/v1/query` vrací `501 Not Implemented`, dokud tato část nevznikne.
