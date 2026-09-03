import { envVarNameFor, LOCAL_PROVIDER_ID, PROVIDERS, resolveApiKey } from "../config";
import { normalizeBaseURL, providers } from "../providers/index";
import { appendKeyToEnv } from "./env";
import { confirmPrompt, maskedPrompt, textPrompt } from "./input";
import { fetchModels } from "./models";
import { BACK, select, type SelectChoice, type SelectIO } from "./select";

/** Mirrors `RaceConfig` minus `laneId` — the caller assigns that when building lanes. */
export interface WizardResult {
  providerId: string;
  modelId: string;
  apiKey: string;
  /** Only set for the `local` provider. */
  baseUrl?: string;
  runs: number;
  /** Always `false` — the wizard doesn't offer an opt-out; use `--static-prompt` on the CLI for that. */
  staticPrompt: boolean;
}

const DEFAULT_LOCAL_BASE_URL = "http://localhost:11434/v1";
/** Mirrors `DEFAULT_RUNS` in scripts/bench.ts — shown as the default answer here. */
const DEFAULT_RUNS = 1;

const defaultIO: SelectIO = { input: process.stdin, output: process.stderr };

type Step = "provider" | "baseUrl" | "apiKey" | "model" | "runs";

/**
 * Interactive provider -> key -> model wizard. Draws prompts on `io.output`
 * (stderr by default, so `--json` piping on stdout stays clean). Resolves
 * `null` if the user cancels with Ctrl-C, or backs out of the very first
 * step (provider) with Escape. Escape at any later step walks back one step
 * instead of exiting.
 */
export async function runWizard(io: SelectIO = defaultIO): Promise<WizardResult | null> {
  let step: Step = "provider";
  let providerId: string | undefined;
  let isLocal = false;
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  let modelId: string | undefined;
  let runs: number | undefined;

  for (;;) {
    if (step === "provider") {
      const result = await pickProvider(io);
      if (result === null || result === BACK) return null;
      providerId = result;
      isLocal = providerId === LOCAL_PROVIDER_ID;
      baseUrl = PROVIDERS[providerId]?.baseUrl;
      step = isLocal ? "baseUrl" : "apiKey";
      continue;
    }

    if (step === "baseUrl") {
      const entered = await textPrompt(io, "Base URL", { defaultValue: DEFAULT_LOCAL_BASE_URL });
      if (entered === null) return null;
      if (entered === BACK) {
        step = "provider";
        continue;
      }
      baseUrl = normalizeBaseURL(entered);
      step = "apiKey";
      continue;
    }

    if (step === "apiKey") {
      const result = await resolveOrPromptApiKey(io, providerId!, isLocal);
      if (result === null) return null;
      if (result === BACK) {
        step = isLocal ? "baseUrl" : "provider";
        continue;
      }
      apiKey = result;
      step = "model";
      continue;
    }

    if (step === "model") {
      const models = baseUrl ? await fetchModels(providerId!, apiKey!, baseUrl) : [];
      const modelResult = models.length > 0 ? await pickModel(io, models) : await typeModel(io);
      if (modelResult === null) return null;
      if (modelResult === BACK) {
        step = "apiKey";
        continue;
      }
      modelId = modelResult;
      step = "runs";
      continue;
    }

    // step === "runs"
    const result = await promptRuns(io);
    if (result === null) return null;
    if (result === BACK) {
      step = "model";
      continue;
    }
    runs = result;
    return {
      providerId: providerId!,
      modelId: modelId!,
      apiKey: apiKey!,
      baseUrl,
      runs,
      staticPrompt: false,
    };
  }
}

/** Retries until a positive integer is entered; propagates `BACK`/cancel as-is. */
async function promptRuns(io: SelectIO): Promise<number | typeof BACK | null> {
  for (;;) {
    const entered = await textPrompt(io, "Number of runs", { defaultValue: String(DEFAULT_RUNS) });
    if (entered === null || entered === BACK) return entered;

    const parsed = Number.parseInt(entered, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;

    io.output.write("  please enter a positive whole number\n");
  }
}

/**
 * Resolves an API key from `<PROVIDER>_API_KEY` env, or prompts for one
 * (masked) and offers to save it to `.env`. For the `local` provider the key
 * is optional — a blank answer resolves to `""` with no save prompt, since
 * plenty of local endpoints (Ollama, etc.) don't need one.
 *
 * If a key is already set in the env, asks whether to reuse it rather than
 * assuming — declining falls through to the manual entry prompt below.
 * Escape at that confirm propagates out as `BACK` to the caller. Escape at
 * the save-to-.env confirm re-asks for the key rather than propagating out —
 * that's "one step back" within this function. Escape at the key prompt
 * itself propagates out as `BACK` to the caller.
 */
async function resolveOrPromptApiKey(
  io: SelectIO,
  providerId: string,
  optional: boolean
): Promise<string | typeof BACK | null> {
  const { output } = io;
  const envName = envVarNameFor(providerId);
  const fromEnv = resolveApiKey(providerId, undefined);
  if (fromEnv) {
    const useEnv = await confirmPrompt(io, `Use ${envName} from .env?`);
    if (useEnv === null || useEnv === BACK) return useEnv;
    if (useEnv) {
      output.write(`using ${envName} from env\n`);
      return fromEnv;
    }
  }

  const displayName = PROVIDERS[providerId]?.displayName ?? providerId;
  const message = optional ? `${displayName} API key (leave blank if none)` : `${displayName} API key`;

  for (;;) {
    const entered = await maskedPrompt(io, message);
    if (entered === null || entered === BACK) return entered;
    if (!entered) return "";

    const shouldSave = await confirmPrompt(io, "Save to .env for next time?");
    if (shouldSave === null) return null;
    if (shouldSave === BACK) continue;
    if (shouldSave) await appendKeyToEnv(providerId, entered);

    return entered;
  }
}

async function pickProvider(io: SelectIO): Promise<string | typeof BACK | null> {
  const ids = Object.keys(providers).concat(LOCAL_PROVIDER_ID);
  const choices: SelectChoice<string>[] = ids.map((id) => ({
    value: id,
    label: PROVIDERS[id]?.displayName ?? id,
  }));
  return select(io, "Provider", choices);
}

async function pickModel(io: SelectIO, models: string[]): Promise<string | typeof BACK | null> {
  const choices: SelectChoice<string>[] = models.map((id) => ({ value: id, label: id }));
  return select(io, `Model (${models.length} available)`, choices);
}

async function typeModel(io: SelectIO): Promise<string | typeof BACK | null> {
  io.output.write("⚠ couldn't list models\n");
  return textPrompt(io, "Model");
}
