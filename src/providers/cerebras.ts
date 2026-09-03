import { PROVIDERS } from "../config";
import { createOpenAICompatibleAdapter } from "./openaiCompatible";

export const cerebrasAdapter = createOpenAICompatibleAdapter(
  PROVIDERS.cerebras.baseUrl!,
  PROVIDERS.cerebras.name,
  PROVIDERS.cerebras.displayName
);
