import { z } from "zod";
import toml from "../../config.toml";

const configSchema = z.object({
  server: z.object({
    port: z.number().int().positive(),
    host: z.string().min(1).default("0.0.0.0"),
  }),
  clustering: z.object({
    silence_gap_minutes: z.number().positive(),
    short_message_word_limit: z.number().int().nonnegative(),
    similarity_threshold: z.number().min(0).max(1),
    continuation_similarity_threshold: z.number().min(0).max(1),
    continuation_lookback_days: z.number().positive(),
    active_subcluster_idle_minutes: z.number().positive(),
  }),
  embedding: z.object({
    model: z.string().min(1),
    dimensions: z.number().int().positive(),
  }),
  llm: z.object({
    provider: z.enum(["anthropic", "openai-compatible", "gemini"]),
    model: z.string().min(1),
    max_tokens: z.number().int().positive(),
    temperature: z.number().min(0).max(2),
    max_messages_per_call: z.number().int().positive(),
    request_timeout_ms: z.number().int().positive(),
  }),
  // every key defaulted, and the whole section prefaulted, so a config.toml written
  // before Part 2 (no [web] block) still boots
  web: z
    .object({
      enabled: z.boolean().default(true),
      dev_port: z.number().int().positive().default(5173),
      llm_calls_retention_days: z.number().int().positive().default(14),
      llm_calls_max_rows: z.number().int().positive().default(50_000),
      stats_tick_seconds: z.number().positive().default(2),
      graph_overview_limit: z.number().int().positive().default(400),
    })
    .prefault({}),
  // Část 4.1 - slovník jmen (POST /api/v1/dictionary). Defaulted + prefaulted so a
  // config.toml written before Part 4 (no [dictionary] block) still boots.
  dictionary: z
    .object({
      max_ids_per_request: z.number().int().positive().default(5000),
      inline_graph_propagation_max: z.number().int().positive().default(200),
    })
    .prefault({}),
  // Část 3 - dotazování. Every key defaulted + section prefaulted, so a config.toml
  // written before Part 3 (no [query] block) still boots.
  query: z
    .object({
      search_query_variants: z.number().int().positive().default(3),
      vector_top_k: z.number().int().positive().default(40),
      anchor_limit: z.number().int().positive().default(30),
      expansion_seed_count: z.number().int().positive().default(8),
      expansion_fanout: z.number().int().positive().default(5),
      evidence_set_size: z.number().int().positive().default(10),
      raw_message_discussions: z.number().int().nonnegative().default(4),
      raw_messages_per_discussion: z.number().int().positive().default(40),
      context_token_budget: z.number().int().positive().default(12_000),
      min_candidate_score: z.number().min(0).default(0.35),
      recency_half_life_days: z.number().positive().default(120),
      weight_vector: z.number().min(0).default(1.0),
      weight_anchor: z.number().min(0).default(0.6),
      weight_expansion: z.number().min(0).default(0.4),
      weight_recency: z.number().min(0).default(0.15),
      weight_type_preference: z.number().min(0).default(0.15),
      opinion_sentiment_diversity: z.boolean().default(true),
      vocab_sample_size: z.number().int().positive().default(60),
    })
    .prefault({}),
});

const parsed = configSchema.parse(toml);

// [server] is deploy-environment sensitive: PORT / HOSTNAME in .env win over config.toml
// so the same image can be dropped behind Docker / a PaaS without editing the committed config.
if (process.env.PORT) parsed.server.port = Number(process.env.PORT);
if (process.env.HOSTNAME) parsed.server.host = process.env.HOSTNAME;

export const config = parsed;
export type Config = z.infer<typeof configSchema>;
