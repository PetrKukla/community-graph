import { Hono } from 'hono';
import { z } from 'zod';
import { getLLMProvider } from '../../adapters/llm';
import { getGraphStore, isNeo4jConfigured } from '../../adapters/graph';
import { getEmbeddingProvider } from '../../adapters/embedding';
import {
  answerQuestion,
  GraphUnavailableError
} from '../../core/query/queryPipeline';
import { sqliteContextSource } from '../../db/sqlite/repositories/queryRepository';
import { methodNotAllowed } from '../middleware/methodNotAllowed';

const bodySchema = z.object({
  question: z.string().trim().min(3).max(2000),
  filters: z
    .object({
      channel_ids: z.array(z.string()).max(50).optional(),
      discussion_types: z.array(z.string()).max(20).optional(),
      since: z.string().optional()
    })
    .optional()
});

export const queryRoute = new Hono();

/**
 * Část 3 - dotazování nad grafem. NL question -> answer synthesised from the graph, with citations.
 * Synchronous: one embedding batch + a couple of Neo4j reads + two LLM calls, seconds of latency.
 */
queryRoute.post('/query', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return c.json(
      { error: 'invalid_request', details: parsed.error.flatten() },
      422
    );
  }

  if (!isNeo4jConfigured()) {
    return c.json(
      {
        error: 'graph_unavailable',
        detail: 'Neo4j není nakonfigurováno (NEO4J_PASSWORD).'
      },
      503
    );
  }

  const debug = ['1', 'true', 'yes'].includes(
    (c.req.query('debug') ?? '').toLowerCase()
  );

  try {
    const answer = await answerQuestion(
      {
        question: parsed.data.question,
        filters: parsed.data.filters
          ? {
              channelIds: parsed.data.filters.channel_ids,
              discussionTypes: parsed.data.filters.discussion_types,
              since: parsed.data.filters.since
            }
          : undefined,
        debug
      },
      {
        llm: getLLMProvider(),
        graph: getGraphStore(),
        embedder: getEmbeddingProvider(),
        sqlite: sqliteContextSource
      }
    );
    return c.json(answer);
  } catch (err) {
    if (err instanceof GraphUnavailableError) {
      return c.json({ error: 'graph_unavailable', detail: err.message }, 503);
    }
    console.error(
      `[query] failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
    );
    return c.json(
      {
        error: 'query_failed',
        detail: err instanceof Error ? err.message : String(err)
      },
      500
    );
  }
});

queryRoute.all('/query', methodNotAllowed);
