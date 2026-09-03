import { PROVIDERS } from "../config";

const MODELS_TIMEOUT_MS = 10_000;

/**
 * List model IDs from a provider's `/models` endpoint. Anthropic and every
 * OpenAI-compatible provider return the same `{ data: [{ id }] }` shape, so
 * one parser covers all of them.
 *
 * Never throws: a bad response, a network error, an unexpected timeout, or a
 * body that doesn't match the expected shape all resolve to `[]` so the
 * wizard can fall back to a free-text model prompt instead of crashing.
 */
export async function fetchModels(providerId: string, apiKey: string, baseUrl: string): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (providerId === PROVIDERS.anthropic.name) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
  } catch {
    return [];
  }

  if (!response.ok) return [];

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return [];
  }

  return parseModelIds(body);
}

function parseModelIds(body: unknown): string[] {
  if (!body || typeof body !== "object" || !("data" in body)) return [];
  const data = (body as { data: unknown }).data;
  if (!Array.isArray(data)) return [];

  const ids: string[] = [];
  for (const entry of data) {
    if (entry && typeof entry === "object" && "id" in entry) {
      const id = (entry as { id: unknown }).id;
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}
