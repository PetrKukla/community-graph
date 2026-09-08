import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SQLITE_PATH = join(tmpdir(), `cg-graph-${randomUUID()}.sqlite`);
process.env.API_KEY ??= 'test-key';

const { runMigrations } = await import('../../src/db/sqlite/client');
const { env } = await import('../../src/config/env');
const { isNeo4jConfigured } = await import('../../src/adapters/graph');

runMigrations();

const { app } = await import('../../src/http/app');
const auth = { headers: { 'x-api-key': env.API_KEY } };

// The suite runs with whatever `.env` provides. These lock in routing + the
// graceful-degradation contract the dashboard relies on, not the graph payloads.
// `502` = Neo4j configured but unreachable; `503` = not configured at all.
describe('graph read endpoints', () => {
  test('GET /graph/meta answers without throwing (200 payload or 502)', async () => {
    const res = await app.request('/api/v1/graph/meta', auth);
    expect([200, 502]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as { configured: boolean };
      expect(typeof body.configured).toBe('boolean');
      if (!isNeo4jConfigured()) expect(body.configured).toBe(false);
    }
  });

  test('GET /graph/subgraph without seeds -> 400 (or 503 without Neo4j)', async () => {
    const res = await app.request('/api/v1/graph/subgraph', auth);
    expect(isNeo4jConfigured() ? [400] : [503]).toContain(res.status);
  });

  test('GET /graph/search is routed', async () => {
    const res = await app.request(
      '/api/v1/graph/search?q=linux&labels=Topic',
      auth
    );
    expect([200, 502, 503]).toContain(res.status);
  });

  test('GET /graph/node/:id and /graph/node/by-domain-id are both routed', async () => {
    const detail = await app.request('/api/v1/graph/node/4:abc:1', auth);
    expect([200, 404, 502, 503]).toContain(detail.status);
    const resolve = await app.request(
      '/api/v1/graph/node/by-domain-id?label=Discussion&id=d1',
      auth
    );
    expect([200, 404, 502, 503]).toContain(resolve.status);
  });

  test('/graph endpoints need the api key', async () => {
    expect((await app.request('/api/v1/graph/meta')).status).toBe(401);
    expect((await app.request('/api/v1/graph/search?q=x')).status).toBe(401);
  });
});
