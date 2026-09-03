# Lokální vývoj (Bun)

Alternativa k `docker compose up` z [README](../README.md#instalace) — pro vývoj: hot-reload
služby, samostatný Vite dev server pro webové rozhraní a spouštění testů.

Vyžaduje [Bun](https://bun.com) (testováno na `1.3.x`). Docker je potřeba jen na Neo4j (krok 3).

```bash
bun install
cp .env.example .env                  # vyplň aspoň API_KEY
cp config.example.toml config.toml    # laditelné parametry (config.toml je gitignored)
docker compose up -d neo4j            # jen krok 3; Browser :7474, Bolt :7687
bun run dev                           # služba s auto-reloadem na :3004
```

- SQLite migrace z `migrations/` se aplikují automaticky při startu (stejně jako v Dockeru).
- Embedding model (`Xenova/multilingual-e5-small`) se stáhne a zacachuje při prvním `/clusterize`.
- Kroky 1 a 2 běží i bez Neo4j — `docker compose up -d neo4j` můžeš vynechat, dokud nepotřebuješ
  `graph-write`.
- `bun run start` je totéž bez `--watch`.

## Webové rozhraní ve vývoji

Frontend (`web/`) běží zvlášť na Vite dev serveru s proxy na běžící službu:

```bash
bun run web:dev        # Vite na :5173, proxuje /api → :3004
```

Do `.env` dej `VITE_API_KEY` = hodnota `API_KEY`, aby klientský bundl mohl volat chráněné
`/api/v1/*`. Volitelně `VITE_API_BASE`, když služba neběží na výchozím portu. Proměnné
s prefixem `VITE_` čte jen Vite, ne služba samotná.

Produkční build lokálně (bez Dockeru) — jeden proces, jeden origin:

```bash
bun run web:build      # → web/dist/
bun run start          # Hono servíruje web/dist/ na / (SPA fallback) i /api/v1/*
```

## Testy

```bash
bun test                       # celá sada
bun test tests/llm/            # jen jeden adresář
```

## Změna DB schématu

Schéma je v `src/db/sqlite/schema.ts` ([Drizzle ORM](https://orm.drizzle.team/), žádné ruční
SQL). Po úpravě spusť `bun run db:generate` — migrace se vygeneruje do `migrations/` a aplikuje
při dalším startu služby.

## Formát a lint

Projekt používá `oxfmt` (2 mezery, jednoduché uvozovky, bez trailing comma) a `oxlint`:

```bash
bunx oxfmt .
bunx oxlint
```
