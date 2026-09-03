import type { ProviderAdapter } from "../providers/types";

/**
 * Race Mode — multi-lane parallel LLM benchmark.
 *
 * Pure types only. No DOM, no Preact, no fetch. Safe to unit-test in node.
 */

/** A single racer's configuration. `laneId` is the stable identity. */
export interface RaceConfig {
  laneId: string;
  providerId: string;
  modelId: string;
  apiKey: string;
  /** Only used for the `local` provider. */
  baseUrl?: string;
  pricing?: {
    input: number;
    output: number;
  };
}

/** Live state for one lane, surfaced to the UI on every update. */
export interface LaneState {
  laneId: string;
  providerId: string;
  modelId: string;
  status: LaneStatus;
  /** Tokens/sec, null until first token + a chunk or usage arrives. */
  tps: number | null;
  /** Time-to-first-token in ms, null until first token. */
  ttft: number | null;
  /** Total time in ms, null until the lane finishes. */
  ttlt: number | null;
  /** Output token count (from usage if available, else estimated). */
  tokenCount: number;
  /** Input token count, null until usage arrives. */
  inputTokens: number | null;
  /** Output token count from usage, null until usage arrives. */
  outputTokens: number | null;
  /** Accumulated streamed text (capped for UI memory). */
  text: string;
  /** True when the provider signalled upstream processing/queueing. */
  providerQueued: boolean;
  /** 1-based finish rank (1 = first to finish). Null until ranked. */
  finishRank: number | null;
  /** Present when status === "error". */
  error?: string;
  pricing?: {
    input: number;
    output: number;
  };
}

export type LaneStatus = "idle" | "running" | "done" | "error";

/** Final, ranked result for one lane. */
export interface RaceResult {
  laneId: string;
  providerId: string;
  modelId: string;
  finishRank: number;
  tps: number | null;
  ttft: number | null;
  ttlt: number | null;
  tokenCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  error?: string;
  pricing?: {
    input: number;
    output: number;
  };
}

/** Callbacks the runner emits. UI wires these to setState. */
export interface RaceCallbacks {
  /** Fired on any state change for a lane (chunk, first token, finish, error). */
  onLaneUpdate: (lane: LaneState) => void;
  /** Fired once when a lane finishes, with its assigned finish rank. */
  onLaneFinish: (lane: LaneState, rank: number) => void;
  /** Fired once when every lane has reached done/error. */
  onAllDone: (results: RaceResult[]) => void;
}

/** Map of providerId -> adapter. Injected so tests can pass mocks. */
export type AdapterRegistry = Record<string, ProviderAdapter>;

/** Handle returned by runRace; lets the caller abort all lanes. */
export interface RaceHandle {
  abort: () => void;
}

/**
 * Classic race palette, colorblind-aware. Lane index 0..N maps to these.
 * McQueen red, Sally blue, Chick Hicks green.
 */
export const LANE_COLORS: ReadonlyArray<{ id: string; hex: string; label: string }> = [
  { id: "mcqueen", hex: "#E10600", label: "McQueen" },
  { id: "sally", hex: "#1E90FF", label: "Sally" },
  { id: "chick", hex: "#43A047", label: "Chick" },
];

/** Minimum lanes a race can have — the starting count for new users. */
export const MIN_RACE_LANES = 2;
/** Maximum lanes a race can have — capped by the palette and UI width. */
export const MAX_RACE_LANES = LANE_COLORS.length;

/** Cap streamed text stored in LaneState to avoid unbounded memory in long races. */
export const MAX_LANE_TEXT_CHARS = 2000;
