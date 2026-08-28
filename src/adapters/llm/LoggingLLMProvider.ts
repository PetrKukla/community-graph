import type { LLMProvider, LLMStructuredRequest, LLMStructuredResult } from "../../core/ports/LLMProvider";

/**
 * Wraps any LLMProvider and prints a one-line note when a request goes out and when its response
 * comes back - just enough to follow what the app is doing, no prompt/response dumps. Used around
 * the real adapter in the factory so all providers get it.
 */
export class LoggingLLMProvider implements LLMProvider {
  readonly #inner: LLMProvider;
  readonly #label: string;

  constructor(inner: LLMProvider, label: string) {
    this.#inner = inner;
    this.#label = label;
  }

  async generateStructured<T>(request: LLMStructuredRequest<T>): Promise<LLMStructuredResult<T>> {
    const startedAt = Date.now();
    const ctx = request.context ? ` · ${request.context}` : "";
    console.log(`[llm →] ${this.#label}${ctx}`);

    try {
      const result = await this.#inner.generateStructured(request);
      console.log(`[llm ←] ${this.#label}${ctx} · ${Date.now() - startedAt} ms`);
      return result;
    } catch (err) {
      console.error(`[llm ✗] ${this.#label}${ctx} · ${Date.now() - startedAt} ms · ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
}
