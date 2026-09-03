import { randomUUID } from 'node:crypto';
import type {
  LLMProvider,
  LLMStructuredRequest,
  LLMStructuredResult
} from '../../core/ports/LLMProvider';
import { llmCallContext } from './callContext';

/** One finished (or failed) LLM call, handed to the optional sink for persistence + broadcast. */
export interface LLMCallRecord {
  id: string;
  provider: string;
  model: string;
  context: string | null;
  channelId: string | null;
  jobId: string | null;
  startedAt: string; // ISO8601
  durationMs: number;
  status: 'ok' | 'error';
  promptTokens: number | null;
  completionTokens: number | null;
  error: string | null;
  /** Full text of the call, for the AI-view detail panel. Long prompts are truncated. */
  systemPrompt: string | null;
  userPrompt: string | null;
  response: string | null; // raw JSON text from the model; null on error
}

/** Guard against a pathological row: keep the head of very long prompts/responses. */
const MAX_STORED_CHARS = 200_000;
function clip(text: string | null | undefined): string | null {
  if (text == null) return null;
  return text.length > MAX_STORED_CHARS
    ? `${text.slice(0, MAX_STORED_CHARS)}\n… [zkráceno, ${text.length} znaků]`
    : text;
}

export interface LoggingLLMProviderOptions {
  provider: string;
  model: string;
  /** Called after every call (success or failure) with a fully-populated record. */
  sink?: (record: LLMCallRecord) => void;
}

/**
 * Wraps any LLMProvider: prints a one-line note when a request goes out and when its response
 * comes back, and - if a sink is given - hands it a structured record of the call. The wrapped
 * adapter and the core stay unaware of any of this; the factory installs the sink.
 */
export class LoggingLLMProvider implements LLMProvider {
  readonly #inner: LLMProvider;
  readonly #provider: string;
  readonly #model: string;
  readonly #label: string;
  readonly #sink?: (record: LLMCallRecord) => void;

  constructor(inner: LLMProvider, opts: LoggingLLMProviderOptions) {
    this.#inner = inner;
    this.#provider = opts.provider;
    this.#model = opts.model;
    this.#label = `${opts.provider}/${opts.model}`;
    this.#sink = opts.sink;
  }

  async generateStructured<T>(
    request: LLMStructuredRequest<T>
  ): Promise<LLMStructuredResult<T>> {
    const startedAt = new Date();
    const start = performance.now();
    const ctx = request.context ? ` · ${request.context}` : '';
    console.log(`[llm →] ${this.#label}${ctx}`);

    try {
      const result = await this.#inner.generateStructured(request);
      const durationMs = Math.round(performance.now() - start);
      console.log(`[llm ←] ${this.#label}${ctx} · ${durationMs} ms`);
      this.#emit(
        request,
        startedAt,
        durationMs,
        'ok',
        result.usage ?? null,
        null,
        result.raw ?? null
      );
      return result;
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[llm ✗] ${this.#label}${ctx} · ${durationMs} ms · ${message}`
      );
      this.#emit(request, startedAt, durationMs, 'error', null, message, null);
      throw err;
    }
  }

  #emit(
    request: LLMStructuredRequest<unknown>,
    startedAt: Date,
    durationMs: number,
    status: 'ok' | 'error',
    usage: {
      promptTokens: number | null;
      completionTokens: number | null;
    } | null,
    error: string | null,
    response: string | null
  ): void {
    if (!this.#sink) return;
    const { jobId, channelId } = llmCallContext.getStore() ?? {};
    try {
      this.#sink({
        id: randomUUID(),
        provider: this.#provider,
        model: this.#model,
        context: request.context ?? null,
        channelId: channelId ?? null,
        jobId: jobId ?? null,
        startedAt: startedAt.toISOString(),
        durationMs,
        status,
        promptTokens: usage?.promptTokens ?? null,
        completionTokens: usage?.completionTokens ?? null,
        error,
        systemPrompt: clip(request.system),
        userPrompt: clip(request.user),
        response: clip(response)
      });
    } catch (sinkErr) {
      console.error(
        `[llm sink] failed: ${sinkErr instanceof Error ? sinkErr.message : String(sinkErr)}`
      );
    }
  }
}
