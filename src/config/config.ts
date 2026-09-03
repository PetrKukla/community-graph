import { z } from 'zod';

// config.toml je celý dobrovolný. Načítá se přes require() (catchable - když soubor
// vůbec není, jedeme na defaultech; static import by spadl při načítání modulu).
let rawToml: unknown = {};
try {
  rawToml = require('../../config.toml');
} catch {
  console.warn('[config] config.toml nenalezen, jedu celý na defaultech');
}

// Každý klíč má `.catch(x)`: chybějící i nevalidní hodnota (špatný typ, mimo rozsah)
// spadne na default x. Chybějící / rozbité [sekce] řeší normalizace v loadConfig().
const configSchema = z.object({
  clustering: z.object({
    // M - mezera ticha (min), po které se time-block považuje za uzavřený
    silence_gap_minutes: z.number().positive().catch(30),
    // W - pod tímto počtem slov se pro zprávu negeneruje embedding
    short_message_word_limit: z.number().int().nonnegative().catch(6),
    // tau - práh cosine similarity pro přiřazení zprávy k aktivnímu sub-clusteru
    similarity_threshold: z.number().min(0).max(1).catch(0.85),
    // theta - práh pro sémantické CONTINUATION_OF (zatím nevyužito)
    continuation_similarity_threshold: z.number().min(0).max(1).catch(0.8),
    continuation_lookback_days: z.number().positive().catch(14),
    active_subcluster_idle_minutes: z.number().positive().catch(15)
  }),
  embedding: z.object({
    model: z.string().min(1).catch('Xenova/multilingual-e5-small'),
    dimensions: z.number().int().positive().catch(384)
  }),
  llm: z.object({
    provider: z
      .enum(['anthropic', 'openai-compatible', 'gemini', 'geek-ai-scheduler'])
      .catch('gemini'),
    model: z.string().min(1).catch('gemma-4-31b-it'),
    max_tokens: z.number().int().positive().catch(8192),
    // ignorováno Anthropic adaptérem (Claude 4.5+ parametr odmítá)
    temperature: z.number().min(0).max(2).catch(0.2),
    max_messages_per_call: z.number().int().positive().catch(400),
    request_timeout_ms: z.number().int().positive().catch(120_000),
    // Část 4.4 - batchování enrichmentu; 0 = batching vypnutý (1 volání/diskuze)
    enrichment_batch_target_tokens: z.number().int().nonnegative().catch(6000),
    enrichment_batch_max_discussions: z.number().int().positive().catch(25),
    enrichment_batch_retry_individually: z.boolean().catch(true)
  }),
  web: z.object({
    // false = neservírovat web/dist ani /api/v1/stream|stats|graph
    enabled: z.boolean().catch(true),
    dev_port: z.number().int().positive().catch(5173),
    llm_calls_retention_days: z.number().int().positive().catch(14),
    llm_calls_max_rows: z.number().int().positive().catch(50_000),
    stats_tick_seconds: z.number().positive().catch(2),
    graph_overview_limit: z.number().int().positive().catch(400)
  }),
  // Část 4.1 - slovník jmen (POST /api/v1/dictionary)
  dictionary: z.object({
    max_ids_per_request: z.number().int().positive().catch(5000),
    inline_graph_propagation_max: z.number().int().positive().catch(200)
  }),
  // Část 4.2 - sjednocený běh pipeline (POST /api/v1/pipeline)
  pipeline: z.object({
    // default pro request bez options.skip_graph_write (obráceně)
    include_graph_write: z.boolean().catch(true)
  }),
  // Část 3 - dotazování nad grafem (POST /api/v1/query)
  query: z.object({
    search_query_variants: z.number().int().positive().catch(3),
    vector_top_k: z.number().int().positive().catch(40),
    anchor_limit: z.number().int().positive().catch(30),
    expansion_seed_count: z.number().int().positive().catch(8),
    expansion_fanout: z.number().int().positive().catch(5),
    evidence_set_size: z.number().int().positive().catch(10),
    raw_message_discussions: z.number().int().nonnegative().catch(4),
    raw_messages_per_discussion: z.number().int().positive().catch(40),
    context_token_budget: z.number().int().positive().catch(12_000),
    min_candidate_score: z.number().min(0).catch(0.35),
    recency_half_life_days: z.number().positive().catch(120),
    weight_vector: z.number().min(0).catch(1.0),
    weight_anchor: z.number().min(0).catch(0.6),
    weight_expansion: z.number().min(0).catch(0.4),
    weight_recency: z.number().min(0).catch(0.15),
    weight_type_preference: z.number().min(0).catch(0.15),
    opinion_sentiment_diversity: z.boolean().catch(true),
    vocab_sample_size: z.number().int().positive().catch(60)
  })
});

export type Config = z.infer<typeof configSchema>;

// Bind adresa serveru žije jen v .env (SERVER_HOST / SERVER_PORT), ne tady - v Dockeru je
// HOSTNAME rezervované (ID kontejneru) a přebilo by config. Viz env.ts.
function loadConfig(): Config {
  const src: Record<string, unknown> =
    rawToml && typeof rawToml === 'object'
      ? (rawToml as Record<string, unknown>)
      : {};
  // Každá [sekce] smí chybět nebo být rozbitá: nahradíme ji `{}` a klíče dobere `.catch()`.
  const normalized = Object.fromEntries(
    Object.keys(configSchema.shape).map((section) => {
      const value = src[section];
      if (
        value !== undefined &&
        (typeof value !== 'object' || value === null)
      ) {
        console.warn(
          `[config] [${section}] má špatný typ, jedu na defaultech té sekce`
        );
        return [section, {}];
      }
      return [section, value ?? {}];
    })
  );
  return configSchema.parse(normalized);
}

export const config = loadConfig();
