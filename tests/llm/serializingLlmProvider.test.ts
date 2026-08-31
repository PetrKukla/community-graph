import { describe, expect, test } from "bun:test";
import type { LLMProvider, LLMStructuredRequest, LLMStructuredResult } from "../../src/core/ports/LLMProvider";
import { SerializingLLMProvider } from "../../src/adapters/llm/SerializingLLMProvider";

function req(context: string): LLMStructuredRequest<unknown> {
  return { system: "s", user: "u", schema: {} as never, schemaName: "x", context };
}

/** Inner provider that records overlap and can be told to fail / take a given time. */
class FakeInner implements LLMProvider {
  inFlight = 0;
  maxInFlight = 0;
  readonly order: string[] = [];

  async generateStructured<T>(request: LLMStructuredRequest<T>): Promise<LLMStructuredResult<T>> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((r) => setTimeout(r, 10));
      this.order.push(request.context ?? "");
      if (request.context === "boom") throw new Error("inner failed");
      return { value: request.context as T, raw: "" };
    } finally {
      this.inFlight -= 1;
    }
  }
}

describe("SerializingLLMProvider", () => {
  test("never runs two calls at once and preserves FIFO order", async () => {
    const inner = new FakeInner();
    const p = new SerializingLLMProvider(inner);

    const results = await Promise.all([p.generateStructured(req("a")), p.generateStructured(req("b")), p.generateStructured(req("c"))]);

    expect(inner.maxInFlight).toBe(1);
    expect(inner.order).toEqual(["a", "b", "c"]);
    expect(results.map((r) => r.value)).toEqual(["a", "b", "c"]);
  });

  test("a failing call does not block the ones queued behind it", async () => {
    const inner = new FakeInner();
    const p = new SerializingLLMProvider(inner);

    const boom = p.generateStructured(req("boom"));
    const after = p.generateStructured(req("after"));

    await expect(boom).rejects.toThrow("inner failed");
    await expect(after).resolves.toMatchObject({ value: "after" });
    expect(inner.maxInFlight).toBe(1);
  });
});
