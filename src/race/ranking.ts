import type { LaneState, RaceResult } from "./types";

/**
 * Pure ranking helpers. No side effects, no DOM — fully unit-testable.
 *
 * Two ranking dimensions are useful:
 *  - By finish time (who crossed the line first) — the "race" ranking.
 *  - By throughput (who was actually fastest per token) — the "speed" ranking.
 *
 * The MVP podium uses finish order with TPS as the tiebreaker, because that
 * matches the visual race metaphor. The other helpers are exposed for the
 * share card / future "speed king" view.
 */

/** True if a lane produced tokens (i.e. actually raced). */
function raced(lane: { tokenCount: number; status: string }): boolean {
  return lane.tokenCount > 0 && (lane.status === "done" || lane.status === "error");
}

/**
 * Rank lanes by tokens/sec, descending. Lanes with null TPS or that didn't
 * race sort last (stable). Ties keep their input order.
 */
export function rankByTps<T extends { tps: number | null; tokenCount: number; status: string }>(
  lanes: T[],
): T[] {
  return [...lanes].sort((a, b) => {
    const aRaced = raced(a);
    const bRaced = raced(b);
    if (aRaced !== bRaced) return aRaced ? -1 : 1;
    const aTps = a.tps ?? -Infinity;
    const bTps = b.tps ?? -Infinity;
    return bTps - aTps;
  });
}

/**
 * Rank lanes by total time (ttlt), ascending — fastest finisher first.
 * Lanes with null ttlt or that didn't race sort last. Ties broken by TPS.
 */
export function rankByFinish<T extends { ttlt: number | null; tps: number | null; tokenCount: number; status: string }>(
  lanes: T[],
): T[] {
  return [...lanes].sort((a, b) => {
    const aRaced = raced(a);
    const bRaced = raced(b);
    if (aRaced !== bRaced) return aRaced ? -1 : 1;
    const aTtlt = a.ttlt ?? Infinity;
    const bTtlt = b.ttlt ?? Infinity;
    if (aTtlt !== bTtlt) return aTtlt - bTtlt;
    const aTps = a.tps ?? -Infinity;
    const bTps = b.tps ?? -Infinity;
    return bTps - aTps;
  });
}

/**
 * Podium order for the MVP: finish-time primary, TPS tiebreaker. Lanes that
 * errored without producing tokens still appear (last), so the podium always
 * shows every configured lane.
 */
export function podiumOrder(lanes: LaneState[]): LaneState[] {
  return rankByFinish(lanes);
}

/**
 * Assign 1-based podium ranks to a list of RaceResults, returning a new list
 * sorted by rank. Useful for the share card / persisted results.
 */
export function rankResults(results: RaceResult[]): RaceResult[] {
  // RaceResult already has finishRank from the runner; sort by it, errors last.
  return [...results].sort((a, b) => {
    const aRaced = a.tokenCount > 0;
    const bRaced = b.tokenCount > 0;
    if (aRaced !== bRaced) return aRaced ? -1 : 1;
    return a.finishRank - b.finishRank;
  });
}
