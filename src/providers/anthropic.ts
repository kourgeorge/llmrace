import { PROVIDERS } from "../config";
import type { ProviderAdapter, StreamParams } from "./types";

export const anthropicAdapter: ProviderAdapter = {
  id: PROVIDERS.anthropic.name,
  name: PROVIDERS.anthropic.displayName,

  async stream({ apiKey, model, prompt, onChunk, onFirstToken, onUsage, onDone, onError, signal }: StreamParams) {
    // Strip provider prefix (e.g. "anthropic/claude-..." → "claude-...")
    const modelId = model.includes("/") ? model.split("/").slice(1).join("/") : model;

    let response: Response;
    try {
      response = await fetch(`${PROVIDERS.anthropic.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }],
          stream: true,
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
      if (response.status === 401) {
        errMsg = "Invalid API key. Please check your Anthropic API key and try again.";
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
    const rawEvents: object[] = [];
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();

          try {
            const parsed = JSON.parse(data);
            rawEvents.push(parsed);

            if (parsed.type === "message_start" && parsed.message?.usage) {
              inputTokens = parsed.message.usage.input_tokens;
            }
            if (parsed.type === "message_delta" && parsed.usage) {
              outputTokens = parsed.usage.output_tokens;
            }

            if (parsed.type === "content_block_delta" && parsed.delta?.text) {
              if (!firstTokenFired) {
                firstTokenFired = true;
                onFirstToken();
              }
              onChunk(parsed.delta.text);
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }

      if (inputTokens !== null && outputTokens !== null && onUsage) {
        onUsage({ inputTokens, outputTokens });
      }
      onDone({ events: rawEvents });
    } catch (err) {
      if (signal.aborted) return;
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  },
};
