import { describe, it, expect, vi, beforeEach } from "vitest";
import { openaiAdapter } from "../../src/providers/openai";

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

describe("openai-adapter", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls correct endpoint with correct headers", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
      ]),
    });
    globalThis.fetch = fetchSpy;

    const abort = new AbortController();
    await openaiAdapter.stream({
      apiKey: "sk-test",
      model: "gpt-4o",
      prompt: "Hello",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test",
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

    await openaiAdapter.stream({
      apiKey: "sk-test",
      model: "gpt-4o",
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

    await openaiAdapter.stream({
      apiKey: "sk-test",
      model: "gpt-4o",
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

    await openaiAdapter.stream({
      apiKey: "bad-key",
      model: "gpt-4o",
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

    await openaiAdapter.stream({
      apiKey: "sk-test",
      model: "gpt-4o",
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

    await openaiAdapter.stream({
      apiKey: "sk-test",
      model: "gpt-4o",
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

  it("does not call onUsage when usage is absent", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
      ]),
    });

    const onUsage = vi.fn();
    const abort = new AbortController();

    await openaiAdapter.stream({
      apiKey: "sk-test",
      model: "gpt-4o",
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

  it("calls onProcessing when an SSE comment line is received", async () => {
    // Simulate a stream with a comment line (e.g. OpenRouter's ": OPENROUTER PROCESSING")
    const encoder = new TextEncoder();
    const sseData =
      ": OPENROUTER PROCESSING\n\n" +
      ": OPENROUTER PROCESSING\n\n" +
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" } }] })}\n\n` +
      "data: [DONE]\n\n";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseData));
          controller.close();
        },
      }),
    });

    const onProcessing = vi.fn();
    const abort = new AbortController();

    await openaiAdapter.stream({
      apiKey: "sk-test",
      model: "gpt-4o",
      prompt: "test",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onProcessing,
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    // Two comment lines were sent before the data chunk
    expect(onProcessing).toHaveBeenCalledTimes(2);
    globalThis.fetch = originalFetch;
  });

  it("does not call onProcessing when no comment lines are present", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
      ]),
    });

    const onProcessing = vi.fn();
    const abort = new AbortController();

    await openaiAdapter.stream({
      apiKey: "sk-test",
      model: "gpt-4o",
      prompt: "test",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onProcessing,
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(onProcessing).not.toHaveBeenCalled();
    globalThis.fetch = originalFetch;
  });
});
