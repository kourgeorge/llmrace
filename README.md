<div align="center">

# 🏁 llmrace

**Speedtest.net, but for LLMs.**
Benchmark how fast a model actually responds — tokens/sec, time-to-first-token, and total latency — right from your terminal.

[![npm version](https://img.shields.io/npm/v/llmrace.svg?color=cb3837&label=npm)](https://www.npmjs.com/package/llmrace)
[![npm downloads](https://img.shields.io/npm/dm/llmrace.svg?color=cb3837)](https://www.npmjs.com/package/llmrace)
[![node](https://img.shields.io/node/v/llmrace.svg?color=339933&logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/-TypeScript-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![license](https://img.shields.io/npm/l/llmrace.svg?color=blue)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

</div>

## Quick Start

Two commands. That's the whole tool.

Groq has a free tier, so it's the fastest way to try this — grab a key at [console.groq.com/keys](https://console.groq.com/keys):

```bash
export GROQ_API_KEY=your-key-here

npx llmrace --provider groq --model openai/gpt-oss-120b            # 1. one quick test
npx llmrace --provider groq --model openai/gpt-oss-120b --runs 5   # 2. 5 runs → median/min/max
```

Run #1 gives you a single reading. Run #2 repeats it and reports the median, min, and max — so one lucky (or unlucky) request doesn't fool you.

No key yet, or you'd rather pick interactively? Run `npx llmrace` with nothing else and a wizard walks you through provider, model, and API key.

<p align="center">
  <img src="docs/demo.svg" alt="llmrace running one model five times and reporting median, min, and max tokens/sec, TTFT, and total time" width="880">
</p>

- 🎯 **Real percentiles, not one lucky run** — `--runs N` reports median/min/max.
- 📊 **Two throughput numbers** — `stream tok/s` for raw per-token speed, `eff tok/s` (tokens ÷ total time) for a number that's still fair when a provider buffers its response instead of streaming it.
- 🔌 **13 providers out of the box** — OpenAI, Anthropic, Groq, Cerebras, Fireworks, Mistral, OpenRouter, Google, x.ai, z.ai, Meta, Kimi, plus any OpenAI-compatible local server (Ollama, LM Studio, llama.cpp…).
- 🤖 **Scriptable** — `--json` for CI, dashboards, or your own leaderboard.

Want to compare providers instead of testing one? That's optional — see [Racing Providers](#racing-providers-optional).

## Table of Contents

- [Quick Start](#quick-start)
- [Installing](#installing)
- [Setting Your API Key](#setting-your-api-key)
- [Usage](#usage)
- [Options](#options)
- [Racing Providers (Optional)](#racing-providers-optional)
- [Supported Providers](#supported-providers)
- [Adding a Provider](#adding-a-provider)
- [Testing](#testing)
- [Contributing](#contributing)
- [License](#license)

## Installing

<details>
<summary><b>Global install</b> — if you'd rather not type <code>npx</code> every time</summary>

```bash
npm install -g llmrace
llmrace --provider groq --model openai/gpt-oss-120b
```

</details>

<details>
<summary><b>Project dev dependency</b></summary>

```bash
npm install --save-dev llmrace
npx llmrace --provider groq --model openai/gpt-oss-120b
```

</details>

<details>
<summary><b>From a local clone</b></summary>

```bash
git clone https://github.com/kourgeorge/llmrace.git
cd llmrace
npm install
npm run bench -- --provider groq --model openai/gpt-oss-120b
```

</details>

Requires Node.js 18+.

## Setting Your API Key

Each provider reads its key from an environment variable named `<PROVIDER>_API_KEY` (e.g. `GROQ_API_KEY`, `OPENAI_API_KEY`). Pick whichever of these fits your workflow:

<details open>
<summary><b>1. Export it in your shell</b> — good for one-off testing</summary>

```bash
export GROQ_API_KEY=sk-your-key-here
npx llmrace --provider groq --model openai/gpt-oss-120b
```

</details>

<details>
<summary><b>2. Pass it inline on the command</b> — good for a single command, no shell history</summary>

```bash
GROQ_API_KEY=sk-your-key-here npx llmrace --provider groq --model openai/gpt-oss-120b
```

</details>

<details>
<summary><b>3. Put it in a <code>.env</code> file</b> — good for repeated local use</summary>

```bash
cp .env.example .env
# then edit .env and fill in the key(s) you need, e.g.:
# GROQ_API_KEY=sk-your-key-here
npx llmrace --provider groq --model openai/gpt-oss-120b
```

The `.env` file is loaded automatically — no extra flag needed.

</details>

<details>
<summary><b>4. Skip env vars entirely</b> — pass the key directly on the command line</summary>

```bash
npx llmrace --provider groq --model openai/gpt-oss-120b --api-key sk-your-key-here
```

`--api-key` always overrides the environment variable.

</details>

The `local` provider (Ollama, LM Studio, llama.cpp, etc.) doesn't need a key at all — it just needs `--base-url`.

<details>
<summary>All env var names</summary>

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

</details>

## Usage

```bash
npx llmrace --help
```

```bash
# Test a single model
npx llmrace --provider groq --model openai/gpt-oss-120b

# Smooth out noise with repeated runs (median/min/max)
npx llmrace --provider groq --model openai/gpt-oss-120b --runs 5

# A local OpenAI-compatible server (Ollama, LM Studio, llama.cpp...)
npx llmrace --provider local --base-url http://localhost:11434/v1 --model llama3

# Machine-readable output for scripts and CI
npx llmrace --provider groq --model openai/gpt-oss-120b --json
```

Running `npx llmrace` with no flags in an interactive terminal launches a step-by-step wizard instead.

## Options

| Flag | Description |
| --- | --- |
| `-p, --provider <id>` | Provider id for a single run (see [supported providers](#supported-providers), or run `--list`) |
| `-m, --model <id>` | Model id for a single run |
| `--base-url <url>` | Required for provider `local` — the OpenAI-compatible endpoint to hit |
| `--api-key <key>` | Overrides the `<PROVIDER>_API_KEY` env var |
| `--race <list>` | Optional: comma-separated `provider:model` entries to compare, run in parallel instead of `--provider`/`--model` |
| `--prompt <text>` | Overrides the default benchmark prompt |
| `--runs <n>` | Repeat the benchmark `n` times and report median/min/max (default `1`) |
| `--static-prompt` | Send the exact same prompt every run (default: a per-run marker is appended to dodge proxy/gateway response caching) |
| `--json` | Emit machine-readable JSON on stdout instead of text |
| `--timeout <ms>` | Abort if no result after this many ms (default `120000`) |
| `--list` | List known provider ids and exit |
| `-h, --help` | Show help |

## Racing Providers (Optional)

Want to compare providers head-to-head instead of testing one model? Add `--race` with a comma-separated `provider:model` list, and they'll run in parallel on the same prompt at the same moment:

```bash
npx llmrace --race groq:openai/gpt-oss-120b,openai:gpt-4o-mini,anthropic:claude-3-5-haiku-20241022
```

Results are ranked by `eff tok/s` (tokens ÷ total time), since that number stays comparable even when one provider buffers its response instead of streaming it.

## Supported Providers

| Provider | id |
| --- | --- |
| OpenAI | `openai` |
| Anthropic | `anthropic` |
| Groq | `groq` |
| Cerebras | `cerebras` |
| Fireworks AI | `fireworks` |
| Mistral | `mistral` |
| OpenRouter | `openrouter` |
| Google (Gemini) | `google` |
| x.ai | `xai` |
| z.ai | `zai` |
| Meta | `meta` |
| Kimi (Moonshot AI) | `kimi` |
| Local (Ollama, LM Studio, llama.cpp, or any OpenAI-compatible server) | `local` |

## Adding a Provider

1. Create a new adapter in `src/providers/` (many providers can reuse the OpenAI-compatible adapter).
2. Register it in `src/providers/index.ts`.
3. Add provider metadata to `src/config.ts`.

## Testing

```bash
npm test
```

## Contributing

Issues and PRs are welcome — new provider adapters especially. Please add or update tests for anything you change (`npm test`) and run `npm run lint` before opening a PR.

## License

MIT © [George Kour](https://github.com/kourgeorge)
