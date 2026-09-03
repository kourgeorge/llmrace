import type { ProviderAdapter, StreamParams } from "./types";

export function normalizeBaseURL(input: string): string {
  if (!input) return "";
  let url = input.trim().replace(/\/+$/, "");
  if (!/\/v1$|\/openai\/v1$/.test(url)) {
    url = url + "/v1";
  }
  return url;
}

export interface OpenAICompatibleOptions {
  /** When false, omit stream_options from the request body (for APIs that reject it). */
  sendStreamOptions?: boolean;
}

export function createOpenAICompatibleAdapter(
  baseURL: string,
  providerName: string,
  displayName: string,
  extraHeaders?: Record<string, string>,
  options?: OpenAICompatibleOptions
): ProviderAdapter {
  return {
    id: providerName,
    name: displayName,

    async stream({
      apiKey,
      model,
      prompt,
      onChunk,
      onFirstToken,
      onUsage,
      onProcessing,
      onDone,
      onError,
      signal,
    }: StreamParams) {
      // Strip leading provider prefix only when appropriate.
      // For Groq, some systems intentionally use "groq/xxx" as the model id.
      let modelId = model;
      if (model.startsWith(`${providerName}/`)) {
        const candidate = model.slice(providerName.length + 1);
        if (providerName === 'groq' && model.startsWith('groq/')) {
          modelId = model; // keep full for groq/compound etc.
        } else {
          modelId = candidate;
        }
      }

      let response: Response;
      try {
        response = await fetch(`${baseURL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            ...(extraHeaders || {}),
          },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: prompt }],
            stream: true,
            ...(options?.sendStreamOptions !== false
              ? { stream_options: { include_usage: true } }
              : {}),
          }),
          signal,
        });
      } catch (err) {
        if (signal.aborted) return;
        onError(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      if (!response.ok) {
        let errMsg = `HTTP ${response.status}`;
        try {
          const body = await response.json();
          errMsg = body?.error?.message || errMsg;
        } catch {
          // ignore parse failure
        }
        onError(new Error(errMsg));
        return;
      }

      if (!response.body) {
        onError(new Error("Response body is null"));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let firstTokenFired = false;
      const rawChunks: object[] = [];
      let usageData: { prompt_tokens: number; completion_tokens: number } | null = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            // SSE comment lines start with ":" and must be ignored per spec.
            // OpenRouter sends ": OPENROUTER PROCESSING" as a heartbeat while
            // a request is queued or being processed — surface it via onProcessing.
            if (trimmed.startsWith(":")) {
              if (onProcessing) onProcessing();
              continue;
            }
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              rawChunks.push(parsed);
              if (parsed.usage) {
                // Reasoning tokens are handled differently across providers:
                // - Nested (OpenAI o-series, Meta Muse Spark):
                //     total_tokens ≈ prompt + completion
                //     completion already includes reasoning → subtract for visible TPS
                // - Separate (xAI):
                //     total_tokens ≈ prompt + completion + reasoning
                //     completion is already visible-only → do not subtract
                // Comparing total_tokens is the reliable discriminator; a
                // reasoning ≤ completion check alone is wrong when xAI emits
                // more visible tokens than reasoning tokens.
                const completionTokens = parsed.usage.completion_tokens;
                const promptTokens = parsed.usage.prompt_tokens;
                if (typeof completionTokens === 'number' && !isNaN(completionTokens)) {
                  const rawReasoning = parsed.usage.completion_tokens_details?.reasoning_tokens;
                  const reasoning = typeof rawReasoning === 'number' && !isNaN(rawReasoning) ? rawReasoning : 0;
                  const totalTokens = parsed.usage.total_tokens;
                  const hasTotal = typeof totalTokens === 'number' && !isNaN(totalTokens)
                    && typeof promptTokens === 'number' && !isNaN(promptTokens);
                  // Nested accounting: total matches prompt+completion (reasoning inside).
                  // Separate accounting: total matches prompt+completion+reasoning.
                  const nestedByTotal = hasTotal
                    && Math.abs(totalTokens - (promptTokens + completionTokens)) <= 1;
                  const separateByTotal = hasTotal
                    && reasoning > 0
                    && Math.abs(totalTokens - (promptTokens + completionTokens + reasoning)) <= 1;
                  const shouldSubtract = reasoning > 0
                    && reasoning <= completionTokens
                    && !separateByTotal
                    && (nestedByTotal || !hasTotal);
                  usageData = {
                    prompt_tokens: promptTokens,
                    completion_tokens: shouldSubtract
                      ? completionTokens - reasoning
                      : completionTokens,
                  };
                } else {
                  // Fallback: use original values if completion_tokens is missing/invalid
                  usageData = {
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens,
                  };
                }
              }
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                if (!firstTokenFired) {
                  firstTokenFired = true;
                  onFirstToken();
                }
                onChunk(content);
              }
            } catch {
              // skip malformed SSE lines
            }
          }
        }

        if (usageData && onUsage) {
          onUsage({ inputTokens: usageData.prompt_tokens, outputTokens: usageData.completion_tokens });
        }
        onDone({ chunks: rawChunks });
      } catch (err) {
        if (signal.aborted) return;
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}
