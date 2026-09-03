import { PROVIDERS } from "../config";
import { createOpenAICompatibleAdapter } from "./openaiCompatible";

export const openaiAdapter = createOpenAICompatibleAdapter(
  PROVIDERS.openai.baseUrl!,
  PROVIDERS.openai.name,
  PROVIDERS.openai.displayName
);
