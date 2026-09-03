import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireworksAdapter } from "../../src/providers/fireworks";

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

describe("fireworks-adapter", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the Fireworks AI endpoint with correct headers", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
      ]),
    });
    globalThis.fetch = fetchSpy;

    const abort = new AbortController();
    await fireworksAdapter.stream({
      apiKey: "fw-test",
      model: "accounts/fireworks/models/llama-v3p1-8b-instruct",
      prompt: "Hello",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.fireworks.ai/inference/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer fw-test",
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

    await fireworksAdapter.stream({
      apiKey: "fw-test",
      model: "accounts/fireworks/models/llama-v3p1-8b-instruct",
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

    await fireworksAdapter.stream({
      apiKey: "fw-test",
      model: "accounts/fireworks/models/llama-v3p1-8b-instruct",
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

    await fireworksAdapter.stream({
      apiKey: "bad-key",
      model: "accounts/fireworks/models/llama-v3p1-8b-instruct",
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

    await fireworksAdapter.stream({
      apiKey: "fw-test",
      model: "accounts/fireworks/models/llama-v3p1-8b-instruct",
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

    await fireworksAdapter.stream({
      apiKey: "fw-test",
      model: "accounts/fireworks/models/llama-v3p1-8b-instruct",
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

  it("strips fireworks/ prefix from model id", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
      ]),
    });
    globalThis.fetch = fetchSpy;

    const abort = new AbortController();
    await fireworksAdapter.stream({
      apiKey: "fw-test",
      model: "fireworks/accounts/fireworks/models/llama-v3p1-8b-instruct",
      prompt: "test",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(callBody.model).toBe("accounts/fireworks/models/llama-v3p1-8b-instruct");
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

    await fireworksAdapter.stream({
      apiKey: "fw-test",
      model: "accounts/fireworks/models/llama-v3p1-8b-instruct",
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
