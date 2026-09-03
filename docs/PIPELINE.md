# Pipeline — kroky 1–3

Proces má tři samostatné, nezávisle spustitelné kroky, aby šel každý zvlášť vyladit:

| #   | Krok                      | Co dělá                                                                                                                | Kde končí |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | **ingest + clusterizace** | zprávy se uloží a rozdělí do tematických diskuzí (time-gapy, Discord thready/replies, embeddingy)                      | SQLite    |
| 2   | **AI enrichment**         | každá diskuze projde LLM (title, summary, topics, entities, sentiment, key points) — model ji může i rozdělit na menší | SQLite    |
| 3   | **graph write**           | obohacené diskuze se idempotentně zapíšou do Neo4j jako knowledge graph                                                | Neo4j     |

SQLite drží syrová data a mezistavy, Neo4j je jediný výstupní store. Datová schémata
obou storů jsou v [`DATA_MODEL.md`](./DATA_MODEL.md).

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
a prožene je přes LLM. Model dostane text zpráv a vrátí **pole segmentů** — každý
segment je souvislá (pod)diskuze s vlastním enrichmentem a seznamem `message_ids`.

- **Batchování (Část 4.4):** víc malých diskuzí se sbalí do jednoho LLM volání do rozpočtu
  `llm.enrichment_batch_target_tokens` (0 = vypnuto, 1 volání na diskuzi). V promptu je každý
  cluster oštítkovaný blok `=== CLUSTER <štítek> ===`; vrácené segmenty se mapují zpět na
  rodičovské diskuze podle vlastnictví zpráv (`source_cluster` je jen tie-breaker). Segment
  přesahující dva clustery se rozřízne po hranici vlastnictví, vynechaný cluster se dořeší
  samostatným voláním. Výsledek přidává `batchCount` a `individualRetryCount`.
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

Seznam uzlů a hran, které vzniknou, je v [`DATA_MODEL.md`](./DATA_MODEL.md#neo4j-graf).

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
