import type { LLMProvider, LLMStructuredRequest, LLMStructuredResult } from "../../core/ports/LLMProvider";

/**
 * Serialises every LLM call process-wide: at most one request is in flight at a time, the rest
 * queue FIFO and run as the model frees up. Concurrent enrich / pipeline jobs (and the query
 * endpoint) thus take turns instead of racing the model into rate-limit errors - a job that
 * arrives while another is talking to the model simply waits and resumes on its own, one call
 * at a time, so the wait is at most a single in-flight request, not a whole job.
 *
 * Sits OUTSIDE LoggingLLMProvider so queue-wait time is not counted into the logged call duration.
 */
export class SerializingLLMProvider implements LLMProvider {
  readonly #inner: LLMProvider;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(inner: LLMProvider) {
    this.#inner = inner;
  }

  generateStructured<T>(request: LLMStructuredRequest<T>): Promise<LLMStructuredResult<T>> {
    // chain off whatever is currently running/queued; a prior call's rejection must not
    // poison the queue, so both settle paths just release the lock.
    const result = this.#tail.then(
      () => this.#inner.generateStructured(request),
      () => this.#inner.generateStructured(request),
    );
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
