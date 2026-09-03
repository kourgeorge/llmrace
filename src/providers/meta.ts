import { PROVIDERS } from "../config";
import { createOpenAICompatibleAdapter } from "./openaiCompatible";

export const metaAdapter = createOpenAICompatibleAdapter(
  PROVIDERS.meta.baseUrl!,
  PROVIDERS.meta.name,
  PROVIDERS.meta.displayName
);
