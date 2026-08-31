import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type {
  LLMProvider,
  LLMStructuredRequest,
  LLMStructuredResult
} from '../../core/ports/LLMProvider';

export interface AnthropicLLMAdapterOptions {
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
}

/**
 * LLMProvider backed by the official Anthropic SDK. Uses messages.parse + zodOutputFormat for
 * schema-constrained JSON. `temperature` is intentionally not sent - Claude 4.5+ models reject it.
 */
export class AnthropicLLMAdapter implements LLMProvider {
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #maxTokens: number;

  constructor(opts: AnthropicLLMAdapterOptions) {
    this.#client = new Anthropic({
      apiKey: opts.apiKey,
      timeout: opts.timeoutMs
    });
    this.#model = opts.model;
    this.#maxTokens = opts.maxTokens;
  }

  async generateStructured<T>(
    request: LLMStructuredRequest<T>
  ): Promise<LLMStructuredResult<T>> {
    const response = await this.#client.messages.parse({
      model: this.#model,
      max_tokens: this.#maxTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- helper wants a ZodType; our port already guarantees one
      output_config: { format: zodOutputFormat(request.schema as any) }
    });

    const raw = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    if (response.parsed_output == null) {
      throw new Error(
        `Anthropic returned no schema-valid output (stop_reason=${response.stop_reason}): ${raw.slice(0, 500)}`
      );
    }
    return {
      value: response.parsed_output as T,
      raw,
      usage: {
        promptTokens: response.usage?.input_tokens ?? null,
        completionTokens: response.usage?.output_tokens ?? null
      }
    };
  }
}
