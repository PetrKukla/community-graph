import { config } from '../../config/config';
import { env } from '../../config/env';
import { bus } from '../../core/events/bus';
import type { LLMProvider } from '../../core/ports/LLMProvider';
import {
  insertLlmCall,
  maybePruneLlmCalls
} from '../../db/sqlite/repositories/llmCallRepository';
import { AnthropicLLMAdapter } from './AnthropicLLMAdapter';
import { OpenAICompatibleLLMAdapter } from './OpenAICompatibleLLMAdapter';
import { GeminiLLMAdapter } from './GeminiLLMAdapter';
import { LoggingLLMProvider, type LLMCallRecord } from './LoggingLLMProvider';
import { SerializingLLMProvider } from './SerializingLLMProvider';

let cached: LLMProvider | null = null;

function buildAdapter(): LLMProvider {
  const { provider, model, max_tokens, temperature, request_timeout_ms } =
    config.llm;

  switch (provider) {
    case 'anthropic': {
      if (!env.LLM_ANTHROPIC_API_KEY)
        throw new Error(
          "config.toml [llm] provider='anthropic' but LLM_ANTHROPIC_API_KEY is not set"
        );
      return new AnthropicLLMAdapter({
        apiKey: env.LLM_ANTHROPIC_API_KEY,
        model,
        maxTokens: max_tokens,
        timeoutMs: request_timeout_ms
      });
    }
    case 'openai-compatible': {
      if (!env.LLM_OPENAI_COMPATIBLE_BASE_URL) {
        throw new Error(
          "config.toml [llm] provider='openai-compatible' but LLM_OPENAI_COMPATIBLE_BASE_URL is not set"
        );
      }
      return new OpenAICompatibleLLMAdapter({
        baseUrl: env.LLM_OPENAI_COMPATIBLE_BASE_URL,
        apiKey: env.LLM_OPENAI_COMPATIBLE_API_KEY,
        model,
        maxTokens: max_tokens,
        temperature,
        timeoutMs: request_timeout_ms
      });
    }
    case 'gemini': {
      if (!env.LLM_GEMINI_API_KEY)
        throw new Error(
          "config.toml [llm] provider='gemini' but LLM_GEMINI_API_KEY is not set"
        );
      return new GeminiLLMAdapter({
        apiKey: env.LLM_GEMINI_API_KEY,
        model,
        maxTokens: max_tokens,
        temperature,
        timeoutMs: request_timeout_ms
      });
    }
  }
}

/** Persist one instrumentation row and fan the call out to the realtime bus. Never throws. */
function recordLlmCall(record: LLMCallRecord): void {
  try {
    insertLlmCall(record);
    maybePruneLlmCalls();
  } catch (err) {
    console.error(
      `[llm sink] persist failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  bus.emit('llm.call', {
    id: record.id,
    provider: record.provider,
    model: record.model,
    context: record.context,
    channel_id: record.channelId,
    job_id: record.jobId,
    started_at: record.startedAt,
    duration_ms: record.durationMs,
    status: record.status,
    prompt_tokens: record.promptTokens,
    completion_tokens: record.completionTokens,
    error: record.error
  });
}

/**
 * Returns the LLMProvider selected in config.toml, constructed once per process.
 * SerializingLLMProvider(Logging(adapter)): one model request at a time process-wide, callers
 * queue and resume automatically; logging measures only the real call, not the queue wait.
 */
export function getLLMProvider(): LLMProvider {
  cached ??= new SerializingLLMProvider(
    new LoggingLLMProvider(buildAdapter(), {
      provider: config.llm.provider,
      model: config.llm.model,
      sink: recordLlmCall
    })
  );
  return cached;
}
