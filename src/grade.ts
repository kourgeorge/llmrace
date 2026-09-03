/**
 * Speed grade classification for LLM benchmark results.
 *
 * Maps TPS (tokens per second) to a human-friendly tier label + emoji.
 * Thresholds are calibrated to real-world provider speeds:
 *   - Cerebras/Groq routinely hit 500-3000+ tok/s → Kachow!
 *   - Fast open-model providers hit 200-499        → Ludicrous Speed
 *   - Frontier models (GPT-4o, Claude) hit 50-199  → Warp Drive / Cruising
 *   - Slow or rate-limited endpoints < 50          → Rush Hour
 */

export interface SpeedGrade {
  label: string;
  emoji: string;
  /** 1 = highest tier. Useful for sorting or comparison. */
  tier: number;
  /** CSS-friendly color for the grade badge. */
  color: string;
}

const GRADES: readonly SpeedGrade[] = [
  { label: "Kachow!",        emoji: "🏎️", tier: 1, color: "#fbbf24" },
  { label: "Ludicrous Speed", emoji: "⚡",  tier: 2, color: "#a78bfa" },
  { label: "Warp Drive",      emoji: "🚀", tier: 3, color: "#34d399" },
  { label: "Cruising",        emoji: "🏃", tier: 4, color: "#60a5fa" },
  { label: "Rush Hour",       emoji: "🐌", tier: 5, color: "#94a3b8" },
] as const;

const THRESHOLDS = [500, 200, 100, 50] as const;

export function getSpeedGrade(tps: number): SpeedGrade {
  for (let i = 0; i < THRESHOLDS.length; i++) {
    if (tps >= THRESHOLDS[i]) return GRADES[i];
  }
  return GRADES[GRADES.length - 1];
}

/** All available grades, ordered from highest to lowest tier. */
export const ALL_GRADES: readonly SpeedGrade[] = GRADES;
