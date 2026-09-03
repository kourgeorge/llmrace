export const LOCAL_PROVIDER_ID = "local";

export interface ProviderMetadata {
  name: string;
  displayName: string;
  /** API root. Omitted for `local`, which takes it from --base-url at runtime. */
  baseUrl?: string;
}

export const PROVIDERS: Record<string, ProviderMetadata> = {
  openai: { name: "openai", displayName: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  anthropic: { name: "anthropic", displayName: "Anthropic", baseUrl: "https://api.anthropic.com/v1" },
  groq: { name: "groq", displayName: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  cerebras: { name: "cerebras", displayName: "Cerebras", baseUrl: "https://api.cerebras.ai/v1" },
  fireworks: {
    name: "fireworks",
    displayName: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
  },
  mistral: { name: "mistral", displayName: "Mistral", baseUrl: "https://api.mistral.ai/v1" },
  openrouter: { name: "openrouter", displayName: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  google: {
    name: "google",
    displayName: "Google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  xai: { name: "xai", displayName: "x.ai", baseUrl: "https://api.x.ai/v1" },
  zai: { name: "zai", displayName: "Z.ai", baseUrl: "https://api.z.ai/api/paas/v4" },
  meta: { name: "meta", displayName: "Meta", baseUrl: "https://api.meta.ai/v1" },
  kimi: { name: "kimi", displayName: "Kimi", baseUrl: "https://api.moonshot.ai/v1" },
  local: { name: LOCAL_PROVIDER_ID, displayName: "Local" },
};

export function envVarNameFor(providerId: string): string {
  return `${providerId.toUpperCase()}_API_KEY`;
}

/**
 * Resolve an API key for a lane: explicit flag wins, then the derived env var.
 * Returns "" for the local provider (auth is optional there) when nothing is set.
 */
export function resolveApiKey(providerId: string, flagValue: string | undefined): string {
  if (flagValue) return flagValue;
  const envName = envVarNameFor(providerId);
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  return "";
}
