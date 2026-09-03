import { PROVIDERS } from "../config";
import { createOpenAICompatibleAdapter } from "./openaiCompatible";
import type { ProviderAdapter, StreamParams } from "./types";

const primaryAdapter = createOpenAICompatibleAdapter(
  PROVIDERS.kimi.baseUrl!,
  PROVIDERS.kimi.name,
  PROVIDERS.kimi.displayName
);

const fallbackAdapter = createOpenAICompatibleAdapter(
  "https://api.moonshot.cn/v1",
  PROVIDERS.kimi.name,
  PROVIDERS.kimi.displayName
);

export const kimiAdapter: ProviderAdapter = {
  id: PROVIDERS.kimi.name,
  name: PROVIDERS.kimi.displayName,

  async stream(params: StreamParams) {
    let primaryFailed = false;
    const originalOnError = params.onError;

    await primaryAdapter.stream({
      ...params,
      onError: (err) => {
        if (params.signal.aborted) {
          originalOnError(err);
          return;
        }

        const msg = err.message || "";
        const isNetworkError =
          msg.includes("Failed to fetch") ||
          msg.includes("NetworkError") ||
          msg.includes("network error") ||
          msg.includes("ENOTFOUND") ||
          msg.includes("ECONNREFUSED");

        if (isNetworkError && !primaryFailed) {
          primaryFailed = true;
          fallbackAdapter.stream(params).catch((fallbackErr) => {
            originalOnError(fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr)));
          });
          return;
        }

        originalOnError(err);
      },
    });
  },
};
