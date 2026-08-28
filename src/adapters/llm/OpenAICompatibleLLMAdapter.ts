import { z } from "zod";
import type { LLMProvider, LLMStructuredRequest, LLMStructuredResult } from "../../core/ports/LLMProvider";

export interface OpenAICompatibleLLMAdapterOptions {
  baseUrl: string; // e.g. https://api.openai.com/v1 or http://localhost:11434/v1
  apiKey?: string; // optional - local servers (Ollama, LM Studio) often need none
  model: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

/**
 * LLMProvider for any OpenAI-compatible /chat/completions endpoint (OpenAI, Ollama, vLLM,
 * LM Studio, and most self-hosted gateways). Plain fetch, no SDK. Tries native json_schema
 * response formatting first and falls back to json_object if the server rejects it.
 */
export class OpenAICompatibleLLMAdapter implements LLMProvider {
  readonly #opts: OpenAICompatibleLLMAdapterOptions;

  constructor(opts: OpenAICompatibleLLMAdapterOptions) {
    this.#opts = { ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, "") };
  }

  async generateStructured<T>(request: LLMStructuredRequest<T>): Promise<LLMStructuredResult<T>> {
    const jsonSchema = z.toJSONSchema(request.schema, { target: "draft-2020-12" });
    const messages = [
      { role: "system", content: request.system },
      {
        role: "user",
        content: `${request.user}\n\nOdpověz výhradně JSON objektem odpovídajícím tomuto JSON schématu:\n${JSON.stringify(jsonSchema)}`,
      },
    ];

    const responseFormats = [
      { type: "json_schema", json_schema: { name: request.schemaName, schema: jsonSchema } },
      { type: "json_object" },
    ];

    let lastError = "";
    for (const responseFormat of responseFormats) {
      const res = await this.#post({
        model: this.#opts.model,
        max_tokens: this.#opts.maxTokens,
        temperature: this.#opts.temperature,
        messages,
        response_format: responseFormat,
      });
      if (!res.ok) {
        lastError = `${res.status} ${await res.text()}`;
        continue; // try the next (looser) response_format
      }
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const raw = body.choices?.[0]?.message?.content ?? "";
      const value = request.schema.parse(JSON.parse(raw));
      return { value, raw };
    }
    throw new Error(`OpenAI-compatible request failed: ${lastError}`);
  }

  #post(payload: unknown): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#opts.apiKey) headers.authorization = `Bearer ${this.#opts.apiKey}`;
    return fetch(`${this.#opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.#opts.timeoutMs),
    });
  }
}
