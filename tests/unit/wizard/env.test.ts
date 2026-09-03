import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendKeyToEnv } from "../../../src/wizard/env";

describe("appendKeyToEnv", () => {
  let envPath: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mach1-env-test-"));
    envPath = path.join(dir, ".env");
  });

  afterEach(async () => {
    await fs.rm(path.dirname(envPath), { recursive: true, force: true });
  });

  it("creates a .env file when one doesn't exist yet", async () => {
    await appendKeyToEnv("groq", "gsk-secret", envPath);

    const content = await fs.readFile(envPath, "utf8");
    expect(content).toBe("GROQ_API_KEY=gsk-secret\n");
  });

  it("appends to an existing .env, preserving what was already there", async () => {
    await fs.writeFile(envPath, "OPENAI_API_KEY=sk-existing\n");

    await appendKeyToEnv("groq", "gsk-secret", envPath);

    const content = await fs.readFile(envPath, "utf8");
    expect(content).toBe("OPENAI_API_KEY=sk-existing\nGROQ_API_KEY=gsk-secret\n");
  });

  it("adds a leading newline when the existing file doesn't end with one", async () => {
    await fs.writeFile(envPath, "OPENAI_API_KEY=sk-existing");

    await appendKeyToEnv("groq", "gsk-secret", envPath);

    const content = await fs.readFile(envPath, "utf8");
    expect(content).toBe("OPENAI_API_KEY=sk-existing\nGROQ_API_KEY=gsk-secret\n");
  });

  it("does not duplicate the var when it's already present", async () => {
    await fs.writeFile(envPath, "GROQ_API_KEY=gsk-old\n");

    await appendKeyToEnv("groq", "gsk-new", envPath);

    const content = await fs.readFile(envPath, "utf8");
    expect(content).toBe("GROQ_API_KEY=gsk-old\n");
  });

  it("uses the uppercase <PROVIDER>_API_KEY convention", async () => {
    await appendKeyToEnv("anthropic", "sk-ant-secret", envPath);

    const content = await fs.readFile(envPath, "utf8");
    expect(content).toContain("ANTHROPIC_API_KEY=sk-ant-secret");
  });
});
