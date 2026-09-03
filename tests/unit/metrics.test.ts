import { describe, it, expect } from "vitest";
import { createMetricsTracker } from "../../src/metrics";

describe("metrics", () => {
  it("TTFT is null before recordFirstToken", () => {
    const tracker = createMetricsTracker("openai", "gpt-4o", 10);
    tracker.start();
    tracker.recordChunk("hello");
    const m = tracker.getMetrics();
    expect(m.ttft).toBeNull();
  });

  it("TTFT is set after recordFirstToken", async () => {
    const tracker = createMetricsTracker("openai", "gpt-4o", 10);
    tracker.start();
    await new Promise((r) => setTimeout(r, 20));
    tracker.recordFirstToken();
    const m = tracker.getMetrics();
    expect(m.ttft).not.toBeNull();
    expect(m.ttft).toBeGreaterThanOrEqual(15);
  });

  it("tokensPerSecond is calculated correctly after multiple recordChunk calls", async () => {
    const tracker = createMetricsTracker("openai", "gpt-4o", 10);
    tracker.start();
    tracker.recordFirstToken();
    tracker.recordChunk("hello world foo bar");
    tracker.recordChunk("baz qux quux corge");
    const m = tracker.getMetrics();
    expect(m.tokenCount).toBeGreaterThan(0);
    expect(m.provider).toBe("openai");
    expect(m.model).toBe("gpt-4o");
    expect(m.promptLength).toBe(10);
  });

  it("getMetrics is idempotent", () => {
    const tracker = createMetricsTracker("openai", "gpt-4o", 5);
    tracker.start();
    tracker.recordChunk("test");
    tracker.finish();
    const m1 = tracker.getMetrics();
    const m2 = tracker.getMetrics();
    expect(m1.ttft).toBe(m2.ttft);
    expect(m1.ttlt).toBe(m2.ttlt);
    expect(m1.tokenCount).toBe(m2.tokenCount);
  });

  it("finish sets ttlt", async () => {
    const tracker = createMetricsTracker("anthropic", "claude", 20);
    tracker.start();
    await new Promise((r) => setTimeout(r, 10));
    tracker.finish();
    const m = tracker.getMetrics();
    expect(m.ttlt).not.toBeNull();
    expect(m.ttlt).toBeGreaterThanOrEqual(5);
  });

  it("inputTokens and outputTokens are null before recordUsage", () => {
    const tracker = createMetricsTracker("openai", "gpt-4o", 10);
    tracker.start();
    tracker.recordChunk("hello world");
    const m = tracker.getMetrics();
    expect(m.inputTokens).toBeNull();
    expect(m.outputTokens).toBeNull();
  });

  it("recordUsage sets inputTokens, outputTokens, and overrides tokenCount to output", () => {
    const tracker = createMetricsTracker("openai", "gpt-4o", 10);
    tracker.start();
    tracker.recordChunk("hello world");
    tracker.recordUsage(15, 42);
    const m = tracker.getMetrics();
    expect(m.inputTokens).toBe(15);
    expect(m.outputTokens).toBe(42);
    expect(m.tokenCount).toBe(42);
  });

  it("recordUsage updates tokensPerSecond to use output tokens", async () => {
    const tracker = createMetricsTracker("openai", "gpt-4o", 10);
    tracker.start();
    tracker.recordFirstToken();
    await new Promise((r) => setTimeout(r, 50));
    tracker.recordUsage(10, 100);
    tracker.finish();
    const m = tracker.getMetrics();
    expect(m.tokensPerSecond).not.toBeNull();
    expect(m.tokensPerSecond!).toBeGreaterThan(0);
  });
});
