/**
 * Shapes of the community-graph API responses and realtime events, mirrored from `src/`.
 * Kept in sync by hand - the backend is the source of truth.
 */

export type JobType =
  | 'cluster'
  | 'enrich'
  | 'graph_write'
  | 'name_sync'
  | 'pipeline';
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface JobSummary {
  id: string;
  type: JobType;
  status: JobStatus;
  channel_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobDetail extends JobSummary {
  progress: { current: number; total: number };
  result?: Record<string, unknown>;
  error?: string;
  started_at?: string;
  finished_at?: string;
}

export type LlmCallStatus = 'ok' | 'error';

export interface LlmCall {
  id: string;
  provider: string;
  model: string;
  context: string | null;
  channel_id: string | null;
  job_id: string | null;
  started_at: string;
  duration_ms: number;
  status: LlmCallStatus;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  error: string | null;
}

export interface Paginated<T> {
  items: T[];
  next_cursor: string | null;
}

export interface PipelineFunnel {
  raw: number;
  clustered: number;
  enriched: number;
  graph_written: number;
}

export interface StatsTotals {
  channels: number;
  messages: number;
  users: number;
  discussions: number;
  topics: number;
  entities: number;
  last_ingested_at: string | null;
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

export interface Stats {
  totals: StatsTotals;
  funnel: PipelineFunnel;
  messages_per_channel: {
    channel_id: string;
    name: string | null;
    count: number;
  }[];
  clusters_per_channel: {
    channel_id: string;
    name: string | null;
    discussions: number;
    messages: number;
    avg_messages_per_discussion: number;
  }[];
  cluster_size_histogram: { bucket: string; count: number }[];
  discussion_types: { type: string; count: number }[];
  sentiment: { label: string; count: number }[];
  top_topics: { name: string; count: number }[];
  top_entities: { key: string; name: string; type: string; count: number }[];
  llm: LlmStats;
  llm_timeseries: { ts_bucket: string; calls: number; avg_ms: number }[];
}

// --- Část 4.3: dotazování na webu (POST /api/v1/query + citation drawer) ------

export type QueryConfidence = 'high' | 'medium' | 'low';

export interface QueryCitation {
  ref: string;
  discussion_id: string;
  title: string | null;
  channel: string | null;
  discussion_type: string | null;
  sentiment: string | null;
  started_at: string | null;
  score: number;
  used: boolean;
}

export interface QueryAnswer {
  answer: string;
  confidence: QueryConfidence;
  citations: QueryCitation[];
  used_discussion_count: number;
  intent: string;
  answer_language: string;
}

export interface QueryFilters {
  channel_ids?: string[];
  discussion_types?: string[];
  since?: string;
}

export interface DiscussionEnrichmentView {
  title: string | null;
  summary: string | null;
  topics: string[] | null;
  entities: { name: string; type: string }[] | null;
  key_points: string[] | null;
  sentiment: string | null;
  sentiment_score: number | null;
  language: string | null;
  discussion_type: string | null;
  resolved: boolean | null;
  enriched_at: string;
}

export interface DiscussionBundle {
  id: string;
  channel_id: string;
  status: string;
  thread_id: string | null;
  parent_discussion_id: string | null;
  message_count: number;
  block_start_at: string;
  block_end_at: string;
  continuation_of_discussion_id: string | null;
  continuation_reason: string | null;
  enrichment: DiscussionEnrichmentView | null;
  messages: {
    id: string;
    author_id: string;
    author_label: string;
    content: string;
    created_at: string;
  }[];
}

// --- graph view --------------------------------------------------------------

export interface GraphViewNode {
  id: string;
  label: string;
  caption: string;
  props: Record<string, unknown>;
  degree: number;
}

export interface GraphViewEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  props: Record<string, unknown>;
}

export interface GraphView {
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
}

// --- realtime bus events -------------------------------------------------------

export interface JobCreatedEvent {
  id: string;
  type: JobType;
  channel_id: string | null;
  created_at: string;
}

export interface JobUpdatedEvent {
  id: string;
  status: JobStatus;
  progress: { current: number; total: number };
  result?: Record<string, unknown>;
  error?: string;
  updated_at: string;
}

export interface LlmCallEvent extends LlmCall {}

export interface IngestBatchEvent {
  batch_id: string;
  channel_id: string;
  message_count: number;
  inserted_count: number;
  duplicate_count: number;
  at: string;
}

export interface StatsTickEvent {
  funnel: PipelineFunnel;
  totals: StatsTotals;
}

export interface DictionarySyncedEvent {
  guild_changed: boolean;
  channel_ids: string[];
  user_ids: string[];
  at: string;
}

export interface BusEventMap {
  'job.created': JobCreatedEvent;
  'job.updated': JobUpdatedEvent;
  'llm.call': LlmCallEvent;
  'ingest.batch': IngestBatchEvent;
  'stats.tick': StatsTickEvent;
  'dictionary.synced': DictionarySyncedEvent;
}

export type BusEventName = keyof BusEventMap;

export type BusEnvelope = {
  [K in BusEventName]: { event: K; data: BusEventMap[K] };
}[BusEventName];
