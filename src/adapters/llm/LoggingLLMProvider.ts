import type { LLMProvider, LLMStructuredRequest, LLMStructuredResult } from "../../core/ports/LLMProvider";

/**
 * Wraps any LLMProvider and prints every request (system + user prompt) and its response to the
 * console, with timing. Used around the real adapter in the factory so all providers get it.
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
    const ctx = request.context ? ` ${request.context}` : "";
    console.log(
      [
        `\n[llm →] ${this.#label}${ctx} (schema=${request.schemaName})`,
        `--- system ---`,
        request.system,
        `--- user (${request.user.length} znaků) ---`,
        request.user,
      ].join("\n"),
    );

    try {
      const result = await this.#inner.generateStructured(request);
      console.log(
        [
          `[llm ←] ${this.#label}${ctx} OK za ${Date.now() - startedAt} ms`,
          `--- odpověď (${result.raw.length} znaků) ---`,
          result.raw,
          "",
        ].join("\n"),
      );
      return result;
    } catch (err) {
      console.error(`[llm ✗] ${this.#label}${ctx} chyba za ${Date.now() - startedAt} ms: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
}
