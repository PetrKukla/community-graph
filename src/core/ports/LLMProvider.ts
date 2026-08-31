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
  /** Optional human-readable context (e.g. the discussion id) for logging - not sent to the model. */
  context?: string;
}

/** Token counts for one call, when the provider reports them. `null` when it does not. */
export interface LLMTokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface LLMStructuredResult<T> {
  /** Parsed + schema-validated value. */
  value: T;
  /** Raw JSON text returned by the model, kept verbatim for audit/debug. */
  raw: string;
  /** Token usage for the call, if the adapter could read it. */
  usage?: LLMTokenUsage;
}

/**
 * Hexagonal boundary for the enrichment step. Core code depends only on this port -
 * never on a concrete vendor SDK. Implementations live in src/adapters/llm/.
 */
export interface LLMProvider {
  generateStructured<T>(request: LLMStructuredRequest<T>): Promise<LLMStructuredResult<T>>;
}
