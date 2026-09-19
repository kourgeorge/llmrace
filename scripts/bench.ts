/**
 * Terminal benchmark CLI.
 *
 * Run with: npx tsx scripts/bench.ts --provider groq --model llama-3.3-70b-versatile
 *       or: npm run bench -- --provider groq --model llama-3.3-70b-versatile
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runRace } from "../src/race/runner";
import { getSpeedGrade } from "../src/grade";
import { providers } from "../src/providers/index";
import { PROVIDERS, LOCAL_PROVIDER_ID, envVarNameFor, resolveApiKey } from "../src/config";
import { runWizard } from "../src/wizard/index";
import type { RaceConfig, RaceResult, LaneState } from "../src/race/types";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RUNS = 1;

/**
 * Tiny ANSI colorer, scoped to one stream so stdout tables and stderr
 * progress lines each respect their own TTY-ness (e.g. `bench > out.txt`
 * keeps stdout plain while stderr progress still gets color in the terminal).
 * Honors NO_COLOR. No dependency needed for this small a surface.
 */
function colorerFor(stream: NodeJS.WriteStream) {
  const enabled = Boolean(stream.isTTY) && !process.env.NO_COLOR;
  const wrap = (code: string, text: string) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  return {
    enabled,
    bold: (s: string) => wrap("1", s),
    dim: (s: string) => wrap("2", s),
    red: (s: string) => wrap("31", s),
    green: (s: string) => wrap("32", s),
    yellow: (s: string) => wrap("33", s),
    blue: (s: string) => wrap("34", s),
    magenta: (s: string) => wrap("35", s),
    cyan: (s: string) => wrap("36", s),
    gray: (s: string) => wrap("90", s),
  };
}
const c = colorerFor(process.stdout);
const cErr = colorerFor(process.stderr);

/** Color a speed grade's label to match its tier (mirrors grade.ts's hex colors, in ANSI). */
function gradeColor(colorer: ReturnType<typeof colorerFor>, tier: number, s: string): string {
  switch (tier) {
    case 1:
      return colorer.yellow(s);
    case 2:
      return colorer.magenta(s);
    case 3:
      return colorer.green(s);
    case 4:
      return colorer.blue(s);
    default:
      return colorer.gray(s);
  }
}

const MEDALS = ["🥇", "🥈", "🥉"] as const;

/** Length of a string as it will actually render, ignoring invisible ANSI escapes. */
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex -- stripping ANSI SGR codes requires matching ESC
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Like String.padEnd, but pads based on visible (ANSI-stripped) width. */
function padEndVisible(s: string, width: number): string {
  const pad = width - visibleLength(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

/**
 * Truncates to at most `maxVisible` visible (ANSI-stripped) characters,
 * preserving embedded color codes and appending a reset so a cut mid-styled
 * segment can't bleed color into whatever gets written after it. No-ops if
 * the string already fits.
 */
function truncateVisible(s: string, maxVisible: number): string {
  // eslint-disable-next-line no-control-regex -- stripping ANSI SGR codes requires matching ESC
  const ansi = /\x1b\[[0-9;]*m/g;
  let visible = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  for (;;) {
    match = ansi.exec(s);
    const segEnd = match ? match.index : s.length;
    const segLen = segEnd - lastIndex;
    if (visible + segLen >= maxVisible) {
      const cut = lastIndex + (maxVisible - visible);
      return `${s.slice(0, cut)}\x1b[0m`;
    }
    visible += segLen;
    if (!match) return s;
    lastIndex = match.index + match[0].length;
  }
}

/**
 * ANSI "cursor up n lines," or "" when n <= 0. Most real terminals treat an
 * explicit `\x1b[0A` the same as an omitted parameter — which the CSI spec
 * defaults to 1, not 0 — so emitting it for n=0 actually moves the cursor up
 * one line instead of leaving it in place. Whenever a widget block has
 * exactly one active row (n=0 here), that turns into an extra line of
 * upward drift on every tick, eventually climbing into whatever was above
 * the block (a prior finish line, the shell prompt, the typed command).
 */
function moveUpSeq(n: number): string {
  return n > 0 ? `\x1b[${n}A` : "";
}

const GAUGE_WIDTH = 20;
/** Bar fills at this rate — just past the "Kachow!" tier onset (500), so the
 * top speed tiers still read as visually "full" rather than pegged forever. */
const GAUGE_SCALE_TPS = 600;

/** Max chars for a lane's "provider/model" label in the live widget — model
 * ids can be long (e.g. openrouter's), and an uncapped label is the main way
 * a widget row overflows a real terminal's width. */
const MAX_LABEL_CHARS = 28;

/** Caps a lane's provider/model label so widget rows stay a predictable width. */
function shortLabel(providerId: string, modelId: string): string {
  const label = `${providerId}/${modelId}`;
  return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;
}

function renderGauge(colorer: ReturnType<typeof colorerFor>, tps: number, tier: number): string {
  const filled = Math.round(Math.min(1, tps / GAUGE_SCALE_TPS) * GAUGE_WIDTH);
  return gradeColor(colorer, tier, `${"█".repeat(filled)}${"░".repeat(GAUGE_WIDTH - filled)}`);
}

/**
 * Bar + plain-English tok/s range for a finished result, e.g.
 * "[██████████████░░░░░░]  ≥500 tok/s" — shows where the number falls
 * against real-world provider speeds instead of naming a tier.
 */
function speedIndicator(colorer: ReturnType<typeof colorerFor>, tps: number | null): string {
  if (tps === null) return "";
  const grade = getSpeedGrade(tps);
  return `  [${renderGauge(colorer, tps, grade.tier)}]  ${colorer.dim(grade.rangeLabel)}`;
}

/**
 * Live speed widget for the wait on a request (a fast.com-style ticking
 * number instead of a plain "please wait"). Two phases per lane:
 *  - connecting: no token yet — a clock icon sits to the left of the track.
 *  - streaming: once the first chunk arrives, a live tok/s gauge that
 *    updates every chunk, plus a running token count and elapsed clock.
 * Draws one row per still-active lane, redrawing the whole block in place
 * each tick — a real live leaderboard rather than a single "fastest so far"
 * line. Rows stay in launch order (no reordering) so the block doesn't jitter
 * as speeds change. Finished lanes are dropped from the block on the next
 * start() (the caller prints their permanent result line separately). No-ops
 * when stderr isn't a TTY (piped output, CI, NO_COLOR).
 */
class LiveWidget {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private readonly lanes = new Map<string, LaneState>();
  private readonly single: boolean;
  /** Rows drawn on the previous tick — needed to clear the right number of lines. */
  private lastLineCount = 0;

  constructor(private readonly configs: RaceConfig[]) {
    this.single = configs.length === 1;
  }

  update(lane: LaneState): void {
    this.lanes.set(lane.laneId, lane);
  }

  start(): void {
    if (!cErr.enabled) return;
    if (this.startedAt === 0) this.startedAt = Date.now();
    this.timer = setInterval(() => this.render(), 90);
    this.render();
  }

  /** Still-running lanes, in original launch order. */
  private activeLanes(): LaneState[] {
    const active: LaneState[] = [];
    for (const config of this.configs) {
      const lane = this.lanes.get(config.laneId);
      if (lane && lane.status !== "done" && lane.status !== "error") active.push(lane);
    }
    return active;
  }

  private rowFor(lane: LaneState, seconds: string): string {
    const laneLabel = shortLabel(lane.providerId, lane.modelId);
    if (lane.tps === null || lane.tokenCount === 0) {
      const width = 14;
      const track = "·".repeat(width);
      return `🕐 ${cErr.cyan(`[${track}]`)}  ${cErr.dim(`racing ${laneLabel}…`)}  ${cErr.dim(`${seconds}s`)}`;
    }
    const who = this.single ? "" : `  ${cErr.dim(laneLabel)}`;
    const grade = getSpeedGrade(lane.tps);
    const gauge = renderGauge(cErr, lane.tps, grade.tier);
    const speedLabel = cErr.bold(gradeColor(cErr, grade.tier, `${lane.tps.toFixed(1)} tok/s`));
    return `${grade.emoji} [${gauge}] ${speedLabel}${who}  ${cErr.dim(`${lane.tokenCount} tok · ${seconds}s`)}`;
  }

  private render(): void {
    const elapsedMs = Date.now() - this.startedAt;
    const seconds = (elapsedMs / 1000).toFixed(1);
    // Hard safety net: even with shortLabel() capping the variable-length part
    // of a row, a narrow terminal (or double-width emoji glyphs) could still
    // push a row past the actual column count, causing it to soft-wrap onto a
    // second physical line — which desyncs the fixed-line-count cursor math
    // in draw()/stop() and makes the block appear to climb the screen. Capping
    // every row to the real terminal width guarantees one physical line per
    // logical row regardless of terminal size.
    const maxVisible = Math.max(20, (process.stderr.columns ?? 80) - 6);
    const rows = this.activeLanes().map((lane) => truncateVisible(this.rowFor(lane, seconds), maxVisible));
    this.draw(rows);
  }

  /** Redraws the block in place: moves to its top, clears every line, writes the new rows. */
  private draw(rows: string[]): void {
    if (!cErr.enabled) return;
    if (this.lastLineCount > 0) process.stderr.write(`${moveUpSeq(this.lastLineCount - 1)}\r`);
    const lineCount = Math.max(this.lastLineCount, rows.length);
    for (let i = 0; i < lineCount; i++) {
      process.stderr.write(`\x1b[2K${rows[i] ?? ""}`);
      if (i < lineCount - 1) process.stderr.write("\n");
    }
    process.stderr.write("\r");
    this.lastLineCount = rows.length;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (cErr.enabled && this.lastLineCount > 0) {
      const up = moveUpSeq(this.lastLineCount - 1);
      process.stderr.write(`${up}\r`);
      for (let i = 0; i < this.lastLineCount; i++) {
        process.stderr.write("\x1b[2K");
        if (i < this.lastLineCount - 1) process.stderr.write("\n");
      }
      process.stderr.write(`${up}\r`);
    }
    this.lastLineCount = 0;
  }
}

/**
 * Default benchmark prompt. Asks for a response long enough that stream
 * tok/s and eff tok/s average over enough tokens to be stable — a one-line
 * "Hello World" reply is short enough that fixed overhead and the metrics
 * floor dominate the measurement — but short enough that --runs 10 doesn't
 * take minutes: ~150 words is plenty of tokens for a stable rate without a
 * long wait per run. Override with --prompt.
 */
const DEFAULT_PROMPT =
  "Write a ~150-word short story about a lighthouse keeper who discovers " +
  "something unusual during a storm.";

/**
 * Below this generation window (ttlt - ttft), a response almost certainly
 * arrived as one burst rather than being streamed token-by-token — the
 * underlying metrics tracker floors generation time at 10ms, which turns a
 * near-instant flush into an inflated tok/s figure. Flag it instead of
 * reporting it as real per-token throughput.
 */
const BUFFERED_THRESHOLD_MS = 20;

/**
 * Appends a short random marker to a prompt so repeated identical requests
 * aren't served a cached response by a proxy/gateway — a full-response cache
 * hit looks identical to a buffered/non-streaming response (TTFT≈total), but
 * has a completely different cause and would silently corrupt --runs stats.
 * The marker is prefixed with an instruction to ignore it since it's plain
 * prompt text, not a protocol-level field.
 */
export function withNonce(basePrompt: string, nonce: string | null): string {
  if (nonce === null) return basePrompt;
  return `${basePrompt}\n\n[ignore this line, cache-buster: ${nonce}]`;
}

function makeNonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface LaneSpec {
  providerId: string;
  modelId: string;
}

/** Parse one "provider:model" entry from a --race list. Model ids may contain ":" or "/". */
export function parseLaneSpec(raw: string): LaneSpec {
  const sep = raw.indexOf(":");
  if (sep === -1) {
    throw new Error(
      `Invalid race lane "${raw}" — expected "provider:model", e.g. "groq:llama-3.3-70b-versatile"`,
    );
  }
  const providerId = raw.slice(0, sep).trim();
  const modelId = raw.slice(sep + 1).trim();
  if (!providerId || !modelId) {
    throw new Error(`Invalid race lane "${raw}" — both provider and model are required`);
  }
  return { providerId, modelId };
}

export { resolveApiKey };
export { disambiguateLaneIds };

interface ResolvedLane extends LaneSpec {
  laneId: string;
  baseUrl?: string;
  apiKey: string;
}

function resolveLane(spec: LaneSpec, baseUrlFlag: string | undefined, apiKeyFlag: string | undefined): ResolvedLane {
  const { providerId, modelId } = spec;
  const isLocal = providerId === LOCAL_PROVIDER_ID;

  if (!isLocal && !providers[providerId]) {
    const known = Object.keys(providers).concat(LOCAL_PROVIDER_ID).sort().join(", ");
    throw new Error(`Unknown provider "${providerId}". Known providers: ${known}`);
  }

  const apiKey = resolveApiKey(providerId, apiKeyFlag);

  if (isLocal) {
    if (!baseUrlFlag) {
      throw new Error(`Provider "local" requires --base-url (the OpenAI-compatible endpoint to hit).`);
    }
  } else if (!apiKey) {
    throw new Error(
      `Missing API key for provider "${providerId}". Pass --api-key or set ${envVarNameFor(providerId)}.`,
    );
  }

  return {
    providerId,
    modelId,
    laneId: `${providerId}:${modelId}`,
    baseUrl: isLocal ? baseUrlFlag : undefined,
    apiKey,
  };
}

/**
 * A race that repeats the same provider:model pair (e.g. to sanity-check
 * variance) would otherwise give every occurrence the same laneId. Lanes are
 * tracked in maps keyed by laneId, so the second "finish" for that id gets
 * silently dropped as a duplicate and the race never reaches onAllDone —
 * the process hangs. Suffix repeats with #2, #3, ... to keep every laneId
 * unique; the first occurrence is left as-is so the common no-duplicates
 * case is unaffected.
 */
function disambiguateLaneIds(lanes: ResolvedLane[]): ResolvedLane[] {
  const seen = new Map<string, number>();
  return lanes.map((lane) => {
    const count = (seen.get(lane.laneId) ?? 0) + 1;
    seen.set(lane.laneId, count);
    return count === 1 ? lane : { ...lane, laneId: `${lane.laneId}#${count}` };
  });
}

function runRaceAsync(configs: RaceConfig[], prompt: string, timeoutMs: number): Promise<RaceResult[]> {
  return new Promise((resolve) => {
    let settled = false;
    let finished = 0;
    const widget = new LiveWidget(configs);
    widget.start();

    const handle = runRace(
      configs,
      prompt,
      {
        onLaneUpdate: (lane) => widget.update(lane),
        onLaneFinish: (lane, rank) => {
          widget.stop();
          finished += 1;
          const laneLabel = `${lane.providerId}/${lane.modelId}`;
          if (lane.status === "error" && lane.tokenCount === 0) {
            process.stderr.write(cErr.red(`[${rank}] ${laneLabel} — error: ${lane.error}\n`));
          } else {
            const grade = lane.tps !== null ? getSpeedGrade(lane.tps) : null;
            const tps = lane.tps !== null ? `${lane.tps.toFixed(1)} stream tok/s` : "no stream tok/s";
            const effTps = effectiveTps(lane);
            const effLabel = effTps !== null ? `, ${effTps.toFixed(1)} eff tok/s` : "";
            const ttftLabel = lane.ttft !== null ? `, TTFT ${Math.round(lane.ttft)} ms` : "";
            const buffered = isBuffered(lane) ? cErr.yellow(" ⚠ buffered") : "";
            const gradeLabel = grade ? ` ${grade.emoji}` : "";
            process.stderr.write(
              `${cErr.green(`[${rank}]`)} ${cErr.bold(laneLabel)} — done (${tps}${effLabel}${ttftLabel})${gradeLabel}${buffered}\n`,
            );
          }
          if (finished < configs.length) widget.start();
        },
        onAllDone: (results) => {
          if (settled) return;
          settled = true;
          widget.stop();
          clearTimeout(timer);
          process.off("SIGINT", onSigint);
          resolve(results);
        },
      },
      providers,
    );

    const timer = setTimeout(() => {
      if (settled) return;
      widget.stop();
      process.stderr.write(cErr.red(`Timed out after ${timeoutMs}ms — aborting.\n`));
      handle.abort();
    }, timeoutMs);

    const onSigint = () => {
      widget.stop();
      process.stderr.write("\nInterrupted — aborting.\n");
      handle.abort();
    };
    process.on("SIGINT", onSigint);
  });
}

function formatMs(ms: number | null): string {
  return ms === null ? "—" : `${Math.round(ms)} ms`;
}

function formatTps(tps: number | null): string {
  return tps === null ? "—" : tps.toFixed(1);
}

/** Pads a field label to a fixed width so single-lane output lines up. */
function label(text: string): string {
  return text.padEnd(13);
}

/**
 * True when a result's generation window (ttlt - ttft) is so short it almost
 * certainly means the response was delivered as one burst rather than
 * streamed — see BUFFERED_THRESHOLD_MS.
 */
export function isBuffered(result: Pick<RaceResult, "ttft" | "ttlt" | "tokenCount">): boolean {
  if (result.ttft === null || result.ttlt === null) return false;
  if (result.tokenCount <= 1) return false;
  return result.ttlt - result.ttft < BUFFERED_THRESHOLD_MS;
}

/**
 * Total tokens divided by total wall-clock time (request sent to response fully
 * received). Unlike `tps` — which needs a real generation window (ttlt - ttft) to
 * mean anything — this is well-defined whether or not the response was streamed
 * token-by-token, so it's the number to compare across buffered and non-buffered
 * lanes, or across different proxies/providers.
 */
export function effectiveTps(result: Pick<RaceResult, "ttlt" | "tokenCount">): number | null {
  if (result.ttlt === null || result.ttlt <= 0 || result.tokenCount <= 0) return null;
  return (result.tokenCount / result.ttlt) * 1000;
}

const BUFFERED_NOTE =
  "Note: this looks like the response arrived in one burst rather than\n" +
  "being streamed token-by-token, so stream tok/s is not a real per-token rate.\n" +
  "Check whether this route streams natively at the source. Use eff tok/s\n" +
  "instead — it's comparable either way.";

/** Median of a list of numbers. Returns null for an empty list. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Human-readable block for a single-lane run. */
function formatSingle(result: RaceResult): string {
  const buffered = isBuffered(result);
  const lines = [c.bold(`🏁 ${result.providerId}/${result.modelId}`)];
  if (result.error) {
    lines.push(c.red(`  error    ${result.error}`));
  }
  lines.push(`  ${c.dim(label("TTFT"))}${formatMs(result.ttft)}`);
  lines.push(
    `  ${c.dim(label("stream tok/s"))}${formatTps(result.tps)}${speedIndicator(c, result.tps)}${buffered ? c.yellow("  ⚠ buffered") : ""}`,
  );
  const effTps = effectiveTps(result);
  lines.push(`  ${c.dim(label("eff tok/s"))}${formatTps(effTps)}${speedIndicator(c, effTps)}`);
  lines.push(`  ${c.dim(label("total"))}${formatMs(result.ttlt)}`);
  lines.push(`  ${c.dim(label("tokens"))}${result.tokenCount}`);
  if (buffered) {
    lines.push("");
    lines.push(c.yellow(BUFFERED_NOTE.split("\n").map((l) => `  ${l}`).join("\n")));
  }
  return lines.join("\n");
}

/** Ranked table for a multi-lane race, ordered by throughput (fastest first). */
export function formatTable(results: RaceResult[]): string {
  const ranked = [...results].sort((a, b) => {
    const aRaced = a.tokenCount > 0;
    const bRaced = b.tokenCount > 0;
    if (aRaced !== bRaced) return aRaced ? -1 : 1;
    return (b.tps ?? -Infinity) - (a.tps ?? -Infinity);
  });
  const header = ["#", "PROVIDER/MODEL", "stream tok/s", "eff tok/s", "TTFT", "total", "tokens"].map((h) =>
    c.dim(h),
  );
  const rows = ranked.map((r, i) => {
    const raced = r.tokenCount > 0;
    const medal = raced ? MEDALS[i] : undefined;
    const grade = r.tps !== null ? getSpeedGrade(r.tps) : null;
    const nameCell = `${r.providerId}/${r.modelId}${r.error ? " (error)" : ""}${grade ? ` ${grade.emoji}` : ""}`;
    return [
      medal ?? String(i + 1),
      i === 0 && raced ? c.bold(nameCell) : nameCell,
      `${formatTps(r.tps)}${isBuffered(r) ? c.yellow(" ⚠") : ""}`,
      formatTps(effectiveTps(r)),
      formatMs(r.ttft),
      formatMs(r.ttlt),
      String(r.tokenCount),
    ];
  });
  const widths = header.map((h, col) =>
    Math.max(visibleLength(h), ...rows.map((row) => visibleLength(row[col]))),
  );
  const formatRow = (cols: string[]) => cols.map((col, i) => padEndVisible(col, widths[i])).join("  ");
  const lines = [formatRow(header), ...rows.map(formatRow)];
  if (ranked.some((r) => isBuffered(r))) {
    lines.push("");
    lines.push(
      c.yellow(
        "⚠ = looks buffered (TTFT≈total) — stream tok/s for that lane is not a real per-token rate.\n" +
          "eff tok/s (tokens ÷ total time) is comparable across buffered and streamed lanes.",
      ),
    );
  }
  return lines.join("\n");
}

interface LaneAggregate {
  laneId: string;
  providerId: string;
  modelId: string;
  runs: number;
  successCount: number;
  bufferedCount: number;
  ttft: { median: number | null; min: number | null; max: number | null };
  tps: { median: number | null; min: number | null; max: number | null };
  effTps: { median: number | null; min: number | null; max: number | null };
  ttlt: { median: number | null; min: number | null; max: number | null };
  tokenCount: number | null;
}

function statBlock(values: number[]): { median: number | null; min: number | null; max: number | null } {
  if (values.length === 0) return { median: null, min: null, max: null };
  return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
}

/** Aggregate one lane's results across repeated runs. */
export function aggregateLane(laneId: string, results: RaceResult[]): LaneAggregate {
  const first = results[0];
  const successes = results.filter((r) => r.tokenCount > 0);
  const ttftValues = results.filter((r) => r.ttft !== null).map((r) => r.ttft as number);
  const tpsValues = results.filter((r) => r.tps !== null).map((r) => r.tps as number);
  const effTpsValues = results.map((r) => effectiveTps(r)).filter((v): v is number => v !== null);
  const ttltValues = results.filter((r) => r.ttlt !== null).map((r) => r.ttlt as number);
  const tokenCounts = results.map((r) => r.tokenCount).filter((n) => n > 0);

  return {
    laneId,
    providerId: first.providerId,
    modelId: first.modelId,
    runs: results.length,
    successCount: successes.length,
    bufferedCount: results.filter((r) => isBuffered(r)).length,
    ttft: statBlock(ttftValues),
    tps: statBlock(tpsValues),
    effTps: statBlock(effTpsValues),
    ttlt: statBlock(ttltValues),
    tokenCount: median(tokenCounts),
  };
}

function formatRange(stat: { min: number | null; max: number | null }, fmt: (n: number) => string): string {
  if (stat.min === null || stat.max === null) return "";
  return stat.min === stat.max ? "" : `  (${fmt(stat.min)}-${fmt(stat.max)})`;
}

function bufferedSuffix(agg: LaneAggregate): string {
  return agg.bufferedCount > 0 ? `  ⚠ buffered: ${agg.bufferedCount}/${agg.runs} runs` : "";
}

/** Human-readable aggregate block for a single lane run over multiple --runs. */
function formatSingleAggregate(agg: LaneAggregate): string {
  const fullSuccess = agg.successCount === agg.runs;
  const lines = [c.bold(`🏁 ${agg.providerId}/${agg.modelId}  (${agg.runs} runs)`)];
  lines.push(
    `  ${c.dim(label("TTFT"))}median ${formatMs(agg.ttft.median)}${c.dim(formatRange(agg.ttft, (n) => `${Math.round(n)} ms`))}`,
  );
  lines.push(
    `  ${c.dim(label("stream tok/s"))}median ${formatTps(agg.tps.median)}${speedIndicator(c, agg.tps.median)}${c.dim(formatRange(agg.tps, (n) => n.toFixed(1)))}${bufferedSuffix(agg)}`,
  );
  lines.push(
    `  ${c.dim(label("eff tok/s"))}median ${formatTps(agg.effTps.median)}${speedIndicator(c, agg.effTps.median)}${c.dim(formatRange(agg.effTps, (n) => n.toFixed(1)))}`,
  );
  lines.push(
    `  ${c.dim(label("success"))}${fullSuccess ? c.green(`${agg.successCount}/${agg.runs} runs`) : c.red(`${agg.successCount}/${agg.runs} runs`)}`,
  );
  if (agg.bufferedCount > 0) {
    lines.push("");
    lines.push(
      c.yellow(
        `⚠ ${agg.bufferedCount} of ${agg.runs} runs showed instant delivery after TTFT (TTFT≈total) —\n  stream tok/s for those runs is not a real measurement of per-token throughput.\n  Use eff tok/s above instead — it's comparable across buffered and streamed runs.`,
      ),
    );
  }
  return lines.join("\n");
}

/** Ranked aggregate table for a multi-lane race over multiple --runs. */
export function formatAggregateTable(aggregates: LaneAggregate[]): string {
  const ranked = [...aggregates].sort((a, b) => {
    const aRaced = a.successCount > 0;
    const bRaced = b.successCount > 0;
    if (aRaced !== bRaced) return aRaced ? -1 : 1;
    const aEffTps = a.effTps.median ?? -Infinity;
    const bEffTps = b.effTps.median ?? -Infinity;
    return bEffTps - aEffTps;
  });
  const header = ["#", "PROVIDER/MODEL", "eff tok/s (median)", "stream tok/s (median)", "TTFT (median)", "success"].map(
    (h) => c.dim(h),
  );
  const rows = ranked.map((a, i) => {
    const raced = a.successCount > 0;
    const medal = raced ? MEDALS[i] : undefined;
    const grade = a.tps.median !== null ? getSpeedGrade(a.tps.median) : null;
    const nameCell = `${a.providerId}/${a.modelId}${grade ? ` ${grade.emoji}` : ""}`;
    const fullSuccess = a.successCount === a.runs;
    return [
      medal ?? String(i + 1),
      i === 0 && raced ? c.bold(nameCell) : nameCell,
      formatTps(a.effTps.median),
      `${formatTps(a.tps.median)}${a.bufferedCount > 0 ? c.yellow(" ⚠") : ""}`,
      formatMs(a.ttft.median),
      fullSuccess ? c.green(`${a.successCount}/${a.runs}`) : c.red(`${a.successCount}/${a.runs}`),
    ];
  });
  const widths = header.map((h, col) =>
    Math.max(visibleLength(h), ...rows.map((row) => visibleLength(row[col]))),
  );
  const formatRow = (cols: string[]) => cols.map((col, i) => padEndVisible(col, widths[i])).join("  ");
  const lines = [formatRow(header), ...rows.map(formatRow)];
  lines.push("");
  lines.push(c.dim("Ranked by eff tok/s (tokens ÷ total time) — reliable across buffered and streamed lanes."));
  if (ranked.some((a) => a.bufferedCount > 0)) {
    lines.push(
      c.yellow(
        "⚠ = at least one run looked buffered (TTFT≈total) — median stream tok/s (not eff tok/s) may be inflated.",
      ),
    );
  }
  return lines.join("\n");
}

function printHelp(): void {
  const known = Object.keys(PROVIDERS).sort().join(", ");
  process.stdout.write(`
Usage:
  llmrace --provider <id> --model <id> [--base-url <url>] [--api-key <key>]
  llmrace --race <provider:model,provider:model,...>
  llmrace                Run with no flags on a terminal to launch the interactive wizard

Options:
  -p, --provider <id>   Provider id for a single run (see below)
  -m, --model <id>       Model id for a single run
      --base-url <url>   Required for provider "local" (an OpenAI-compatible endpoint)
      --api-key <key>    Overrides the <PROVIDER>_API_KEY env var
      --prompt <text>    Overrides the default benchmark prompt
      --race <list>      Comma-separated provider:model entries, run in parallel
      --runs <n>          Repeat the benchmark n times and report median/min/max (default ${DEFAULT_RUNS})
      --static-prompt    Send the exact same prompt every run (default: a per-run marker is
                          appended to dodge proxy/gateway response caching — see below)
      --json             Emit machine-readable JSON on stdout instead of text
      --timeout <ms>      Abort if no result after this many ms (default ${DEFAULT_TIMEOUT_MS})
      --list             List known provider ids and exit
  -h, --help             Show this help

API keys: set <PROVIDER>_API_KEY, e.g. GROQ_API_KEY, OPENAI_API_KEY (a .env file is loaded
automatically). The "local" provider takes --base-url and an optional --api-key.

A single run's stream tok/s can be misleading if the endpoint doesn't stream
token by token — a "buffered" warning appears when TTFT and total time are
nearly identical. Use --runs 5 (or more) to smooth out per-run noise.

"eff tok/s" (tokens ÷ total time) is a second, always-reliable throughput
number — it's comparable even when a lane is buffered, since it doesn't
depend on measuring a real per-token generation window. Race/aggregate
tables rank by it for that reason.

Each run's prompt gets a unique marker appended by default, so a gateway
that caches full responses by exact request match can't return a stale
answer — a cache hit looks just like a buffered response (TTFT≈total) but
means something different. Pass --static-prompt to send the identical
prompt every time instead (e.g. to deliberately measure cache-hit speed).

Known providers: ${known}

Examples:
  llmrace --provider local --base-url http://localhost:11434/v1 --model llama3
  llmrace --provider groq --model llama-3.3-70b-versatile
  llmrace --provider groq --model llama-3.3-70b-versatile --runs 5
  llmrace --race groq:llama-3.3-70b-versatile,local:llama3 --base-url http://localhost:11434/v1
`);
}

function isNodeParseError(err: unknown): err is Error & { code: string } {
  return err instanceof Error && "code" in err && typeof (err as { code: unknown }).code === "string";
}

async function main(): Promise<void> {
  let values: {
    provider?: string;
    model?: string;
    "base-url"?: string;
    "api-key"?: string;
    prompt?: string;
    race?: string;
    runs?: string;
    "static-prompt": boolean;
    json: boolean;
    timeout?: string;
    list: boolean;
    help: boolean;
  };
  try {
    ({ values } = parseArgs({
      options: {
        provider: { type: "string", short: "p" },
        model: { type: "string", short: "m" },
        "base-url": { type: "string" },
        "api-key": { type: "string" },
        prompt: { type: "string" },
        race: { type: "string" },
        runs: { type: "string" },
        "static-prompt": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        timeout: { type: "string" },
        list: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    if (isNodeParseError(err) && err.code.startsWith("ERR_PARSE_ARGS")) {
      process.stderr.write(`${err.message}\nTip: e.g. llmrace --provider groq --model ...\n`);
    } else {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    }
    process.exitCode = 1;
    return;
  }

  if (values.help) {
    printHelp();
    return;
  }

  if (values.list) {
    for (const [id, meta] of Object.entries(PROVIDERS)) {
      process.stdout.write(`${id}\t${meta.displayName}\n`);
    }
    return;
  }

  const prompt = values.prompt ?? DEFAULT_PROMPT;
  const timeoutMs = values.timeout ? Number.parseInt(values.timeout, 10) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    process.stderr.write(`Invalid --timeout value: ${values.timeout}\n`);
    process.exitCode = 1;
    return;
  }

  let wizardRuns: number | undefined;
  let wizardStaticPrompt: boolean | undefined;

  let specs: LaneSpec[];
  try {
    if (values.race) {
      specs = values.race.split(",").map((entry) => parseLaneSpec(entry));
    } else if (!values.provider || !values.model) {
      if (process.stdin.isTTY && process.stderr.isTTY) {
        const answers = await runWizard();
        if (!answers) return; // user cancelled (Ctrl-C)
        specs = [{ providerId: answers.providerId, modelId: answers.modelId }];
        values["api-key"] = answers.apiKey;
        values["base-url"] = answers.baseUrl;
        wizardRuns = answers.runs;
        wizardStaticPrompt = answers.staticPrompt;
      } else {
        process.stderr.write("Missing --provider/--model (or use --race). Run with --help for usage.\n");
        process.exitCode = 1;
        return;
      }
    } else {
      specs = [{ providerId: values.provider, modelId: values.model }];
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  let lanes: ResolvedLane[];
  try {
    lanes = specs.map((spec) => resolveLane(spec, values["base-url"], values["api-key"]));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }
  lanes = disambiguateLaneIds(lanes);

  const configs: RaceConfig[] = lanes.map((lane) => ({
    laneId: lane.laneId,
    providerId: lane.providerId,
    modelId: lane.modelId,
    apiKey: lane.apiKey,
    baseUrl: lane.baseUrl,
  }));

  const runs = wizardRuns ?? (values.runs ? Number.parseInt(values.runs, 10) : DEFAULT_RUNS);
  if (!Number.isFinite(runs) || runs <= 0) {
    process.stderr.write(`Invalid --runs value: ${values.runs}\n`);
    process.exitCode = 1;
    return;
  }

  const staticPrompt = wizardStaticPrompt ?? values["static-prompt"];

  if (runs === 1) {
    const promptSent = withNonce(prompt, staticPrompt ? null : makeNonce());
    const results = await runRaceAsync(configs, promptSent, timeoutMs);
    const anyError = results.some((r) => r.tokenCount === 0);

    if (values.json) {
      const withEffTps = results.map((r) => ({ ...r, effectiveTps: effectiveTps(r) }));
      process.stdout.write(`${JSON.stringify({ prompt: promptSent, results: withEffTps }, null, 2)}\n`);
    } else if (results.length === 1) {
      process.stdout.write(`${formatSingle(results[0])}\n`);
    } else {
      process.stdout.write(`${formatTable(results)}\n`);
    }

    process.exitCode = anyError ? 1 : 0;
    return;
  }

  if (!staticPrompt) {
    process.stderr.write(
      cErr.dim(
        "Each run's prompt includes a unique marker to dodge proxy response-cache hits (pass --static-prompt to disable).\n",
      ),
    );
  }

  const rounds: RaceResult[][] = [];
  const promptsSent: string[] = [];
  for (let i = 0; i < runs; i++) {
    process.stderr.write(cErr.bold(cErr.cyan(`🏁 run ${i + 1}/${runs}\n`)));
    const promptSent = withNonce(prompt, staticPrompt ? null : makeNonce());
    promptsSent.push(promptSent);
    rounds.push(await runRaceAsync(configs, promptSent, timeoutMs));
  }

  const aggregates = configs.map((config, laneIndex) =>
    aggregateLane(config.laneId, rounds.map((round) => round[laneIndex])),
  );
  const anyLaneAlwaysFailed = aggregates.some((a) => a.successCount === 0);

  if (values.json) {
    const roundsWithEffTps = rounds.map((round) => round.map((r) => ({ ...r, effectiveTps: effectiveTps(r) })));
    process.stdout.write(
      `${JSON.stringify({ prompt, staticPrompt, promptsSent, runs, rounds: roundsWithEffTps, summary: aggregates }, null, 2)}\n`,
    );
  } else if (aggregates.length === 1) {
    process.stdout.write(`${formatSingleAggregate(aggregates[0])}\n`);
  } else {
    process.stdout.write(`${formatAggregateTable(aggregates)}\n`);
  }

  process.exitCode = anyLaneAlwaysFailed ? 1 : 0;
}

/**
 * True when this module was run directly as the CLI entry point (vs. imported,
 * e.g. by the test suite, which pulls in pure helpers like formatTable/parseLaneSpec).
 *
 * A naive `import.meta.url === file://${process.argv[1]}` check breaks under every
 * real install path: npm's `bin` mechanism always invokes this file through a
 * symlink (node_modules/.bin/llmrace -> ../llmrace/dist/bench.js). process.argv[1]
 * is the symlink path the user/npx typed, but import.meta.url is the resolved real
 * path — they never match, main() silently never runs, and the CLI does nothing at
 * all (exit 0, no output). Resolving both sides to their real path fixes that.
 */
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

const isMain = isMainModule();
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
