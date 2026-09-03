import { describe, it, expect, vi, beforeEach } from "vitest";
import { runRace } from "../../../src/race/runner";
import type { ProviderAdapter, StreamParams } from "../../../src/providers/types";
import type {
  RaceConfig,
  LaneState,
  RaceResult,
  RaceCallbacks,
  AdapterRegistry,
} from "../../../src/race/types";

/**
 * Mock adapter that emits a scripted sequence of callbacks on the next tick.
 * Each step is { delayMs, op, payload? } where op is one of:
 *   "firstToken" | "chunk" | "usage" | "processing" | "done" | "error"
 *
 * Honors AbortSignal: if aborted mid-sequence, stops emitting and returns.
 */
interface ScriptedStep {
  delayMs: number;
  op: "processing" | "firstToken" | "chunk" | "usage" | "done" | "error";
  payload?: string | { inputTokens: number; outputTokens: number } | Error;
}

function makeScriptedAdapter(id: string, steps: ScriptedStep[]): ProviderAdapter {
  return {
    id,
    name: id,
    async stream(params: StreamParams): Promise<void> {
      for (const step of steps) {
        if (params.signal.aborted) return;
        await new Promise((r) => setTimeout(r, step.delayMs));
        if (params.signal.aborted) return;
        switch (step.op) {
          case "processing":
            params.onProcessing?.();
            break;
          case "firstToken":
            params.onFirstToken();
            break;
          case "chunk":
            params.onChunk(step.payload as string);
            break;
          case "usage":
            params.onUsage?.(step.payload as { inputTokens: number; outputTokens: number });
            break;
          case "done":
            params.onDone({ chunks: [] });
            return;
          case "error":
            params.onError(step.payload as Error);
            return;
        }
      }
    },
  };
}

function makeConfigs(): RaceConfig[] {
  return [
    { laneId: "lane-1", providerId: "openai", modelId: "gpt-4o", apiKey: "k1" },
    { laneId: "lane-2", providerId: "anthropic", modelId: "claude", apiKey: "k2" },
    { laneId: "lane-3", providerId: "groq", modelId: "llama", apiKey: "k3" },
  ];
}

function makeCallbacks(): RaceCallbacks & {
  updates: LaneState[];
  finishes: { lane: LaneState; rank: number }[];
  allDone: RaceResult[] | null;
} {
  const updates: LaneState[] = [];
  const finishes: { lane: LaneState; rank: number }[] = [];
  // Use a holder so the getter returns the current value, not a snapshot
  // taken at object-creation time (closure-over-primitive pitfall).
  const state = { allDone: null as RaceResult[] | null };
  return {
    onLaneUpdate: (lane) => updates.push({ ...lane }),
    onLaneFinish: (lane, rank) => finishes.push({ lane: { ...lane }, rank }),
    onAllDone: (results) => {
      state.allDone = results;
    },
    updates,
    finishes,
    get allDone() {
      return state.allDone;
    },
  };
}

// Use fake timers so we can control timing deterministically.
beforeEach(() => {
  vi.useFakeTimers();
});

describe("runRace", () => {
  it("emits running state for every lane immediately", () => {
    const adapters: AdapterRegistry = {
      openai: makeScriptedAdapter("openai", [{ delayMs: 10, op: "chunk", payload: "hi" }, { delayMs: 5, op: "done" }]),
      anthropic: makeScriptedAdapter("anthropic", [{ delayMs: 10, op: "chunk", payload: "hi" }, { delayMs: 5, op: "done" }]),
      groq: makeScriptedAdapter("groq", [{ delayMs: 10, op: "chunk", payload: "hi" }, { delayMs: 5, op: "done" }]),
    };
    const cb = makeCallbacks();
    runRace(makeConfigs(), "hello", cb, adapters);

    const runningUpdates = cb.updates.filter((u) => u.status === "running");
    expect(runningUpdates).toHaveLength(3);
    expect(new Set(runningUpdates.map((u) => u.laneId))).toEqual(new Set(["lane-1", "lane-2", "lane-3"]));
  });

  it("ranks lanes by finish order and fires onAllDone after the last one", async () => {
    // Lane 2 finishes first (15ms), then lane 1 (30ms), then lane 3 (45ms).
    const adapters: AdapterRegistry = {
      openai: makeScriptedAdapter("openai", [
        { delayMs: 10, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: "hello" },
        { delayMs: 15, op: "done" },
      ]),
      anthropic: makeScriptedAdapter("anthropic", [
        { delayMs: 5, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: "hi" },
        { delayMs: 5, op: "done" },
      ]),
      groq: makeScriptedAdapter("groq", [
        { delayMs: 15, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: "hey" },
        { delayMs: 25, op: "done" },
      ]),
    };
    const cb = makeCallbacks();
    runRace(makeConfigs(), "hello", cb, adapters);

    await vi.advanceTimersByTimeAsync(50);

    expect(cb.finishes).toHaveLength(3);
    expect(cb.finishes.map((f) => f.lane.laneId)).toEqual(["lane-2", "lane-1", "lane-3"]);
    expect(cb.finishes.map((f) => f.rank)).toEqual([1, 2, 3]);
    expect(cb.allDone).not.toBeNull();
    expect(cb.allDone).toHaveLength(3);
  });

  it("one lane erroring does not stop the others", async () => {
    const adapters: AdapterRegistry = {
      openai: makeScriptedAdapter("openai", [{ delayMs: 5, op: "error", payload: new Error("boom") }]),
      anthropic: makeScriptedAdapter("anthropic", [
        { delayMs: 10, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: "hello" },
        { delayMs: 5, op: "done" },
      ]),
      groq: makeScriptedAdapter("groq", [
        { delayMs: 10, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: "hey" },
        { delayMs: 15, op: "done" },
      ]),
    };
    const cb = makeCallbacks();
    runRace(makeConfigs(), "hello", cb, adapters);

    await vi.advanceTimersByTimeAsync(50);

    // Lane 1 errored before producing tokens -> error finish.
    const lane1Final = cb.updates.filter((u) => u.laneId === "lane-1").at(-1)!;
    expect(lane1Final.status).toBe("error");
    expect(lane1Final.error).toBe("boom");

    // Lanes 2 and 3 still finished normally.
    const lane2Final = cb.updates.filter((u) => u.laneId === "lane-2").at(-1)!;
    const lane3Final = cb.updates.filter((u) => u.laneId === "lane-3").at(-1)!;
    expect(lane2Final.status).toBe("done");
    expect(lane3Final.status).toBe("done");

    // onAllDone still fires with all 3 results.
    expect(cb.allDone).toHaveLength(3);
  });

  it("a lane that errors after producing tokens counts as a normal finish", async () => {
    const adapters: AdapterRegistry = {
      openai: makeScriptedAdapter("openai", [
        { delayMs: 5, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: "hello world" },
        { delayMs: 5, op: "error", payload: new Error("mid-stream") },
      ]),
      anthropic: makeScriptedAdapter("anthropic", [
        { delayMs: 20, op: "firstToken" },
        { delayMs: 5, op: "done" },
      ]),
      groq: makeScriptedAdapter("groq", [
        { delayMs: 30, op: "firstToken" },
        { delayMs: 5, op: "done" },
      ]),
    };
    const cb = makeCallbacks();
    runRace(makeConfigs(), "hello", cb, adapters);

    await vi.advanceTimersByTimeAsync(50);

    const lane1Final = cb.updates.filter((u) => u.laneId === "lane-1").at(-1)!;
    // Produced tokens before erroring -> status "done", not "error".
    expect(lane1Final.status).toBe("done");
    expect(lane1Final.tokenCount).toBeGreaterThan(0);
    // Lane 1 finished first because it errored-out earliest.
    expect(lane1Final.finishRank).toBe(1);
  });

  it("abort cancels all lanes and fires onAllDone", async () => {
    const adapters: AdapterRegistry = {
      openai: makeScriptedAdapter("openai", [{ delayMs: 1000, op: "firstToken" }, { delayMs: 1000, op: "done" }]),
      anthropic: makeScriptedAdapter("anthropic", [{ delayMs: 1000, op: "firstToken" }, { delayMs: 1000, op: "done" }]),
      groq: makeScriptedAdapter("groq", [{ delayMs: 1000, op: "firstToken" }, { delayMs: 1000, op: "done" }]),
    };
    const cb = makeCallbacks();
    const handle = runRace(makeConfigs(), "hello", cb, adapters);

    // Abort before any lane finishes.
    handle.abort();

    expect(cb.allDone).not.toBeNull();
    expect(cb.allDone).toHaveLength(3);
    // Every lane should be marked as an error finish (aborted).
    for (const r of cb.allDone!) {
      expect(r.error).toBe("Aborted.");
      expect(r.finishRank).toBeGreaterThan(0);
    }
  });

  it("abort after some lanes finished still terminates the rest", async () => {
    const adapters: AdapterRegistry = {
      openai: makeScriptedAdapter("openai", [
        { delayMs: 5, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: "hi" },
        { delayMs: 5, op: "done" },
      ]),
      anthropic: makeScriptedAdapter("anthropic", [{ delayMs: 1000, op: "firstToken" }, { delayMs: 1000, op: "done" }]),
      groq: makeScriptedAdapter("groq", [{ delayMs: 1000, op: "firstToken" }, { delayMs: 1000, op: "done" }]),
    };
    const cb = makeCallbacks();
    const handle = runRace(makeConfigs(), "hello", cb, adapters);

    // Let lane 1 finish.
    await vi.advanceTimersByTimeAsync(20);
    expect(cb.finishes).toHaveLength(1);

    // Abort the remaining two.
    handle.abort();

    expect(cb.allDone).toHaveLength(3);
    const aborted = cb.allDone!.filter((r) => r.error === "Aborted.");
    expect(aborted).toHaveLength(2);
  });

  it("surfaces onProcessing as providerQueued, cleared on first token", async () => {
    const adapters: AdapterRegistry = {
      openai: makeScriptedAdapter("openai", [
        { delayMs: 5, op: "processing" },
        { delayMs: 10, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: "hi" },
        { delayMs: 5, op: "done" },
      ]),
      anthropic: makeScriptedAdapter("anthropic", [
        { delayMs: 5, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: "hi" },
        { delayMs: 5, op: "done" },
      ]),
      groq: makeScriptedAdapter("groq", [
        { delayMs: 5, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: "hi" },
        { delayMs: 5, op: "done" },
      ]),
    };
    const cb = makeCallbacks();
    runRace(makeConfigs(), "hello", cb, adapters);

    await vi.advanceTimersByTimeAsync(30);

    const lane1Updates = cb.updates.filter((u) => u.laneId === "lane-1");
    const queuedUpdate = lane1Updates.find((u) => u.providerQueued);
    expect(queuedUpdate).toBeDefined();
    const afterFirstToken = lane1Updates.filter((u) => u.ttft !== null);
    for (const u of afterFirstToken) {
      expect(u.providerQueued).toBe(false);
    }
  });

  it("records usage tokens on the lane state", async () => {
    const adapters: AdapterRegistry = {
      openai: makeScriptedAdapter("openai", [
        { delayMs: 5, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: "hello" },
        { delayMs: 5, op: "usage", payload: { inputTokens: 10, outputTokens: 42 } },
        { delayMs: 5, op: "done" },
      ]),
      anthropic: makeScriptedAdapter("anthropic", [
        { delayMs: 5, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: "hi" },
        { delayMs: 5, op: "done" },
      ]),
      groq: makeScriptedAdapter("groq", [
        { delayMs: 5, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: "hi" },
        { delayMs: 5, op: "done" },
      ]),
    };
    const cb = makeCallbacks();
    runRace(makeConfigs(), "hello", cb, adapters);

    await vi.advanceTimersByTimeAsync(30);

    const lane1Final = cb.updates.filter((u) => u.laneId === "lane-1").at(-1)!;
    expect(lane1Final.inputTokens).toBe(10);
    expect(lane1Final.outputTokens).toBe(42);
    expect(lane1Final.tokenCount).toBe(42);
  });

  it("a lane that produces zero tokens finishes as an error", async () => {
    const adapters: AdapterRegistry = {
      openai: makeScriptedAdapter("openai", [{ delayMs: 5, op: "done" }]),
      anthropic: makeScriptedAdapter("anthropic", [
        { delayMs: 5, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: "hi" },
        { delayMs: 5, op: "done" },
      ]),
      groq: makeScriptedAdapter("groq", [
        { delayMs: 5, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: "hi" },
        { delayMs: 5, op: "done" },
      ]),
    };
    const cb = makeCallbacks();
    runRace(makeConfigs(), "hello", cb, adapters);

    await vi.advanceTimersByTimeAsync(30);

    const lane1Final = cb.updates.filter((u) => u.laneId === "lane-1").at(-1)!;
    expect(lane1Final.status).toBe("error");
    expect(lane1Final.error).toBe("No tokens were generated.");
  });

  it("throws on unknown provider (and still finishes that lane + others)", async () => {
    const configs: RaceConfig[] = [
      { laneId: "lane-1", providerId: "unknown", modelId: "x", apiKey: "k" },
      { laneId: "lane-2", providerId: "anthropic", modelId: "claude", apiKey: "k" },
      { laneId: "lane-3", providerId: "groq", modelId: "llama", apiKey: "k" },
    ];
    const adapters: AdapterRegistry = {
      anthropic: makeScriptedAdapter("anthropic", [
        { delayMs: 5, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: "hi" },
        { delayMs: 5, op: "done" },
      ]),
      groq: makeScriptedAdapter("groq", [
        { delayMs: 5, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: "hi" },
        { delayMs: 5, op: "done" },
      ]),
    };
    const cb = makeCallbacks();
    runRace(configs, "hello", cb, adapters);

    await vi.advanceTimersByTimeAsync(30);

    const lane1Final = cb.updates.filter((u) => u.laneId === "lane-1").at(-1)!;
    expect(lane1Final.status).toBe("error");
    expect(lane1Final.error).toContain("unknown");
    expect(cb.allDone).toHaveLength(3);
  });

  it("caps stored text to MAX_LANE_TEXT_CHARS", async () => {
    // Emit a huge chunk that exceeds the cap.
    const bigText = "x".repeat(5000);
    const adapters: AdapterRegistry = {
      openai: makeScriptedAdapter("openai", [
        { delayMs: 5, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: bigText },
        { delayMs: 5, op: "done" },
      ]),
      anthropic: makeScriptedAdapter("anthropic", [
        { delayMs: 5, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: "hi" },
        { delayMs: 5, op: "done" },
      ]),
      groq: makeScriptedAdapter("groq", [
        { delayMs: 5, op: "firstToken" },
        { delayMs: 5, op: "chunk", payload: "hi" },
        { delayMs: 5, op: "done" },
      ]),
    };
    const cb = makeCallbacks();
    runRace(makeConfigs(), "hello", cb, adapters);

    await vi.advanceTimersByTimeAsync(30);

    const lane1Final = cb.updates.filter((u) => u.laneId === "lane-1").at(-1)!;
    expect(lane1Final.text.length).toBeLessThanOrEqual(2000);
  });
});
