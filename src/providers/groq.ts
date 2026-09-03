import { PROVIDERS } from "../config";
import { createOpenAICompatibleAdapter } from "./openaiCompatible";

export const groqAdapter = createOpenAICompatibleAdapter(
  PROVIDERS.groq.baseUrl!,
  PROVIDERS.groq.name,
  PROVIDERS.groq.displayName
);
