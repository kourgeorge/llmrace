import { describe, it, expect, vi, beforeEach } from "vitest";
import { xaiAdapter } from "../../src/providers/xai";

function createSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const sseData = chunks.map((c) => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseData));
      controller.close();
    },
  });
}

function createErrorStream(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("xai-adapter", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the x.ai endpoint with correct headers", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
      ]),
    });
    globalThis.fetch = fetchSpy;

    const abort = new AbortController();
    await xaiAdapter.stream({
      apiKey: "xai-test",
      model: "grok-4.3",
      prompt: "Hello",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.x.ai/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer xai-test",
          "Content-Type": "application/json",
        }),
      })
    );

    globalThis.fetch = originalFetch;
  });

  it("parses SSE chunks and calls onChunk correctly", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hello " } }] }),
        JSON.stringify({ choices: [{ delta: { content: "World" } }] }),
      ]),
    });

    const chunks: string[] = [];
    const abort = new AbortController();

    await xaiAdapter.stream({
      apiKey: "xai-test",
      model: "grok-4.3",
      prompt: "test",
      onChunk: (text) => chunks.push(text),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(chunks).toEqual(["Hello ", "World"]);
    globalThis.fetch = originalFetch;
  });

  it("calls onFirstToken exactly once", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "A" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "B" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "C" } }] }),
      ]),
    });

    const onFirstToken = vi.fn();
    const abort = new AbortController();

    await xaiAdapter.stream({
      apiKey: "xai-test",
      model: "grok-4.3",
      prompt: "test",
      onChunk: vi.fn(),
      onFirstToken,
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(onFirstToken).toHaveBeenCalledTimes(1);
    globalThis.fetch = originalFetch;
  });

  it("handles 401 error response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createErrorStream(401, { error: { message: "Invalid API key" } })
    );

    const onError = vi.fn();
    const abort = new AbortController();

    await xaiAdapter.stream({
      apiKey: "bad-key",
      model: "grok-4.3",
      prompt: "test",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError,
      signal: abort.signal,
    });

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "Invalid API key",
    }));
    globalThis.fetch = originalFetch;
  });

  it("respects AbortSignal", async () => {
    const abort = new AbortController();
    abort.abort();

    const onError = vi.fn();
    const onDone = vi.fn();

    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));

    await xaiAdapter.stream({
      apiKey: "xai-test",
      model: "grok-4.3",
      prompt: "test",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone,
      onError,
      signal: abort.signal,
    });

    expect(onDone).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    globalThis.fetch = originalFetch;
  });

  it("handles usage with null reasoning_tokens gracefully", async () => {
    // Some providers may send completion_tokens_details with null/invalid reasoning_tokens
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
        JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            completion_tokens_details: { reasoning_tokens: null },
          },
        }),
      ]),
    });

    const onUsage = vi.fn();
    const abort = new AbortController();

    await xaiAdapter.stream({
      apiKey: "xai-test",
      model: "grok-4.3",
      prompt: "test",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onUsage,
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 5 });
    globalThis.fetch = originalFetch;
  });

  it("does not subtract separate xAI reasoning_tokens from completion_tokens", async () => {
    // xAI reports reasoning outside completion_tokens:
    // total_tokens = prompt + completion + reasoning (e.g. 32 + 9 + 94 = 135).
    // Subtracting would yield negative/zero outputTokens and blank TPS.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
        JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 32,
            completion_tokens: 9,
            total_tokens: 135,
            completion_tokens_details: { reasoning_tokens: 94 },
          },
        }),
      ]),
    });

    const onUsage = vi.fn();
    const abort = new AbortController();

    await xaiAdapter.stream({
      apiKey: "xai-test",
      model: "grok-4.3",
      prompt: "test",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onUsage,
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 32, outputTokens: 9 });
    globalThis.fetch = originalFetch;
  });

  it("does not subtract separate reasoning when visible completion exceeds reasoning", async () => {
    // Critical edge: reasoning ≤ completion would pass a naive inequality check
    // (50 ≤ 100), but xAI total accounting is still prompt+completion+reasoning.
    // Old bug: would wrongly subtract and report 50 visible tokens.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "long reply" } }] }),
        JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 40,
            completion_tokens: 100,
            total_tokens: 190, // 40 + 100 + 50
            completion_tokens_details: { reasoning_tokens: 50 },
          },
        }),
      ]),
    });

    const onUsage = vi.fn();
    const abort = new AbortController();

    await xaiAdapter.stream({
      apiKey: "xai-test",
      model: "grok-4.3",
      prompt: "test",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onUsage,
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 40, outputTokens: 100 });
    globalThis.fetch = originalFetch;
  });

  it("parses usage from final chunk and calls onUsage", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
      ]),
    });

    const onUsage = vi.fn();
    const abort = new AbortController();

    await xaiAdapter.stream({
      apiKey: "xai-test",
      model: "grok-4.3",
      prompt: "test",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onUsage,
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 5 });
    globalThis.fetch = originalFetch;
  });

  it("strips xai/ prefix from model id", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
      ]),
    });
    globalThis.fetch = fetchSpy;

    const abort = new AbortController();
    await xaiAdapter.stream({
      apiKey: "xai-test",
      model: "xai/grok-4.3",
      prompt: "test",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(callBody.model).toBe("grok-4.3");
    globalThis.fetch = originalFetch;
  });

  it("does not call onUsage when usage is absent", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
      ]),
    });

    const onUsage = vi.fn();
    const abort = new AbortController();

    await xaiAdapter.stream({
      apiKey: "xai-test",
      model: "grok-4.3",
      prompt: "test",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onUsage,
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(onUsage).not.toHaveBeenCalled();
    globalThis.fetch = originalFetch;
  });
});
