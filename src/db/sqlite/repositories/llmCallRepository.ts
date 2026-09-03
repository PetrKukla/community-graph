import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { config } from '../../../config/config';
import type { LLMCallRecord } from '../../../adapters/llm/LoggingLLMProvider';
import { db } from '../client';
import { llmCalls } from '../schema';

export function insertLlmCall(record: LLMCallRecord): void {
  db.insert(llmCalls)
    .values({
      id: record.id,
      provider: record.provider,
      model: record.model,
      context: record.context,
      channelId: record.channelId,
      jobId: record.jobId,
      startedAt: record.startedAt,
      durationMs: record.durationMs,
      status: record.status,
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
      error: record.error,
      systemPrompt: record.systemPrompt,
      userPrompt: record.userPrompt,
      response: record.response
    })
    .run();
}

// The table is a dashboard buffer, not an audit log: keep it small with a plain cap applied
// occasionally on write - drop rows older than the retention window, then any excess over the
// row limit (oldest first).
let lastPruneAt = 0;
const PRUNE_INTERVAL_MS = 5 * 60_000;

export function maybePruneLlmCalls(): void {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;

  const cutoff = new Date(
    now - config.web.llm_calls_retention_days * 86_400_000
  ).toISOString();
  db.delete(llmCalls).where(lt(llmCalls.startedAt, cutoff)).run();

  const max = config.web.llm_calls_max_rows;
  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(llmCalls)
      .get()?.n ?? 0;
  if (total > max) {
    const oldestToKeep = db
      .select({ startedAt: llmCalls.startedAt })
      .from(llmCalls)
      .orderBy(desc(llmCalls.startedAt))
      .limit(1)
      .offset(max - 1)
      .get();
    if (oldestToKeep) {
      db.delete(llmCalls)
        .where(lt(llmCalls.startedAt, oldestToKeep.startedAt))
        .run();
    }
  }
}

export interface ListLlmCallsParams {
  limit: number;
  status?: string;
  model?: string;
  jobId?: string;
  channelId?: string;
  cursor?: string; // "<startedAt>__<id>" of the last row from the previous page
}

export interface LlmCallRow {
  id: string;
  provider: string;
  model: string;
  context: string | null;
  channel_id: string | null;
  job_id: string | null;
  started_at: string;
  duration_ms: number;
  status: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  error: string | null;
}

/** Row + the full call text, for the AI-view detail panel (GET /ai/calls/:id). */
export interface LlmCallDetail extends LlmCallRow {
  system_prompt: string | null;
  user_prompt: string | null;
  response: string | null;
}

/** One call with its prompts/response, or null when the id is unknown. */
export function getLlmCall(id: string): LlmCallDetail | null {
  const r = db.select().from(llmCalls).where(eq(llmCalls.id, id)).get();
  if (!r) return null;
  return {
    id: r.id,
    provider: r.provider,
    model: r.model,
    context: r.context,
    channel_id: r.channelId,
    job_id: r.jobId,
    started_at: r.startedAt,
    duration_ms: r.durationMs,
    status: r.status,
    prompt_tokens: r.promptTokens,
    completion_tokens: r.completionTokens,
    error: r.error,
    system_prompt: r.systemPrompt,
    user_prompt: r.userPrompt,
    response: r.response
  };
}

export interface ListLlmCallsResult {
  items: LlmCallRow[];
  next_cursor: string | null;
}

/** Newest-first page of llm_calls with keyset pagination on (started_at, id). */
export function listLlmCalls(params: ListLlmCallsParams): ListLlmCallsResult {
  const limit = Math.min(Math.max(params.limit, 1), 200);
  const filters = [];
  if (params.status) filters.push(eq(llmCalls.status, params.status));
  if (params.model) filters.push(eq(llmCalls.model, params.model));
  if (params.jobId) filters.push(eq(llmCalls.jobId, params.jobId));
  if (params.channelId) filters.push(eq(llmCalls.channelId, params.channelId));

  if (params.cursor) {
    const sep = params.cursor.lastIndexOf('__');
    if (sep > 0) {
      const cStart = params.cursor.slice(0, sep);
      const cId = params.cursor.slice(sep + 2);
      filters.push(
        or(
          lt(llmCalls.startedAt, cStart),
          and(eq(llmCalls.startedAt, cStart), lt(llmCalls.id, cId))
        )
      );
    }
  }

  // Explicit column list: the list view never needs system_prompt/user_prompt/response,
  // and those blobs would bloat every page. Detail panel fetches them via getLlmCall().
  const rows = db
    .select({
      id: llmCalls.id,
      provider: llmCalls.provider,
      model: llmCalls.model,
      context: llmCalls.context,
      channelId: llmCalls.channelId,
      jobId: llmCalls.jobId,
      startedAt: llmCalls.startedAt,
      durationMs: llmCalls.durationMs,
      status: llmCalls.status,
      promptTokens: llmCalls.promptTokens,
      completionTokens: llmCalls.completionTokens,
      error: llmCalls.error
    })
    .from(llmCalls)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(llmCalls.startedAt), desc(llmCalls.id))
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    items: page.map((r) => ({
      id: r.id,
      provider: r.provider,
      model: r.model,
      context: r.context,
      channel_id: r.channelId,
      job_id: r.jobId,
      started_at: r.startedAt,
      duration_ms: r.durationMs,
      status: r.status,
      prompt_tokens: r.promptTokens,
      completion_tokens: r.completionTokens,
      error: r.error
    })),
    next_cursor: hasMore && last ? `${last.startedAt}__${last.id}` : null
  };
}
