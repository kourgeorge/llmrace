import { describe, it, expect } from "vitest";
import { rankByTps, rankByFinish, podiumOrder, rankResults } from "../../../src/race/ranking";
import type { LaneState, RaceResult } from "../../../src/race/types";

function lane(overrides: Partial<LaneState> & { laneId: string }): LaneState {
  return {
    laneId: overrides.laneId,
    providerId: overrides.providerId ?? "openai",
    modelId: overrides.modelId ?? "gpt-4o",
    status: overrides.status ?? "done",
    tps: overrides.tps ?? null,
    ttft: overrides.ttft ?? null,
    ttlt: overrides.ttlt ?? null,
    tokenCount: overrides.tokenCount ?? 10,
    inputTokens: overrides.inputTokens ?? null,
    outputTokens: overrides.outputTokens ?? null,
    text: overrides.text ?? "",
    providerQueued: overrides.providerQueued ?? false,
    finishRank: overrides.finishRank ?? null,
    error: overrides.error,
  };
}

describe("rankByTps", () => {
  it("sorts by tps descending", () => {
    const lanes = [
      lane({ laneId: "a", tps: 50 }),
      lane({ laneId: "b", tps: 120 }),
      lane({ laneId: "c", tps: 80 }),
    ];
    const ranked = rankByTps(lanes);
    expect(ranked.map((l) => l.laneId)).toEqual(["b", "c", "a"]);
  });

  it("puts null tps last", () => {
    const lanes = [
      lane({ laneId: "a", tps: null }),
      lane({ laneId: "b", tps: 30 }),
    ];
    const ranked = rankByTps(lanes);
    expect(ranked.map((l) => l.laneId)).toEqual(["b", "a"]);
  });

  it("puts lanes that produced no tokens last, even with high tps", () => {
    const lanes = [
      lane({ laneId: "a", tps: 999, tokenCount: 0, status: "error" }),
      lane({ laneId: "b", tps: 10, tokenCount: 5 }),
    ];
    const ranked = rankByTps(lanes);
    expect(ranked.map((l) => l.laneId)).toEqual(["b", "a"]);
  });

  it("does not mutate input", () => {
    const lanes = [lane({ laneId: "a", tps: 1 }), lane({ laneId: "b", tps: 2 })];
    rankByTps(lanes);
    expect(lanes.map((l) => l.laneId)).toEqual(["a", "b"]);
  });
});

describe("rankByFinish", () => {
  it("sorts by ttlt ascending (fastest finish first)", () => {
    const lanes = [
      lane({ laneId: "a", ttlt: 3000 }),
      lane({ laneId: "b", ttlt: 1000 }),
      lane({ laneId: "c", ttlt: 2000 }),
    ];
    const ranked = rankByFinish(lanes);
    expect(ranked.map((l) => l.laneId)).toEqual(["b", "c", "a"]);
  });

  it("breaks ttlt ties by tps descending", () => {
    const lanes = [
      lane({ laneId: "a", ttlt: 1000, tps: 50 }),
      lane({ laneId: "b", ttlt: 1000, tps: 120 }),
    ];
    const ranked = rankByFinish(lanes);
    expect(ranked.map((l) => l.laneId)).toEqual(["b", "a"]);
  });

  it("puts null ttlt last", () => {
    const lanes = [
      lane({ laneId: "a", ttlt: null }),
      lane({ laneId: "b", ttlt: 5000 }),
    ];
    const ranked = rankByFinish(lanes);
    expect(ranked.map((l) => l.laneId)).toEqual(["b", "a"]);
  });

  it("puts non-raced lanes last regardless of ttlt", () => {
    const lanes = [
      lane({ laneId: "a", ttlt: 100, tokenCount: 0, status: "error" }),
      lane({ laneId: "b", ttlt: 9999, tokenCount: 1 }),
    ];
    const ranked = rankByFinish(lanes);
    expect(ranked.map((l) => l.laneId)).toEqual(["b", "a"]);
  });
});

describe("podiumOrder", () => {
  it("is an alias for rankByFinish", () => {
    const lanes = [
      lane({ laneId: "a", ttlt: 3000, tps: 50 }),
      lane({ laneId: "b", ttlt: 1000, tps: 30 }),
      lane({ laneId: "c", ttlt: 2000, tps: 80 }),
    ];
    expect(podiumOrder(lanes).map((l) => l.laneId)).toEqual(rankByFinish(lanes).map((l) => l.laneId));
  });

  it("returns all lanes including errored ones", () => {
    const lanes = [
      lane({ laneId: "a", ttlt: 1000, tps: 30 }),
      lane({ laneId: "b", ttlt: null, status: "error", tokenCount: 0, error: "boom" }),
      lane({ laneId: "c", ttlt: 2000, tps: 80 }),
    ];
    const podium = podiumOrder(lanes);
    expect(podium).toHaveLength(3);
    expect(podium[2].laneId).toBe("b");
  });
});

describe("rankResults", () => {
  function result(overrides: Partial<RaceResult> & { laneId: string }): RaceResult {
    return {
      laneId: overrides.laneId,
      providerId: overrides.providerId ?? "openai",
      modelId: overrides.modelId ?? "gpt-4o",
      finishRank: overrides.finishRank ?? 1,
      tps: overrides.tps ?? null,
      ttft: overrides.ttft ?? null,
      ttlt: overrides.ttlt ?? null,
      tokenCount: overrides.tokenCount ?? 10,
      inputTokens: overrides.inputTokens ?? null,
      outputTokens: overrides.outputTokens ?? null,
      error: overrides.error,
    };
  }

  it("sorts by finishRank ascending, raced first", () => {
    const results = [
      result({ laneId: "a", finishRank: 3, tokenCount: 5 }),
      result({ laneId: "b", finishRank: 1, tokenCount: 5 }),
      result({ laneId: "c", finishRank: 2, tokenCount: 5 }),
    ];
    const ranked = rankResults(results);
    expect(ranked.map((r) => r.laneId)).toEqual(["b", "c", "a"]);
  });

  it("puts zero-token results last regardless of finishRank", () => {
    const results = [
      result({ laneId: "a", finishRank: 1, tokenCount: 0, error: "no tokens" }),
      result({ laneId: "b", finishRank: 2, tokenCount: 5 }),
    ];
    const ranked = rankResults(results);
    expect(ranked.map((r) => r.laneId)).toEqual(["b", "a"]);
  });
});
