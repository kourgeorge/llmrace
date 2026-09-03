import { describe, it, expect, vi, beforeEach } from "vitest";
import { anthropicAdapter } from "../../src/providers/anthropic";

function createSSEStream(events: Array<{ type: string; [key: string]: unknown }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const sseData = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseData));
      controller.close();
    },
  });
}

describe("anthropic-adapter", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls correct endpoint with correct headers", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
      ]),
    });
    globalThis.fetch = fetchSpy;

    const abort = new AbortController();
    await anthropicAdapter.stream({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-6",
      prompt: "Hello",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "sk-ant-test",
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        }),
      })
    );

    globalThis.fetch = originalFetch;
  });

  it("parses content_block_delta events and calls onChunk", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        { type: "message_start", message: { id: "msg_1" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "World" } },
        { type: "message_stop" },
      ]),
    });

    const chunks: string[] = [];
    const abort = new AbortController();

    await anthropicAdapter.stream({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-6",
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
        { type: "content_block_delta", delta: { type: "text_delta", text: "A" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "B" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "C" } },
      ]),
    });

    const onFirstToken = vi.fn();
    const abort = new AbortController();

    await anthropicAdapter.stream({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-6",
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
      new Response(JSON.stringify({ error: { message: "Authentication failed" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );

    const onError = vi.fn();
    const abort = new AbortController();

    await anthropicAdapter.stream({
      apiKey: "bad-key",
      model: "claude-sonnet-4-6",
      prompt: "test",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError,
      signal: abort.signal,
    });

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "Invalid API key. Please check your Anthropic API key and try again.",
    }));
    globalThis.fetch = originalFetch;
  });

  it("respects AbortSignal", async () => {
    const abort = new AbortController();
    abort.abort();

    const onError = vi.fn();
    const onDone = vi.fn();

    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));

    await anthropicAdapter.stream({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-6",
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

  it("parses usage from message_start and message_delta and calls onUsage", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 25 } } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
        { type: "message_delta", usage: { output_tokens: 8 } },
      ]),
    });

    const onUsage = vi.fn();
    const abort = new AbortController();

    await anthropicAdapter.stream({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-6",
      prompt: "test",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onUsage,
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 25, outputTokens: 8 });
    globalThis.fetch = originalFetch;
  });

  it("does not call onUsage when usage events are missing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
      ]),
    });

    const onUsage = vi.fn();
    const abort = new AbortController();

    await anthropicAdapter.stream({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-6",
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
