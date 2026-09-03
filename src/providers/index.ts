import { openaiAdapter } from "./openai";
import { anthropicAdapter } from "./anthropic";
import { groqAdapter } from "./groq";
import { cerebrasAdapter } from "./cerebras";
import { fireworksAdapter } from "./fireworks";
import { mistralAdapter } from "./mistral";
import { openrouterAdapter } from "./openrouter";
import { googleAdapter } from "./google";
import { xaiAdapter } from "./xai";
import { zaiAdapter } from "./zai";
import { metaAdapter } from "./meta";
import { kimiAdapter } from "./kimi";
import type { ProviderAdapter } from "./types";

export const providers: Record<string, ProviderAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  groq: groqAdapter,
  cerebras: cerebrasAdapter,
  fireworks: fireworksAdapter,
  mistral: mistralAdapter,
  openrouter: openrouterAdapter,
  google: googleAdapter,
  xai: xaiAdapter,
  zai: zaiAdapter,
  meta: metaAdapter,
  kimi: kimiAdapter,
};

export type { ProviderAdapter, StreamParams } from "./types";
export { createOpenAICompatibleAdapter, normalizeBaseURL } from "./openaiCompatible";
