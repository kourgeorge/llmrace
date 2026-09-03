import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { charKey, fakeInput, fakeOutput, key } from "./fixtures";

vi.mock("../../../src/wizard/models", () => ({
  fetchModels: vi.fn(),
}));
vi.mock("../../../src/wizard/env", () => ({
  appendKeyToEnv: vi.fn(),
}));

import { runWizard } from "../../../src/wizard/index";
import { appendKeyToEnv } from "../../../src/wizard/env";
import { fetchModels } from "../../../src/wizard/models";

const fetchModelsMock = fetchModels as unknown as ReturnType<typeof vi.fn>;
const appendKeyToEnvMock = appendKeyToEnv as unknown as ReturnType<typeof vi.fn>;

/** Lets pending promise-chain microtasks (the `await`s between wizard steps) settle. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const typeText = (input: ReturnType<typeof fakeInput>, text: string): void => {
  for (const ch of text) input.emit("keypress", ch, charKey(ch));
};

const filterSelect = (input: ReturnType<typeof fakeInput>, query: string): void => {
  input.emit("keypress", "/", charKey("/"));
  typeText(input, query);
  input.emit("keypress", undefined, key("return"));
};

/** Accepts the default "runs" value — the common tail. */
const acceptDefaultRuns = async (input: ReturnType<typeof fakeInput>): Promise<void> => {
  input.emit("keypress", undefined, key("return")); // accept default runs (1)
};

describe("runWizard", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    fetchModelsMock.mockReset();
    appendKeyToEnvMock.mockReset().mockResolvedValue(undefined);
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("prompts for a key, saves it on confirmation, and lists fetched models", async () => {
    fetchModelsMock.mockResolvedValue(["model-a", "model-b"]);
    const input = fakeInput();
    const output = fakeOutput();

    const promise = runWizard({ input, output });

    filterSelect(input, "openai");
    await flush();

    typeText(input, "sk-test");
    input.emit("keypress", undefined, key("return"));
    await flush();

    input.emit("keypress", undefined, key("return")); // accept default "Y" for save prompt
    await flush();

    input.emit("keypress", undefined, key("return")); // pick "model-a" (cursor at 0)
    await flush();

    await acceptDefaultRuns(input);

    await expect(promise).resolves.toEqual({
      providerId: "openai",
      modelId: "model-a",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      runs: 1,
      staticPrompt: false,
    });
    expect(appendKeyToEnvMock).toHaveBeenCalledWith("openai", "sk-test");
    expect(fetchModelsMock).toHaveBeenCalledWith("openai", "sk-test", "https://api.openai.com/v1");
  });

  it("does not save the key when the user declines", async () => {
    fetchModelsMock.mockResolvedValue(["model-a"]);
    const input = fakeInput();
    const output = fakeOutput();

    const promise = runWizard({ input, output });

    filterSelect(input, "openai");
    await flush();

    typeText(input, "sk-test");
    input.emit("keypress", undefined, key("return"));
    await flush();

    typeText(input, "n");
    input.emit("keypress", undefined, key("return")); // decline save
    await flush();

    input.emit("keypress", undefined, key("return")); // pick "model-a"
    await flush();

    await acceptDefaultRuns(input);

    await promise;
    expect(appendKeyToEnvMock).not.toHaveBeenCalled();
  });

  it("asks to reuse <PROVIDER>_API_KEY from env and uses it on confirmation", async () => {
    process.env.GROQ_API_KEY = "gsk-env-key";
    fetchModelsMock.mockResolvedValue(["m1"]);
    const input = fakeInput();
    const output = fakeOutput();

    const promise = runWizard({ input, output });

    filterSelect(input, "groq");
    await flush();

    input.emit("keypress", undefined, key("return")); // accept default "Y" to reuse the env key
    await flush();

    input.emit("keypress", undefined, key("return")); // pick "m1"
    await flush();

    await acceptDefaultRuns(input);

    const result = await promise;
    expect(result?.apiKey).toBe("gsk-env-key");
    expect(appendKeyToEnvMock).not.toHaveBeenCalled();
    expect(output.lines.join("")).toContain("Use GROQ_API_KEY from .env?");
    expect(output.lines.join("")).toContain("using GROQ_API_KEY from env");
  });

  it("prompts for a key manually when the user declines the env key", async () => {
    process.env.GROQ_API_KEY = "gsk-env-key";
    fetchModelsMock.mockResolvedValue(["m1"]);
    const input = fakeInput();
    const output = fakeOutput();

    const promise = runWizard({ input, output });

    filterSelect(input, "groq");
    await flush();

    typeText(input, "n");
    input.emit("keypress", undefined, key("return")); // decline reusing the env key
    await flush();

    typeText(input, "sk-manual");
    input.emit("keypress", undefined, key("return"));
    await flush();

    typeText(input, "n");
    input.emit("keypress", undefined, key("return")); // decline save
    await flush();

    input.emit("keypress", undefined, key("return")); // pick "m1"
    await flush();

    await acceptDefaultRuns(input);

    const result = await promise;
    expect(result?.apiKey).toBe("sk-manual");
    expect(appendKeyToEnvMock).not.toHaveBeenCalled();
  });

  it("prompts for a base URL then an optional key for the local provider", async () => {
    fetchModelsMock.mockResolvedValue(["llama"]);
    const input = fakeInput();
    const output = fakeOutput();

    const promise = runWizard({ input, output });

    filterSelect(input, "local");
    await flush();

    input.emit("keypress", undefined, key("return")); // accept default base URL
    await flush();

    input.emit("keypress", undefined, key("return")); // leave the key prompt blank
    await flush();

    input.emit("keypress", undefined, key("return")); // pick "llama"
    await flush();

    await acceptDefaultRuns(input);

    await expect(promise).resolves.toEqual({
      providerId: "local",
      modelId: "llama",
      apiKey: "",
      baseUrl: "http://localhost:11434/v1",
      runs: 1,
      staticPrompt: false,
    });
    expect(appendKeyToEnvMock).not.toHaveBeenCalled();
    expect(fetchModelsMock).toHaveBeenCalledWith("local", "", "http://localhost:11434/v1");
  });

  it("saves a key entered for the local provider on confirmation", async () => {
    fetchModelsMock.mockResolvedValue(["llama"]);
    const input = fakeInput();
    const output = fakeOutput();

    const promise = runWizard({ input, output });

    filterSelect(input, "local");
    await flush();

    input.emit("keypress", undefined, key("return")); // accept default base URL
    await flush();

    typeText(input, "sk-proxy-key");
    input.emit("keypress", undefined, key("return"));
    await flush();

    input.emit("keypress", undefined, key("return")); // accept default "Y" for save prompt
    await flush();

    input.emit("keypress", undefined, key("return")); // pick "llama"
    await flush();

    await acceptDefaultRuns(input);

    await expect(promise).resolves.toEqual({
      providerId: "local",
      modelId: "llama",
      apiKey: "sk-proxy-key",
      baseUrl: "http://localhost:11434/v1",
      runs: 1,
      staticPrompt: false,
    });
    expect(appendKeyToEnvMock).toHaveBeenCalledWith("local", "sk-proxy-key");
    expect(fetchModelsMock).toHaveBeenCalledWith("local", "sk-proxy-key", "http://localhost:11434/v1");
  });

  it("skips the local key prompt when LOCAL_API_KEY is already set", async () => {
    process.env.LOCAL_API_KEY = "sk-env-proxy-key";
    fetchModelsMock.mockResolvedValue(["llama"]);
    const input = fakeInput();
    const output = fakeOutput();

    const promise = runWizard({ input, output });

    filterSelect(input, "local");
    await flush();

    input.emit("keypress", undefined, key("return")); // accept default base URL
    await flush();

    input.emit("keypress", undefined, key("return")); // accept default "Y" to reuse the env key
    await flush();

    input.emit("keypress", undefined, key("return")); // pick "llama"
    await flush();

    await acceptDefaultRuns(input);

    const result = await promise;
    expect(result?.apiKey).toBe("sk-env-proxy-key");
    expect(appendKeyToEnvMock).not.toHaveBeenCalled();
    expect(output.lines.join("")).toContain("using LOCAL_API_KEY from env");
  });

  it("falls back to a free-text model prompt when no models are listed", async () => {
    process.env.GROQ_API_KEY = "gsk-env-key";
    fetchModelsMock.mockResolvedValue([]);
    const input = fakeInput();
    const output = fakeOutput();

    const promise = runWizard({ input, output });

    filterSelect(input, "groq");
    await flush();

    input.emit("keypress", undefined, key("return")); // accept default "Y" to reuse the env key
    await flush();

    typeText(input, "custom-model");
    input.emit("keypress", undefined, key("return"));
    await flush();

    await acceptDefaultRuns(input);

    await expect(promise).resolves.toEqual({
      providerId: "groq",
      modelId: "custom-model",
      apiKey: "gsk-env-key",
      baseUrl: "https://api.groq.com/openai/v1",
      runs: 1,
      staticPrompt: false,
    });
    expect(output.lines.join("")).toContain("couldn't list models");
  });

  it("returns null when the user cancels at the provider picker", async () => {
    const input = fakeInput();
    const output = fakeOutput();

    const promise = runWizard({ input, output });
    input.emit("keypress", undefined, key("escape"));

    await expect(promise).resolves.toBeNull();
    expect(fetchModelsMock).not.toHaveBeenCalled();
    expect(appendKeyToEnvMock).not.toHaveBeenCalled();
  });

  it("returns null when the user cancels the key prompt", async () => {
    const input = fakeInput();
    const output = fakeOutput();

    const promise = runWizard({ input, output });

    filterSelect(input, "openai");
    await flush();

    input.emit("keypress", undefined, key("c", { ctrl: true }));

    await expect(promise).resolves.toBeNull();
    expect(fetchModelsMock).not.toHaveBeenCalled();
    expect(appendKeyToEnvMock).not.toHaveBeenCalled();
  });

  it("escape at the key prompt goes back to the provider picker", async () => {
    fetchModelsMock.mockResolvedValue(["m1"]);
    const input = fakeInput();
    const output = fakeOutput();

    const promise = runWizard({ input, output });

    filterSelect(input, "openai");
    await flush();

    input.emit("keypress", undefined, key("escape")); // back to provider picker
    await flush();

    filterSelect(input, "groq");
    await flush();

    typeText(input, "gsk-test");
    input.emit("keypress", undefined, key("return"));
    await flush();

    input.emit("keypress", undefined, key("return")); // accept default "Y" for save prompt
    await flush();

    input.emit("keypress", undefined, key("return")); // pick "m1"
    await flush();

    await acceptDefaultRuns(input);

    await expect(promise).resolves.toEqual({
      providerId: "groq",
      modelId: "m1",
      apiKey: "gsk-test",
      baseUrl: "https://api.groq.com/openai/v1",
      runs: 1,
      staticPrompt: false,
    });
  });

  it("escape at the base URL prompt goes back to the provider picker", async () => {
    fetchModelsMock.mockResolvedValue(["m1"]);
    const input = fakeInput();
    const output = fakeOutput();

    const promise = runWizard({ input, output });

    filterSelect(input, "local");
    await flush();

    input.emit("keypress", undefined, key("escape")); // back to provider picker
    await flush();

    filterSelect(input, "openai");
    await flush();

    typeText(input, "sk-test");
    input.emit("keypress", undefined, key("return"));
    await flush();

    input.emit("keypress", undefined, key("return")); // accept default "Y" for save prompt
    await flush();

    input.emit("keypress", undefined, key("return")); // pick "m1"
    await flush();

    await acceptDefaultRuns(input);

    await expect(promise).resolves.toEqual({
      providerId: "openai",
      modelId: "m1",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      runs: 1,
      staticPrompt: false,
    });
  });

  it("escape at the save-to-.env confirm re-asks for the key", async () => {
    fetchModelsMock.mockResolvedValue(["m1"]);
    const input = fakeInput();
    const output = fakeOutput();

    const promise = runWizard({ input, output });

    filterSelect(input, "openai");
    await flush();

    typeText(input, "sk-first");
    input.emit("keypress", undefined, key("return"));
    await flush();

    input.emit("keypress", undefined, key("escape")); // back from the save confirm to the key prompt
    await flush();

    typeText(input, "sk-second");
    input.emit("keypress", undefined, key("return"));
    await flush();

    input.emit("keypress", undefined, key("return")); // accept default "Y" for save prompt
    await flush();

    input.emit("keypress", undefined, key("return")); // pick "m1"
    await flush();

    await acceptDefaultRuns(input);

    await expect(promise).resolves.toEqual({
      providerId: "openai",
      modelId: "m1",
      apiKey: "sk-second",
      baseUrl: "https://api.openai.com/v1",
      runs: 1,
      staticPrompt: false,
    });
    expect(appendKeyToEnvMock).toHaveBeenLastCalledWith("openai", "sk-second");
  });

  it("escape at the model picker goes back to the key prompt", async () => {
    fetchModelsMock.mockResolvedValue(["model-a", "model-b"]);
    const input = fakeInput();
    const output = fakeOutput();

    const promise = runWizard({ input, output });

    filterSelect(input, "openai");
    await flush();

    typeText(input, "sk-first");
    input.emit("keypress", undefined, key("return"));
    await flush();

    input.emit("keypress", undefined, key("return")); // accept default "Y" for save prompt
    await flush();

    input.emit("keypress", undefined, key("escape")); // back from the model picker to the key prompt
    await flush();

    typeText(input, "sk-second");
    input.emit("keypress", undefined, key("return"));
    await flush();

    input.emit("keypress", undefined, key("return")); // accept default "Y" for save prompt
    await flush();

    input.emit("keypress", undefined, key("return")); // pick "model-a"
    await flush();

    await acceptDefaultRuns(input);

    await expect(promise).resolves.toEqual({
      providerId: "openai",
      modelId: "model-a",
      apiKey: "sk-second",
      baseUrl: "https://api.openai.com/v1",
      runs: 1,
      staticPrompt: false,
    });
    expect(appendKeyToEnvMock).toHaveBeenLastCalledWith("openai", "sk-second");
  });

  it("accepts a custom runs count", async () => {
    fetchModelsMock.mockResolvedValue(["m1"]);
    const input = fakeInput();
    const output = fakeOutput();

    const promise = runWizard({ input, output });

    filterSelect(input, "openai");
    await flush();

    typeText(input, "sk-test");
    input.emit("keypress", undefined, key("return"));
    await flush();

    input.emit("keypress", undefined, key("return")); // accept default "Y" for save prompt
    await flush();

    input.emit("keypress", undefined, key("return")); // pick "m1"
    await flush();

    typeText(input, "5");
    input.emit("keypress", undefined, key("return")); // custom runs count

    await expect(promise).resolves.toEqual({
      providerId: "openai",
      modelId: "m1",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      runs: 5,
      staticPrompt: false,
    });
  });

  it("rejects non-numeric input at the runs prompt and re-asks", async () => {
    fetchModelsMock.mockResolvedValue(["m1"]);
    const input = fakeInput();
    const output = fakeOutput();

    const promise = runWizard({ input, output });

    filterSelect(input, "openai");
    await flush();

    typeText(input, "sk-test");
    input.emit("keypress", undefined, key("return"));
    await flush();

    input.emit("keypress", undefined, key("return")); // accept default "Y" for save prompt
    await flush();

    input.emit("keypress", undefined, key("return")); // pick "m1"
    await flush();

    typeText(input, "abc");
    input.emit("keypress", undefined, key("return")); // invalid, re-asks
    await flush();

    typeText(input, "3");
    input.emit("keypress", undefined, key("return"));

    const result = await promise;
    expect(result?.runs).toBe(3);
    expect(output.lines.join("")).toContain("please enter a positive whole number");
  });

  it("escape at the runs prompt goes back to the model picker", async () => {
    fetchModelsMock.mockResolvedValue(["model-a", "model-b"]);
    const input = fakeInput();
    const output = fakeOutput();

    const promise = runWizard({ input, output });

    filterSelect(input, "openai");
    await flush();

    typeText(input, "sk-test");
    input.emit("keypress", undefined, key("return"));
    await flush();

    input.emit("keypress", undefined, key("return")); // accept default "Y" for save prompt
    await flush();

    input.emit("keypress", undefined, key("return")); // pick "model-a"
    await flush();

    input.emit("keypress", undefined, key("escape")); // back from runs to model picker
    await flush();

    input.emit("keypress", undefined, key("down"));
    input.emit("keypress", undefined, key("return")); // pick "model-b"
    await flush();

    await acceptDefaultRuns(input);

    await expect(promise).resolves.toEqual({
      providerId: "openai",
      modelId: "model-b",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      runs: 1,
      staticPrompt: false,
    });
  });

});
