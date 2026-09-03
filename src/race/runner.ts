import { createMetricsTracker } from "../metrics";
import { createOpenAICompatibleAdapter, normalizeBaseURL } from "../providers/openaiCompatible";
import { LOCAL_PROVIDER_ID } from "../config";
import type { ProviderAdapter, StreamParams } from "../providers/types";
import type {
  RaceConfig,
  LaneState,
  RaceResult,
  RaceCallbacks,
  AdapterRegistry,
  RaceHandle,
} from "./types";
import { MAX_LANE_TEXT_CHARS } from "./types";

/**
 * Resolve the adapter for a lane config. Local lanes build an OpenAI-compatible
 * adapter from baseUrl; everything else looks up the registry.
 */
function resolveAdapter(config: RaceConfig, adapters: AdapterRegistry): ProviderAdapter {
  if (config.providerId === LOCAL_PROVIDER_ID && config.baseUrl) {
    return createOpenAICompatibleAdapter(
      normalizeBaseURL(config.baseUrl),
      LOCAL_PROVIDER_ID,
      "Local",
    );
  }
  const adapter = adapters[config.providerId];
  if (!adapter) {
    throw new Error(`No adapter registered for provider "${config.providerId}"`);
  }
  return adapter;
}

function makeInitialLaneState(config: RaceConfig): LaneState {
  return {
    laneId: config.laneId,
    providerId: config.providerId,
    modelId: config.modelId,
    status: "idle",
    tps: null,
    ttft: null,
    ttlt: null,
    tokenCount: 0,
    inputTokens: null,
    outputTokens: null,
    text: "",
    providerQueued: false,
    finishRank: null,
    pricing: config.pricing,
  };
}

function toResult(lane: LaneState): RaceResult {
  return {
    laneId: lane.laneId,
    providerId: lane.providerId,
    modelId: lane.modelId,
    finishRank: lane.finishRank ?? 0,
    tps: lane.tps,
    ttft: lane.ttft,
    ttlt: lane.ttlt,
    tokenCount: lane.tokenCount,
    inputTokens: lane.inputTokens,
    outputTokens: lane.outputTokens,
    error: lane.error,
    pricing: lane.pricing,
  };
}

/**
 * Run a multi-lane race. Fires every lane's adapter.stream() in parallel
 * against the same prompt. Emits callbacks on each lane update, finish, and
 * once when all lanes are done.
 *
 * Pure with respect to the DOM/Preact — only touches the injected adapters
 * and the provided callbacks. Adapters are passed in so tests can inject
 * mocks that emit chunks on a deterministic schedule.
 *
 * @returns a handle whose `abort()` cancels every still-running lane.
 */
export function runRace(
  configs: RaceConfig[],
  prompt: string,
  callbacks: RaceCallbacks,
  adapters: AdapterRegistry,
): RaceHandle {
  const controller = new AbortController();
  const signal = controller.signal;

  // Per-lane mutable state. Kept in a map keyed by laneId for stable identity.
  const lanes = new Map<string, LaneState>();
  for (const config of configs) {
    const state = makeInitialLaneState(config);
    lanes.set(config.laneId, state);
  }

  // Finish bookkeeping. Lanes finish in the order they call onDone/onError
  // after the first token; lanes that error before any token are ranked last.
  let nextFinishRank = 1;
  const finishedLaneIds = new Set<string>();

  function markFinished(laneId: string, asError: boolean, errorMessage?: string): void {
    const lane = lanes.get(laneId);
    if (!lane) return;
    if (finishedLaneIds.has(laneId)) return;
    finishedLaneIds.add(laneId);

    const rank = nextFinishRank++;
    lane.finishRank = rank;
    lane.status = asError ? "error" : "done";
    if (errorMessage) lane.error = errorMessage;
    callbacks.onLaneUpdate({ ...lane });
    callbacks.onLaneFinish({ ...lane }, rank);

    if (finishedLaneIds.size === configs.length) {
      const results = configs.map((c) => toResult(lanes.get(c.laneId)!));
      callbacks.onAllDone(results);
    }
  }

  // Launch every lane. We do not await here — each lane runs independently.
  for (const config of configs) {
    const lane = lanes.get(config.laneId)!;
    lane.status = "running";
    callbacks.onLaneUpdate({ ...lane });

    const tracker = createMetricsTracker(config.providerId, config.modelId, prompt.length);
    tracker.start();

    let adapter: ProviderAdapter;
    try {
      adapter = resolveAdapter(config, adapters);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markFinished(config.laneId, true, message);
      continue;
    }

    const streamParams: StreamParams = {
      apiKey: config.apiKey,
      model: config.modelId,
      prompt,
      signal,
      onChunk: (text) => {
        const l = lanes.get(config.laneId);
        if (!l) return;
        tracker.recordChunk(text);
        const m = tracker.getMetrics();
        l.tps = m.tokensPerSecond;
        l.tokenCount = m.tokenCount;
        // Cap stored text to bound memory in long races. Truncate the chunk
        // itself if it would exceed the cap, so a single huge chunk can't
        // blow past the limit.
        if (l.text.length < MAX_LANE_TEXT_CHARS) {
          const remaining = MAX_LANE_TEXT_CHARS - l.text.length;
          l.text += text.slice(0, remaining);
        }
        callbacks.onLaneUpdate({ ...l });
      },
      onFirstToken: () => {
        const l = lanes.get(config.laneId);
        if (!l) return;
        tracker.recordFirstToken();
        const m = tracker.getMetrics();
        l.ttft = m.ttft;
        l.tps = m.tokensPerSecond;
        l.providerQueued = false;
        callbacks.onLaneUpdate({ ...l });
      },
      onProcessing: () => {
        const l = lanes.get(config.laneId);
        if (!l) return;
        l.providerQueued = true;
        callbacks.onLaneUpdate({ ...l });
      },
      onUsage: (usage) => {
        const l = lanes.get(config.laneId);
        if (!l) return;
        tracker.recordUsage(usage.inputTokens, usage.outputTokens);
        const m = tracker.getMetrics();
        l.inputTokens = m.inputTokens;
        l.outputTokens = m.outputTokens;
        l.tokenCount = m.tokenCount;
        l.tps = m.tokensPerSecond;
        callbacks.onLaneUpdate({ ...l });
      },
      onDone: () => {
        const l = lanes.get(config.laneId);
        if (!l) return;
        tracker.finish();
        const m = tracker.getMetrics();
        l.ttlt = m.ttlt;
        l.tps = m.tokensPerSecond;
        l.tokenCount = m.tokenCount;
        l.inputTokens = m.inputTokens;
        l.outputTokens = m.outputTokens;
        // A lane that produced zero tokens counts as an error finish.
        if (m.tokenCount === 0) {
          markFinished(config.laneId, true, "No tokens were generated.");
        } else {
          markFinished(config.laneId, false);
        }
      },
      onError: (err) => {
        const l = lanes.get(config.laneId);
        if (!l) return;
        tracker.finish();
        const m = tracker.getMetrics();
        l.ttlt = m.ttlt;
        l.tps = m.tokensPerSecond;
        l.tokenCount = m.tokenCount;
        // If the lane produced tokens before erroring, still count it as a
        // completed run (ranked by finish order); otherwise a hard error.
        const message = err.message || String(err);
        if (m.tokenCount > 0) {
          markFinished(config.laneId, false, message);
        } else {
          markFinished(config.laneId, true, message);
        }
      },
    };

    // Fire and forget; the adapter handles its own errors via onError.
    // Swallow rejections so an unhandled promise doesn't crash the page —
    // errors are already routed through onError -> markFinished.
    adapter.stream(streamParams).catch(() => {
      // Defensive: if stream() itself threw without calling onError, ensure
      // the lane is marked finished so onAllDone still fires.
      const l = lanes.get(config.laneId);
      if (l && !finishedLaneIds.has(config.laneId)) {
        markFinished(config.laneId, true, "Stream threw unexpectedly.");
      }
    });
  }

  return {
    abort: () => {
      controller.abort();
      // Mark any still-running lanes as finished (error: aborted) so the
      // caller gets a terminal onAllDone and the UI doesn't hang.
      for (const config of configs) {
        if (!finishedLaneIds.has(config.laneId)) {
          markFinished(config.laneId, true, "Aborted.");
        }
      }
    },
  };
}
