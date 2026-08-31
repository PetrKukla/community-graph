import { z } from "zod";
import toml from "../../config.toml";

const configSchema = z.object({
  server: z.object({
    port: z.number().int().positive(),
    host: z.string().min(1),
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
  web: z.object({
    enabled: z.boolean(),
    dev_port: z.number().int().positive(),
    llm_calls_retention_days: z.number().int().positive(),
    llm_calls_max_rows: z.number().int().positive(),
    stats_tick_seconds: z.number().positive(),
    graph_overview_limit: z.number().int().positive(),
  }),
});

const parsed = configSchema.parse(toml);

// [server] is deploy-environment sensitive: PORT / HOSTNAME in .env win over config.toml
// so the same image can be dropped behind Docker / a PaaS without editing the committed config.
if (process.env.PORT) parsed.server.port = Number(process.env.PORT);
if (process.env.HOSTNAME) parsed.server.host = process.env.HOSTNAME;

export const config = parsed;
export type Config = z.infer<typeof configSchema>;
