# community-graph — Část 4: Propojení

## Zařazení

Navazuje na M6 z [`PLAN.md`](../PLAN.md) (hotová pipeline), na [Část 2](../PLAN.md#část-2--webová-aplikace-a-zobrazení-grafu)
(web shell — router, api klient, WS, TanStack Query, Tailwind v4, shadcn-svelte) a na
[Část 3](QUERYING.md) (backend `POST /api/v1/query`).

Tři **nezávislé slice**, každý za vlastním endpointem / pohledem:

| #   | Slice                       | Náplň                                                                              | Detail                                 |
| --- | --------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------- |
| 4.1 | **Slovník jmen**            | názvy uživatelů/kanálů/serveru se posílají zvlášť a přírůstkově, ne s dávkou zpráv | [`plans/DICTIONARY.md`](DICTIONARY.md) |
| 4.2 | **Sjednocený běh pipeline** | jeden endpoint provede ingest → clusterize → enrich → graph-write                  | §4.2 níže                              |
| 4.3 | **Dotazování na webu**      | pohled `/ask` v dashboardu nad `POST /api/v1/query`                                | §4.3 níže                              |
| 4.4 | **Batchování enrichmentu**  | víc clusterů do jednoho LLM volání dle tokenového rozpočtu                         | §4.4 níže                              |

Doporučené pořadí (slice jsou nezávislé, ale takto do sebe zapadají nejlíp):
**4.1 → 4.2 → 4.3.** Slovník odblokuje čisté id-only dávky, na které pak sjednocený pipeline
endpoint rovnou počítá; dotazování na webu vyžaduje dokončenou Část 3. **4.4 je nezávislé na
4.1–4.3** — je to čistě optimalizace enrichment stage, dá se udělat kdykoli po M3.

---

## 4.1 — Slovník jmen

Plná specifikace: [`plans/DICTIONARY.md`](DICTIONARY.md). Shrnutí:

Dnes názvy (`guild.name`, `channel.name`, `author.username` / `display_name`) tečou s **každou**
dávkou zpráv — redundantní, neřeší přejmenování, není jasný vlastník pravdy. Cílově:

- Nový **`POST /api/v1/dictionary`** — přírůstkový upsert názvů (posílá se jen to, co se
  změnilo; `null` maže, chybějící pole nechává být). Zapisuje synchronně do SQLite.
- **`POST /api/v1/batches` nese jen ID** (`guild {id}`, `channel {id, type?}`, `author {id}`) —
  breaking change, názvová pole → `400`.
- Jediný zdroj pravdy o názvech = sloupce v SQLite; **žádná nová tabulka**, jen `dictionary`
  je jejich jediný zapisovatel a ingest je přestane sahat.
- Propagace do Neo4j: inline `MATCH ... SET` u malého syncu, job `name_sync` u velkého,
  `POST /api/v1/dictionary/graph-resync` pro obnovu po výpadku. Nový uzel **`Guild`** +
  `(Channel)-[:IN_GUILD]->(Guild)`, aby byl název serveru v grafu vidět.
- Web: invalidace grafových dotazů na nový bus event `dictionary.synced`.

Milníky **D0–D5** — viz [`plans/DICTIONARY.md`](DICTIONARY.md#milníky).

---

## 4.2 — Sjednocený běh pipeline

### Cíl

Jeden HTTP endpoint, který přijme dávku zpráv a provede celý řetězec
**ingest → clusterize → enrich → graph-write**, aby volající (bot) nemusel orchestrovat
čtyři volání a polling mezi nimi. Granulární endpointy (`/batches`, `/clusterize`, `/enrich`,
`/graph-write`) **zůstávají** pro ladění a cílené re-run.

### Rozhodnutí — jeden orchestrující job

`POST /api/v1/pipeline` spustí `ingestBatch()` **synchronně** (rychlé; chceme fail-fast na
špatné tělo a hned znát `inserted` / `duplicate` counts), pak založí **jeden** job
`type = "pipeline"` a v něm sekvenčně zavolá existující stage funkce
`clusterChannel` → `enrichChannel` → `graphWriteChannel`.

Proč jeden job a ne řetězené joby: **nejmenší nová plocha** — žádné cross-job řetězení,
žádná nová polling logika, stage funkce už jsou samostatné a bezstavové (navazují na
`messages.processed` / `discussions_local.status`). Cena: hrubší granularita — spadne-li
`enrich`, job je `failed` jako celek; data z `ingest` + `cluster` ale zůstávají v SQLite a
jdou dokončit granulárními endpointy nebo dalším během (stage jsou idempotentní).

### Endpoint

```
POST /api/v1/pipeline
  body: {                              # tvarově shodné s POST /api/v1/batches
    guild: { id }, channel: { id, type? },
    messages: [{ id, author: { id }, content, created_at, ... }],
    options?: {
      max_messages?: number,           # -> clusterChannel
      max_discussions?: number,        # -> enrichChannel + graphWriteChannel
      skip_graph_write?: boolean       # jen ingest+cluster+enrich, Neo4j nechat být
    }
  }
  -> 202 {
    batch_id, inserted_count, duplicate_count,   # z ingestu (synchronně)
    job_id, type: "pipeline", status: "queued"
  }
  -> 400 { error: "invalid_request", details }

# varianta bez dávky — spustí pipeline nad už naingestovanými processed=0 zprávami kanálu
POST /api/v1/channels/:id/pipeline
  body: { options?: { ... } }  -> 202 { job_id, type: "pipeline", status: "queued" }
```

### Job orchestrace

`src/jobs/pipelineStage.ts` + `runPipelineJob` v `jobRunner.ts` (skládá existující stage
funkce, stejné providery jako ostatní joby — `embeddingProvider` singleton, `getLLMProvider()`,
`getGraphStore()`):

```
markJobRunning(jobId)                          # progressTotal = 3 (2 při skip_graph_write)
const r = { ingest }                           # ingest counts z už proběhlého ingestBatch()
try:
  r.cluster    = await clusterChannel(channelId, embeddingProvider, { maxMessages })
  progress 1;  saveJobResult(jobId, r)                         # partial result po každé stage
  r.enrich     = await llmCallContext.run({ jobId, channelId },
                       () => enrichChannel(channelId, getLLMProvider(), embeddingProvider, { maxDiscussions }))
  progress 2;  saveJobResult(jobId, r)
  if (!skipGraphWrite):
    await store.bootstrap()
    r.graphWrite = await graphWriteChannel(channelId, store, { maxDiscussions })
  progress 3
  markJobCompleted(jobId, r)                   # r = { ingest, cluster, enrich, graphWrite? }
catch (err) at stage S:
  markJobFailed(jobId, `${S}: ${message}`)     # partial r už uložený přes saveJobResult
```

**Nová drobnost v `jobRepository`:** `saveJobResult(jobId, result)` — zapíše `jobs.result`
bez změny `status` (dnes se `result` píše jen v `markJobCompleted`). Umožní vidět dokončené
stage i u `failed` pipeline jobu a průběžně na dashboardu.

`enrich` část je obalená `llmCallContext.run(...)`, takže `llm_calls` řádky nesou `job_id`
tohoto pipeline jobu (stejně jako u samostatného `enrich` jobu).

### Bus / web

Job jede přes stávající `job.created` / `job.updated` (progress + partial `result` mezi
stagemi) — „Jobs“ a „Přehled“ pohled ho zobrazí bez úprav; na frontendu se `pipeline` jen
přidá do filtru typu. Detail jobu ukáže kombinovaný `result` se čtyřmi bloky.

### Config

`config.example.toml` + `src/config/config.ts` (`prefault({})` + `.default(...)`):

```toml
[pipeline]
include_graph_write = true   # default pro chybějící options.skip_graph_write (obráceně)
```

Jediný klíč; víc netřeba. Popis do `README.md`.

### Mimo rozsah 4.2

- Paralelní běh více kanálů v jednom jobu (dávka je vždy jeden kanál).
- Fronta / rate-limiting pipeline jobů, automatické opakování spadlé stage.

### Milníky

- **P1** — `pipelineStage` + `runPipelineJob` + `POST /api/v1/pipeline` + `pipeline` typ +
  `saveJobResult` + kombinovaný `result` tvar + per-stage progress + `[pipeline]` config.
  **Test:** jedno volání na sample dávce → job `completed`, `result` má `ingest` / `cluster` /
  `enrich` / `graphWrite` bloky; čísla sedí s během po jednotlivých endpointech.
- **P2** — chybová větev (stage spadne → job `failed`, partial `result` zachován, název
  stage v `error`), `options.skip_graph_write`, `POST /api/v1/channels/:id/pipeline`
  (bez dávky), README sekce. **Test:** dočasně rozbít LLM klíč → job `failed` s `error`
  `"enrich: …"`, `result.cluster` přítomen; `skip_graph_write` s vypnutým Neo4j proběhne
  po `enrich` bez chyby.

---

## 4.3 — Dotazování na webu

### Cíl

UI nad backendem z [Části 3](QUERYING.md) (`POST /api/v1/query`): pole na otázku v dashboardu,
zobrazení ukotvené odpovědi, klikací citace vedoucí na detail diskuze a na uzel v grafové
vizualizaci, historie dotazů.

### Rozsah

- **V rozsahu:** nový pohled `/ask`, odeslání otázky + render odpovědi, citace + jejich
  prokliky, filtry, klientská historie, drobné čtecí endpointy pro detail diskuze a překlad
  ID pro graf.
- **Mimo rozsah:** streaming odpovědí token po tokenu (→ [Část 5](../PLAN.md#část-5--budoucí-vylepšení)),
  serverová perzistence historie, multi-turn konverzace.

### Pohled `/ask`

Nová route v SPA (history-mode router — viz commit `cdd55e0`), položka v navigaci
„Zeptat se“. Rozložení: vlevo vstup + historie, vpravo odpověď + citace.

**Vstup dotazu**

- `textarea` (Enter odešle, Shift+Enter nový řádek), tlačítko „Zeptat se“, blokované během
  běhu requestu.
- Volitelné filtry (skládají `filters` v těle requestu — mají přednost před plánovačem):
  multi-select kanálů (z `GET /api/v1/stats` `messagesByChannel`, nebo drobný nový
  `GET /api/v1/channels`), multi-select `discussion_type`, „od data“.
- Request přes TanStack **mutation** (je to akce, ne cache-able čtení), `POST /api/v1/query`
  se stávajícím api klientem (`X-API-Key`). Očekávaná latence jednotky sekund → skeleton
  odpovědi + počítadlo uplynulého času. Žádný streaming (Část 5).

**Panel odpovědi**

- `answer` renderovaný jako Markdown; inline značky `[D#]` → klikací horní indexy, které
  skrolují na příslušnou kartu citace.
- Badge `confidence` (`high` / `medium` / `low`), `caveats` jako tlumená poznámka pod
  odpovědí.
- `confidence: "low"` / prázdný evidence set → výrazný stav „nenašel jsem k tomu dost
  podkladů“ místo odpovědi (backend v tom případě LLM syntézu vůbec nespustí).
- Chyby: `422` (prázdná/nesmyslná otázka) → inline validace u pole; `503` (Neo4j down) →
  banner „graf není dostupný“.

**Citace**

- `citations[]` (`ref`, `discussion_id`, `title`, `channel`, `discussion_type`, `sentiment`,
  `started_at`, `score`) → seznam karet s kotvami `#D1`…`#Dk`.
- Klik na kartu → **drawer s detailem diskuze**. Potřebuje nový bundle endpoint
  `GET /api/v1/discussions/:id` = `discussions_local` řádek + `discussion_enrichment` +
  zprávy (dnes existuje jen `GET /api/v1/discussions/:id/enrichment` a hromadný
  `GET /api/v1/channels/:id/discussions`). Drawer ukáže title / summary / key_points /
  účastníky / sentiment + rozbalitelný seznam syrových zpráv.
- „Otevřít v grafu“ → deep-link `/graph?focus=<discussion_id>`. Grafový pohled přijme query
  param `focus`, přeloží doménové `Discussion.id` na Neo4j `elementId` (nový
  `GET /api/v1/graph/node/by-domain-id?label=Discussion&id=…` → `MATCH (d:Discussion {id})
RETURN elementId(d)`), vycentruje uzel a rozbalí sousedy (stávající expand-on-click cesta).

**Historie dotazů**

- Klientská, `localStorage` (klíč `cg.ask.history`), strop ~25 položek (frontend konstanta).
  Ukládá `{ question, filters, answer, citations, confidence, at }`.
- Seznam v levém sloupci; klik → znovu vykreslí uloženou odpověď (bez volání); tlačítko
  „Zeptat se znovu“ pošle request znovu.
- Serverová perzistence je mimo rozsah v1 (šla by přidat tabulka `query_log` +
  `GET /api/v1/queries` — viz Část 5).

### Nové backendové drobnosti (v rámci 4.3)

Obojí za `apiKeyAuth`, jen když `[web] enabled`:

- `GET /api/v1/discussions/:id` — bundle pro drawer (`discussions_local` + `enrichment` + zprávy).
- `GET /api/v1/graph/node/by-domain-id?label=&id=` — překlad doménového ID na `elementId`
  pro deep-link z citace do grafu.

### Design

Konzistentní s dashboardem — Svelte 5 runes (žádné Svelte 4 vzory), Tailwind v4 utility +
`@theme` tokeny, shadcn-svelte primitivy (Card, Badge, Button, Skeleton, Drawer),
`@tabler/icons-svelte`. Lehké a věcné, **bez „AI chat“ klišé** (žádné bubliny, žádný avatar
asistenta) — je to nástroj na dotazování znalostní báze, ne chatbot.

### Milníky

- **W-Q1** — pohled `/ask`: vstup + mutation na `POST /api/v1/query` + render odpovědi
  (Markdown, `confidence`, `caveats`) + seznam citací (zatím bez prokliků) + navigační
  položka + skeleton/časovač během běhu. **Test:** obě akceptační otázky ze zadání → v UI
  ukotvená odpověď s citacemi.
- **W-Q2** — `GET /api/v1/discussions/:id` + drawer s detailem diskuze; `[D#]` v odpovědi
  jako kotvy na karty citací. **Test:** klik na `[D2]` skroluje na kartu, klik na kartu
  otevře drawer se správnými zprávami.
- **W-Q3** — filtry (kanál / typ / od data) → `filters` v těle; „low confidence“ prázdný
  stav; chybové stavy `422` / `503`. **Test:** filtr na jeden kanál se propíše do
  `?debug=1` kandidátů; nesmyslná otázka → prázdný stav bez fabulace.
- **W-Q4** — „Otevřít v grafu“ deep-link + `graph/node/by-domain-id` + fokus uzlu v grafovém
  pohledu; klientská historie v `localStorage` (re-view + re-run). **Test:** z citace skok
  do grafu vycentruje danou diskuzi; historie přežije reload, „Zeptat se znovu“ vrátí
  čerstvou odpověď.
- **W-Q5** — dolazení, README sekce „Dotazování na webu“, e2e průchod
  `pipeline → ask → citace → drawer → graf`.

---

## 4.4 — Batchování enrichmentu

### Cíl

Dnes `enrichChannel()` volá LLM **jednou za každou diskuzi** (`enrichDiscussion` → 1 volání na
cluster). U kanálu s tisíci krátkými diskuzemi to je tisíce volání, systémový prompt se posílá
pořád dokola a průchod trvá zbytečně dlouho. Cíl: **poslat víc clusterů do jednoho volání** až
do konfigurovaného tokenového rozpočtu, při plném zachování hranic vstupních clusterů a
stávající single/split logiky.

### Klíčové pozorování — split mechanismus už umí „víc clusterů na výstupu“

`enrichmentResponseSchema` už teď vrací `segments[]` — pole (sub-)diskuzí, každá s vlastními
`message_ids`. Dnes to pole znamená „podčásti jedné vstupní diskuze“ (split v
[§1.7 krok 7](../PLAN.md#17-clustering-algoritmus--krok-za-krokem)). Batchování je **rozšíření
téhož**: pošle se M vstupních clusterů naráz, model vrátí `segments[]` napříč všemi a každý
segment se namapuje zpět na svůj rodičovský cluster. Žádná nová odpovědní struktura — jen jedno
volitelné pole navíc na segmentu (`source_cluster`) a mapovací krok.

### Rozhodnutí

**1. Balení clusterů (bin-packing).** Nová `packDiscussionsIntoBatches(rows)` v
`enrichmentPipeline.ts`:

- Odhad tokenů na diskuzi bez vendor tokenizeru (hexagonální čistota):
  `est = overhead_per_cluster + ceil(renderedChars / chars_per_token)`, kde
  `chars_per_token ≈ 3.5` pro češtinu, `overhead_per_cluster ≈ 40` (delimiter + hlavička).
- Greedy first-fit, diskuze v pořadí `blockStartAt` (ať batch drží časově blízké věci
  pohromadě): přidávej do aktuálního batche, dokud by další diskuze nepřekročila
  `enrichment_batch_target_tokens`; pak batch uzavři.
- Diskuze sama větší než rozpočet jde do batche sama (a pořád platí `max_messages_per_call`,
  nově jako strop na **součet zpráv za celý batch**).
- Druhý strop `enrichment_batch_max_discussions` (default 25) proti patologii „300
  jednozprávových clusterů v jednom volání“.
- `enrichment_batch_target_tokens = 0` → batching vypnutý, chování 1:1 jako dnes (fallback/ladění).

**2. Renderování — explicitní delimitery (řeší „AI zapomene kontext u malých clusterů“).**
Riziko není délka, ale **rozpuštění hranic**: když do promptu naliješ 30 drobných clusterů jako
jeden nerozlišený seznam zpráv, model si je přeskupí po svém. Řešení — každý vstupní cluster je
oštítkovaný blok:

```
=== CLUSTER c1 · 5 zpráv ===
[id=111] alice @ 2026-08-30T10:00:00Z
Text zprávy…
[id=112] bob @ 2026-08-30T10:01:00Z
…

=== CLUSTER c2 · 1 zpráva ===
[id=200] carol @ 2026-08-30T12:00:00Z
…
```

`c1`, `c2` … jsou lokální štítky batche (ne UUID — kratší, míň tokenů, a UUID v promptu svádí
model k halucinaci). Mapa `štítek → discussionId` se drží mimo prompt.

Systémový prompt dostane odstavec navíc: _„Dostáváš VÍC oštítkovaných clusterů
(`=== CLUSTER <štítek> ===`). Zpracuj každý samostatně. Nikdy neslévej zprávy z různých clusterů
do jednoho segmentu. Uvnitř jednoho clusteru smíš vrátit víc segmentů, pokud se do něj slily
nesouvisející konverzace (stávající pravidlo). U každého segmentu vyplň `source_cluster` štítkem
clusteru, ze kterého pochází.“_

Jednozprávové clustery jsou pak v pohodě: každý je samostatný oštítkovaný blok, po modelu se
nechce držet kontext napříč bloky, jen shrnout každý blok zvlášť. Navíc se u nich amortizuje
systémový prompt, který se dnes posílá zvlášť pro každý.

**3. Schema — jedno volitelné pole navíc.** `enrichmentSegmentSchema` dostane
`source_cluster: z.string().optional()` (popis: „štítek vstupního clusteru, ze kterého segment
pochází; u jedno-clusterových volání vynech“). `enrichmentResponseSchema` beze změny. Zpětná
kompatibilita: samostatné volání (batch o velikosti 1) pole neřeší, chování identické jako dnes.

**4. Mapování odpovědi zpět na rodiče.** Nová `enrichBatch(clusters, …)` vrací
`Map<discussionId, EnrichDiscussionResult>`:

- Autoritativní je **vlastnictví zprávy**: z `message_ids` segmentu → `messageId → discussionId`
  (víme ze stagingu). `source_cluster` je jen tie-breaker pro segmenty, které model vrátil bez
  použitelných id.
- Segmenty se seskupí per rodičovský cluster → pak **beze změny** projedou stávající
  single/split větví z `enrichDiscussion` (`partitionMessages` běží jen nad zprávami toho
  jednoho rodiče).
- Segment, jehož `message_ids` sahají do víc clusterů → rozřízne se po hranici vlastnictví,
  každá část do svého rodiče.
- Cluster, který model v odpovědi úplně vynechal → fallback: dořeší se samostatným voláním
  (nikdy se tiše nezahodí).
- `enrichDiscussion` zůstane jako tenký wrapper `enrichBatch([one])` — testy a granularita
  zůstávají.

**5. Izolace chyb.** Spadne-li batchové volání (timeout, provider 5xx, schema mismatch),
`enrichChannel` podle `enrichment_batch_retry_individually` (default `true`) zkusí každou diskuzi
batche zvlášť — jedno špatné volání nezhodí 25 diskuzí. Při `false` se celý batch započítá do
`failedCount` s chybou per diskuze (jako dnes).

**6. Persistence a `llm_calls` beze změny co do tvaru.** Persist smyčka v `enrichChannel` je
stejná (`persistSingleEnrichment` / `persistSplitEnrichment` per rodič). `llm_calls` má nově
**jeden řádek na batch** místo na diskuzi; `context` = `batch N diskuzí (M zpráv)`. Míň řádků,
míň opakovaného promptu — měřitelná úspora, viditelná na dashboardu z Části 2.

### Config

`config.example.toml`, sekce `[llm]` + zod v `src/config/config.ts`:

```toml
[llm]
# … stávající klíče …
enrichment_batch_target_tokens = 6000      # cílový rozpočet promptu na jedno enrichment volání; 0 = batching vypnutý (1 volání/diskuze)
enrichment_batch_max_discussions = 25      # tvrdý strop na počet clusterů v jednom volání
enrichment_batch_retry_individually = true # spadlý batch → zkusit diskuze po jedné
```

`max_messages_per_call` zůstává — nově je to strop na **součet zpráv za celý batch**, ne za diskuzi.

### Dopad na soubory

- `src/core/enrichment/schemas.ts` — `source_cluster` na segmentu.
- `src/core/enrichment/prompt.ts` — `buildBatchEnrichmentUserPrompt(clusters, …)` s delimitery;
  odstavec do `ENRICHMENT_SYSTEM_PROMPT`.
- `src/core/enrichment/enrichmentPipeline.ts` — `packDiscussionsIntoBatches`, `enrichBatch`,
  `enrichDiscussion` jako wrapper.
- `src/jobs/enrichStage.ts` — `enrichChannel` iteruje batche místo diskuzí; nové čítače
  `batchCount`, `individualRetryCount` v `EnrichChannelResult`.
- `src/config/config.ts` + `config.example.toml` — tři klíče.
- `README.md` — popis klíčů.
- Beze změny: `enrichmentRepository.ts`, persist funkce, embeddingy, graph-write,
  `runPipelineJob` (volá `enrichChannel` stejně).

### Mimo rozsah 4.4

- Přesný tokenizer / počítání tokenů přes vendor SDK (rozbíjí hexagonální hranici; heuristika
  stačí, `max_tokens` na odpovědi je pojistka).
- Paralelní běh víc batchů naráz (LLM volání jsou serializovaná — viz commit `f4a7b2b`).
- Dynamické ladění `target_tokens` podle modelu / historie latencí.
- Batchování napříč kanály (batch je vždy jeden kanál, jako u pipeline jobu).

### Milníky

- **B1** — `source_cluster` ve schématu, `buildBatchEnrichmentUserPrompt` + delimitery +
  systémový prompt, `packDiscussionsIntoBatches`, `enrichBatch`, `enrichDiscussion` wrapper,
  `[llm]` klíče. `enrichChannel` jede přes batche. **Test:** kanál s ~40 malými diskuzemi →
  `enrichChannel` udělá ~2 volání místo 40; každá diskuze má `enriched`/`split` stav a stejný
  počet zpráv jako před během; segmenty se namapovaly na správné rodiče (žádná zpráva nezměnila
  rodiče kromě očekávaných splitů). Srovnávací test: stejný vstup s
  `enrichment_batch_target_tokens = 0` dá stejné diskuze/segmenty.
- **B2** — izolace chyb (`enrichment_batch_retry_individually`), fallback pro vynechaný cluster,
  řez segmentu přes hranici clusterů, `batchCount`/`individualRetryCount` v resultu a v
  kombinovaném `result` pipeline jobu. **Test:** mock LLM, který na první batch hodí timeout →
  diskuze doenrichované po jedné, `failedCount = 0`; mock, který vynechá jeden cluster → ten
  cluster dořešený samostatným voláním; mock vracející segment s `message_ids` ze dvou clusterů
  → zprávy skončí u svých rodičů.

---

## Souhrnná verifikace Části 4

- **Slovník:** viz [`plans/DICTIONARY.md`](DICTIONARY.md#verifikace).
- **Pipeline:** jedno volání `POST /api/v1/pipeline` na čistém kanálu dá **týž** výsledný graf
  jako ruční `batches → clusterize → enrich → graph-write`; spadlá stage nechá partial
  `result` a název stage v `error`.
- **Web dotazování:** obě akceptační otázky ze zadání vrátí v UI ukotvenou odpověď; každé
  `[D#]` má kartu citace a proklik na existující diskuzi; „otevřít v grafu“ vycentruje uzel;
  historie přežije reload.
- **Batching:** `enrichChannel` na stejném vstupu dá stejné diskuze/segmenty jako s
  `enrichment_batch_target_tokens = 0`, jen v méně LLM voláních; žádná zpráva nezmění
  rodičovský cluster kromě očekávaných splitů.

## Mimo rozsah Části 4

- Streaming odpovědí token po tokenu (→ [Část 5](../PLAN.md#část-5--budoucí-vylepšení)).
- Serverová historie dotazů, multi-turn konverzace, cache odpovědí (→ Část 5).
- Verzování názvů / historie přezdívek (→ [`plans/DICTIONARY.md`](DICTIONARY.md)).
- Paralelní pipeline běh více kanálů, automatický retry spadlé stage.
- Přesný tokenizer, paralelní běh víc enrichment batchů, batchování napříč kanály (→ §4.4 Mimo rozsah).
