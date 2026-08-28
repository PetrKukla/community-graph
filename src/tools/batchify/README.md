# batchify

Utilita mimo běžící službu. Spouští se ručně přes `bun run convert`
(`src/tools/batchify/cli.ts`).

## Syrový dump zpráv → dávky pro ingest

Převede syrový export zpráv z databáze Discord bota na JSON dávky pro
`POST /api/v1/batches`, rozdělené **po serverech → po kanálech → po dnech**.

- `batchify.ts` — čistá funkce `rawMessagesToBatches()` + zod schéma vstupu (dá se importovat i jinam)
- `cli.ts` — CLI obálka, registrovaná jako `bun run convert`

### Vstup

Pole objektů (nebo jeden objekt, nebo NDJSON — jeden objekt na řádek):

```json
{
  "id": "1462881571076833455",
  "channel_id": "1462881475979640842",
  "author_id": "569933947585298482",
  "content": "Myslim si, že RTX 3090 je dneska stále ještě dobrá grafika.",
  "created_at": "2026-01-19T18:49:05.57+00:00",
  "deleted_at": null
}
```

Sloupce navíc se ignorují. Čte se ze souboru (poziční argument) nebo ze stdinu.

### Výstup

Se `--out <dir>` se zapíše složková struktura (složka i mezisložky se vytvoří):

```
<dir>/<guild>/<channel>/<YYYY-MM-DD>.json
```

Složky `<guild>` a `<channel>` se pojmenují podle `--guild-name` / `--channel`; kde
název chybí, použije se ID. Režim řídí `--dir-names`:

| `--dir-names` | `<guild>` / `<channel>` |
|---|---|
| `name` (výchozí) | název, kde chybí → ID; kdyby dvě různá ID spadla do stejné složky, skončí to chybou |
| `id` | vždy ID |
| `name-id` | `<název>-<id>` (čitelné a bez rizika kolize) |

Každý soubor je jedna dávka přesně ve tvaru, který bere `POST /api/v1/batches`:

```json
{
  "guild": { "id": "123456789", "name": "Geekboy" },
  "channel": { "id": "1462881475979640842", "name": "hardware" },
  "messages": [
    {
      "id": "1462881571076833455",
      "author": { "id": "569933947585298482" },
      "content": "Myslim si, že RTX 3090 je dneska stále ještě dobrá grafika.",
      "created_at": "2026-01-19T18:49:05.570Z"
    }
  ]
}
```

S `--out` jde na **stdout** jen zelený souhrn (co se zapsalo). Bez `--out` se na
**stdout** vypíše ploché pole všech dávek a souhrn jde na **stderr** — JSON se tak dá
rovnou pipenout. Chyby jdou červeně na stderr; barvy vypne `NO_COLOR=1`.

### Co utilita dělá

- seskupí zprávy podle `guild_id` (viz níže), `channel_id` a **UTC dne** z `created_at`
- v rámci každé dávky seřadí zprávy chronologicky
- zahodí duplicitní `id` (v rámci server+kanál)
- **vynechá smazané** zprávy (`deleted_at != null`) a **prázdné** (jen whitespace/příloha) —
  přepínatelné přes `--include-deleted` / `--include-empty`
- `created_at` znormalizuje na ISO 8601 v UTC (`2026-01-19T18:49:05.57+00:00`
  → `2026-01-19T18:49:05.570Z`); den se bere z tohoto UTC času

### Servery (`guild_id`)

Syrový dump `guild_id` neobsahuje, musíš ho dodat:

- `--guild <id>` — jedna guilda pro všechny kanály
- `--guild-map <path>` — JSON soubor `{ "<channel_id>": "<guild_id>" }` pro dumpy
  míchající víc serverů; `--guild` (pokud je taky zadané) slouží jako fallback pro
  kanály, které v mapě nejsou

Když se pro nějaký kanál guilda nenajde, utilita skončí chybou s výpisem těch `channel_id`.

### Volby

| Volba | Význam |
|---|---|
| `--out <dir>`, `-o` | výstupní složka; bez ní jde ploché pole dávek na stdout |
| `--guild <id>`, `-g` | ID guildy/serveru pro kanály mimo `--guild-map` |
| `--guild-name <name>` | název guildy do `guild.name` i do názvu složky (jen pro guildu z `--guild`) |
| `--guild-map <path>` | JSON `{ "channel_id": "guild_id" }` pro víc serverů v jednom dumpu |
| `--channel <id=name>` | název kanálu pro dané `channel_id` do `channel.name` i do názvu složky (lze zopakovat) |
| `--dir-names <mode>` | `name` (výchozí) \| `id` \| `name-id` — jak pojmenovat složky `<guild>`/`<channel>` |
| `--include-deleted` | zahrnout i smazané zprávy (`deleted_at != null`) |
| `--include-empty` | zahrnout i zprávy s prázdným obsahem |
| `--pretty` | odsazený JSON i pro stdout náhled (soubory jsou odsazené vždy) |
| `--help`, `-h` | nápověda |

### Příklady

```bash
# jeden server, výstup do složky
bun run convert --guild 123456789 --guild-name Geekboy \
  --channel 1462881475979640842=hardware \
  --out ./batches dump.json

# vstup ze stdinu (JSON pole i NDJSON)
cat dump.json | bun run convert --guild 123456789 --out ./batches

# víc serverů v jednom dumpu
bun run convert --guild-map ./guild-map.json --out ./batches dump.json

# rychlý náhled bez zápisu na disk
bun run convert --guild 123456789 --pretty dump.json | less

# Příklad pro Geekboy - Technologie, počítače a hry
bun convert --guild 727854412953026650 --guild-name GeekBoy-Technologie-pocitace-a-hry --channel 820649506013315072=programovani --channel 729316187745550356=pocitace --channel 846741885036396564=pokec --channel 1057031098481262633=monitory --channel 729315501796360252=chytra-domacnost --channel 996108941484372008=apple --channel 907707969750335550=linux --channel 986712451640872980=slevy --channel 793065466155106324=aplikace-software --channel 1193574648126918736=soukromi-bezpecnost --channel 727854413447954466=mobily --channel 987971337559605299=klavesnice-mysi --out examples/dump messages-dump.json
```

### Nahrání do služby

Po vygenerování projdi soubory a pošli obsah každého na `POST /api/v1/batches`:

```bash
find ./batches -name '*.json' | while read f; do
  curl -sS -X POST http://localhost:3003/api/v1/batches \
    -H "X-API-Key: $API_KEY" \
    -H 'Content-Type: application/json' \
    --data-binary "@$f"
done
```

Pořadí souborů (server → kanál → den, dny vzestupně) odpovídá pořadí, v jakém dává
smysl je ingestovat. Endpoint dedupuje podle `id` zprávy, takže opakované nahrání
stejného souboru nevadí.
