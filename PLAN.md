# community-graph — Fáze 1: Generace grafu (ingest → clustering → AI enrichment → graph write)

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

## Kontext

Projekt `community-graph` je zatím prázdný Bun/TypeScript scaffold (jen `index.ts` s `console.log`). Cílem fáze 1 je postavit robustní pipeline, která přijme batch Discord zpráv přes HTTP, rozdělí je do tematických shluků (Discussion), obohatí je pomocí LLM (topic/entities/sentiment/summary/...) a zapíše je jako knowledge graph. Graf musí jít inkrementálně doplňovat bez duplicit a bez nutnosti držet celou historii v paměti. Dotazování nad grafem (query/answer) je vědomě mimo scope této fáze — schéma je ale navrženo tak, aby ho podporovalo.

Během ujasňování zadání padla dvě zásadní rozhodnutí, která mění/doplňují uživatelův původní návrh:
- **Grafová databáze bude Neo4j**, ne "graph-on-SQLite". Neo4j 5.11+ má nativní vektorový index, takže zároveň nahrazuje uživatelův návrh na `sqlite-vector` pro Discussion-level embeddingy (slouží k budoucímu sémantickému dotazování i k detekci `CONTINUATION_OF` napříč časem). SQLite zůstává pro syrová data (zprávy, uživatelé, kanály, dedup, job/checkpoint stav) a jen dočasnou pracovní cache message-level embeddingů během clusteringu.
- **Architektura ports & adapters (hexagonal)** je tvrdý požadavek — uživatel chce později napojit vlastní lokální AI systém, jehož API tvar ještě není finální. Jádro (clustering, graph-building logika) proto nesmí nikde přímo importovat Anthropic/OpenAI/Gemini SDK ani konkrétní embedding knihovnu — jen `LLMProvider` a `EmbeddingProvider` porty. Konkrétní implementace `LLMProvider`: OpenAI-compatible adapter (funguje rovnou s Ollama/vLLM/LM Studio a pravděpodobně i s budoucím vlastním systémem), Anthropic adapter a Google Gemini adapter — všechny přepínatelné přes konfiguraci. Embeddingy poběží vestavěně v procesu (transformers.js/ONNX), ne přes uživatelův AI systém.
- **Konfigurace se dělí na dvě vrstvy**: `.env` pro credentials/secrety, `config.toml` (nativní Bun TOML loader) pro laditelné, necitlivé parametry (M, W, τ, θ, výběr LLM providera, embedding model...). Obojí je popsané v českém `README.md`.
- **Přístup k SQLite jde přes Drizzle ORM** — žádné ruční SQL stringy. Schéma je definované v TypeScriptu (`drizzle-orm/sqlite-core`), migrace generuje `drizzle-kit`.
- **Ingest endpoint je od začátku chráněný API-key headerem**, ne jen jako budoucí doporučení.
- **`(User)-[:INTERESTED_IN]->(Topic)` je součástí v1** — je to jednoduchá agregace nad `PARTICIPATED_IN`/`DISCUSSES` počítaná přímo v kroku graph-write, nepřidává žádnou novou pipeline fázi.
- **Implementace fáze 1 je rozdělená na tři samostatně spustitelné a testovatelné kroky**, každý za vlastním HTTP endpointem, aby šlo každý krok pořádně vyladit izolovaně, než se naváže na další:
  a. **ingest + clustering** — uložení zpráv a jejich rozdělení do diskuzí (kroky 0–6, viz níže), bez volání LLM a bez zápisu do Neo4j. Endpoint `POST /api/v1/channels/:id/clusterize`.
  b. **AI enrichment** — obohacení už vytvořených diskuzí přes `LLMProvider` (kroky 7–9), zapisuje jen do SQLite (`discussion_enrichment`). Endpoint `POST /api/v1/channels/:id/enrich`.
  c. **graph write** — zápis obohacených diskuzí do Neo4j (kroky 10–11). Endpoint `POST /api/v1/channels/:id/graph-write`.
  Žádný krok automaticky nespouští ten následující — to je záměr, aby šel výstup každého kroku ručně zkontrolovat (přes SQLite/debug endpoint, resp. Neo4j Browser) předtím, než se pustí další. Automatické zřetězení všech tří kroků do jednoho "full pipeline" volání je vědomě odložené na později, až budou jednotlivé kroky ověřené.

## Tech stack

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

**Explicitně mimo scope fáze 1:**
- Žádný query/ask endpoint — jen placeholder route vracející `501`.
- Žádná synchronizace editů/mazání zpráv z Discordu (batch-historické ingesty, ne live sync) — zmíněno jako známé omezení.
- `(User)-[:MENTIONED]->(User)` sociální graf — jen nápad do budoucna, nestavět teď.

## Struktura repozitáře

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

## SQLite schéma (staging/raw archiv) — Drizzle ORM

Žádné ruční SQL — schéma je TypeScript (`src/db/sqlite/schema.ts`), migrace generuje `drizzle-kit generate` do `migrations/` a na startu appky se spustí `migrate()` z `drizzle-orm/bun-sqlite/migrator`.

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

## Neo4j schéma

**Constraints/indexy (bootstrap při startu appky):**

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

`discussion_type` (nová vlastnost navíc k zadání) — enum `question|help-request|discussion|announcement|off-topic|banter|other`, `resolved` bool (LLM odvodí z pozdějších zpráv typu "diky, uz to funguje"). Přímo cílí na příklad s Arch Linuxem — umožní filtrovat na "help-request" clustery.

**Entity** node navíc oproti zadání (uživatel žádal extrakci "entities", ale ne samostatný node typ) — odděluje konkrétní pojmenované věci (produkt "RTX 4070", brand "Smarty", technologie "Arch Linux") od širších `Topic` (např. "grafické karty"). Bez tohoto rozlišení by `Topic` uzly rychle explodovaly a `COOCCURS_WITH` ztratilo smysl.

**Relationships:**
- `(User)-[:PARTICIPATED_IN {message_count, first_message_at, last_message_at}]->(Discussion)`
- `(Discussion)-[:DISCUSSES]->(Topic)`
- `(Discussion)-[:OCCURRED_IN]->(Channel)`
- `(Discussion)-[:CONTINUATION_OF {reason: 'explicit_reply'|'semantic_similarity', similarity_score, created_at}]->(Discussion)` — novější → starší.
- `(Topic)-[:COOCCURS_WITH {count, last_seen_at}]->(Topic)` — vytvářeno v abecedním pořadí názvů, aby nevznikaly duplicitní opačné hrany (vztah je fakticky neorientovaný).
- `(Discussion)-[:MENTIONS {count}]->(Entity)` (nová relace)
- `(Entity)-[:COOCCURS_WITH {count, last_seen_at}]->(Entity)` (nová relace, zrcadlí Topic-Topic)
- `(User)-[:INTERESTED_IN {weight, discussion_count, last_interaction_at}]->(Topic)` (nová relace, součást v1) — agregace nad `PARTICIPATED_IN`+`DISCUSSES`: pokaždé, když uživatel participuje v diskuzi, která `DISCUSSES` daný topic, se `weight` navýší o počet zpráv uživatele v té diskuzi (`PARTICIPATED_IN.message_count`) a `discussion_count` o 1. Počítá se přímo v kroku 10 (graph write), nepřidává žádnou extra pipeline fázi.

Všechny zápisy přes `MERGE` na unikátní klíč s `ON CREATE SET`/`ON MATCH SET` — kritické pro idempotenci při inkrementálních batchích.

**Budoucí/v2 nápady, vědomě nestavěné teď:** `(User)-[:MENTIONED]->(User)` sociální graf.

## Clustering algoritmus — krok za krokem

Běží per kanál, per spuštění pipeline. Rozlišuje první ingest (bez checkpointu) od inkrementálního update.

**Krok 0 — Určení scan okna.** Čte se `channel_checkpoints`. Bez checkpointu → okno = všechny nezpracované zprávy kanálu. S checkpointem → okno = nezpracované zprávy po checkpointu + read-only lookback buffer (posledních K už zpracovaných zpráv/nejbližší diskuze) použitý jen jako kontext pro reply/continuity matching, nikdy znovu nezpracovávaný.

**Krok 1 — Rozdělení podle threadu.** Discord nativní `thread_id` je tvrdý signál: zprávy se seskupí per-thread, čímž se pro ně obchází time-gap logika níže. Zbylé zprávy kanálu tvoří primární (non-threaded) proud.

**Krok 2 — Time-block segmentace.** V rámci proudu se prochází chronologicky; mezera ticha > `M` minut začíná nový blok. `M` konfigurovatelné.

**Krok 3 — Reply reassignment (cross-block / cross-batch).** Pro každou zprávu v okně s nastaveným `reply_to_message_id` se dohledá `discussion_id` cíle (může být z aktuálního batche nebo už zapsaná diskuze z předchozího běhu). Pak dvě možné cesty:
  - **(a) Přesun jen té jedné zprávy** — pokud odpovídající zpráva zůstane v kroku 5 lokálním outlierem (žádné další nové zprávy se s ní neshluknou), přesune se sama do cílové diskuze. Řeší případ "krátká reakce do den staré diskuze" (příklad s GTA VI).
  - **(b) CONTINUATION_OF na úrovni diskuze** — pokud se odpovídající zpráva v kroku 5 shlukne s ≥2 dalšími novými zprávami do vlastního sub-clusteru, zůstane v nové diskuzi a při graph-write (krok 10) se místo toho vytvoří hrana `CONTINUATION_OF {reason:'explicit_reply'}` z nové diskuze na starou.
  Krok 5 musí proběhnout dřív, aby bylo jasné, která varianta platí — pořadí implementace: nejprve tentativně označit reply cíle, spustit krok 5, pak finalizovat (a) vs (b) podle výsledného členství v sub-clusteru.

**Krok 4 — Short-message shortcut.** Zprávy s `word_count < W` přeskakují embedding úplně: přilepí se (a) k diskuzi svého reply cíle, pokud existuje, jinak (b) k diskuzi chronologicky předcházející zprávy ve stejném bloku. Pokud je to první zpráva nového bloku, založí novou diskuzi. `W` konfigurovatelné.

**Krok 5 — Streaming clustering zbylých delších zpráv.** Per blok: udržuje se seznam aktivních sub-clusterů `[{id, centroid, lastMessageAt, recentAuthors, recentMentionedUsers}]`, resetovaný per blok per proud. Pro každou nevyřešenou zprávu v pořadí: batch-embedding přes `EmbeddingProvider`; cosine similarity vůči každému aktivnímu centroidu; malé heuristické bonusy (stejný autor psal nedávno, @mention nedávného participanta sub-clusteru); přiřazení k nejlepší shodě pokud skóre ≥ `τ`, jinak nový sub-cluster. Sub-clustery se po delší neaktivitě v rámci bloku vyřazují z aktivní sady, aby se omezily porovnání (nikdy plné O(n²) přes celý kanál). `τ` konfigurovatelné.

**Krok 6 — Finalizace `discussions_local` řádků.** Nové sub-clustery dostanou nové řádky; zprávy přiřazené přes krok 3(a) nebo reply/short-message shortcuts ukazují na existující řádky, které dostanou `status = 'needs_reenrichment'`.

**Krok 7 — LLM enrichment.** Pro každou diskuzi ve stavu `'clustering'` nebo `'needs_reenrichment'` se posbírá celý text zpráv, zavolá `LLMProvider.generateStructured(input, EnrichmentSchema)` → `{title, summary, topics[], entities[], sentiment, sentiment_score, language, discussion_type, resolved}`. Uloží se do `discussion_enrichment`. Spočítá se Discussion-level embedding ze syntetizovaného řetězce `"title. summary. topics"` (konzistentní s budoucím sémantickým dotazováním).

**Krok 8 — Kanonizace Topic/Entity.** Každý navržený topic/entity label se embedduje, hledá se shoda s existujícími `Topic`/`Entity` uzly nad prahem kanonizace (lokální cache posledních labelů, aby se nedělal Neo4j round-trip na každý label; autoritativní kontrola přes Neo4j vektorový index). Entity se párují v rámci svého `type`, aby nedocházelo ke kolizím Topic/Entity jmen (např. "Docker" jako Topic vs Entity).

**Krok 9 — Sémantická CONTINUATION_OF inference.** Po spočítání Discussion embeddingu se dotáže Neo4j vektorový index na top-K podobných `Discussion` uzlů (primárně stejný kanál, volitelně napříč kanály se slabším prahem) v rámci lookback okna, vynechají se páry už propojené přes krok 3(b). Nad prahem `θ` se vytvoří `CONTINUATION_OF {reason:'semantic_similarity', similarity_score}`. `θ` konfigurovatelné.

**Krok 10 — Graph write.** Pro každou hotovou diskuzi: `MERGE` `Discussion`, `Channel`, `User` uzlů + `PARTICIPATED_IN`; `MERGE` `Topic`/`Entity` uzlů + `DISCUSSES`/`MENTIONS`; `MERGE` `COOCCURS_WITH` hran (abecední konvence) pro páry topiců/entit vyskytujících se spolu v diskuzi; `MERGE` `INTERESTED_IN` hran mezi každým participantem diskuze a každým jejím topicem (increment `weight`/`discussion_count`); `MERGE` `CONTINUATION_OF` hran z kroků 3(b) a 9. Nastaví se `discussions_local.neo4j_written = 1`, `messages.processed = 3`.

**Krok 11 — Posun checkpointu.** Checkpoint se posouvá jen za **plně uzavřené** bloky — blok je uzavřený, jakmile je pozorována mezera > `M` minut po jeho poslední zprávě, nebo max timestamp batche minus `M` přesáhne čas poslední zprávy bloku. Zprávy ve stále otevřeném koncovém bloku zůstávají `processed = 0` a znovu se zvažují spolu s novými zprávami dalšího batche. Tohle je nejkritičtější místo pro správnost inkrementálních updatů — musí mít vlastní testy.

## Konfigurace: .env vs config.toml

Rozdělení podle citlivosti/účelu:

- **`.env`** — jen credentials a prostředí-specifické hodnoty, nikdy ve verzovaném configu: `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `SQLITE_PATH`, `API_KEY` (auth ingest endpointu), `LLM_OPENAI_COMPATIBLE_BASE_URL`, `LLM_OPENAI_COMPATIBLE_API_KEY`, `LLM_ANTHROPIC_API_KEY`, `LLM_GEMINI_API_KEY`. Validace přes zod v `src/config/env.ts`.
- **`config.toml`** — laditelné, necitlivé parametry, commitnuté v repu s rozumnými defaulty. Načítá se přes nativní Bun TOML import (`import raw from "../../config.toml"`, Bun umí `.toml` importovat bez extra knihovny), validuje se přes zod v `src/config/config.ts`.

Návrh `config.toml`:

```toml
[server]
port = 3000

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

Do českého `README.md` patří: účel projektu ve zkratce, jak spustit (`docker compose up`), vysvětlení každého klíče v `config.toml` (co dělá, jaký má default, kdy ho měnit) a jasné rozlišení, že `.env` (vzor v `.env.example`) drží credentials a `config.toml` laditelné parametry.

## HTTP API (fáze 1 — bez query endpointu)

Ingest, clustering, enrichment a graph-write jsou čtyři oddělené kroky/endpointy — žádný z nich automaticky nespouští další (viz Kontext výše). Každý spouští `job` odpovídajícího `type` (`ingest` je synchronní, zbylé tři běží přes `jobRunner`), takže progres/výsledek se sleduje stejným `GET /api/v1/jobs/:id` pro všechny.

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

POST /api/v1/query -> 501 Not Implemented  # explicitní placeholder pro fázi 2

GET /health -> kontrola SQLite + Neo4j konektivity
```

## Milníky implementace

Milníky teď odpovídají třem krokům z Kontextu (a/b/c) — každý končí funkčním, ručně otestovatelným HTTP endpointem, než se pokračuje dál.

- **M0 — Scaffolding & config**: `package.json` (hono, zod, `@huggingface/transformers`, `neo4j-driver`, `drizzle-orm`, `drizzle-kit` (dev), `@anthropic-ai/sdk`, `@google/genai`, uuid), `src/config/env.ts` (zod nad `.env`), `src/config/config.ts` (zod nad `config.toml`), `config.toml`, `.env.example`, `drizzle.config.ts`, `docker-compose.yml` skeleton (zatím jen `app` + volume, `neo4j` service přibude v M4), `docker/Dockerfile`, `src/index.ts` (Hono + `/health`), `README.md` (česky — popis `config.toml`/`.env` a spuštění).
- **M1 — SQLite schéma (Drizzle) + ingest endpoint + dedup + auth**: `src/db/sqlite/schema.ts`, `client.ts`, migrace přes `drizzle-kit generate` do `migrations/`, repositories pro `message/channel/user/batch` (přes Drizzle query builder), `src/http/routes/ingest.ts` (`POST /api/v1/batches`, jen ukládá — nic dalšího nespouští), `src/http/middleware/apiKey.ts` (aktivní od teď na všech `/api/v1/*` routách, klíč z `.env`). Dedup přes Drizzle `insert().onConflictDoNothing()`/upsert na message/user/channel id. **Testovatelné samostatně**: curl batch → ověřit v SQLite počty řádků a dedup při opakovaném odeslání; ověřit `401` bez/se špatným API klíčem.
- **M2 — Krok (a): embedding adapter + clustering + `/clusterize` endpoint**: `EmbeddingProvider.ts`, `LocalTransformersEmbeddingAdapter.ts`, `timeBlockSplitter.ts`, `streamingClusterer.ts`, `shortMessageAttachment.ts`, `replyReassignment.ts` (jen intra-batch větev zatím, cross-batch dotažení v M5), `src/jobs/worker.ts`, `clusterStage.ts`, `jobRunner.ts` (typ `cluster`), `src/http/routes/clusterize.ts`, `discussionStagingRepository.ts`, debug endpoint `GET /api/v1/channels/:id/discussions`. Žádný LLM, žádný Neo4j. **Testovatelné samostatně**: ingest testovacího batche → `POST /clusterize` → `GET /channels/:id/discussions` a ruční kontrola, že se zprávy rozpadly do smysluplných diskuzí (thread bypass, time-gap split, short-message attachment). Unit testy na `streamingClusterer`/`timeBlockSplitter`/`shortMessageAttachment` nezávisle na HTTP vrstvě.
- **M3 — Krok (b): LLM adaptery + strukturovaný enrichment + `/enrich` endpoint**: `LLMProvider.ts`, `schemas.ts`, `OpenAICompatibleLLMAdapter.ts`, `AnthropicLLMAdapter.ts`, `GeminiLLMAdapter.ts` (přes `@google/genai`, structured JSON output), `enrichmentPipeline.ts`, `topicCanonicalizer.ts` (kanonizace zatím jen lokální/in-memory, proti Neo4j vektorovému indexu až v M4), `enrichStage.ts`, `jobRunner.ts` rozšířen o typ `enrich`, `src/http/routes/enrich.ts`. Výběr providera přes `config.toml` (`[llm] provider`), API klíče přes `.env`. **Testovatelné samostatně**: na kanálu už proklastrovaném v M2 zavolat `POST /enrich` → `GET /channels/:id/discussions` a zkontrolovat title/summary/topics/sentiment bez nutnosti mít Neo4j vůbec zapnuté.
- **M4 — Krok (c): Neo4j schéma + idempotentní graph writer + `/graph-write` endpoint**: `GraphStore.ts`, `Neo4jGraphStore.ts` (bootstrap constraints/vektorového indexu + MERGE queries), `discussionWriter.ts` (včetně `INTERESTED_IN` agregace User→Topic a dotažení `entityCanonicalizer.ts` proti Neo4j indexu), `graphWriteStage.ts`, `jobRunner.ts` rozšířen o typ `graph_write`, `src/http/routes/graphWrite.ts`, dokončení `neo4j` service v `docker-compose.yml` (volume + healthcheck). **Testovatelné samostatně**: na kanálu obohaceném v M3 zavolat `POST /graph-write` → Neo4j Browser dotazy na `Discussion`/`User`/`Topic`/`INTERESTED_IN`.
- **M5 — Korektnost inkrementálních updatů napříč všemi třemi kroky**: dotažení `replyReassignment.ts` o cross-batch/cross-run větev (krok 3a/3b), `continuationInference.ts` (sémantické `CONTINUATION_OF` přes Neo4j vektorový index), `checkpointRepository.ts` (block-closure logika). Integrační testy simulující dva po sobě jdoucí cykly `clusterize → enrich → graph-write`, včetně reply o několik dní později do už zapsané diskuze.
- **M6 — docker-compose + Dockerfile + e2e smoke test**: finální `docker/Dockerfile` (multi-stage Bun build), `docker-compose.yml`, `.env.example`, README s instrukcemi, `tests/integration/ingestion.integration.test.ts` (prochází všechny čtyři endpointy v pořadí). Zřetězení do jednoho "spusť všechno" volání je vědomě mimo scope — každý krok se spouští ručně/orchestrací zvenčí.

## Verifikace / testovací plán

- **Unit testy** (`tests/unit/clustering/*`) se syntetickými batchi zpráv: normální time-block splitting; explicitní `thread_id` bypass; short-message attachment (reply-target i preceding-message případ); prokládaná paralelní témata v jednom time-bloku (správnost streaming clustereru); hranice reply-reassignment (a) vs (b); edge-case uzavírání bloků v checkpointu (otevřený koncový blok se neposouvá).
- **Integrační test** (`tests/integration/ingestion.integration.test.ts`, buduje se postupně s M2/M3/M4): Neo4j přes docker-compose (nebo Testcontainers), POST malého syntetického Discord exportu na `/api/v1/batches` (s platným `API_KEY` headerem), pak postupně `POST /clusterize` → `POST /enrich` → `POST /graph-write`, s pollingem `/api/v1/jobs/:id` mezi kroky. Po `clusterize`/`enrich` se výsledek ověřuje přes `GET /channels/:id/discussions` (bez závislosti na Neo4j). Po `graph-write` přímý dotaz do Neo4j ověřující počty/tvary uzlů a hran (počet Discussion, PARTICIPATED_IN hrany, korektní agregace `INTERESTED_IN` vah, žádné duplicitní Topic uzly napříč dvěma běhy). Druhý cyklus: druhý batch odpovídající do prvního → ověří dedup + vznik `CONTINUATION_OF` bez re-processingu starých zpráv.
- **Auth test**: request bez `API_KEY` headeru nebo se špatnou hodnotou na kterémkoliv `/api/v1/*` endpointu vrací `401`.
- **Manuální smoke test po každém kroku zvlášť** (odpovídá pořadí M2 → M3 → M4, ne až na konci):
  1. `curl -X POST localhost:PORT/api/v1/batches -d @sample-batch.json` → zkontrolovat `inserted_count`/`duplicate_count`.
  2. `curl -X POST localhost:PORT/api/v1/channels/:id/clusterize`, počkat na job, `curl localhost:PORT/api/v1/channels/:id/discussions` → ručně posoudit, jestli rozdělení do diskuzí dává smysl, případně doladit `M`/`W`/`τ` v `config.toml` a spustit znovu.
  3. `curl -X POST localhost:PORT/api/v1/channels/:id/enrich`, počkat na job, znovu `GET /discussions` → posoudit kvalitu title/summary/topics/sentiment, případně doladit prompt/model v `config.toml`.
  4. `curl -X POST localhost:PORT/api/v1/channels/:id/graph-write`, pak Neo4j Browser s `MATCH (d:Discussion)-[:OCCURRED_IN]->(c:Channel) RETURN d,c LIMIT 25` a podobnými dotazy pro vizuální kontrolu grafu.

## Klíčové soubory k implementaci

- `src/core/clustering/streamingClusterer.ts` — jádro algoritmu, na správnosti závisí vše ostatní.
- `src/db/sqlite/schema.ts` (Drizzle) — dedup, checkpointing, resumability se odvíjí od tohoto schématu.
- `src/adapters/graph/Neo4jGraphStore.ts` — idempotentní MERGE writer, korektnost inkrementálních updatů.
- `src/core/ports/LLMProvider.ts` a `src/core/ports/EmbeddingProvider.ts` — hexagonální hranice, kterou uživatel explicitně vyžaduje.
- `src/jobs/jobRunner.ts` — resumable běh na pozadí (požadavek "ne blokující HTTP request").
