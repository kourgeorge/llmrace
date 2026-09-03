import { describe, it, expect, vi, beforeEach } from "vitest";
import { kimiAdapter } from "../../src/providers/kimi";

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

describe("kimi-adapter", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the primary Moonshot AI endpoint (api.moonshot.ai) with correct headers", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
      ]),
    });
    globalThis.fetch = fetchSpy;

    const abort = new AbortController();
    await kimiAdapter.stream({
      apiKey: "kimi-test-key",
      model: "moonshot-v1-8k",
      prompt: "Hi",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.moonshot.ai/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer kimi-test-key",
          "Content-Type": "application/json",
        }),
      })
    );

    globalThis.fetch = originalFetch;
  });

  it("falls back to api.moonshot.cn if api.moonshot.ai encounters a network error", async () => {
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.includes("api.moonshot.ai")) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return Promise.resolve({
        ok: true,
        body: createSSEStream([
          JSON.stringify({ choices: [{ delta: { content: "Fallback OK" } }] }),
        ]),
      });
    });
    globalThis.fetch = fetchSpy;

    const chunks: string[] = [];
    const abort = new AbortController();

    await kimiAdapter.stream({
      apiKey: "kimi-test-key",
      model: "moonshot-v1-8k",
      prompt: "Hello",
      onChunk: (c) => chunks.push(c),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "https://api.moonshot.ai/v1/chat/completions",
      expect.anything()
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "https://api.moonshot.cn/v1/chat/completions",
      expect.anything()
    );
    expect(chunks).toEqual(["Fallback OK"]);

    globalThis.fetch = originalFetch;
  });

  it("does NOT fallback on HTTP error (e.g. 401 Invalid Key or 429 Rate Limit)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "Invalid API key" } }),
    });
    globalThis.fetch = fetchSpy;

    const onError = vi.fn();
    const abort = new AbortController();

    await kimiAdapter.stream({
      apiKey: "invalid-key",
      model: "moonshot-v1-8k",
      prompt: "Hello",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError,
      signal: abort.signal,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("Invalid API key"),
    }));

    globalThis.fetch = originalFetch;
  });

  it("handles aborted signal without triggering fallback", async () => {
    const abort = new AbortController();
    abort.abort();

    const fetchSpy = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));
    globalThis.fetch = fetchSpy;

    const onError = vi.fn();

    await kimiAdapter.stream({
      apiKey: "kimi-test-key",
      model: "moonshot-v1-8k",
      prompt: "Hello",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError,
      signal: abort.signal,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // User aborts should be handled silently without calling onError
    expect(onError).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  it("parses SSE chunks and usage statistics correctly", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hello " } }] }),
        JSON.stringify({ choices: [{ delta: { content: "World" } }] }),
        JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
      ]),
    });

    const chunks: string[] = [];
    const onUsage = vi.fn();
    const abort = new AbortController();

    await kimiAdapter.stream({
      apiKey: "kimi-test-key",
      model: "moonshot-v1-8k",
      prompt: "Hello",
      onChunk: (c) => chunks.push(c),
      onFirstToken: vi.fn(),
      onUsage,
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(chunks).toEqual(["Hello ", "World"]);
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 5 });

    globalThis.fetch = originalFetch;
  });

  it("strips kimi/ prefix from model id", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Test" } }] }),
      ]),
    });
    globalThis.fetch = fetchSpy;

    const abort = new AbortController();
    await kimiAdapter.stream({
      apiKey: "kimi-test-key",
      model: "kimi/moonshot-v1-32k",
      prompt: "Hello",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.moonshot.ai/v1/chat/completions",
      expect.objectContaining({
        body: expect.stringContaining('"model":"moonshot-v1-32k"'),
      })
    );

    globalThis.fetch = originalFetch;
  });
});
