import { sql, type SQLWrapper } from "drizzle-orm";
import type { PipelineFunnel, StatsTotals } from "../../../core/events/bus";
import { db } from "../client";

// drizzle's raw-SQL `.get()` returns positional array rows; `.all()` returns keyed objects.
function scalar(query: SQLWrapper): number {
  return db.all<{ v: number | null }>(query)[0]?.v ?? 0;
}

function scalarText(query: SQLWrapper): string | null {
  return db.all<{ v: string | null }>(query)[0]?.v ?? null;
}

/** Cheap funnel + totals - safe to recompute on every stats.tick. */
export function computeStatsTick(): { funnel: PipelineFunnel; totals: StatsTotals } {
  const funnel: PipelineFunnel = {
    raw: scalar(sql`select count(*) as v from messages`),
    clustered: scalar(sql`select count(*) as v from messages where discussion_id is not null`),
    enriched: scalar(
      sql`select count(*) as v from messages where discussion_id in (
            select id from discussions_local where status in ('enriched','written'))`,
    ),
    graph_written: scalar(sql`select count(*) as v from messages where processed = 3`),
  };

  const totals: StatsTotals = {
    channels: scalar(sql`select count(*) as v from channels`),
    messages: funnel.raw,
    users: scalar(sql`select count(*) as v from users`),
    discussions: scalar(sql`select count(*) as v from discussions_local where status <> 'split'`),
    topics: scalar(
      sql`select count(distinct value) as v from discussion_enrichment, json_each(discussion_enrichment.topics)
          where discussion_enrichment.topics is not null`,
    ),
    entities: scalar(
      sql`select count(distinct json_extract(value,'$.type') || ':' || json_extract(value,'$.name')) as v
          from discussion_enrichment, json_each(discussion_enrichment.entities)
          where discussion_enrichment.entities is not null`,
    ),
    last_ingested_at: scalarText(sql`select max(ingested_at) as v from messages`),
  };

  return { funnel, totals };
}

export interface ChannelMessageCount {
  channel_id: string;
  name: string | null;
  count: number;
}

export interface ChannelClusterStats {
  channel_id: string;
  name: string | null;
  discussions: number;
  messages: number;
  avg_messages_per_discussion: number;
}

export interface LabelCount {
  label: string;
  count: number;
}

export interface LlmModelStats {
  model: string;
  calls: number;
  avg_ms: number;
  p95_ms: number;
}

export interface LlmStats {
  total_calls: number;
  error_rate: number;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  by_model: LlmModelStats[];
}

export interface FullStats extends ReturnType<typeof computeStatsTick> {
  messages_per_channel: ChannelMessageCount[];
  clusters_per_channel: ChannelClusterStats[];
  cluster_size_histogram: { bucket: string; count: number }[];
  discussion_types: { type: string; count: number }[];
  sentiment: LabelCount[];
  top_topics: { name: string; count: number }[];
  top_entities: { key: string; name: string; type: string; count: number }[];
  llm: LlmStats;
  llm_timeseries: { ts_bucket: string; calls: number; avg_ms: number }[];
}

const HISTOGRAM_BUCKETS: { label: string; max: number }[] = [
  { label: "1", max: 1 },
  { label: "2–3", max: 3 },
  { label: "4–7", max: 7 },
  { label: "8–15", max: 15 },
  { label: "16–31", max: 31 },
  { label: "32+", max: Infinity },
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)] ?? 0);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export function computeFullStats(): FullStats {
  const base = computeStatsTick();

  const messages_per_channel = db.all<ChannelMessageCount>(sql`
    select m.channel_id as channel_id, c.name as name, count(*) as count
    from messages m left join channels c on c.id = m.channel_id
    group by m.channel_id order by count desc`);

  const clusterRows = db.all<{ channel_id: string; name: string | null; discussions: number; messages: number }>(sql`
    select d.channel_id as channel_id, c.name as name,
           count(distinct d.id) as discussions, coalesce(sum(d.message_count), 0) as messages
    from discussions_local d left join channels c on c.id = d.channel_id
    where d.status <> 'split'
    group by d.channel_id order by discussions desc`);
  const clusters_per_channel: ChannelClusterStats[] = clusterRows.map((r) => ({
    ...r,
    avg_messages_per_discussion: r.discussions > 0 ? Math.round((r.messages / r.discussions) * 10) / 10 : 0,
  }));

  const sizes = db
    .all<{ n: number }>(sql`select message_count as n from discussions_local where status <> 'split'`)
    .map((r) => r.n);
  const cluster_size_histogram = HISTOGRAM_BUCKETS.map((b, i) => {
    const min = i === 0 ? 1 : (HISTOGRAM_BUCKETS[i - 1]?.max ?? 0) + 1;
    return { bucket: b.label, count: sizes.filter((n) => n >= min && n <= b.max).length };
  });

  const discussion_types = db.all<{ type: string; count: number }>(sql`
    select discussion_type as type, count(*) as count from discussion_enrichment
    where discussion_type is not null group by discussion_type order by count desc`);

  const sentiment = db.all<LabelCount>(sql`
    select sentiment as label, count(*) as count from discussion_enrichment
    where sentiment is not null group by sentiment order by count desc`);

  const top_topics = db.all<{ name: string; count: number }>(sql`
    select value as name, count(*) as count
    from discussion_enrichment, json_each(discussion_enrichment.topics)
    where discussion_enrichment.topics is not null
    group by value order by count desc limit 15`);

  const top_entities = db.all<{ key: string; name: string; type: string; count: number }>(sql`
    select json_extract(value,'$.type') || ':' || json_extract(value,'$.name') as key,
           json_extract(value,'$.name') as name, json_extract(value,'$.type') as type, count(*) as count
    from discussion_enrichment, json_each(discussion_enrichment.entities)
    where discussion_enrichment.entities is not null
    group by key order by count desc limit 15`);

  // LLM aggregates: pull the raw columns and reduce in JS (SQLite has no percentile function).
  const calls = db.all<{ duration_ms: number; status: string; model: string }>(sql`
    select duration_ms, status, model from llm_calls`);
  const allDurations = calls.map((c) => c.duration_ms).sort((a, b) => a - b);
  const errors = calls.filter((c) => c.status === "error").length;
  const byModel = new Map<string, number[]>();
  for (const c of calls) {
    const list = byModel.get(c.model) ?? [];
    list.push(c.duration_ms);
    byModel.set(c.model, list);
  }
  const llm: LlmStats = {
    total_calls: calls.length,
    error_rate: calls.length > 0 ? Math.round((errors / calls.length) * 1000) / 1000 : 0,
    avg_ms: mean(allDurations),
    p50_ms: percentile(allDurations, 50),
    p95_ms: percentile(allDurations, 95),
    by_model: [...byModel.entries()]
      .map(([model, ds]) => {
        const sorted = [...ds].sort((a, b) => a - b);
        return { model, calls: ds.length, avg_ms: mean(sorted), p95_ms: percentile(sorted, 95) };
      })
      .sort((a, b) => b.calls - a.calls),
  };

  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const llm_timeseries = db.all<{ ts_bucket: string; calls: number; avg_ms: number }>(sql`
    select substr(started_at, 1, 16) as ts_bucket, count(*) as calls, round(avg(duration_ms)) as avg_ms
    from llm_calls where started_at >= ${since}
    group by ts_bucket order by ts_bucket`);

  return {
    ...base,
    messages_per_channel,
    clusters_per_channel,
    cluster_size_histogram,
    discussion_types,
    sentiment,
    top_topics,
    top_entities,
    llm,
    llm_timeseries,
  };
}
