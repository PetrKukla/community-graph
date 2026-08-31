# Multi-stage Bun build: install deps once, build the web/ bundle, ship src + dist.
FROM oven/bun:1.3 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
COPY vite.config.ts config.example.toml ./
COPY web ./web
# vite.config.ts reads config.toml for the dev port only; it falls back to defaults if absent
RUN bun run web:build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/web/dist ./web/dist
COPY package.json bun.lock drizzle.config.ts ./
COPY src ./src
COPY migrations ./migrations
# baseline config; bind-mount or COPY a real config.toml to override, or use PORT/HOSTNAME in .env
COPY config.example.toml ./config.toml

EXPOSE 3004
CMD ["bun", "run", "src/index.ts"]
