# AI_INTEGRATION.md

Návod pro integraci `geek-ai-scheduler` do AI klienta / agenta. Stručně: jak
se s tím mluví, co čekat v odpovědi a na co si dát pozor.

Pro provoz a konfiguraci viz [README](./README.md), pro architekturu
[TECHNOLOGY.md](./TECHNOLOGY.md).

## Model v jedné větě

Je to **synchronní fronta před Ollamou**. Pošleš jeden HTTP požadavek, spojení
zůstane otevřené a odpověď dostaneš, až na tebe ve frontě přijde řada a úloha
doběhne. Žádný streaming, žádný polling, žádné job ID k pozdějšímu dotažení.
Úlohy se zpracovávají **striktně po jedné**, seřazené podle priority.

Z toho plyne pár věcí, které si integrace musí ohlídat:

- **Klientský timeout musí být delší než serverový.** Server drží požadavek až
  `[server].request_timeout_ms` (výchozí 300 000 ms = 5 min). HTTP klient na
  tvé straně musí mít read/socket timeout aspoň tak dlouhý, jinak spojení
  utneš dřív, než přijde výsledek.
- **Timeout (504) neznamená, že se úloha nespustila.** Server přestal čekat,
  ale úloha může na pozadí doběhnout do Ollamy. Retry po 504 tedy může model
  spustit podruhé — není to idempotentní.
- **Žádná autentizace.** Když to vystavíš mimo localhost/vlastní síť, dej před
  to reverzní proxy s autentizací.
- **Model musí být v Ollamě stažený.** `model` v požadavku je název modelu v
  Ollamě (`ollama pull <model>`). Neznámý model skončí jako `status: "failed"`
  (HTTP 502).

## Endpoint

### `POST /v1/schedule`

Hlavička: `Content-Type: application/json` (jinak 415). Tělo max 1 000 000 B
(jinak 413).

#### Tělo požadavku

```jsonc
{
  "node": "laptop-1",        // POVINNÉ. Identifikátor volajícího uzlu; slouží k dohledání navýšení priority.
  "model": "llama3.2",       // POVINNÉ. Název modelu v Ollamě.

  // Právě JEDEN z těchto dvou (XOR — ne oba, ne žádný):
  "prompt": "Proč je obloha modrá?",
  "messages": [
    { "role": "system",    "content": "Jsi stručný asistent." },
    { "role": "user",      "content": "Proč je obloha modrá?" }
  ],
  // role ∈ system | user | assistant, content neprázdný string

  "priority": 0,             // volitelné, int -1000..1000, výchozí 0. Vyšší = dřív na řadě.
  "options": { "temperature": 0.7 }, // volitelné, předá se beze změny do Ollamy (options)
  "format": "json",          // volitelné, string nebo JSON schema; předá se do Ollamy (format)
  "keepAlive": "5m",         // volitelné, předá se do Ollamy jako keep_alive
  "stream": false            // volitelné; přijímá se jen false. stream:true => 400.
}
```

- `prompt` → interně jde na Ollama `/api/generate`.
- `messages` → interně jde na Ollama `/api/chat`.
- Neznámá pole v těle → 400 (schéma je `strict`).

#### Tělo odpovědi

**Vždy stejný tvar**, ať úloha uspěla, selhala, nebo vypršel čas. Stav se pozná
z pole `status` (a z HTTP kódu).

```jsonc
{
  "id": "…",
  "node": "laptop-1",
  "model": "llama3.2",
  "status": "completed",     // "completed" | "failed" | "timeout"
  "priority": { "input": 0, "nodeBoost": 10, "effective": 10 },
  "timing": {
    "queuedAt":    "2026-08-20T12:00:00.000Z",
    "startedAt":   "2026-08-20T12:00:01.000Z", // null, když úloha nikdy nezačala
    "completedAt": "2026-08-20T12:00:04.000Z", // null, když úloha nikdy neskončila
    "queueWaitMs": 1000,     // null, dokud úloha nezačala
    "processingMs": 3000     // null, dokud úloha neskončí
  },
  "result": {                // null, pokud status != "completed"
    "text": "Kvůli Rayleighově rozptylu…",
    "raw": { /* surová odpověď Ollamy */ }
  },
  "error": null              // { "code": "…", "message": "…" }, pokud status != "completed"
}
```

Pro běžné použití stačí: zkontroluj `status === "completed"` a vezmi
`result.text`. `result.raw` je originální JSON z Ollamy, když potřebuješ
tokeny/časy/`done_reason` apod.

#### HTTP stavové kódy

| Kód | `status`      | Význam                                                                                     |
| --- | ------------- | ---------------------------------------------------------------------------------------- |
| 200 | `completed`   | Hotovo, text je v `result.text`.                                                        |
| 502 | `failed`      | Úloha se dostala k Ollamě a selhala (Ollama nedostupná, odpověď mimo 2xx, vadný JSON…). |
| 504 | `timeout`    | Do timeoutu nedorazil výsledek. Úloha může na pozadí ještě doběhnout — retry NENÍ bezpečný. |
| 400 | —            | Nevalidní JSON nebo validace: chybí `node`/`model`, oba/žádný z `prompt`/`messages`, `priority` mimo rozsah, `stream:true`, neznámé pole. |
| 413 | —            | Tělo požadavku je moc velké.                                                            |
| 415 | —            | `Content-Type` není `application/json`.                                                 |
| 503 | —            | Redis nedostupný, nebo je fronta na kapacitě `[queue].max_size`.                        |

#### Chybová obálka (400/413/415/503/404/405/500)

Tohle je jiný tvar než odpověď scheduleru — nemá `status`/`result`:

```jsonc
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "prompt: exactly one of 'prompt' or 'messages' must be provided",
    "issues": [ { "path": "prompt", "message": "…" } ]  // jen u VALIDATION_ERROR
  }
}
```

### `GET /healthz`

`200 {"status":"ok"}`, jakmile je Redis dostupný; jinak
`503 {"status":"degraded","reason":"queue unavailable"}`. Hodí se jako
readiness check před tím, než začneš posílat úlohy.

## Priorita

`effective = priority (z požadavku) + navýšení podle uzlu`. Navýšení podle uzlu
se bere z `config.toml` (`[priority.nodes]` podle pole `node`, jinak
`[priority].default`). Při stejné efektivní prioritě se drží FIFO. Vrácené
`priority.effective` říká, s jakou prioritou úloha reálně běžela.

## Doporučené chování klienta

1. **Timeouty:** klientský HTTP timeout ≥ serverový `request_timeout_ms`
   (+ rezerva). Ideálně si drž vlastní strop a ber 504 jako „nevím, jak to
   dopadlo".
2. **Retry:**
   - 503 (`QUEUE_UNAVAILABLE` / `QUEUE_FULL`) — bezpečné opakovat s backoffem,
     úloha se nezařadila.
   - 502 (`failed`) — opakovat lze, ale nejdřív zjisti důvod z `error.message`
     (často špatný `model` nebo spadlá Ollama).
   - 504 (`timeout`) — **neopakovat automaticky**; může běžet druhá instance
     téhož promptu. Když retry musí být, počítej s tím.
   - 400/413/415 — chyba na tvé straně, retry nepomůže.
3. **Souběh:** posílat víc požadavků paralelně je OK (zařadí se podle
   priority), ale reálná propustnost je 1 úloha v daný okamžik. Nediv se
   dlouhému `queueWaitMs`.
4. **Volba `prompt` vs `messages`:** pro víceotáčkový chat / system prompt
   použij `messages`; pro jednorázové doplnění `prompt`.

## Ukázky

### curl

```bash
curl -sS -X POST http://localhost:3000/v1/schedule \
  -H "Content-Type: application/json" \
  -d '{"node":"laptop-1","model":"llama3.2","prompt":"Proč je obloha modrá?"}'
```

### JavaScript / TypeScript (fetch)

```ts
async function schedule(body: object, signal?: AbortSignal) {
  const res = await fetch("http://localhost:3000/v1/schedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal, // vlastní timeout přes AbortController, delší než serverový
  });

  const data = await res.json();

  if (res.status === 200 && data.status === "completed") {
    return data.result.text as string;
  }
  if (data.error) {
    throw new Error(`${data.error.code}: ${data.error.message}`);
  }
  // failed / timeout — má tvar odpovědi scheduleru
  throw new Error(`${data.status}: ${data.error?.message ?? "unknown"}`);
}

// chat varianta
await schedule({
  node: "laptop-1",
  model: "llama3.2",
  messages: [
    { role: "system", content: "Odpovídej česky a stručně." },
    { role: "user", content: "Shrň, co je Rayleighův rozptyl." },
  ],
  options: { temperature: 0.2 },
});
```

### Python (requests)

```python
import requests

def schedule(body: dict, timeout: float = 360.0) -> str:
    r = requests.post(
        "http://localhost:3000/v1/schedule",
        json=body,
        timeout=timeout,  # delší než serverový request_timeout_ms
    )
    data = r.json()
    if r.status_code == 200 and data.get("status") == "completed":
        return data["result"]["text"]
    if "error" in data and "status" not in data:
        raise RuntimeError(f'{data["error"]["code"]}: {data["error"]["message"]}')
    raise RuntimeError(f'{data["status"]}: {(data.get("error") or {}).get("message")}')

print(schedule({"node": "laptop-1", "model": "llama3.2",
                "prompt": "Proč je obloha modrá?"}))
```

## Rychlý checklist pro integraci

- [ ] `Content-Type: application/json`
- [ ] přesně jeden z `prompt` / `messages`
- [ ] `node` a `model` vyplněné, `model` je v Ollamě stažený
- [ ] klientský timeout > serverový `request_timeout_ms`
- [ ] větvení podle `status` (`completed` / `failed` / `timeout`) i podle HTTP kódu
- [ ] 504 se neopakuje naslepo
- [ ] před ostrým provozem `GET /healthz`
