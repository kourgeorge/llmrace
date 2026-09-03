export interface BenchmarkMetrics {
  ttft: number | null;
  ttlt: number | null;
  tokenCount: number;
  tokensPerSecond: number | null;
  provider: string;
  model: string;
  promptLength: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface MetricsTracker {
  start(): void;
  recordFirstToken(): void;
  recordChunk(text: string): void;
  recordUsage(inputTokens: number, outputTokens: number): void;
  finish(): void;
  getMetrics(): BenchmarkMetrics;
}

function estimateTokenCount(text: string): number {
  // ~4 chars per token is a better heuristic than word count
  // words undercount punctuation, numbers, and subword tokens
  return Math.ceil(text.length / 4);
}

export function createMetricsTracker(provider: string, model: string, promptLength: number): MetricsTracker {
  let startTime: number | null = null;
  let firstTokenTime: number | null = null;
  let endTime: number | null = null;
  let totalText = "";
  let tokenCount = 0;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  return {
    start() {
      startTime = performance.now();
      firstTokenTime = null;
      endTime = null;
      totalText = "";
      tokenCount = 0;
      inputTokens = null;
      outputTokens = null;
    },

    recordFirstToken() {
      if (firstTokenTime === null && startTime !== null) {
        firstTokenTime = performance.now() - startTime;
      }
    },

    recordChunk(text: string) {
      totalText += text;
      tokenCount = estimateTokenCount(totalText);
    },

    recordUsage(input: number, output: number) {
      inputTokens = input;
      outputTokens = output;
      tokenCount = output;
    },

    finish() {
      if (startTime !== null) {
        endTime = performance.now() - startTime;
      }
    },

    getMetrics(): BenchmarkMetrics {
      const ttlt = endTime ?? (startTime !== null ? performance.now() - startTime : null);
      
      // generation time = ttlt minus ttft (exclude the wait for first token)
      let generationTime = ttlt && firstTokenTime ? ttlt - firstTokenTime : ttlt;
      
      // Guard against near-zero generation times that would produce unrealistic TPS
      const MIN_GENERATION_TIME_MS = 10;
      if (generationTime !== null && generationTime > 0 && generationTime < MIN_GENERATION_TIME_MS) {
        generationTime = MIN_GENERATION_TIME_MS;
      }
      
      const outputForTps = outputTokens ?? estimateTokenCount(totalText);
      const tokensPerSecond = generationTime && generationTime > 0 && outputForTps > 0
        ? (outputForTps / generationTime) * 1000
        : null;

      return {
        ttft: firstTokenTime,
        ttlt,
        tokenCount,
        tokensPerSecond: tokensPerSecond !== null ? Math.round(tokensPerSecond * 10) / 10 : null,
        provider,
        model,
        promptLength,
        inputTokens,
        outputTokens,
      };
    },
  };
}
