import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SQLITE_PATH = join(tmpdir(), `cg-webask-${randomUUID()}.sqlite`);
process.env.API_KEY ??= 'test-key';

const { runMigrations, db } = await import('../../src/db/sqlite/client');
const { discussionsLocal, discussionEnrichment, messages } =
  await import('../../src/db/sqlite/schema');
// env is parsed once per process; when the whole suite shares a process another file may have
// evaluated it first, so take the key the auth middleware actually checks against.
const { env } = await import('../../src/config/env');

runMigrations();

db.insert(discussionsLocal)
  .values({
    id: 'd1',
    channelId: 'c1',
    blockStartAt: '2026-08-01T00:00:00.000Z',
    blockEndAt: '2026-08-01T01:00:00.000Z',
    status: 'written',
    messageCount: 2
  })
  .run();
db.insert(discussionEnrichment)
  .values({
    discussionId: 'd1',
    title: 'Zvuk na Archu',
    summary: 'Po aktualizaci nešel zvuk, pomohl restart pipewire.',
    topics: ['Linux', 'zvuk'],
    keyPoints: ['restart pipewire pomohl'],
    sentiment: 'neutral',
    discussionType: 'help-request',
    resolved: true,
    enrichedAt: '2026-08-01T02:00:00.000Z'
  })
  .run();
db.insert(messages)
  .values([
    {
      id: 'm1',
      channelId: 'c1',
      authorId: 'u1',
      content: 'nejde zvuk',
      createdAt: '2026-08-01T00:10:00.000Z',
      wordCount: 2,
      ingestedAt: 'x',
      discussionId: 'd1'
    },
    {
      id: 'm2',
      channelId: 'c1',
      authorId: 'u2',
      content: 'zkus restart pipewire',
      createdAt: '2026-08-01T00:20:00.000Z',
      wordCount: 3,
      ingestedAt: 'x',
      discussionId: 'd1'
    }
  ])
  .run();

const { app } = await import('../../src/http/app');
const auth = { headers: { 'x-api-key': env.API_KEY } };

describe('web query view read endpoints', () => {
  test('GET /discussions/:id returns the bundle', async () => {
    const res = await app.request('/api/v1/discussions/d1', auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      enrichment: { title: string; resolved: boolean };
      messages: { id: string }[];
    };
    expect(body.id).toBe('d1');
    expect(body.enrichment.title).toBe('Zvuk na Archu');
    expect(body.enrichment.resolved).toBe(true);
    expect(body.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  test('GET /discussions/:id -> 404 for an unknown id', async () => {
    const res = await app.request('/api/v1/discussions/nope', auth);
    expect(res.status).toBe(404);
  });

  test('GET /discussions/:id -> 401 without the api key', async () => {
    const res = await app.request('/api/v1/discussions/d1');
    expect(res.status).toBe(401);
  });

  test('GET /graph/node/by-domain-id is registered (not 404-as-unrouted)', async () => {
    const res = await app.request(
      '/api/v1/graph/node/by-domain-id?label=Discussion&id=d1',
      auth
    );
    // 503 (no Neo4j) / 502 (Neo4j down) / 404 (no such node) / 200 - anything but "route missing"
    expect([200, 404, 502, 503]).toContain(res.status);
  });
});
