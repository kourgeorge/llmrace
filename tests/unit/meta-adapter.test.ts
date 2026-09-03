import { describe, it, expect, vi, beforeEach } from "vitest";
import { metaAdapter } from "../../src/providers/meta";

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

describe("meta-adapter", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the Meta chat completions endpoint with correct headers", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
      ]),
    });
    globalThis.fetch = fetchSpy;

    const abort = new AbortController();
    await metaAdapter.stream({
      apiKey: "meta-test-key",
      model: "muse-spark-1.1",
      prompt: "Hello",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.meta.ai/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer meta-test-key",
          "Content-Type": "application/json",
        }),
      })
    );

    globalThis.fetch = originalFetch;
  });

  it("sends stream_options with include_usage in the request body", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
      ]),
    });
    globalThis.fetch = fetchSpy;

    const abort = new AbortController();
    await metaAdapter.stream({
      apiKey: "meta-test-key",
      model: "muse-spark-1.1",
      prompt: "Hello",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    const bodyArg = fetchSpy.mock.calls[0][1].body;
    const parsed = JSON.parse(bodyArg);
    expect(parsed.stream_options).toEqual({ include_usage: true });
    expect(parsed.stream).toBe(true);
    expect(parsed.model).toBe("muse-spark-1.1");

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

    await metaAdapter.stream({
      apiKey: "meta-test-key",
      model: "muse-spark-1.1",
      prompt: "Hello",
      onChunk: (c) => chunks.push(c),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(chunks).toEqual(["Hello ", "World"]);
    globalThis.fetch = originalFetch;
  });

  it("fires onFirstToken exactly once", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hello " } }] }),
        JSON.stringify({ choices: [{ delta: { content: "World" } }] }),
      ]),
    });

    const onFirstToken = vi.fn();
    const abort = new AbortController();

    await metaAdapter.stream({
      apiKey: "meta-test-key",
      model: "muse-spark-1.1",
      prompt: "Hello",
      onChunk: vi.fn(),
      onFirstToken,
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(onFirstToken).toHaveBeenCalledTimes(1);
    globalThis.fetch = originalFetch;
  });

  it("strips meta/ prefix from model id", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
      ]),
    });
    globalThis.fetch = fetchSpy;

    const abort = new AbortController();
    await metaAdapter.stream({
      apiKey: "meta-test-key",
      model: "meta/muse-spark-1.1",
      prompt: "Hello",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.meta.ai/v1/chat/completions",
      expect.objectContaining({
        body: expect.stringContaining('"model":"muse-spark-1.1"'),
      })
    );

    globalThis.fetch = originalFetch;
  });

  it("handles HTTP errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "Invalid API key" } }),
    });

    const onError = vi.fn();
    const abort = new AbortController();

    await metaAdapter.stream({
      apiKey: "bad-key",
      model: "muse-spark-1.1",
      prompt: "Hello",
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

  it("subtracts reasoning_tokens from completion_tokens in usage", async () => {
    // Meta's Muse Spark includes hidden reasoning_tokens in completion_tokens.
    // Nested accounting: total_tokens = prompt + completion (reasoning inside).
    // 19 + 1962 = 1981 — not 19 + 1962 + 1905.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 19,
            completion_tokens: 1962,
            total_tokens: 1981,
            completion_tokens_details: { reasoning_tokens: 1905 },
          },
        }),
      ]),
    });

    const onUsage = vi.fn();
    const abort = new AbortController();

    await metaAdapter.stream({
      apiKey: "meta-test-key",
      model: "muse-spark-1.1",
      prompt: "Hello",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onUsage,
      signal: abort.signal,
    });

    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 19,
      outputTokens: 57, // 1962 - 1905 reasoning tokens
    });
    globalThis.fetch = originalFetch;
  });

  it("subtracts nested reasoning even when reasoning < half of completion", async () => {
    // Nested, but reasoning is a minority of completion. total still = prompt+completion.
    // A fragile heuristic that only subtracts when reasoning is "large" would fail here.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "answer" } }] }),
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 120,
            total_tokens: 140, // 20 + 120 (reasoning nested, NOT separate)
            completion_tokens_details: { reasoning_tokens: 30 },
          },
        }),
      ]),
    });

    const onUsage = vi.fn();
    const abort = new AbortController();

    await metaAdapter.stream({
      apiKey: "meta-test-key",
      model: "muse-spark-1.1",
      prompt: "Hello",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onUsage,
      signal: abort.signal,
    });

    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 20,
      outputTokens: 90, // 120 - 30 nested reasoning
    });
    globalThis.fetch = originalFetch;
  });
});
