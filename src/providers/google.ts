import { PROVIDERS } from "../config";
import { createOpenAICompatibleAdapter } from "./openaiCompatible";

// Google exposes an OpenAI-compatible endpoint for Gemini models.
// See: https://ai.google.dev/gemini-api/docs/openai
export const googleAdapter = createOpenAICompatibleAdapter(
  PROVIDERS.google.baseUrl!,
  PROVIDERS.google.name,
  PROVIDERS.google.displayName
);
