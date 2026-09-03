import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { GeekAiSchedulerLLMAdapter } from '../../src/adapters/llm/GeekAiSchedulerLLMAdapter';
import type { LLMStructuredRequest } from '../../src/core/ports/LLMProvider';

const schema = z.object({ answer: z.string() });

function req(): LLMStructuredRequest<z.infer<typeof schema>> {
  return {
    system: 'Jsi stručný asistent.',
    user: 'Proč je obloha modrá?',
    schema,
    schemaName: 'answer',
    context: 'test'
  };
}

const realFetch = globalThis.fetch;
let lastCall: { url: string; body: any } | null = null;

function stubFetch(status: number, payload: unknown): void {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    lastCall = { url, body: JSON.parse(init.body as string) };
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  lastCall = null;
});

const adapter = new GeekAiSchedulerLLMAdapter({
  baseUrl: 'http://scheduler.local:3000/',
  node: 'community-graph',
  model: 'llama3.2',
  temperature: 0.2,
  timeoutMs: 360_000,
  maxTokens: 2048
});

describe('GeekAiSchedulerLLMAdapter', () => {
  test('posts node + model to /v1/schedule and parses result.text', async () => {
    stubFetch(200, {
      status: 'completed',
      result: {
        text: JSON.stringify({ answer: 'Rayleighův rozptyl.' }),
        raw: { prompt_eval_count: 11, eval_count: 7 }
      },
      error: null
    });

    const out = await adapter.generateStructured(req());

    expect(lastCall?.url).toBe('http://scheduler.local:3000/v1/schedule');
    expect(lastCall?.body.node).toBe('community-graph');
    expect(lastCall?.body.model).toBe('llama3.2');
    expect(lastCall?.body.stream).toBe(false);
    expect(lastCall?.body.options).toMatchObject({
      temperature: 0.2,
      num_predict: 2048
    });
    expect(lastCall?.body.format).toMatchObject({ type: 'object' });
    expect(lastCall?.body.messages[0]).toEqual({
      role: 'system',
      content: 'Jsi stručný asistent.'
    });

    expect(out.value).toEqual({ answer: 'Rayleighův rozptyl.' });
    expect(out.usage).toEqual({ promptTokens: 11, completionTokens: 7 });
  });

  test('throws on the error envelope (no status field)', async () => {
    stubFetch(400, {
      error: { code: 'VALIDATION_ERROR', message: 'node: Required' }
    });

    await expect(adapter.generateStructured(req())).rejects.toThrow(
      'geek-ai-scheduler 400 VALIDATION_ERROR: node: Required'
    );
  });

  test('throws on a scheduler-shaped timeout response', async () => {
    stubFetch(504, {
      status: 'timeout',
      result: null,
      error: { code: 'TIMEOUT', message: 'no result before timeout' }
    });

    await expect(adapter.generateStructured(req())).rejects.toThrow(
      'geek-ai-scheduler 504 timeout: no result before timeout'
    );
  });

  test('wraps a network failure with a reachability hint', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError(
        'Unable to connect. Is the computer able to access the url?'
      );
    }) as unknown as typeof fetch;

    await expect(adapter.generateStructured(req())).rejects.toThrow(
      /nedá se připojit na http:\/\/scheduler\.local:3000\/v1\/schedule.*host\.docker\.internal/s
    );
  });

  test('wraps a client-side timeout with a config hint', async () => {
    globalThis.fetch = (async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }) as unknown as typeof fetch;

    await expect(adapter.generateStructured(req())).rejects.toThrow(
      /klientský timeout po 360000 ms.*request_timeout_ms/s
    );
  });
});
