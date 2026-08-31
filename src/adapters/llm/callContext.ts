import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Ambient context for an LLM call so the instrumentation sink can tag `llm_calls` rows with the
 * job / channel that triggered them without threading those ids through the core enrichment code.
 * The job runner wraps a stage in `llmCallContext.run({ jobId, channelId }, ...)`.
 */
export interface LLMCallContext {
  jobId?: string;
  channelId?: string;
}

export const llmCallContext = new AsyncLocalStorage<LLMCallContext>();
