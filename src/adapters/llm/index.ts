import { config } from "../../config/config";
import { env } from "../../config/env";
import type { LLMProvider } from "../../core/ports/LLMProvider";
import { AnthropicLLMAdapter } from "./AnthropicLLMAdapter";
import { OpenAICompatibleLLMAdapter } from "./OpenAICompatibleLLMAdapter";
import { GeminiLLMAdapter } from "./GeminiLLMAdapter";
import { LoggingLLMProvider } from "./LoggingLLMProvider";

let cached: LLMProvider | null = null;

function buildAdapter(): LLMProvider {
  const { provider, model, max_tokens, temperature, request_timeout_ms } = config.llm;

  switch (provider) {
    case "anthropic": {
      if (!env.LLM_ANTHROPIC_API_KEY) throw new Error("config.toml [llm] provider='anthropic' but LLM_ANTHROPIC_API_KEY is not set");
      return new AnthropicLLMAdapter({ apiKey: env.LLM_ANTHROPIC_API_KEY, model, maxTokens: max_tokens, timeoutMs: request_timeout_ms });
    }
    case "openai-compatible": {
      if (!env.LLM_OPENAI_COMPATIBLE_BASE_URL) {
        throw new Error("config.toml [llm] provider='openai-compatible' but LLM_OPENAI_COMPATIBLE_BASE_URL is not set");
      }
      return new OpenAICompatibleLLMAdapter({
        baseUrl: env.LLM_OPENAI_COMPATIBLE_BASE_URL,
        apiKey: env.LLM_OPENAI_COMPATIBLE_API_KEY,
        model,
        maxTokens: max_tokens,
        temperature,
        timeoutMs: request_timeout_ms,
      });
    }
    case "gemini": {
      if (!env.LLM_GEMINI_API_KEY) throw new Error("config.toml [llm] provider='gemini' but LLM_GEMINI_API_KEY is not set");
      return new GeminiLLMAdapter({ apiKey: env.LLM_GEMINI_API_KEY, model, maxTokens: max_tokens, temperature, timeoutMs: request_timeout_ms });
    }
  }
}

/** Returns the LLMProvider selected in config.toml, constructed once per process. */
export function getLLMProvider(): LLMProvider {
  cached ??= new LoggingLLMProvider(buildAdapter(), `${config.llm.provider}/${config.llm.model}`);
  return cached;
}
