import { EventEmitter } from "node:events";
import type { SelectIO } from "../../../src/wizard/select";

/**
 * Minimal fake input: a plain EventEmitter with the extra bits the wizard's
 * prompts check for (`isTTY`, `setRawMode`). Tests drive it by emitting
 * "keypress" directly, bypassing `readline.emitKeypressEvents`'s byte-decoding
 * — that decoder only listens for "data", so it never interferes with
 * keypresses emitted directly like this.
 */
export function fakeInput(): SelectIO["input"] & {
  setRawModeCalls: boolean[];
  pauseCalls: number;
  resumeCalls: number;
} {
  const emitter = new EventEmitter() as unknown as SelectIO["input"] & {
    setRawModeCalls: boolean[];
    pauseCalls: number;
    resumeCalls: number;
  };
  emitter.isTTY = true;
  emitter.setRawModeCalls = [];
  emitter.pauseCalls = 0;
  emitter.resumeCalls = 0;
  emitter.setRawMode = (mode: boolean) => {
    emitter.setRawModeCalls.push(mode);
    return emitter as unknown as NodeJS.ReadStream;
  };
  emitter.pause = () => {
    emitter.pauseCalls += 1;
    return emitter;
  };
  emitter.resume = () => {
    emitter.resumeCalls += 1;
    return emitter;
  };
  return emitter;
}

/** Fake output: collects writes, `isTTY: false` so no ANSI noise to strip in assertions. */
export function fakeOutput(): SelectIO["output"] & { lines: string[] } {
  const written: string[] = [];
  const emitter = new EventEmitter() as unknown as SelectIO["output"] & { lines: string[] };
  emitter.isTTY = false;
  emitter.lines = written;
  emitter.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as SelectIO["output"]["write"];
  return emitter;
}

export const key = (name: string, extra: Partial<{ ctrl: boolean; meta: boolean }> = {}) => ({
  sequence: "",
  name,
  ctrl: extra.ctrl ?? false,
  meta: extra.meta ?? false,
});

export const charKey = (ch: string) => ({ sequence: ch, name: undefined, ctrl: false, meta: false });
