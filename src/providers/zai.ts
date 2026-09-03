import { PROVIDERS } from "../config";
import { createOpenAICompatibleAdapter } from "./openaiCompatible";

export const zaiAdapter = createOpenAICompatibleAdapter(
  PROVIDERS.zai.baseUrl!,
  PROVIDERS.zai.name,
  PROVIDERS.zai.displayName
);
