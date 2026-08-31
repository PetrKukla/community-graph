import { EventEmitter } from "node:events";

/** Message counts at each pipeline stage (messages that have reached at least that stage). */
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

export interface JobCreatedEvent {
  id: string;
  type: string;
  channel_id: string | null;
  created_at: string;
}

export interface JobUpdatedEvent {
  id: string;
  status: string;
  progress: { current: number; total: number };
  result?: Record<string, unknown>;
  error?: string;
  updated_at: string;
}

export interface LlmCallEvent {
  id: string;
  provider: string;
  model: string;
  context: string | null;
  channel_id: string | null;
  job_id: string | null;
  started_at: string;
  duration_ms: number;
  status: "ok" | "error";
  prompt_tokens: number | null;
  completion_tokens: number | null;
  error: string | null;
}

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

/** Emitted after POST /api/v1/dictionary writes name changes to SQLite (Část 4.1). */
export interface DictionarySyncedEvent {
  guild_changed: boolean;
  channel_ids: string[];
  user_ids: string[];
  at: string;
}

export interface BusEventMap {
  "job.created": JobCreatedEvent;
  "job.updated": JobUpdatedEvent;
  "llm.call": LlmCallEvent;
  "ingest.batch": IngestBatchEvent;
  "stats.tick": StatsTickEvent;
  "dictionary.synced": DictionarySyncedEvent;
}

export type BusEventName = keyof BusEventMap;

export type BusEnvelope = {
  [K in BusEventName]: { event: K; data: BusEventMap[K] };
}[BusEventName];

/**
 * Small typed in-process event bus. The only dependency is `node:events` - HTTP, DB and job code
 * emit onto it, and the `/api/v1/stream` WebSocket is the only subscriber that forwards outward.
 * A single shared instance is imported everywhere.
 */
class TypedEventBus {
  readonly #emitter = new EventEmitter();
  readonly #anyEvent = Symbol("any");

  constructor() {
    this.#emitter.setMaxListeners(0);
  }

  emit<K extends BusEventName>(event: K, payload: BusEventMap[K]): void {
    this.#emitter.emit(event, payload);
    this.#emitter.emit(this.#anyEvent, { event, data: payload } as BusEnvelope);
  }

  on<K extends BusEventName>(event: K, listener: (payload: BusEventMap[K]) => void): () => void {
    this.#emitter.on(event, listener as (payload: unknown) => void);
    return () => this.#emitter.off(event, listener as (payload: unknown) => void);
  }

  /** Subscribe to every event as `{ event, data }`. Returns an unsubscribe function. */
  onAny(listener: (envelope: BusEnvelope) => void): () => void {
    this.#emitter.on(this.#anyEvent, listener as (payload: unknown) => void);
    return () => this.#emitter.off(this.#anyEvent, listener as (payload: unknown) => void);
  }
}

export const bus = new TypedEventBus();
