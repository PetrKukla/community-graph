# community-graph

Dokerizovaná (zatím lokálně spustitelná) služba, která z historie chatu na Discordu (případně
i jiných zdrojů v budoucnu) postupně buduje znalostní graf komunity — kdo o čem mluvil, jaká
témata spolu souvisí a jak na sebe diskuze v čase navazují. Graf jde kdykoliv doplnit o novou
dávku zpráv, aniž by vznikaly duplicity.

Celý proces je rozdělený na tři samostatné, nezávisle spustitelné kroky, aby šel každý z nich
zvlášť pořádně vyladit:

1. **ingest + clusterizace** — zprávy se uloží a rozdělí do tematických diskuzí (`Discussion`)
   pomocí time-gapů, Discord threadů/replies a embeddingů. *(hotovo, tento README ho popisuje)*
2. **AI enrichment** — každá diskuze se prožene přes LLM (topic, entity, sentiment, shrnutí...).
   *(zatím neimplementováno)*
3. **graph write** — obohacené diskuze se zapíšou do Neo4j jako graf. *(zatím neimplementováno)*

Podrobný návrh celého projektu (architektura, zdůvodnění rozhodnutí, budoucí kroky) je v
[`PLAN.md`](./PLAN.md).

## Jak to spustit

Vyžaduje [Bun](https://bun.com) (testováno na `1.3.x`). Neo4j ani žádná externí AI služba
zatím nejsou potřeba — krok 1 běží čistě nad lokálním SQLite souborem a lokálním embedding
modelem.

```bash
bun install

cp .env.example .env
# uprav si API_KEY v .env na vlastní hodnotu

bun run dev     # spustí server s auto-reloadem při změně souboru
# nebo
bun run start   # spustí server bez watch módu
```

Při startu se automaticky aplikují SQLite migrace (`migrations/`) a nastartuje se HTTP server
na portu z `config.toml` (`[server] port`). V logu uvidíš:

```
community-graph naslouchá na http://localhost:3003
```

Embedding model (`Xenova/multilingual-e5-small`) se stáhne a zacachuje při prvním použití
(první volání `/clusterize` po startu bude o něco pomalejší).

### Vygenerování nové migrace po změně schématu

Schéma SQLite je definované v `src/db/sqlite/schema.ts` pomocí [Drizzle ORM](https://orm.drizzle.team/)
— žádné ruční SQL. Po úpravě schématu vygeneruj migraci příkazem:

```bash
bun run db:generate
```

Nová migrace se vygeneruje do `migrations/` a aplikuje se automaticky při dalším startu appky.

## Konfigurace: `.env` vs `config.toml`

Projekt používá dvě oddělené vrstvy konfigurace:

- **`.env`** — credentials a prostředí-specifické hodnoty, nikdy se necommitují (jsou v
  `.gitignore`). Vzor je v `.env.example`.
- **`config.toml`** — laditelné, necitlivé parametry, commitnuté v repu s rozumnými výchozími
  hodnotami. Načítá se nativně přes Bun (žádná extra knihovna) a validuje přes zod
  (`src/config/config.ts`).

### `.env`

| Proměnná | Popis |
|---|---|
| `SQLITE_PATH` | Cesta k SQLite souboru (výchozí `./data/community-graph.sqlite`). Adresář se vytvoří automaticky. |
| `API_KEY` | Klíč, který musí klient posílat v hlavičce `X-API-Key` na všech `/api/v1/*` endpointech. |

### `config.toml`

```toml
[server]
port = 3003

[clustering]
silence_gap_minutes = 30
short_message_word_limit = 6
similarity_threshold = 0.72
continuation_similarity_threshold = 0.80
continuation_lookback_days = 14
active_subcluster_idle_minutes = 15

[embedding]
model = "Xenova/multilingual-e5-small"
dimensions = 384
```

| Sekce.klíč | Význam | Kdy měnit |
|---|---|---|
| `server.port` | Port, na kterém HTTP server poslouchá. | Podle potřeby prostředí. |
| `clustering.silence_gap_minutes` (**M**) | Mezera ticha v minutách, po které se aktuální časový blok považuje za uzavřený a začíná nový. | Zvyš, pokud se ti hodně "svižné" diskuze zbytečně tříští na víc kusů kvůli krátkým pauzám. Sniž, pokud naopak splýtává víc nesouvisejících témat do jednoho bloku. |
| `clustering.short_message_word_limit` (**W**) | Pod tímto počtem slov se pro zprávu negeneruje embedding — zpráva se místo toho jen "přilepí" k diskuzi předchozí zprávy nebo ke svému reply cíli. | Zvyš, pokud krátké věcné odpovědi (typu "diky, funguje") zbytečně zakládají vlastní embedding výpočet nebo naopak končí ve špatném clusteru. Sniž, pokud naopak krátké, ale obsahově samostatné zprávy potřebuješ clusterovat podle obsahu. |
| `clustering.similarity_threshold` (**τ**) | Práh cosine similarity (0–1), nad kterým se zpráva přiřadí k existujícímu aktivnímu sub-clusteru místo založení nového. | Sniž, pokud vznikají zbytečně roztříštěné diskuze na stejné téma. Zvyš, pokud se naopak slévají různá témata do jedné diskuze. |
| `clustering.active_subcluster_idle_minutes` | Po jak dlouhé neaktivitě v rámci časového bloku se sub-cluster vyřadí z aktivní sady (přestane se s ním porovnávat). | Vyšší hodnota = přesnější, ale pomalejší clustering u dlouhých bloků s mnoha paralelními vlákny konverzace. |
| `clustering.continuation_similarity_threshold` (**θ**) | Práh pro sémantické `CONTINUATION_OF` mezi diskuzemi. | *Zatím nevyužito — patří ke kroku 3 (graph write).* |
| `clustering.continuation_lookback_days` | Jak daleko do historie hledat kandidáty na `CONTINUATION_OF`. | *Zatím nevyužito — patří ke kroku 3 (graph write).* |
| `embedding.model` | Název modelu pro `@huggingface/transformers` (lokální, ONNX, běží in-process). | Změň, pokud chceš přesnější (ale pomalejší) variantu, např. `Xenova/multilingual-e5-base`. |
| `embedding.dimensions` | Dimenze výstupního embeddingu daného modelu. | Musí odpovídat zvolenému modelu (`e5-small` = 384, `e5-base` = 768). |

Po změně `config.toml` stačí server restartovat (soubor se čte jen při startu).

## Datový model (SQLite, `src/db/sqlite/schema.ts`)

- `guilds`, `channels`, `users` — základní entity z Discordu.
- `messages` — syrové zprávy. Sloupec `processed` (0/1) říká, jestli už zpráva prošla
  clusterizací; `discussion_id` ukazuje, do které diskuze patří.
- `ingestion_batches` — evidence jednotlivých `POST /batches` volání (počty vložených/duplicitních zpráv).
- `discussions_local` — clustery vytvořené krokem 1 (staging před AI enrichmentem a zápisem do grafu).
- `channel_checkpoints` — informativní evidence, kam clusterizace v daném kanálu chronologicky došla.
- `jobs` — stav jednotlivých asynchronních běhů (zatím jen typ `cluster`).

## Jak funguje clusterizace (krok 1)

Pro každý kanál se při zavolání `/clusterize` vezmou všechny dosud nezpracované zprávy
(`processed = 0`) a rozdělí se takto:

1. **Thready** — zprávy se stejným Discord `thread_id` vždy tvoří jednu diskuzi (bez ohledu na
   časové mezery). Nová vlákna zakládají novou diskuzi, další zprávy do existujícího vlákna se
   k ní jen připojí (i v pozdějším běhu).
2. **Časové bloky** — zbylé zprávy (mimo thready) se chronologicky rozdělí na bloky podle mezery
   ticha delší než `M` minut.
3. **Uzavřené vs. otevřené bloky** — zpracuje a zapíše se jen blok, u kterého je jisté, že už
   nedostane žádnou další zprávu (od poslední zprávy bloku uplynulo v datech víc než `M` minut).
   Poslední, stále "živý" blok zůstává nezpracovaný (`processed = 0`) a počká na doclusterování,
   až přijdou další zprávy (buď v tomtéž, nebo v některém z příštích volání).
4. **Reply reassignment** — pokud zpráva odpovídá (Discord reply) na zprávu z **už dřív
   finalizované** diskuze, přesune se buď přímo do ní (osamocená reakce), nebo se mezi diskuzemi
   založí vazba `continuation_of` (pokud na reply naváže víc dalších zpráv a vznikne z toho
   vlastní sub-cluster).
5. **Krátké zprávy** (pod `W` slov) se negeneruje embedding — připojí se buď ke svému reply cíli,
   nebo k diskuzi bezprostředně předchozí zprávy ve stejném bloku.
6. **Zbylé (delší) zprávy** se embeddují a přiřazují ke stávajícím aktivním sub-clusterům podle
   cosine similarity (práh `τ`) s malými heuristickými bonusy (stejný autor psal nedávno, zmínka
   nedávného účastníka clusteru).

Známé zjednodušení pro tuto fázi: reply se rozpozná jen tehdy, pokud cílová zpráva už v databázi
má přiřazenou diskuzi (tj. byla finalizovaná v některém z předchozích běhů nebo v dřívějším,
již zpracovaném bloku tohoto běhu). Reply na zprávu, která je součástí stále otevřeného bloku,
zatím zachycena není.

### Proč se některé zprávy "vynechají" (zůstanou `processed = 0`)

Blok se zapíše (a jeho zprávy dostanou `processed = 1` a `discussion_id`) jen tehdy, když si
engine je jistý, že do něj už nic dalšího nepřibude. To se pozná takto: `splitIntoTimeBlocks`
(`src/core/clustering/timeBlockSplitter.ts`) rozdělí chronologicky seřazené zprávy na bloky
podle mezery > `M` minut — každý blok, za kterým už následuje jiný blok, je tím pádem uzavřený
"z podstaty" (mezeru za ním jsme reálně v datech viděli). Jenže úplně **poslední** blok v aktuálním
scan okně je jiný případ — nevíme, jestli mezera za ním je proto, že diskuze skutečně skončila,
nebo jen proto, že novější zprávy zatím nepřišly. Ten se proto uzavře jen tehdy, když:

```
(nejnovější timestamp v datech kanálu) − (čas poslední zprávy tohoto bloku) > M minut
```

— tedy až sám dostatečný odstup od nejnovější zprávy, kterou o kanálu vůbec víme, dokáže. Pokud
je poslední blok stále "v dosahu" `M` minut od nejnovější zprávy (typicky proto, že je to úplně
poslední zpráva scan okna, odstup = 0), zůstane celý nezpracovaný (`processed = 0`) a při dalším
`/clusterize` (ať už nad stejnými, nebo nad nově příchozími daty) se posoudí znovu — buď se
uzavře, nebo se k němu připojí další zprávy. Vlákna (`thread_id`) touto logikou vůbec neprochází,
zpracovávají se vždy celá v každém běhu (viz `skippedOpenBlockMessageCount` v odpovědi jobu — to
je přesně počet takto vynechaných zpráv).

### Stavy diskuze (`discussions_local.status`)

- **`clustering`** — čerstvě založená diskuze, ještě neprošla AI enrichmentem (krok 2, zatím
  neimplementován).
- **`needs_reenrichment`** — diskuze **už existovala** (z dřívějšího běhu, případně už měla
  `enriched`/`written` stav z pozdější fáze) a tento běh clusterizace do ní dopsal další zprávy —
  buď rozšířením vlákna (nová zpráva do už existujícího `thread_id`), nebo tím, že do ní jiná
  zpráva/diskuze "spadla" přes reply reassignment (krátká osamocená reakce nebo `continuation_of`
  sub-cluster). Protože se změnil její obsah, její staré title/summary/topics (pokud už nějaké
  má) jsou zastaralé a diskuze čeká na (opětovné) spuštění kroku 2. Nově založené diskuze naopak
  dostávají rovnou `clustering`, protože ještě žádný enrichment neproběhl, takže není co
  "znovu"-obohacovat.
- `enriched`, `written` — cílové stavy kroků 2 a 3, zatím se nikde nenastavují (nejsou
  implementované).

## HTTP API

Všechny `/api/v1/*` endpointy vyžadují hlavičku `X-API-Key` s hodnotou z `.env` (`API_KEY`).
Bez ní nebo se špatnou hodnotou vrací `401`. Platná cesta zavolaná nepodporovanou HTTP metodou
(např. `DELETE /api/v1/batches`) vrací `405 { "error": "method_not_allowed" }`.

### `POST /api/v1/batches`

Uloží dávku zpráv do SQLite (dedup podle `id` zprávy). Nic dalšího automaticky nespouští.

```bash
curl -X POST http://localhost:3003/api/v1/batches \
  -H "X-API-Key: <tvůj API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "guild": { "id": "g1", "name": "Moje komunita" },
    "channel": { "id": "c1", "name": "obecna", "type": "text" },
    "messages": [
      {
        "id": "m1",
        "author": { "id": "u1", "username": "adam" },
        "content": "Ahoj, sledoval někdo ten nový trailer?",
        "created_at": "2026-08-24T10:00:00.000Z",
        "mentions": [],
        "attachments_count": 0
      }
    ]
  }'
```

Odpověď `202`:

```json
{ "batch_id": "...", "message_count": 1, "inserted_count": 1, "duplicate_count": 0 }
```

> `reply_to_message_id`, `thread_id`, `mentions` a `attachments_count` jsou nepovinné — pokud
> zpráva není reply/není ve vlákně, dané pole prostě z JSONu vynech (neposílej `null`, validace
> to odmítne).

### `POST /api/v1/channels/:id/clusterize`

Spustí clusterizaci nezpracovaných zpráv daného kanálu na pozadí. Vrací `202` s `job_id`, průběh
se sleduje přes `GET /api/v1/jobs/:id`.

```bash
curl -X POST http://localhost:3003/api/v1/channels/c1/clusterize -H "X-API-Key: <tvůj API_KEY>"
```

```json
{ "job_id": "...", "type": "cluster", "status": "queued" }
```

### `GET /api/v1/jobs/:id`

```bash
curl http://localhost:3003/api/v1/jobs/<job_id> -H "X-API-Key: <tvůj API_KEY>"
```

```json
{
  "id": "...",
  "type": "cluster",
  "status": "completed",
  "progress": { "current": 0, "total": 0 },
  "result": {
    "processedMessageCount": 10,
    "newDiscussionCount": 2,
    "extendedDiscussionCount": 0,
    "skippedOpenBlockMessageCount": 1
  },
  "created_at": "...",
  "updated_at": "...",
  "started_at": "...",
  "finished_at": "..."
}
```

- `skippedOpenBlockMessageCount` — kolik zpráv zůstalo v ještě neuzavřeném koncovém bloku
  (normální jev, doclusterují se v některém z příštích volání).

### `GET /api/v1/jobs?status=&channel_id=&type=`

Seznam jobů, volitelně filtrovaný.

### `GET /api/v1/channels/:id/discussions?status=`

Debug/inspekční endpoint pro ruční kontrolu výsledku clusterizace — ukáže diskuze daného kanálu
včetně jejich zpráv, bez nutnosti cokoliv dalšího mít zapnuté (Neo4j v této fázi ještě neexistuje).

```bash
curl http://localhost:3003/api/v1/channels/c1/discussions -H "X-API-Key: <tvůj API_KEY>"
```

```json
[
  {
    "id": "...",
    "status": "clustering",
    "thread_id": null,
    "message_count": 5,
    "block_start_at": "...",
    "block_end_at": "...",
    "continuation_of_discussion_id": null,
    "continuation_reason": null,
    "messages": [{ "id": "m1", "author_id": "u1", "content": "...", "created_at": "..." }]
  }
]
```

### `DELETE /api/v1/channels/:id/messages`

Debug endpoint pro reset kanálu při ladění — smaže všechny zprávy daného kanálu, jeho staged
diskuze (`discussions_local`) i checkpoint, aby šel kanál znovu zaingestovat od nuly (typicky po
úpravě `M`/`W`/`τ` v `config.toml`). Historii jobů (`jobs`) nemaže.

```bash
curl -X DELETE http://localhost:3003/api/v1/channels/c1/messages -H "X-API-Key: <tvůj API_KEY>"
```

```json
{ "channel_id": "c1", "deleted_message_count": 11, "deleted_discussion_count": 2 }
```

### `GET /health`

Bez autentizace. Ověří dostupnost SQLite.

```bash
curl http://localhost:3003/health
```

## Doporučený postup ladění

1. Ingestni testovací dávku zpráv (`POST /batches`).
2. Spusť `POST /channels/:id/clusterize`, počkej na dokončení jobu.
3. Zkontroluj `GET /channels/:id/discussions` — dává rozdělení do diskuzí smysl? Neslévají se
   nesouvisející témata? Netříští se zbytečně jedna diskuze na víc kusů?
4. Uprav `M` / `W` / `τ` v `config.toml`, restartuj server a zkus znovu — buď na nové dávce, nebo
   na stejných datech po smazání kanálu přes `DELETE /api/v1/channels/:id/messages`.
