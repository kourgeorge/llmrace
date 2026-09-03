import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseLaneSpec,
  resolveApiKey,
  formatTable,
  isBuffered,
  effectiveTps,
  withNonce,
  median,
  aggregateLane,
  formatAggregateTable,
} from "../../scripts/bench";
import type { RaceResult } from "../../src/race/types";

describe("parseLaneSpec", () => {
  it("splits provider:model", () => {
    expect(parseLaneSpec("groq:llama-3.3-70b-versatile")).toEqual({
      providerId: "groq",
      modelId: "llama-3.3-70b-versatile",
    });
  });

  it("keeps everything after the first colon as the model id", () => {
    expect(parseLaneSpec("openrouter:anthropic/claude-3.5-sonnet")).toEqual({
      providerId: "openrouter",
      modelId: "anthropic/claude-3.5-sonnet",
    });
    expect(parseLaneSpec("local:some:weird:model")).toEqual({
      providerId: "local",
      modelId: "some:weird:model",
    });
  });

  it("throws a readable error when there is no colon", () => {
    expect(() => parseLaneSpec("groq-llama")).toThrow(/provider:model/);
  });

  it("throws when either side is empty", () => {
    expect(() => parseLaneSpec(":model")).toThrow();
    expect(() => parseLaneSpec("provider:")).toThrow();
  });
});

describe("resolveApiKey", () => {
  const ENV_KEY = "GROQ_API_KEY";
  const original = process.env[ENV_KEY];

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("prefers the explicit flag over the environment", () => {
    process.env[ENV_KEY] = "from-env";
    expect(resolveApiKey("groq", "from-flag")).toBe("from-flag");
  });

  it("falls back to the derived <PROVIDER>_API_KEY env var", () => {
    process.env[ENV_KEY] = "from-env";
    expect(resolveApiKey("groq", undefined)).toBe("from-env");
  });

  it("returns an empty string when nothing is set", () => {
    expect(resolveApiKey("groq", undefined)).toBe("");
  });
});

function makeResult(overrides: Partial<RaceResult>): RaceResult {
  return {
    laneId: overrides.laneId ?? "lane",
    providerId: overrides.providerId ?? "groq",
    modelId: overrides.modelId ?? "model",
    finishRank: overrides.finishRank ?? 1,
    tps: overrides.tps ?? null,
    ttft: overrides.ttft ?? null,
    ttlt: overrides.ttlt ?? null,
    tokenCount: overrides.tokenCount ?? 0,
    inputTokens: overrides.inputTokens ?? null,
    outputTokens: overrides.outputTokens ?? null,
    error: overrides.error,
    pricing: overrides.pricing,
  };
}

describe("formatTable", () => {
  it("ranks lanes by throughput, fastest first", () => {
    const results = [
      makeResult({ providerId: "slow", tps: 20, tokenCount: 10, finishRank: 1 }),
      makeResult({ providerId: "fast", tps: 300, tokenCount: 10, finishRank: 2 }),
    ];
    const table = formatTable(results);
    const lines = table.split("\n");
    expect(lines[1]).toContain("fast");
    expect(lines[2]).toContain("slow");
  });

  it("sorts lanes that produced no tokens last", () => {
    const results = [
      makeResult({ providerId: "broken", tps: null, tokenCount: 0, error: "boom", finishRank: 1 }),
      makeResult({ providerId: "ok", tps: 42, tokenCount: 10, finishRank: 2 }),
    ];
    const table = formatTable(results);
    const lines = table.split("\n");
    expect(lines[1]).toContain("ok");
    expect(lines[2]).toContain("broken");
  });

  it("flags a lane whose TTFT and total are nearly identical", () => {
    // Real repro: claude-opus-4-7 via a proxy that flushed the whole
    // response in one burst — ttft 8463ms, ttlt 8464ms, 134 tokens.
    const results = [makeResult({ providerId: "local", ttft: 8463, ttlt: 8464, tokenCount: 134, tps: 13400 })];
    const table = formatTable(results);
    expect(table).toContain("⚠");
    expect(table).toContain("buffered");
  });

  it("does not flag a lane with a real generation window", () => {
    const results = [makeResult({ providerId: "local", ttft: 4481, ttlt: 7835, tokenCount: 391, tps: 116.6 })];
    const table = formatTable(results);
    expect(table).not.toContain("⚠");
  });
});

describe("isBuffered", () => {
  it("flags a near-instant burst as buffered", () => {
    expect(isBuffered({ ttft: 8463, ttlt: 8464, tokenCount: 134 })).toBe(true);
  });

  it("does not flag a real generation window", () => {
    expect(isBuffered({ ttft: 4481, ttlt: 7835, tokenCount: 391 })).toBe(false);
  });

  it("does not flag when metrics are incomplete", () => {
    expect(isBuffered({ ttft: null, ttlt: 100, tokenCount: 10 })).toBe(false);
    expect(isBuffered({ ttft: 100, ttlt: null, tokenCount: 10 })).toBe(false);
  });

  it("does not flag a single-token response (TTFT naturally equals total)", () => {
    expect(isBuffered({ ttft: 100, ttlt: 101, tokenCount: 1 })).toBe(false);
  });
});

describe("effectiveTps", () => {
  it("is the same for a buffered burst as for a real generation window, given the same total time and tokens", () => {
    // A real 391-token, 3354ms-generation-window response and a hypothetical
    // buffered response with the same token count and total time should
    // agree on eff tok/s even though their `tps` fields would not.
    expect(effectiveTps({ ttlt: 7835, tokenCount: 391 })).toBeCloseTo((391 / 7835) * 1000, 5);
  });

  it("stays finite for a near-instant buffered burst instead of exploding like tps does", () => {
    const result = { ttft: 8463, ttlt: 8464, tokenCount: 134 };
    expect(isBuffered(result)).toBe(true);
    expect(effectiveTps(result)).toBeCloseTo((134 / 8464) * 1000, 5);
  });

  it("returns null when there is no total time or no tokens", () => {
    expect(effectiveTps({ ttlt: null, tokenCount: 10 })).toBeNull();
    expect(effectiveTps({ ttlt: 100, tokenCount: 0 })).toBeNull();
  });
});

describe("withNonce", () => {
  it("leaves the prompt untouched when nonce is null (--static-prompt)", () => {
    expect(withNonce("Say Hello World.", null)).toBe("Say Hello World.");
  });

  it("appends a distinguishable marker so two runs never send byte-identical requests", () => {
    const a = withNonce("Say Hello World.", "aaa111");
    const b = withNonce("Say Hello World.", "bbb222");
    expect(a).not.toBe(b);
    expect(a.startsWith("Say Hello World.")).toBe(true);
    expect(a).toContain("aaa111");
  });
});

describe("median", () => {
  it("returns null for an empty list", () => {
    expect(median([])).toBeNull();
  });

  it("returns the middle value for an odd-length list", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the two middle values for an even-length list", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("aggregateLane", () => {
  it("computes median/min/max and buffered/success counts across runs", () => {
    const results = [
      makeResult({ ttft: 100, ttlt: 200, tps: 50, tokenCount: 10 }),
      makeResult({ ttft: 300, ttlt: 310, tps: 9000, tokenCount: 90 }), // buffered burst
      makeResult({ ttft: null, ttlt: null, tps: null, tokenCount: 0, error: "boom" }), // failed run
    ];
    const agg = aggregateLane("lane", results);
    expect(agg.runs).toBe(3);
    expect(agg.successCount).toBe(2);
    expect(agg.bufferedCount).toBe(1);
    expect(agg.ttft.median).toBe(200);
    expect(agg.tps.min).toBe(50);
    expect(agg.tps.max).toBe(9000);
    // eff tok/s should stay in a sane range even though the buffered run's
    // raw tps (9000) is wildly inflated.
    expect(agg.effTps.max).toBeLessThan(1000);
  });

  it("reports zero successes when every run failed", () => {
    const results = [
      makeResult({ ttft: null, ttlt: null, tps: null, tokenCount: 0, error: "boom" }),
      makeResult({ ttft: null, ttlt: null, tps: null, tokenCount: 0, error: "boom" }),
    ];
    const agg = aggregateLane("lane", results);
    expect(agg.successCount).toBe(0);
    expect(agg.tps.median).toBeNull();
  });
});

describe("formatAggregateTable", () => {
  it("ranks lanes by median throughput and flags buffered lanes", () => {
    const fast = aggregateLane("fast", [makeResult({ providerId: "fast", ttft: 100, ttlt: 105, tps: 9000, tokenCount: 50 })]);
    const slow = aggregateLane("slow", [makeResult({ providerId: "slow", ttft: 100, ttlt: 900, tps: 60, tokenCount: 50 })]);
    const table = formatAggregateTable([slow, fast]);
    const lines = table.split("\n");
    expect(lines[1]).toContain("fast");
    expect(lines[2]).toContain("slow");
    expect(table).toContain("⚠");
  });
});
