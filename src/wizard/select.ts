import * as readline from "node:readline";
import type { Key } from "node:readline";

/**
 * Minimal stream shape the picker needs, kept separate from `NodeJS.ReadStream`/
 * `WriteStream` so tests can inject fakes (plain `EventEmitter`s / in-memory
 * writables) instead of real TTYs.
 */
export interface SelectIO {
  input: NodeJS.ReadableStream & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  output: NodeJS.WritableStream & { isTTY?: boolean };
}

export interface SelectChoice<T> {
  value: T;
  label: string;
}

/** Distinct from `null` (full cancel) — signals "go back to the previous step". */
export const BACK = Symbol("wizard-back");

function colorerFor(output: { isTTY?: boolean }) {
  const enabled = Boolean(output.isTTY) && !process.env.NO_COLOR;
  const wrap = (code: string, text: string) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  return {
    enabled,
    bold: (s: string) => wrap("1", s),
    dim: (s: string) => wrap("2", s),
    cyan: (s: string) => wrap("36", s),
  };
}

/**
 * Arrow-key list picker with type-to-filter, rendered on `io.output`
 * (stderr in the wizard, so stdout stays clean for `--json`/piping).
 *
 * Resolves to the selected value, `null` if the user cancels with Ctrl-C,
 * or `BACK` if the user presses Escape (go back a step). Always restores
 * the terminal — raw mode off, cursor shown, keypress listener removed —
 * in a `finally`, so a cancelled prompt never leaves the shell in a broken
 * state.
 */
export function select<T>(
  io: SelectIO,
  message: string,
  choices: SelectChoice<T>[]
): Promise<T | typeof BACK | null> {
  const { input, output } = io;
  const c = colorerFor(output);
  const ttyEnabled = Boolean(output.isTTY);

  return new Promise((resolve) => {
    let filtering = false;
    let filter = "";
    let cursor = 0;
    let linesDrawn = 0;
    let settled = false;

    const visible = (): SelectChoice<T>[] => {
      if (!filtering || !filter) return choices;
      const needle = filter.toLowerCase();
      return choices.filter((choice) => choice.label.toLowerCase().includes(needle));
    };

    const write = (text: string): void => {
      output.write(text);
    };

    // How many choice rows fit on screen at once, leaving room for the header
    // line and the "N more above/below" indicators. Without this cap, a long
    // list (e.g. a provider with 100+ models) renders more lines than the
    // terminal has rows: the terminal itself scrolls, which desyncs the
    // "move cursor up `linesDrawn` lines" redraw below and leaves stray copies
    // of the list behind on every keypress.
    const DEFAULT_MAX_VISIBLE = 15;
    const maxVisible = (): number => {
      const rows = (output as { rows?: number }).rows;
      if (ttyEnabled && typeof rows === "number" && rows > 0) {
        return Math.max(3, rows - 4);
      }
      return DEFAULT_MAX_VISIBLE;
    };

    // A scrolling window of `shown` centered on the cursor, clamped to stay
    // within bounds.
    const windowRange = (total: number, max: number): { start: number; end: number } => {
      if (total <= max) return { start: 0, end: total };
      const start = Math.max(0, Math.min(cursor - Math.floor(max / 2), total - max));
      return { start, end: start + max };
    };

    const render = (): void => {
      const shown = visible();
      if (cursor >= shown.length) cursor = shown.length > 0 ? shown.length - 1 : 0;

      if (ttyEnabled && linesDrawn > 0) {
        write(`\x1b[${linesDrawn}A\x1b[0J`);
      }

      const hint = filtering ? c.dim(` (filter: ${filter})`) : c.dim(" (↑↓ to move, / to filter, enter to select)");
      const lines: string[] = [`${c.bold("?")} ${message}${hint}`];

      if (shown.length === 0) {
        lines.push(c.dim("  no matches"));
      } else {
        const { start, end } = windowRange(shown.length, maxVisible());
        if (start > 0) lines.push(c.dim(`  ↑ ${start} more`));
        for (let i = start; i < end; i++) {
          const choice = shown[i];
          const marker = i === cursor ? c.cyan("❯") : " ";
          const label = i === cursor ? c.bold(choice.label) : choice.label;
          lines.push(`${marker} ${label}`);
        }
        if (end < shown.length) lines.push(c.dim(`  ↓ ${shown.length - end} more`));
      }

      const body = ttyEnabled ? lines.map((line) => `\x1b[2K${line}`).join("\n") : lines.join("\n");
      write(`${body}\n`);
      linesDrawn = lines.length;
    };

    const onKeypress = (str: string | undefined, key: Key): void => {
      const shown = visible();

      if (key.ctrl && key.name === "c") {
        settle(null);
        return;
      }
      if (key.name === "escape") {
        settle(BACK);
        return;
      }
      if (key.name === "return") {
        if (shown.length > 0) settle(shown[cursor].value);
        return;
      }
      if (key.name === "up") {
        cursor = shown.length > 0 ? (cursor - 1 + shown.length) % shown.length : 0;
        render();
        return;
      }
      if (key.name === "down") {
        cursor = shown.length > 0 ? (cursor + 1) % shown.length : 0;
        render();
        return;
      }
      if (key.name === "backspace") {
        if (filtering) {
          filter = filter.slice(0, -1);
          cursor = 0;
          render();
        }
        return;
      }
      if (!filtering && str === "/") {
        filtering = true;
        cursor = 0;
        render();
        return;
      }
      if (filtering && str && !key.ctrl && !key.meta && str.length === 1 && str >= " ") {
        filter += str;
        cursor = 0;
        render();
      }
    };

    const rawModeSupported = Boolean(input.isTTY) && typeof input.setRawMode === "function";

    const cleanup = (): void => {
      input.removeListener("keypress", onKeypress);
      input.removeListener("close", onClose);
      if (rawModeSupported) input.setRawMode!(false);
      if (ttyEnabled) write("\x1b[?25h");
      input.pause();
    };

    const settle = (value: T | typeof BACK | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onClose = (): void => settle(null);

    readline.emitKeypressEvents(input);
    input.resume();
    if (rawModeSupported) input.setRawMode!(true);
    if (ttyEnabled) write("\x1b[?25l");

    input.on("keypress", onKeypress);
    input.on("close", onClose);

    render();
  });
}
