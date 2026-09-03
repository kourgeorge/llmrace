export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
}

export interface StreamParams {
  apiKey: string;
  model: string;
  prompt: string;
  onChunk: (text: string) => void;
  onFirstToken: () => void;
  onUsage?: (usage: UsageInfo) => void;
  // Called when the provider sends an SSE comment (e.g. OpenRouter's
  // ": OPENROUTER PROCESSING" heartbeat). Useful for surfacing a
  // "queued at provider" UX while waiting for the first token.
  onProcessing?: () => void;
  onDone: (rawResponse: object) => void;
  onError: (err: Error) => void;
  signal: AbortSignal;
}

export interface ProviderAdapter {
  id: string;
  name: string;
  stream(params: StreamParams): Promise<void>;
}
