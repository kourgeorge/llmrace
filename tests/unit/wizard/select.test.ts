import { describe, expect, it } from "vitest";
import { BACK, select, type SelectChoice, type SelectIO } from "../../../src/wizard/select";
import { charKey, fakeInput, fakeOutput, key } from "./fixtures";

const choices: SelectChoice<string>[] = [
  { value: "groq", label: "Groq" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
];

describe("select", () => {
  it("resolves the first choice on enter with no input", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = select(io, "Provider", choices);
    input.emit("keypress", undefined, key("return"));

    await expect(promise).resolves.toBe("groq");
  });

  it("moves the cursor down and wraps around to the top", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = select(io, "Provider", choices);
    input.emit("keypress", undefined, key("down"));
    input.emit("keypress", undefined, key("down"));
    input.emit("keypress", undefined, key("down")); // wraps: 0 -> 1 -> 2 -> 0
    input.emit("keypress", undefined, key("return"));

    await expect(promise).resolves.toBe("groq");
  });

  it("moves the cursor up and wraps around to the bottom", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = select(io, "Provider", choices);
    input.emit("keypress", undefined, key("up")); // wraps from 0 straight to the last item
    input.emit("keypress", undefined, key("return"));

    await expect(promise).resolves.toBe("anthropic");
  });

  it("does not filter on typed characters until '/' is pressed", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = select(io, "Provider", choices);
    // Typing "an" before "/" should do nothing to the list.
    input.emit("keypress", "a", charKey("a"));
    input.emit("keypress", "n", charKey("n"));
    input.emit("keypress", undefined, key("return"));

    // Cursor is still at index 0 ("groq") because nothing filtered.
    await expect(promise).resolves.toBe("groq");
  });

  it("filters the list once '/' is pressed, matching by label", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = select(io, "Provider", choices);
    input.emit("keypress", "/", charKey("/"));
    input.emit("keypress", "a", charKey("a"));
    input.emit("keypress", "n", charKey("n")); // filter: "an" -> matches only "Anthropic"
    input.emit("keypress", undefined, key("return"));

    await expect(promise).resolves.toBe("anthropic");
  });

  it("backspace removes the last filter character", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = select(io, "Provider", choices);
    input.emit("keypress", "/", charKey("/"));
    input.emit("keypress", "o", charKey("o"));
    input.emit("keypress", "x", charKey("x")); // filter "ox" matches nothing
    input.emit("keypress", undefined, key("backspace")); // back to "o" -> matches Groq, OpenAI
    input.emit("keypress", undefined, key("return"));

    await expect(promise).resolves.toBe("groq");
  });

  it("resolves null on ctrl-c and restores the terminal", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = select(io, "Provider", choices);
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

    const promise = select(io, "Provider", choices);
    input.emit("keypress", undefined, key("escape"));

    await expect(promise).resolves.toBe(BACK);
  });

  it("resolves null when the input stream closes", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = select(io, "Provider", choices);
    input.emit("close");

    await expect(promise).resolves.toBeNull();
    expect(input.listenerCount("keypress")).toBe(0);
  });

  it("settles only once even if multiple terminal events fire", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = select(io, "Provider", choices);
    input.emit("keypress", undefined, key("return"));
    input.emit("keypress", undefined, key("c", { ctrl: true })); // ignored, already settled
    input.emit("close"); // ignored too

    await expect(promise).resolves.toBe("groq");
  });

  it("caps rendered rows for a long list instead of printing every choice", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    (output as unknown as { rows: number }).rows = 20; // pretend a small terminal
    output.isTTY = true;
    const io: SelectIO = { input, output };

    const manyChoices: SelectChoice<string>[] = Array.from({ length: 100 }, (_, i) => ({
      value: `model-${i}`,
      label: `model-${i}`,
    }));

    const promise = select(io, "Model", manyChoices);
    const firstRender = output.lines.join("");
    const renderedRows = firstRender.split("\n").filter((line) => line.includes("model-"));

    // Far fewer rows than the full 100-item list, and a "more below" hint.
    expect(renderedRows.length).toBeLessThan(20);
    expect(firstRender).toContain("more");

    input.emit("keypress", undefined, key("return"));
    await promise;
  });

  it("renders something to output on the initial call", async () => {
    const input = fakeInput();
    const output = fakeOutput();
    const io: SelectIO = { input, output };

    const promise = select(io, "Provider", choices);
    expect(output.lines.length).toBeGreaterThan(0);
    expect(output.lines.join("")).toContain("Provider");

    input.emit("keypress", undefined, key("return"));
    await promise;
  });
});
