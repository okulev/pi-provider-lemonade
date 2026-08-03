# pi-provider-lemonade

[![npm](https://img.shields.io/npm/v/pi-provider-lemonade)](https://www.npmjs.com/package/pi-provider-lemonade)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A [pi](https://pi.dev) extension that registers your local
[Lemonade Server](https://lemonade-server.ai) as a provider and **discovers its
downloaded models automatically**. Add a model to the server, and
it is available in `/model` — no manual `models.json` updates required.

```text
$ pi --list-models lemonade
provider  model                                 context  max-out  thinking  images
lemonade  Qwen3-4B-GGUF                         41K      16.4K    no        no
lemonade  gemma-3-4b-it-GGUF                    60K      16.4K    no        no
lemonade  Llama-3.3-70B-Instruct-GGUF           131K     16.4K    no        no
lemonade  Qwen3-Coder-30B-A3B-Instruct-GGUF     262K     16.4K    no        no
lemonade  LMX-Omni-52B-Halo                     131K     16.4K    no        no
```

## Quick Start

1. **Ensure Lemonade Server is running** and has at least one downloaded model:

   ```sh
   lemonade list --downloaded
   ```

2. **Install the extension** into pi:

   ```sh
   pi install npm:pi-provider-lemonade
   ```

3. **Select a model**:

   ```sh
   pi --model 'lemonade/gemma-3-4b-it-GGUF'
   pi --models 'lemonade/*'    # cycle every Lemonade model with Ctrl+P
   /model                      # or pick one inside the TUI
   ```

Every downloaded model on your Lemonade Server now appears in pi.

## Install

```sh
pi install npm:pi-provider-lemonade  # from npm
```

Or straight from git, pinned, or just for one run:

```sh
pi install git:github.com/okulev/pi-provider-lemonade
pi install npm:pi-provider-lemonade@1       # pinned to 1.x, skipped by pi update
pi -e npm:pi-provider-lemonade              # try without installing
```

## Configuration

The extension reads the same environment variables the Lemonade CLI uses for
server address and authentication:

| Variable | Default | Effect |
| --- | --- | --- |
| `LEMONADE_HOST` | `127.0.0.1` | Server host address. |
| `LEMONADE_PORT` | `13305` | Server port. |
| `LEMONADE_API_KEY` | `sk-lemonade-local` | Sent as `Authorization: Bearer`. Lemonade ignores it unless `LEMONADE_API_KEY` is set server-side. |

These match the `lemonade` CLI's `--host` / `--port` / `--api-key` flags. If your
server is on a different host or port, set the env vars and all Lemonade tools
(including pi) stay in sync:

```sh
export LEMONADE_HOST=192.168.1.100
export LEMONADE_PORT=13305
export LEMONADE_API_KEY=your-api-key-here
```

## Using models

Select a model with any of:

```sh
pi --model 'lemonade/gemma-3-4b-it-GGUF'
pi --models 'lemonade/*'    # cycle every Lemonade model with Ctrl+P
/model                      # inside the TUI, pick a lemonade/… entry
ctrl-l                      # with keybinding
```

`pi --list-models lemonade` shows all discovered models with their context
window, output cap, thinking, and image support.

## What it reads from your server

At startup the extension calls `GET /v1/models` to list downloaded models, then
calls the Ollama-compatible `POST /api/show` for each (this is **mandatory** —
it determines whether the model is included). Only models whose `/api/show`
reports both `completion` and `tools` capabilities are registered:

| /api/show `capabilities` | Routed to | Included? |
| --- | --- | --- |
| `["completion", "tools", …]` | `/v1/chat/completions` | ✅ included |
| `["completion", …]` (no tools) | chat model, no tool calling | ❌ excluded |
| `["embedding", …]` | `/v1/embeddings` | ❌ excluded |
| *(empty — image, transcription, etc.)* | non-LLM model | ❌ excluded |

If `/api/show` is unavailable for **all** models, discovery degrades to a
`discovery-failed` fallback model. Only models with `downloaded: true` are
included, so every registered model is immediately ready without a download step.

From each model entry (all overridable via `models.json` `modelOverrides`):

| pi field | Derived from |
| --- | --- |
| `contextWindow` | From Ollama `/api/show` `model_info`, falling back to `max_context_window` from `/v1/models`, then 128000 |
| `maxTokens` | 16384, clamped to `contextWindow` |
| `reasoning` | Always `false` (Lemonade uses the model's default thinking) |
| `thinkingLevelMap` | `undefined` (effort levels not exposed) |
| `input` | `["text"]` (text only — vision labels are not used) |
| `cost` | Not reported by server |
| `compat` | `supportsDeveloperRole: false`, `supportsStore: false`, `supportsReasoningEffort: false`, `maxTokensField: "max_tokens"` |

## Overriding models via `models.json`

The extension only reads three environment variables (`LEMONADE_HOST`,
`LEMONADE_PORT`, `LEMONADE_API_KEY`) — everything else
(model-specific context windows, output caps, reasoning overrides, compat flags,
even cost) is configured in `~/.pi/agent/models.json` `modelOverrides`, just
like any other pi provider. This keeps configuration in one place and avoids
scattering extension-specific env vars across your shell.

All numeric, capability, and compat fields are set with sensible defaults at
discovery time and can be overridden per-model in
`~/.pi/agent/models.json` - no reload required; open `/model`, just like any other pi provider.

```json
{
  "providers": {
    "lemonade": {
      "modelOverrides": {
        "Qwen3-4B-GGUF": {
          "name": "Qwen3 4B (High Ctx)",
          "contextWindow": 131072,
          "maxTokens": 32768
        }
      }
    }
  }
}
```

## Extended thinking (reasoning) is disabled

Extended thinking is **always disabled** in pi — `reasoning` is set to `false` and
`thinkingLevelMap` is `undefined`. Lemonade's chat endpoint uses the model's
default thinking behavior, and pi does not attempt to toggle it per-request
(see [lemonade-sdk/lemonade#1511](https://github.com/lemonade-sdk/lemonade/issues/1511)).

The model will still use its built-in default for thinking, so reasoning-capable
models like Qwen3 and DeepSeek continue to reason — pi simply doesn't send
`reasoning_effort` parameters that the server may not support.

## Tool calling

Tool calling (function calling) is supported out of the box via the
`openai-completions` API. No configuration is needed — pi handles tool
selection, execution, and result passing automatically.

## Live model discovery

The extension registers a `refreshModels` callback alongside the initial model
list. Pi calls it during model refresh and `/reload`, so newly downloaded models
appear without restarting the process. If a refresh fails, the last-known-good
list is kept.

## When the server is down

Discovery never blocks pi from starting. On a connection refusal, timeout,
non-2xx response, malformed body, or empty model list, the extension registers
the provider anyway with a single `discovery-failed` model and warns once at session
start:

```text
[pi-provider-lemonade] Model discovery from http://127.0.0.1:13305/v1 failed
(fetch failed). Registered provider "lemonade" with a single "discovery-failed" model.
Start the server and run /reload, or set LEMONADE_HOST/LEMONADE_PORT.
```

Start the server and `/reload` — no restart needed.

## Authentication

There are two ways to provide an API key when your Lemonade Server requires it.

### Option 1: `LEMONADE_API_KEY` environment variable

Set the same variable in pi's environment before starting:

```sh
export LEMONADE_API_KEY="your-secret-key"
pi
```

### Option 2: `/login lemonade` (persistent)

pi's `/login` command stores your API key in `~/.pi/agent/auth.json`:

```sh
/login lemonade
# → Enter your Lemonade API key (leave empty for a placeholder token)
```

The credential is saved as `{ "type": "api_key", "key": "..." }` and
automatically used on every subsequent session — no env var needed. Run
`/reload` to start sending authenticated requests without restarting pi.

When no `LEMONADE_API_KEY` is set and you have not run `/login lemonade`,
the extension sends a harmless placeholder token (`sk-lemonade-local`) that
Lemonade ignores — it only enforces auth when the key is configured server-side.

## Closed Development

While this package is open source, its development is not:

- Only npm-distributed files are kept in [the GitHub repository](https://github.com/okulev/pi-provider-lemonade).
  Development files (tests, type configs) are not published to npm or hosted on GitHub.
- Only issues are allowed; pull requests are disabled.
  If you find a bug, please [open an issue](https://github.com/okulev/pi-provider-lemonade/issues).

## License

[MIT](./LICENSE)
