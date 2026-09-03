import { PROVIDERS } from "../config";
import { createOpenAICompatibleAdapter } from "./openaiCompatible";

export const mistralAdapter = createOpenAICompatibleAdapter(
  PROVIDERS.mistral.baseUrl!,
  PROVIDERS.mistral.name,
  PROVIDERS.mistral.displayName
);
