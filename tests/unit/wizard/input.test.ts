import { describe, expect, it } from "vitest";
import { confirmPrompt, maskedPrompt, textPrompt } from "../../../src/wizard/input";
import { BACK, type SelectIO } from "../../../src/wizard/select";
import { charKey, fakeInput, fakeOutput, key } from "./fixtures";

function typeString(input: ReturnType<typeof fakeInput>, text: string): void {
  for (const ch of text) {
    input.emit("keypress", ch, charKey(ch));
  }
}

describe("textPrompt", () => {
  it("resolves the typed text on enter", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = textPrompt(io, "Base URL");
    typeString(input, "hello");
    input.emit("keypress", undefined, key("return"));

    await expect(promise).resolves.toBe("hello");
  });

  it("resolves the default value when enter is pressed with nothing typed", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = textPrompt(io, "Base URL", { defaultValue: "http://localhost:11434/v1" });
    input.emit("keypress", undefined, key("return"));

    await expect(promise).resolves.toBe("http://localhost:11434/v1");
  });

  it("backspace removes the last typed character", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = textPrompt(io, "Model");
    typeString(input, "gpt-5x");
    input.emit("keypress", undefined, key("backspace"));
    input.emit("keypress", undefined, key("return"));

    await expect(promise).resolves.toBe("gpt-5");
  });

  it("resolves null on ctrl-c and restores the terminal", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = textPrompt(io, "Model");
    typeString(input, "abc");
    input.emit("keypress", undefined, key("c", { ctrl: true }));

    await expect(promise).resolves.toBeNull();
    expect(input.setRawModeCalls).toEqual([true, false]);
    expect(input.listenerCount("keypress")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);
  });

  it("resolves BACK on escape", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = textPrompt(io, "Model");
    input.emit("keypress", undefined, key("escape"));

    await expect(promise).resolves.toBe(BACK);
  });

  it("resolves null when the input stream closes", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = textPrompt(io, "Model");
    input.emit("close");

    await expect(promise).resolves.toBeNull();
  });
});

describe("maskedPrompt", () => {
  it("echoes a bullet per character instead of the character itself", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = maskedPrompt(io, "Groq API key");
    typeString(input, "sk-secret");
    input.emit("keypress", undefined, key("return"));

    await expect(promise).resolves.toBe("sk-secret");
    const rendered = output.lines.join("");
    expect(rendered).not.toContain("sk-secret");
    expect(rendered).toContain("•".repeat("sk-secret".length));
  });
});

describe("confirmPrompt", () => {
  it("defaults to true when enter is pressed with nothing typed", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = confirmPrompt(io, "Save to .env for next time?");
    input.emit("keypress", undefined, key("return"));

    await expect(promise).resolves.toBe(true);
  });

  it("respects a false default", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = confirmPrompt(io, "Overwrite existing key?", false);
    input.emit("keypress", undefined, key("return"));

    await expect(promise).resolves.toBe(false);
  });

  it("treats 'n'/'no' as false regardless of the default", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = confirmPrompt(io, "Save to .env for next time?", true);
    typeString(input, "n");
    input.emit("keypress", undefined, key("return"));

    await expect(promise).resolves.toBe(false);
  });

  it("treats 'yes' as true", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = confirmPrompt(io, "Save to .env for next time?", false);
    typeString(input, "yes");
    input.emit("keypress", undefined, key("return"));

    await expect(promise).resolves.toBe(true);
  });

  it("resolves null when cancelled with ctrl-c", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = confirmPrompt(io, "Save to .env for next time?");
    input.emit("keypress", undefined, key("c", { ctrl: true }));

    await expect(promise).resolves.toBeNull();
  });

  it("re-prompts with an error message on an unrecognized answer", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = confirmPrompt(io, "Save to .env for next time?");

    typeString(input, "a");
    input.emit("keypress", undefined, key("return"));
    await new Promise((resolve) => setImmediate(resolve));

    expect(output.lines.join("")).toContain("please answer y or n");

    typeString(input, "y");
    input.emit("keypress", undefined, key("return"));

    await expect(promise).resolves.toBe(true);
  });

  it("resolves BACK on escape", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = confirmPrompt(io, "Save to .env for next time?");
    input.emit("keypress", undefined, key("escape"));

    await expect(promise).resolves.toBe(BACK);
  });
});
