import { describe, it, expect, vi, beforeEach } from "vitest";
import { googleAdapter } from "../../src/providers/google";

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

describe("google-adapter", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls Google's OpenAI-compatible endpoint with correct URL and Bearer auth", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
      ]),
    });
    globalThis.fetch = fetchSpy;

    const abort = new AbortController();
    await googleAdapter.stream({
      apiKey: "AIza-test-key",
      model: "gemini-2.0-flash",
      prompt: "Hello",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer AIza-test-key",
          "Content-Type": "application/json",
        }),
      })
    );

    globalThis.fetch = originalFetch;
  });

  it("sends model id and stream options in request body", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
      ]),
    });
    globalThis.fetch = fetchSpy;

    const abort = new AbortController();
    await googleAdapter.stream({
      apiKey: "AIza-test-key",
      model: "gemini-2.5-flash",
      prompt: "Hello",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    const callBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(callBody.model).toBe("gemini-2.5-flash");
    expect(callBody.stream).toBe(true);
    expect(callBody.stream_options).toEqual({ include_usage: true });

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

    await googleAdapter.stream({
      apiKey: "AIza-test-key",
      model: "gemini-2.0-flash",
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

    await googleAdapter.stream({
      apiKey: "AIza-test-key",
      model: "gemini-2.0-flash",
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

  it("handles non-401 error response with error message", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createErrorStream(400, { error: { message: "Invalid model name" } })
    );

    const onError = vi.fn();
    const abort = new AbortController();

    await googleAdapter.stream({
      apiKey: "AIza-test-key",
      model: "bad-model",
      prompt: "test",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError,
      signal: abort.signal,
    });

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "Invalid model name",
    }));
    globalThis.fetch = originalFetch;
  });

  it("handles 401 error response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createErrorStream(401, { error: { message: "API key not valid" } })
    );

    const onError = vi.fn();
    const abort = new AbortController();

    await googleAdapter.stream({
      apiKey: "bad-key",
      model: "gemini-2.0-flash",
      prompt: "test",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone: vi.fn(),
      onError,
      signal: abort.signal,
    });

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "API key not valid",
    }));
    globalThis.fetch = originalFetch;
  });

  it("respects AbortSignal", async () => {
    const abort = new AbortController();
    abort.abort();

    const onError = vi.fn();
    const onDone = vi.fn();

    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));

    await googleAdapter.stream({
      apiKey: "AIza-test-key",
      model: "gemini-2.0-flash",
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
        JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } }),
      ]),
    });

    const onUsage = vi.fn();
    const abort = new AbortController();

    await googleAdapter.stream({
      apiKey: "AIza-test-key",
      model: "gemini-2.0-flash",
      prompt: "test",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onUsage,
      onDone: vi.fn(),
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 12, outputTokens: 7 });
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

    await googleAdapter.stream({
      apiKey: "AIza-test-key",
      model: "gemini-2.0-flash",
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

  it("calls onDone with raw chunks", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream([
        JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }),
      ]),
    });

    const onDone = vi.fn();
    const abort = new AbortController();

    await googleAdapter.stream({
      apiKey: "AIza-test-key",
      model: "gemini-2.0-flash",
      prompt: "test",
      onChunk: vi.fn(),
      onFirstToken: vi.fn(),
      onDone,
      onError: vi.fn(),
      signal: abort.signal,
    });

    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({ chunks: expect.any(Array) })
    );
    globalThis.fetch = originalFetch;
  });

  it("has correct adapter id and name", () => {
    expect(googleAdapter.id).toBe("google");
    expect(googleAdapter.name).toBe("Google");
  });
});
