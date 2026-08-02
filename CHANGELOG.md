# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-08-02

### Added

- **Automatic model discovery** from the Lemonade Server's `GET /v1/models`
  endpoint. Every downloaded model is then queried via the Ollama-compatible
  `POST /api/show` (mandatory), and only those reporting both `completion` and
  `tools` capabilities are registered — non-LLM deployments (embeddings,
  image generation, etc.) are excluded.
- **Context length enrichment** from the Ollama-compatible `POST /api/show`
  endpoint (`model_info["<id>.context_length"]`), which is mandatory and takes
  priority over `max_context_window` from `/v1/models`. Falls back to the
  server value, then a 128000-token default, when the server value is missing
  or non-positive.
- **Live model discovery**: `refreshModels` re-fetches the catalog during
  model refresh and `/reload`, so newly downloaded models appear without
  restarting pi. The last-known-good list is retained on failure.
- **Graceful degradation**: if the server is down, unreachable, or returns
  an error, the provider is still registered with a single
  `discovery-failed` model and a one-time warning at session start.
- **Per-model overrides** via `~/.pi/agent/models.json` `modelOverrides` —
  context window, output cap, reasoning, compat flags, and cost can all be
  customised without restarting pi.
- **Server address** via `LEMONADE_HOST` (default `127.0.0.1`) and
  `LEMONADE_PORT` (default `13305`). Discovery fetch timeout is a fixed 4000ms.
- **Two authentication paths**: `/login lemonade` for persistent key storage,
  or the `LEMONADE_API_KEY` environment variable. Live requests resolve the
  key with priority: stored credential → env var → placeholder.
- **Model ID validation**: IDs containing `/` or whitespace are excluded, as
  they would corrupt `lemonade/<id>` CLI/TUI selection.
- **Tool calling** via the `openai-completions` API — no configuration needed.
- **Zero cost**: all models report zero token cost, since local inference
  is free.

### Known Issues

- **Extended thinking is always disabled** — `reasoning` is `false` and
  `thinkingLevelMap` is `undefined`. Lemonade's chat endpoint uses the
  model's default thinking behavior; pi does not toggle it per request
  (see [lemonade-sdk/lemonade#1511](https://github.com/lemonade-sdk/lemonade/issues/1511)).
- **Persistent memory disabled** — OpenAI's `store` parameter is not
  supported (`supportsStore: false`), as local servers don't support it.
- **Developer role mapped to system** — `supportsDeveloperRole` is `false`
  because Lemonade expects a `"system"` role rather than `"developer"`.
- **HTTPS not supported** — the base URL always uses `http://`.

[1.0.0]: https://github.com/okulev/pi-provider-lemonade/releases/tag/v1.0.0
