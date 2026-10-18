# pi-provider-lemonade

[Pi](https://pi.dev) extension that turns your local
[Lemonade Server](https://lemonade-server.ai) into a model provider.
It discovers the models you downloaded on the server automatically — add a
model there, and it shows up in pi's `/model` list. No `models.json` editing.

## What you need

- [pi](https://pi.dev) installed (verified with pi 1.3.0; on a newer pi
  release, streaming should still work — and if it misbehaves, see
  [Troubleshooting](#troubleshooting) for a one-line switch).
- [Lemonade Server](https://lemonade-server.ai) installed and running, with at
  least one model downloaded:
  - **Web UI / Desktop App:** tick **"Downloaded Only"** to see what's ready.
  - **CLI:** `lemonade list --downloaded`.

## Quick start

1. Install the extension:

   ```sh
   pi install npm:pi-provider-lemonade
   ```

2. Start pi (`pi`). If your Lemonade Server runs on this machine with default
   settings, you're done — the extension finds it on its own.

3. In the TUI, run `/model` (or press `ctrl-l`) and pick any `lemonade/…`
   entry. Chat away.

## Everyday commands

| Action | How |
| --- | --- |
| Pick a model | `/model` in the TUI, or `ctrl-l` |
| Pick a model from the shell | `pi --model 'lemonade/gemma-3-4b-it-GGUF'` |
| Cycle through all Lemonade models | `pi --models 'lemonade/*'`, then `Ctrl+P` |
| Refresh the model list after downloading new models | `/reload` in the TUI, or `pi update --models` in the shell |
| List all discovered models with their limits | `pi --list-models lemonade` |

Notes:

- The `/model` dialog refreshes the catalog in the background while it is
  open, so a model you just downloaded usually appears the next time you open
  the dialog — no `/reload` needed.
- **Images:** models that report the `vision` capability accept images pasted
  or dragged into the prompt. (Vision models without an `mmproj` companion
  file fail on image input — a known Lemonade limitation,
  [lemonade-sdk/lemonade#955](https://github.com/lemonade-sdk/lemonade/issues/955).)
- **Thinking:** models with a thinking toggle (e.g. Qwen3, gpt-oss) show pi's
  thinking-level selector. This is configured automatically per model family;
  if a specific model's toggle misbehaves, you can override it in
  `models.json` (see [Fine-tuning models](#fine-tuning-models)).

## Connecting to the server

By default the extension talks to `http://127.0.0.1:13305` — the Lemonade
Server's default address. If your server runs locally with defaults, skip
this section entirely.

**Remote or non-default server — two ways:**

1. **`/login lemonade` in the TUI (preferred).** It shows a list of known
   servers — the one from a previous login, the address from the environment
   variables (below), and any servers found by a network scan — each with a
   live `online`/`offline` status. Pick one (or use **Scan local network…**,
   or **Enter custom URL…**), then enter the API key if your server asks for
   one. Both are stored in pi's credential store.
2. **Environment variables.** Set these before starting pi:

   | Variable | Default | Purpose |
   | --- | --- | --- |
   | `LEMONADE_HOST` | `127.0.0.1` | Server host — bare host (`192.168.1.100`), `host:port`, or a full `http://`/`https://` URL |
   | `LEMONADE_PORT` | `13305` | Server port (used unless `LEMONADE_HOST` already includes one) |
   | `LEMONADE_API_KEY` | — | API key sent to the server |
   | `LEMONADE_ADMIN_API_KEY` | — | Admin key; wins over `LEMONADE_API_KEY` when both are set, exactly like the `lemonade` CLI |

A `/login` credential takes priority over the environment variables.

> **Security note:** unless the server address is an `https://` URL, requests
> — including the API key — travel unencrypted. That's fine on your own
> machine, but for a server on another host use an `https://` URL (or a
> tunnel), and prefer `/login lemonade` over environment variables so the key
> isn't readable by every process in your shell.

## Troubleshooting

| Symptom | What it means / what to do |
| --- | --- |
| No `lemonade/…` entries in `/model` | Is the server running? Is at least one model *downloaded*? Then run `/reload`. |
| A model named like `discovery-failed (…)` | The server could not be reached, or one of your models has unreadable metadata. Start the server (or fix the named model), then `/reload`. The error message names which models failed. |
| The `lemonade` provider appears with no models at all | The server is reachable but has no usable downloaded models (every downloaded model needs `completion` **and** `tools` support). Download a chat model, then `/reload`. |
| Streaming breaks after a pi upgrade (missing system prompt or tools, odd request errors) | Set `"streamingMode": "builtin"` in `~/.pi/agent/pi-provider-lemonade.json` (create the file if needed) to use pi's built-in streaming, which always matches your pi version. |
| Startup discovery seems to fail on a server that requires an API key | Normal on first launch — pi resolves the stored key lazily. Run `/reload` or `/login lemonade` once and the full catalog loads. |
| A request hangs forever mid-answer | The extension retries rate limits and server errors automatically, but a server that stops sending without closing the connection is not timed out. Abort the turn. |
| Model list looks stale after a pi restart | Discovery is cached in `~/.pi/agent/models-store.json` for faster starts; `/reload` refreshes it. |

## Fine-tuning models

Everything numeric or model-specific can be overridden per model in
`~/.pi/agent/models.json`, just like for any other pi provider — no restart
needed, open `/model` afterwards:

```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
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

Useful override fields: `contextWindow`, `maxTokens`, `reasoning`
(force the thinking selector on/off), `compat.thinkingFormat` (how thinking
controls are sent to the server — change it only if a model's toggle does
nothing or the server rejects requests), `input`, and `cost`.

The extension discovers sensible defaults for all of these from the server:
`contextWindow` from the server's model info (fallback 128,000), `maxTokens`
16,384 capped to what fits in the context window, `cost` from the server for
cloud models (0 for local ones), and `input: ["text", "image"]` for vision
models.

## Extension settings (optional)

All of these have working defaults — most users never need this file. It
lives at `~/.pi/agent/pi-provider-lemonade.json` (or the directory in
`PI_CODING_AGENT_DIR`):

```json
{
  "discoveryTimeoutMs": 20000,
  "streamingMode": "extension",
  "startupScan": true
}
```

| Key | Default | Purpose |
| --- | --- | --- |
| `discoveryTimeoutMs` | `20000` | Total time budget for one model-discovery pass. Raise it only for very large model catalogs. |
| `streamingMode` | `"extension"` | `"extension"` — the extension's streaming layer (Lemonade-specific retries and error reporting); `"builtin"` — pi's built-in streaming (the escape hatch after a pi upgrade; see [Troubleshooting](#troubleshooting)). |
| `startupScan` | `true` on Linux, `false` on macOS/Windows | Scan the local network for Lemonade servers at startup to pre-populate the `/login` server list. Off by default on macOS/Windows because the scan triggers an OS firewall prompt. The manual **Scan local network…** in `/login` always works. |

## How model discovery works

The extension lists the server's models (`GET /v1/models`), asks each one for
its capabilities (`POST /api/show`), and registers only chat models that
support both `completion` and `tools` (embedding, image-generation, and
transcription models are skipped). Results are sorted: pinned models first,
then loaded ones, then other downloaded local models, then unloaded cloud
models. Only models with `downloaded: true` are included — download models with
the Lemonade app or CLI, not through pi.

The extension covers Lemonade's OpenAI-compatible chat surface only.
Downloading models, image generation, and other server features are done with
the Lemonade app or CLI.

## Feedback and license

Bugs and feature requests: [open an issue](https://github.com/okulev/pi-provider-lemonade/issues)
(pull requests are not accepted). License: [MIT](./LICENSE).
