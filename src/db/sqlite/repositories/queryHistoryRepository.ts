import { randomUUID } from 'node:crypto';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { config } from '../../../config/config';
import { db } from '../client';
import { queryHistory } from '../schema';

export interface QueryHistoryFilters {
  channel_ids?: string[];
  discussion_types?: string[];
  since?: string;
}

export interface QueryHistoryRow {
  id: string;
  question: string;
  filters: QueryHistoryFilters | null;
  answer: Record<string, unknown>;
  confidence: string;
  used_discussion_count: number;
  created_at: string;
}

/** Uloží zodpovězený dotaz. Chyby loguje, nevyhazuje - historie nesmí shodit odpověď. */
export function insertQueryHistory(input: {
  question: string;
  filters: QueryHistoryFilters | null;
  answer: Record<string, unknown>;
}): void {
  try {
    const confidence = input.answer.confidence;
    const used = input.answer.used_discussion_count;
    db.insert(queryHistory)
      .values({
        id: randomUUID(),
        question: input.question,
        filters: input.filters,
        answer: input.answer,
        confidence: typeof confidence === 'string' ? confidence : 'low',
        usedDiscussionCount: typeof used === 'number' ? used : 0,
        createdAt: new Date().toISOString()
      })
      .run();
  } catch (err) {
    console.error(
      `[query-history] zápis selhal: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// Dashboard buffer, ne audit: občas na zápisu ořízni staré řádky a přebytek nad limitem.
let lastPruneAt = 0;
const PRUNE_INTERVAL_MS = 5 * 60_000;

export function maybePruneQueryHistory(): void {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;

  const cutoff = new Date(
    now - config.web.query_history_retention_days * 86_400_000
  ).toISOString();
  db.delete(queryHistory).where(lt(queryHistory.createdAt, cutoff)).run();

  const max = config.web.query_history_max_rows;
  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(queryHistory)
      .get()?.n ?? 0;
  if (total > max) {
    const oldestToKeep = db
      .select({ createdAt: queryHistory.createdAt })
      .from(queryHistory)
      .orderBy(desc(queryHistory.createdAt))
      .limit(1)
      .offset(max - 1)
      .get();
    if (oldestToKeep) {
      db.delete(queryHistory)
        .where(lt(queryHistory.createdAt, oldestToKeep.createdAt))
        .run();
    }
  }
}

export interface ListQueryHistoryParams {
  limit: number;
  cursor?: string; // "<createdAt>__<id>" posledního řádku předchozí stránky
}

export interface ListQueryHistoryResult {
  items: QueryHistoryRow[];
  next_cursor: string | null;
}

/** Nejnovější první, keyset paginace na (created_at, id). */
export function listQueryHistory(
  params: ListQueryHistoryParams
): ListQueryHistoryResult {
  const limit = Math.min(Math.max(params.limit, 1), 100);
  const filters = [];

  if (params.cursor) {
    const sep = params.cursor.lastIndexOf('__');
    if (sep > 0) {
      const cCreated = params.cursor.slice(0, sep);
      const cId = params.cursor.slice(sep + 2);
      filters.push(
        or(
          lt(queryHistory.createdAt, cCreated),
          and(eq(queryHistory.createdAt, cCreated), lt(queryHistory.id, cId))
        )
      );
    }
  }

  const rows = db
    .select()
    .from(queryHistory)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(queryHistory.createdAt), desc(queryHistory.id))
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    items: page.map((r) => ({
      id: r.id,
      question: r.question,
      filters: r.filters ?? null,
      answer: r.answer,
      confidence: r.confidence,
      used_discussion_count: r.usedDiscussionCount,
      created_at: r.createdAt
    })),
    next_cursor: hasMore && last ? `${last.createdAt}__${last.id}` : null
  };
}

/** Smaže celou historii. Vrací počet smazaných řádků. */
export function clearQueryHistory(): number {
  const before =
    db
      .select({ n: sql<number>`count(*)` })
      .from(queryHistory)
      .get()?.n ?? 0;
  db.delete(queryHistory).run();
  return before;
}
