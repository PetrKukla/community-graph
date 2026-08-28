import type { z } from "zod";

export interface LLMStructuredRequest<T> {
  /** System / instruction prompt - stable across a run, safe to cache. */
  system: string;
  /** The per-discussion payload (messages to analyse). */
  user: string;
  /** Zod schema the response must satisfy; the adapter also derives the provider's JSON-schema from it. */
  schema: z.ZodType<T>;
  /** Short identifier for the schema, used where a provider wants a named JSON schema (OpenAI, Gemini). */
  schemaName: string;
}

export interface LLMStructuredResult<T> {
  /** Parsed + schema-validated value. */
  value: T;
  /** Raw JSON text returned by the model, kept verbatim for audit/debug. */
  raw: string;
}

/**
 * Hexagonal boundary for the enrichment step. Core code depends only on this port -
 * never on a concrete vendor SDK. Implementations live in src/adapters/llm/.
 */
export interface LLMProvider {
  generateStructured<T>(request: LLMStructuredRequest<T>): Promise<LLMStructuredResult<T>>;
}
