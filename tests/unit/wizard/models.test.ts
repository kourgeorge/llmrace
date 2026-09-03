import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDERS } from "../../../src/config";
import { fetchModels } from "../../../src/wizard/models";

describe("fetchModels", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses an OpenAI-shaped { data: [{ id }] } body", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "llama-3.3-70b-versatile" }, { id: "llama-3.1-8b-instant" }],
      }),
    });
    globalThis.fetch = fetchSpy;

    const ids = await fetchModels(PROVIDERS.groq.name, "gsk-test", PROVIDERS.groq.baseUrl!);

    expect(ids).toEqual(["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]);
    expect(fetchSpy).toHaveBeenCalledWith(
      `${PROVIDERS.groq.baseUrl}/models`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer gsk-test" }),
      })
    );

    globalThis.fetch = originalFetch;
  });

  it("sends x-api-key and anthropic-version instead of a Bearer token for Anthropic", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "claude-sonnet-5" }] }),
    });
    globalThis.fetch = fetchSpy;

    const ids = await fetchModels(PROVIDERS.anthropic.name, "sk-ant-test", PROVIDERS.anthropic.baseUrl!);

    expect(ids).toEqual(["claude-sonnet-5"]);
    const [, init] = fetchSpy.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers).toEqual({
      "x-api-key": "sk-ant-test",
      "anthropic-version": "2023-06-01",
    });
    expect(init.headers.Authorization).toBeUndefined();

    globalThis.fetch = originalFetch;
  });

  it("returns [] on a non-200 response (e.g. 401)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    const ids = await fetchModels(PROVIDERS.openai.name, "bad-key", PROVIDERS.openai.baseUrl!);

    expect(ids).toEqual([]);
    globalThis.fetch = originalFetch;
  });

  it("returns [] on a network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    const ids = await fetchModels(PROVIDERS.openai.name, "sk-test", PROVIDERS.openai.baseUrl!);

    expect(ids).toEqual([]);
    globalThis.fetch = originalFetch;
  });

  it("returns [] on a body that doesn't match the expected shape", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: "not what we expected" }),
    });

    const ids = await fetchModels(PROVIDERS.openai.name, "sk-test", PROVIDERS.openai.baseUrl!);

    expect(ids).toEqual([]);
    globalThis.fetch = originalFetch;
  });

  it("returns [] when the body isn't valid JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });

    const ids = await fetchModels(PROVIDERS.openai.name, "sk-test", PROVIDERS.openai.baseUrl!);

    expect(ids).toEqual([]);
    globalThis.fetch = originalFetch;
  });

  it("skips entries whose id isn't a string", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "good-model" }, { id: 42 }, { notAnId: true }] }),
    });

    const ids = await fetchModels(PROVIDERS.openai.name, "sk-test", PROVIDERS.openai.baseUrl!);

    expect(ids).toEqual(["good-model"]);
    globalThis.fetch = originalFetch;
  });
});
