import { z } from 'zod';
import type {
  LLMProvider,
  LLMStructuredRequest,
  LLMStructuredResult
} from '../../core/ports/LLMProvider';

export interface GeekAiSchedulerLLMAdapterOptions {
  /** Adresa, kde geek-ai-scheduler poslouchá, např. http://localhost:3000 (bez /v1/schedule). */
  baseUrl: string;
  /** Povinné pole `node` v požadavku - identifikátor volajícího uzlu, řídí navýšení priority. */
  node: string;
  /** Název modelu v Ollamě (`ollama pull <model>`). */
  model: string;
  temperature: number;
  /**
   * Timeout jednoho HTTP volání. MUSÍ být delší než serverový [server].request_timeout_ms
   * scheduleru (výchozí 300 000 ms), jinak spojení utneš dřív, než přijde výsledek.
   */
  timeoutMs: number;
  /** Volitelný strop na délku odpovědi -> Ollama options.num_predict. */
  maxTokens?: number;
}

/** Tvar odpovědi scheduleru (POST /v1/schedule) - vždy stejný, ať úloha uspěla nebo ne. */
interface SchedulerResponse {
  status?: 'completed' | 'failed' | 'timeout';
  result?: { text?: string; raw?: unknown } | null;
  error?: { code?: string; message?: string } | null;
}

/**
 * LLMProvider mluvící s `geek-ai-scheduler` - synchronní frontou před Ollamou
 * (viz AI_INTEGRATION.md). Jeden HTTP požadavek na POST /v1/schedule, spojení
 * zůstane otevřené a odpověď přijde, až na úlohu ve frontě přijde řada a doběhne.
 * Žádný streaming, žádný polling, žádné job ID.
 *
 * Strukturovaný výstup: Zod schéma z požadavku se předá jako Ollama `format`
 * (JSON schema), takže model vrací rovnou validní JSON; odpověď se pak ještě
 * ověří tím samým schématem.
 *
 * 504 (`timeout`) končí výjimkou a NEOPAKUJE se automaticky - úloha může na
 * pozadí ještě doběhnout do Ollamy, retry tedy není idempotentní. Serializaci
 * a retry řeší vrstvy nad tímto adaptérem.
 */
export class GeekAiSchedulerLLMAdapter implements LLMProvider {
  readonly #opts: GeekAiSchedulerLLMAdapterOptions;

  constructor(opts: GeekAiSchedulerLLMAdapterOptions) {
    this.#opts = { ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, '') };
  }

  async generateStructured<T>(
    request: LLMStructuredRequest<T>
  ): Promise<LLMStructuredResult<T>> {
    const jsonSchema = z.toJSONSchema(request.schema, {
      target: 'draft-2020-12'
    });

    const options: Record<string, unknown> = {
      temperature: this.#opts.temperature
    };
    if (this.#opts.maxTokens) options.num_predict = this.#opts.maxTokens;

    const url = `${this.#opts.baseUrl}/v1/schedule`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          node: this.#opts.node,
          model: this.#opts.model,
          messages: [
            { role: 'system', content: request.system },
            {
              role: 'user',
              content: `${request.user}\n\nOdpověz výhradně JSON objektem odpovídajícím tomuto JSON schématu:\n${JSON.stringify(jsonSchema)}`
            }
          ],
          options,
          format: jsonSchema,
          stream: false
        }),
        signal: AbortSignal.timeout(this.#opts.timeoutMs)
      });
    } catch (err) {
      // AbortSignal.timeout -> DOMException 'TimeoutError'; síťová chyba -> TypeError 'fetch failed'.
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new Error(
          `geek-ai-scheduler: klientský timeout po ${this.#opts.timeoutMs} ms (${url}). ` +
            'Zvyš [llm] request_timeout_ms v config.toml nad serverový request_timeout_ms scheduleru.'
        );
      }
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        `geek-ai-scheduler: nedá se připojit na ${url} (${cause}). ` +
          'Zkontroluj, že scheduler běží a je dosažitelný - z Dockeru přes host.docker.internal, ne localhost.'
      );
    }

    const body = (await res
      .json()
      .catch(() => null)) as SchedulerResponse | null;

    // Chybová obálka (400/413/415/503/404/405/500) - jiný tvar, nemá `status`/`result`.
    if (body?.error && !body.status) {
      throw new Error(
        `geek-ai-scheduler ${res.status} ${body.error.code ?? 'ERROR'}: ${body.error.message ?? 'unknown'}`
      );
    }
    // failed (502) / timeout (504) - tvar odpovědi scheduleru.
    if (!res.ok || body?.status !== 'completed') {
      throw new Error(
        `geek-ai-scheduler ${res.status} ${body?.status ?? 'no-status'}: ${body?.error?.message ?? 'unknown'}`
      );
    }

    const raw = body.result?.text ?? '';
    if (!raw) throw new Error('geek-ai-scheduler vrátil prázdný result.text');

    const value = request.schema.parse(JSON.parse(raw));
    // result.raw je surová odpověď Ollamy (/api/chat) - vezmi z ní počty tokenů, když tam jsou.
    const ollama = (body.result?.raw ?? {}) as {
      prompt_eval_count?: number;
      eval_count?: number;
    };
    return {
      value,
      raw,
      usage: {
        promptTokens: ollama.prompt_eval_count ?? null,
        completionTokens: ollama.eval_count ?? null
      }
    };
  }
}
