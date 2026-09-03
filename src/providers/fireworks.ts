import { PROVIDERS } from "../config";
import { createOpenAICompatibleAdapter } from "./openaiCompatible";

export const fireworksAdapter = createOpenAICompatibleAdapter(
  PROVIDERS.fireworks.baseUrl!,
  PROVIDERS.fireworks.name,
  PROVIDERS.fireworks.displayName
);
