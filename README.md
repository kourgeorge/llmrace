# 🏁 llmrace

Fast.com but for LLMs — a CLI benchmark tool that races LLM providers head-to-head
on tokens/sec, time-to-first-token, and total latency.

## Quick Start

```bash
npx llmrace --provider groq --model llama-3.3-70b-versatile
```

Or, from a local clone:

```bash
npm install
npm run bench -- --provider groq --model llama-3.3-70b-versatile
```

Set the relevant `<PROVIDER>_API_KEY` env var (or copy `.env.example` to `.env`
and fill it in), or pass `--api-key <key>` directly.

## Usage

```bash
npx llmrace --help
```

Race two or more providers on the same prompt:

```bash
npx llmrace --race groq:llama-3.3-70b-versatile,openai:gpt-4o-mini
```

Run it a few times and get median/min/max stats:

```bash
npx llmrace --provider groq --model llama-3.3-70b-versatile --runs 5
```

Supported providers: OpenAI, Anthropic, Groq, Cerebras, Fireworks AI, Mistral,
OpenRouter, Google (Gemini), x.ai, z.ai, Meta, Kimi (Moonshot AI), and Local
(Ollama, LM Studio, llama.cpp, or any OpenAI-compatible server).

## Adding a Provider

1. Create a new adapter in `src/providers/` (many providers can reuse the OpenAI-compatible adapter).
2. Register it in `src/providers/index.ts`.
3. Add provider metadata to `src/config.ts`.

## Testing

```bash
npm test
```

## License

MIT
