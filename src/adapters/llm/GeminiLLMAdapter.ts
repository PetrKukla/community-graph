import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type {
  LLMProvider,
  LLMStructuredRequest,
  LLMStructuredResult
} from '../../core/ports/LLMProvider';

export interface GeminiLLMAdapterOptions {
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

/** LLMProvider backed by Google Gemini (@google/genai), using responseJsonSchema for structured JSON. */
export class GeminiLLMAdapter implements LLMProvider {
  readonly #client: GoogleGenAI;
  readonly #opts: GeminiLLMAdapterOptions;

  constructor(opts: GeminiLLMAdapterOptions) {
    this.#client = new GoogleGenAI({
      apiKey: opts.apiKey,
      httpOptions: { timeout: opts.timeoutMs }
    });
    this.#opts = opts;
  }

  async generateStructured<T>(
    request: LLMStructuredRequest<T>
  ): Promise<LLMStructuredResult<T>> {
    const jsonSchema = z.toJSONSchema(request.schema, {
      target: 'draft-2020-12'
    });
    const response = await this.#client.models.generateContent({
      model: this.#opts.model,
      contents: [{ role: 'user', parts: [{ text: request.user }] }],
      config: {
        systemInstruction: request.system,
        temperature: this.#opts.temperature,
        maxOutputTokens: this.#opts.maxTokens,
        responseMimeType: 'application/json',
        responseJsonSchema: jsonSchema
      }
    });

    const raw = response.text ?? '';
    if (!raw) throw new Error('Gemini returned an empty response');
    const value = request.schema.parse(JSON.parse(raw));
    return {
      value,
      raw,
      usage: {
        promptTokens: response.usageMetadata?.promptTokenCount ?? null,
        completionTokens: response.usageMetadata?.candidatesTokenCount ?? null
      }
    };
  }
}
