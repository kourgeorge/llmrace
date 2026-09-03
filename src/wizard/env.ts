import { promises as fs } from "node:fs";
import * as path from "node:path";
import { envVarNameFor } from "../config";

const DEFAULT_ENV_PATH = path.join(process.cwd(), ".env");

/**
 * Append `<PROVIDER>_API_KEY=<key>` to a `.env` file, creating the file if it
 * doesn't exist yet. No-ops if that var is already present, so the wizard
 * never clobbers a key the user already set by hand.
 *
 * `envPath` defaults to `.env` in the current working directory (the same
 * file `dotenv/config` loads) but is overridable so tests never touch the
 * real one.
 */
export async function appendKeyToEnv(providerId: string, key: string, envPath: string = DEFAULT_ENV_PATH): Promise<void> {
  const varName = envVarNameFor(providerId);

  let existing = "";
  try {
    existing = await fs.readFile(envPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (hasVar(existing, varName)) return;

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  await fs.appendFile(envPath, `${needsLeadingNewline ? "\n" : ""}${varName}=${key}\n`);
}

function hasVar(content: string, varName: string): boolean {
  return new RegExp(`^${varName}=`, "m").test(content);
}
