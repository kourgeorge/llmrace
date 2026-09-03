import { PROVIDERS } from "../config";
import { createOpenAICompatibleAdapter } from "./openaiCompatible";

// OpenRouter recommends HTTP-Referer and X-Title headers for app attribution.
// These are optional but help identify traffic source in their dashboard.
const EXTRA_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://iamspeed.dev",
  "X-Title": "I am speed.",
};

export const openrouterAdapter = createOpenAICompatibleAdapter(
  PROVIDERS.openrouter.baseUrl!,
  PROVIDERS.openrouter.name,
  PROVIDERS.openrouter.displayName,
  EXTRA_HEADERS
);
