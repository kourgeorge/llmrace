import * as readline from "node:readline";
import type { Key } from "node:readline";
import { BACK, type SelectIO } from "./select";

export interface TextPromptOptions {
  /** Used when the user presses enter without typing anything. */
  defaultValue?: string;
  /** Echo "•" per character instead of the character itself (API keys, etc). */
  mask?: boolean;
}

/**
 * Single-line text prompt rendered on `io.output`. Resolves to the typed
 * string, or `options.defaultValue` (or `""` if none given) when the user
 * presses enter without typing anything. Resolves `null` if the user cancels
 * with Ctrl-C, or `BACK` if the user presses Escape (go back a step).
 *
 * Always restores the terminal — raw mode off, cursor shown, listeners
 * removed — no matter how the prompt ends.
 */
export function textPrompt(
  io: SelectIO,
  message: string,
  options: TextPromptOptions = {}
): Promise<string | typeof BACK | null> {
  const { input, output } = io;
  const ttyEnabled = Boolean(output.isTTY);
  const colorEnabled = ttyEnabled && !process.env.NO_COLOR;
  const wrap = (code: string, text: string) => (colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  const bold = (s: string) => wrap("1", s);
  const dim = (s: string) => wrap("2", s);

  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;

    const write = (text: string): void => {
      output.write(text);
    };

    const render = (): void => {
      if (ttyEnabled) write("\x1b[2K\r");
      const shown = options.mask ? "•".repeat(buffer.length) : buffer;
      const hint = options.defaultValue ? dim(` (${options.defaultValue})`) : "";
      const line = `${bold("?")} ${message}${hint} ${shown}`;
      write(ttyEnabled ? line : `${line}\n`);
    };

    const onKeypress = (str: string | undefined, key: Key): void => {
      if (key.ctrl && key.name === "c") {
        settle(null);
        return;
      }
      if (key.name === "escape") {
        settle(BACK);
        return;
      }
      if (key.name === "return") {
        if (ttyEnabled) write("\n");
        settle(buffer.length > 0 ? buffer : options.defaultValue ?? "");
        return;
      }
      if (key.name === "backspace") {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          render();
        }
        return;
      }
      if (str && !key.ctrl && !key.meta && str.length === 1 && str >= " ") {
        buffer += str;
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

    const settle = (value: string | typeof BACK | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onClose = (): void => settle(null);

    readline.emitKeypressEvents(input);
    input.resume();
    if (rawModeSupported) input.setRawMode!(true);

    input.on("keypress", onKeypress);
    input.on("close", onClose);

    render();
  });
}

/** Masked variant for secrets — echoes "•" per character instead of the character. */
export function maskedPrompt(io: SelectIO, message: string): Promise<string | typeof BACK | null> {
  return textPrompt(io, message, { mask: true });
}

/**
 * Yes/no prompt in the `(Y/n)` style. Enter with no input takes `defaultValue`.
 * "n"/"no" (case-insensitive) count as false, "y"/"yes" as true. Anything else
 * is rejected with an error message and re-prompted. Resolves `null` on
 * Ctrl-C, or `BACK` if the user presses Escape (go back a step).
 */
export async function confirmPrompt(
  io: SelectIO,
  message: string,
  defaultValue = true
): Promise<boolean | typeof BACK | null> {
  const hint = defaultValue ? "Y/n" : "y/N";
  for (;;) {
    const answer = await textPrompt(io, `${message} (${hint})`);
    if (answer === null || answer === BACK) return answer;
    const normalized = answer.trim().toLowerCase();
    if (normalized === "") return defaultValue;
    if (normalized === "n" || normalized === "no") return false;
    if (normalized === "y" || normalized === "yes") return true;
    io.output.write(`  please answer y or n (enter = ${defaultValue ? "yes" : "no"})\n`);
  }
}
