# 🏁 llmrace

Fast.com but for LLMs — a CLI benchmark tool that races LLM providers head-to-head
on tokens/sec, time-to-first-token, and total latency.

## Quick Start

```bash
npx llmrace --provider groq --model llama-3.3-70b-versatile
```

## Installing with npm

If you'd rather not type `npx` every time, install it globally:

```bash
npm install -g llmrace
llmrace --provider groq --model llama-3.3-70b-versatile
```

Or add it to a project as a dev dependency:

```bash
npm install --save-dev llmrace
npx llmrace --provider groq --model llama-3.3-70b-versatile
```

Or, from a local clone of this repo:

```bash
npm install
npm run bench -- --provider groq --model llama-3.3-70b-versatile
```

## Setting Your API Key

Each provider reads its key from an environment variable named
`<PROVIDER>_API_KEY` (e.g. `GROQ_API_KEY`, `OPENAI_API_KEY`). Pick whichever
of the three ways below fits your workflow:

**1. Export it in your shell (good for one-off testing)**

```bash
export GROQ_API_KEY=sk-your-key-here
npx llmrace --provider groq --model llama-3.3-70b-versatile
```

**2. Pass it inline on the command (good for a single command, no shell history)**

```bash
GROQ_API_KEY=sk-your-key-here npx llmrace --provider groq --model llama-3.3-70b-versatile
```

**3. Put it in a `.env` file (good for repeated local use)**

```bash
cp .env.example .env
# then edit .env and fill in the key(s) you need, e.g.:
# GROQ_API_KEY=sk-your-key-here
npx llmrace --provider groq --model llama-3.3-70b-versatile
```

The `.env` file is loaded automatically — no extra flag needed.

**Or skip env vars entirely and pass the key directly:**

```bash
npx llmrace --provider groq --model llama-3.3-70b-versatile --api-key sk-your-key-here
```

`--api-key` always overrides the environment variable. The `local` provider
(Ollama, LM Studio, llama.cpp, etc.) doesn't need a key at all — it just needs
`--base-url`.

Available env var names, one per provider:

```
OPENAI_API_KEY
ANTHROPIC_API_KEY
GROQ_API_KEY
CEREBRAS_API_KEY
FIREWORKS_API_KEY
MISTRAL_API_KEY
OPENROUTER_API_KEY
GOOGLE_API_KEY
XAI_API_KEY
ZAI_API_KEY
META_API_KEY
KIMI_API_KEY
```

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

## Options

| Flag | Description |
| --- | --- |
| `-p, --provider <id>` | Provider id for a single run (see supported providers above, or run `--list`) |
| `-m, --model <id>` | Model id for a single run |
| `--base-url <url>` | Required for provider `local` — the OpenAI-compatible endpoint to hit |
| `--api-key <key>` | Overrides the `<PROVIDER>_API_KEY` env var |
| `--race <list>` | Comma-separated `provider:model` entries, run in parallel |
| `--prompt <text>` | Overrides the default benchmark prompt |
| `--runs <n>` | Repeat the benchmark `n` times and report median/min/max (default `1`) |
| `--static-prompt` | Send the exact same prompt every run (default: a per-run marker is appended to dodge proxy/gateway response caching) |
| `--json` | Emit machine-readable JSON on stdout instead of text |
| `--timeout <ms>` | Abort if no result after this many ms (default `120000`) |
| `--list` | List known provider ids and exit |
| `-h, --help` | Show help |

Running `npx llmrace` with no flags in an interactive terminal launches a
step-by-step wizard instead.

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
