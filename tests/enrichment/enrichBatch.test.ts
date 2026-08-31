import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  enrichBatch,
  packDiscussionsIntoBatches,
  type EnrichBatchCluster
} from '../../src/core/enrichment/enrichmentPipeline';
import type { EmbeddingProvider } from '../../src/core/ports/EmbeddingProvider';
import type {
  LLMProvider,
  LLMStructuredRequest,
  LLMStructuredResult
} from '../../src/core/ports/LLMProvider';
import type { EnrichmentResponse } from '../../src/core/enrichment/schemas';

process.env.SQLITE_PATH = join(
  tmpdir(),
  `cg-enrichbatch-${randomUUID()}.sqlite`
);
process.env.API_KEY ??= 'test-key';

const { db, runMigrations } = await import('../../src/db/sqlite/client');
const { channels, users, messages, discussionsLocal, discussionEnrichment } =
  await import('../../src/db/sqlite/schema');
const { enrichChannel } = await import('../../src/jobs/enrichStage');
const { config } = await import('../../src/config/config');

runMigrations();

const embedder: EmbeddingProvider = {
  async embed(texts) {
    return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
  }
};

const SEGMENT_FIELDS = {
  title: 'T',
  summary: 'S',
  topics: ['x'],
  entities: [] as { name: string; type: string }[],
  key_points: [] as string[],
  sentiment: 'neutral' as const,
  sentiment_score: 0,
  language: 'cs',
  discussion_type: 'discussion' as const,
  resolved: null
};

interface FakeOpts {
  throwOnFirstBatchCall?: boolean;
  omitLastCluster?: boolean;
  mergeAllIntoOneSegment?: boolean;
}

/** Parses the rendered prompt back into clusters and echoes one segment per cluster. */
function fakeLlm(opts: FakeOpts = {}): {
  llm: LLMProvider;
  calls: () => number;
} {
  let calls = 0;
  const llm: LLMProvider = {
    async generateStructured<T>(
      req: LLMStructuredRequest<T>
    ): Promise<LLMStructuredResult<T>> {
      calls++;
      const clusterParts = req.user.split(/=== CLUSTER (\S+) · /).slice(1);
      const batched = clusterParts.length > 0;

      if (opts.throwOnFirstBatchCall && batched && calls === 1) {
        throw new Error('provider 500');
      }

      let segments: EnrichmentResponse['segments'];
      if (!batched) {
        const ids = [...req.user.matchAll(/\[id=([^\]]+)\]/g)].map(
          (m) => m[1]!
        );
        segments = [{ message_ids: ids, ...SEGMENT_FIELDS }];
      } else {
        const perCluster: { label: string; ids: string[] }[] = [];
        for (let i = 0; i < clusterParts.length; i += 2) {
          const label = clusterParts[i]!;
          const body = clusterParts[i + 1] ?? '';
          const ids = [...body.matchAll(/\[id=([^\]]+)\]/g)].map((m) => m[1]!);
          perCluster.push({ label, ids });
        }
        if (opts.mergeAllIntoOneSegment) {
          segments = [
            {
              message_ids: perCluster.flatMap((c) => c.ids),
              source_cluster: perCluster[0]!.label,
              ...SEGMENT_FIELDS
            }
          ];
        } else {
          const kept = opts.omitLastCluster
            ? perCluster.slice(0, -1)
            : perCluster;
          segments = kept.map((c) => ({
            message_ids: c.ids,
            source_cluster: c.label,
            ...SEGMENT_FIELDS
          }));
        }
      }
      const value = { segments } as EnrichmentResponse;
      return {
        value: value as unknown as T,
        raw: JSON.stringify(value)
      };
    }
  };
  return { llm, calls: () => calls };
}

let channelSeq = 0;
function seedChannel(discussionCount: number, messagesPer = 1): string {
  const channelId = `chan-${channelSeq++}`;
  const now = '2026-01-01T00:00:00.000Z';
  db.insert(channels)
    .values({ id: channelId, createdAt: now, updatedAt: now })
    .run();
  db.insert(users)
    .values({ id: 'u0', username: 'u0' })
    .onConflictDoNothing()
    .run();

  for (let d = 0; d < discussionCount; d++) {
    const discussionId = `${channelId}-d${d}`;
    const start = new Date(Date.parse(now) + d * 60_000).toISOString();
    db.insert(discussionsLocal)
      .values({
        id: discussionId,
        channelId,
        blockStartAt: start,
        blockEndAt: start,
        status: 'clustering',
        messageCount: messagesPer
      })
      .run();
    for (let m = 0; m < messagesPer; m++) {
      const ts = new Date(Date.parse(start) + m * 1000).toISOString();
      db.insert(messages)
        .values({
          id: `${discussionId}m${m}`,
          channelId,
          authorId: 'u0',
          content: `zprava ${d}-${m}`,
          createdAt: ts,
          wordCount: 2,
          ingestedAt: ts,
          processed: 1,
          discussionId
        })
        .run();
    }
  }
  return channelId;
}

function enrichmentRows(channelId: string) {
  return db
    .select()
    .from(discussionEnrichment)
    .innerJoin(
      discussionsLocal,
      eq(discussionsLocal.id, discussionEnrichment.discussionId)
    )
    .where(eq(discussionsLocal.channelId, channelId))
    .all();
}

describe('packDiscussionsIntoBatches', () => {
  const clusters: EnrichBatchCluster[] = Array.from({ length: 12 }, (_, i) => ({
    discussionId: `d${i}`,
    messages: [
      {
        id: `d${i}m0`,
        authorId: 'u',
        authorLabel: 'u',
        content: 'krátká zpráva',
        createdAt: '2026-01-01T00:00:00.000Z'
      }
    ]
  }));

  test('targetTokens = 0 disables batching (one discussion per batch)', () => {
    const batches = packDiscussionsIntoBatches(clusters, {
      targetTokens: 0,
      maxDiscussions: 25,
      maxMessagesPerCall: 400
    });
    expect(batches).toHaveLength(12);
    expect(batches.every((b) => b.clusters.length === 1)).toBe(true);
  });

  test('maxDiscussions caps a batch even when the token budget is huge', () => {
    const batches = packDiscussionsIntoBatches(clusters, {
      targetTokens: 1_000_000,
      maxDiscussions: 5,
      maxMessagesPerCall: 400
    });
    expect(batches.map((b) => b.clusters.length)).toEqual([5, 5, 2]);
  });

  test('a single oversized discussion gets its own batch', () => {
    const big: EnrichBatchCluster = {
      discussionId: 'big',
      messages: Array.from({ length: 50 }, (_, i) => ({
        id: `big-m${i}`,
        authorId: 'u',
        authorLabel: 'u',
        content: 'x'.repeat(500),
        createdAt: '2026-01-01T00:00:00.000Z'
      }))
    };
    const batches = packDiscussionsIntoBatches(
      [clusters[0]!, big, clusters[1]!],
      { targetTokens: 200, maxDiscussions: 25, maxMessagesPerCall: 400 }
    );
    const bigBatch = batches.find((b) =>
      b.clusters.some((c) => c.discussionId === 'big')
    )!;
    expect(bigBatch.clusters).toHaveLength(1);
  });
});

describe('enrichBatch mapping', () => {
  const params = { embeddingProvider: embedder, maxMessagesPerCall: 400 };

  test('single cluster with several segments -> split, no message lost', async () => {
    const cluster: EnrichBatchCluster = {
      discussionId: 'solo',
      messages: ['a', 'b', 'c', 'd'].map((id, i) => ({
        id,
        authorId: 'u',
        authorLabel: 'u',
        content: id,
        createdAt: new Date(
          Date.parse('2026-01-01T00:00:00Z') + i * 1000
        ).toISOString()
      }))
    };
    // fake that returns two segments for a single (unbatched) call
    const llm: LLMProvider = {
      async generateStructured<T>() {
        const value = {
          segments: [
            { message_ids: ['a', 'b'], ...SEGMENT_FIELDS },
            { message_ids: ['c', 'd'], ...SEGMENT_FIELDS }
          ]
        };
        return { value: value as unknown as T, raw: '{}' };
      }
    };
    const map = await enrichBatch([cluster], { llm, ...params });
    const res = map.get('solo')!;
    expect(res.outcome.kind).toBe('split');
    if (res.outcome.kind === 'split') {
      expect(res.outcome.segments.flatMap((s) => s.messageIds).sort()).toEqual([
        'a',
        'b',
        'c',
        'd'
      ]);
    }
  });

  test('a segment spanning two clusters is cut along message ownership', async () => {
    const mk = (did: string): EnrichBatchCluster => ({
      discussionId: did,
      messages: [0, 1].map((i) => ({
        id: `${did}-m${i}`,
        authorId: 'u',
        authorLabel: 'u',
        content: 'text',
        createdAt: '2026-01-01T00:00:00.000Z'
      }))
    });
    const { llm } = fakeLlm({ mergeAllIntoOneSegment: true });
    const map = await enrichBatch([mk('A'), mk('B')], { llm, ...params });

    expect(map.get('A')!.outcome.kind).toBe('single');
    expect(map.get('B')!.outcome.kind).toBe('single');
    // each parent keeps exactly its own messages
    const b = map.get('B')!;
    if (b.outcome.kind === 'single') {
      // single keeps every message of the parent implicitly; assert we didn't mark it split
      expect(b.outcome.enrichment.title).toBe('T');
    }
  });
});

describe('enrichChannel with batching', () => {
  test('40 tiny discussions collapse into 2 LLM calls, all enriched', async () => {
    const channelId = seedChannel(40);
    const { llm, calls } = fakeLlm();

    const result = await enrichChannel(channelId, llm, embedder);

    expect(calls()).toBe(2); // 25 + 15, capped by enrichment_batch_max_discussions
    expect(result.batchCount).toBe(2);
    expect(result.individualRetryCount).toBe(0);
    expect(result.enrichedDiscussionCount).toBe(40);
    expect(result.failedCount).toBe(0);
    expect(enrichmentRows(channelId)).toHaveLength(40);
  });

  test('a failed batch call is retried discussion-by-discussion', async () => {
    const channelId = seedChannel(6);
    const { llm } = fakeLlm({ throwOnFirstBatchCall: true });

    const result = await enrichChannel(channelId, llm, embedder);

    expect(result.individualRetryCount).toBe(6);
    expect(result.failedCount).toBe(0);
    expect(result.enrichedDiscussionCount).toBe(6);
    expect(enrichmentRows(channelId)).toHaveLength(6);
  });

  test('a cluster the model skips is still enriched via a solo fallback call', async () => {
    const channelId = seedChannel(5);
    const { llm } = fakeLlm({ omitLastCluster: true });

    const result = await enrichChannel(channelId, llm, embedder);

    expect(result.enrichedDiscussionCount).toBe(5);
    expect(result.failedCount).toBe(0);
    expect(enrichmentRows(channelId)).toHaveLength(5);
  });

  test('batching parity: target_tokens = 0 gives the same enriched discussions', async () => {
    const original = config.llm.enrichment_batch_target_tokens;
    config.llm.enrichment_batch_target_tokens = 0;
    try {
      const channelId = seedChannel(8);
      const { llm, calls } = fakeLlm();
      const result = await enrichChannel(channelId, llm, embedder);
      expect(calls()).toBe(8); // one call per discussion
      expect(result.batchCount).toBe(8);
      expect(result.enrichedDiscussionCount).toBe(8);
      expect(enrichmentRows(channelId)).toHaveLength(8);
    } finally {
      config.llm.enrichment_batch_target_tokens = original;
    }
  });

  test('messages never change parent discussion except through a real split', async () => {
    const channelId = seedChannel(10, 2);
    const { llm } = fakeLlm();
    await enrichChannel(channelId, llm, embedder);

    for (let d = 0; d < 10; d++) {
      const did = `${channelId}-d${d}`;
      const owned = db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.discussionId, did))
        .all()
        .map((r) => r.id)
        .sort();
      expect(owned).toEqual([`${did}m0`, `${did}m1`]);
    }
  });
});
