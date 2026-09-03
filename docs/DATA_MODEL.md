# Datový model

## SQLite (`src/db/sqlite/schema.ts`)

Schéma je v Drizzle ORM, žádné ruční SQL. Po úpravě spusť `bun run db:generate` — migrace se
vygeneruje do `migrations/` a aplikuje při dalším startu.

| Tabulka                       | Obsah                                                                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guilds`, `channels`, `users` | základní entity z Discordu                                                                                                                                                         |
| `messages`                    | syrové zprávy; `processed` (`0` raw → `1` clustered → `3` v grafu), `discussion_id`                                                                                                |
| `ingestion_batches`           | evidence `POST /batches` volání (vložené / duplicitní počty)                                                                                                                       |
| `discussions_local`           | clustery z kroku 1 (staging); `parent_discussion_id` u dětských diskuzí ze split                                                                                                   |
| `discussion_enrichment`       | výstup kroku 2: `title`, `summary`, `topics`, `entities`, `key_points`, `sentiment` (+ skóre), `language`, `discussion_type`, `resolved`, embedding pro krok 3, `raw_llm_response` |
| `channel_checkpoints`         | informativní: kam clusterizace v kanálu chronologicky došla                                                                                                                        |
| `jobs`                        | stav asynchronních běhů (`cluster` \| `enrich` \| `graph_write`)                                                                                                                   |

### Životní cyklus diskuze (`discussions_local.status`)

- **`clustering`** — čerstvě založená, ještě neprošla enrichmentem.
- **`needs_reenrichment`** — už existovala a tento běh do ní dopsal zprávy (rozšíření vlákna
  nebo reply reassignment), takže staré title/summary jsou zastaralé a čeká na nový enrichment.
- **`enriched`** — má záznam v `discussion_enrichment`. Platí i pro dětské diskuze ze split.
- **`split`** — LLM ji rozdělil; sama už nenese zprávy (přesunuly se do dětských diskuzí),
  slouží jen jako rodičovský uzel.
- **`written`** — zapsaná do Neo4j; zprávy mají `processed = 3`. `graph-write` ji přeskakuje.

## Neo4j graf

Zapisuje krok 3 ([`PIPELINE.md`](./PIPELINE.md#krok-3--graph-write)). Vše přes
`MERGE … ON CREATE SET / ON MATCH SET`, takže opakovaný běh nevytvoří duplicity.

### Uzly

| Label        | Klíč                                                                | Vlastnosti                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `User`       | `id`                                                                | `username`, `display_name`, `first_seen_at`, `last_seen_at`, `message_count`                                                                                                                                                      |
| `Channel`    | `id`                                                                | `name`, `guild_id`                                                                                                                                                                                                                |
| `Guild`      | `id`                                                                | `name` — server; vzniká při `graph-write`, když má kanál `guild_id` (Část 4.1)                                                                                                                                                    |
| `Discussion` | `id`                                                                | `channel_id`, `started_at`, `ended_at`, `message_count`, `participant_count`, `title`, `summary`, `topics[]`, `sentiment` (+ `_score`), `language`, `discussion_type`, `resolved`, `embedding` (index `discussion_embedding_idx`) |
| `Topic`      | `name` (kanonizované: trim, sražené mezery, dedup case-insensitive) | `discussion_count`, `created_at`                                                                                                                                                                                                  |
| `Entity`     | `key` = `typ:název`                                                 | `name`, `type` (`person`/`product`/`technology`/`organization`/`place`/`event`/`other`), `mention_count`, `created_at`                                                                                                            |

### Hrany

| Hrana                                           | Vlastnosti                                             | Poznámka                                                                             |
| ----------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `(User)-[:PARTICIPATED_IN]->(Discussion)`       | `message_count`, `first_message_at`, `last_message_at` | agregace nad `messages` diskuze                                                      |
| `(Discussion)-[:OCCURRED_IN]->(Channel)`        | —                                                      |                                                                                      |
| `(Channel)-[:IN_GUILD]->(Guild)`                | —                                                      | jen když má kanál `guild_id`                                                         |
| `(Discussion)-[:DISCUSSES]->(Topic)`            | —                                                      |                                                                                      |
| `(Discussion)-[:MENTIONS]->(Entity)`            | `count`                                                |                                                                                      |
| `(Topic)-[:COOCCURS_WITH]->(Topic)`             | `count`, `last_seen_at`                                | v abecedním pořadí názvů (bez opačné duplicity); přeskočí se u diskuze s > 12 topiců |
| `(Entity)-[:COOCCURS_WITH]->(Entity)`           | `count`, `last_seen_at`                                | totéž podle `key`                                                                    |
| `(User)-[:INTERESTED_IN]->(Topic)`              | `weight`, `discussion_count`, `last_interaction_at`    | pro každého účastníka × topic; `weight +=` počet jeho zpráv v diskuzi                |
| `(Discussion)-[:CONTINUATION_OF]->(Discussion)` | `reason`, `similarity_score`, `created_at`             | novější → starší; zatím jen `reason = 'explicit_reply'` z clusteringu                |

**Zjednodušené oproti PLAN.md:** kanonizace topiců/entit je jen přesná shoda po normalizaci
(žádné slučování přes embedding index), `Topic`/`Entity` nedostávají `embedding`/`category`.
Posun `channel_checkpoints` a sémantické `CONTINUATION_OF` patří k dalšímu kroku.
