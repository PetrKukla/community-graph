import { z } from "zod";
import toml from "../../config.toml";

const configSchema = z.object({
  server: z.object({
    port: z.number().int().positive(),
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
});

export const config = configSchema.parse(toml);
export type Config = z.infer<typeof configSchema>;
