import { PROVIDERS } from "../config";
import { createOpenAICompatibleAdapter } from "./openaiCompatible";

export const xaiAdapter = createOpenAICompatibleAdapter(
  PROVIDERS.xai.baseUrl!,
  PROVIDERS.xai.name,
  PROVIDERS.xai.displayName
);
