import { z } from "zod";

const envSchema = z.object({
  SQLITE_PATH: z.string().min(1).default("./data/community-graph.sqlite"),
  API_KEY: z.string().min(1),
  // LLM credentials - only the provider selected in config.toml ([llm] provider) needs its keys.
  LLM_ANTHROPIC_API_KEY: z.string().min(1).optional(),
  LLM_OPENAI_COMPATIBLE_BASE_URL: z.string().url().optional(),
  LLM_OPENAI_COMPATIBLE_API_KEY: z.string().min(1).optional(),
  LLM_GEMINI_API_KEY: z.string().min(1).optional(),
});

export const env = envSchema.parse(process.env);
