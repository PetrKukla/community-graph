import { z } from "zod";

const envSchema = z.object({
  SQLITE_PATH: z.string().min(1).default("./data/community-graph.sqlite"),
  API_KEY: z.string().min(1),
});

export const env = envSchema.parse(process.env);
