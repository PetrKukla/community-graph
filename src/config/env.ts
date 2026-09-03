import { z } from 'zod';

const envSchema = z.object({
  SQLITE_PATH: z.string().min(1).default('./data/community-graph.sqlite'),
  API_KEY: z.string().min(1),
  // HTTP server bind. Vlastní názvy (ne HOSTNAME/PORT) - HOSTNAME si v Dockeru drží
  // runtime pro ID kontejneru a přebilo by cokoli z .env.
  SERVER_HOST: z.string().min(1).default('0.0.0.0'),
  SERVER_PORT: z.coerce.number().int().positive().default(3004),
  // LLM credentials - only the provider selected in config.toml ([llm] provider) needs its keys.
  LLM_ANTHROPIC_API_KEY: z.string().min(1).optional(),
  LLM_OPENAI_COMPATIBLE_BASE_URL: z.string().url().optional(),
  LLM_OPENAI_COMPATIBLE_API_KEY: z.string().min(1).optional(),
  LLM_GEMINI_API_KEY: z.string().min(1).optional(),
  // provider = "geek-ai-scheduler" - synchronní fronta před Ollamou (viz AI_INTEGRATION.md).
  // BASE_URL je adresa, kde scheduler poslouchá (bez /v1/schedule); NODE je povinný
  // identifikátor tohoto uzlu, podle kterého scheduler navyšuje prioritu.
  LLM_GEEK_AI_SCHEDULER_BASE_URL: z.string().url().optional(),
  LLM_GEEK_AI_SCHEDULER_NODE: z.string().min(1).optional(),
  // Neo4j - needed only for the graph-write step (krok 3).
  NEO4J_URI: z.string().min(1).default('bolt://localhost:7687'),
  NEO4J_USER: z.string().min(1).default('neo4j'),
  NEO4J_PASSWORD: z.string().min(1).optional()
});

export const env = envSchema.parse(process.env);
