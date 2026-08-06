# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.5] - 2026-08-06

### Added

- Added npm script `typecheck`.

### Fixed

- Markdown rendering fixes.

### Removed

- Removed `package-lock.json`

## [1.0.4] - 2026-08-05

### Fixed

- `npm version` was not run.

## [1.0.3] - 2026-08-05

### Fixed

- **Model ID Sanitization**: Model IDs containing forward slashes (`/`), whitespace, or control characters are now sanitized (replaced with `_`) instead of being excluded. This prevents model identification issues in the Pi CLI/TUI while ensuring all downloaded models are available.
- **Internal Pathing**: Corrected internal references to `index.ts` (removed legacy `extensions/` subdirectory references).
- **URL Construction**: Fixed `buildBaseUrl` to return the base host:port without the `/v1` suffix, allowing more flexible routing to different server endpoints (OpenAI vs Ollama).

### Changed

- **README documentation overhauled** for better coherence and clarity:
  - **Quick Start** is now UI-first, prioritizing the Lemonade Web UI/Desktop App and Pi TUI commands (`/model`, `/reload`).
  - **Configuration** and **Model Discovery** sections refactored to be more concise.
  - **API Compatibility clarified**: explicitly detailed the use of OpenAI-compatible (`/v1/models`) and Ollama-compatible (`/api/show`) endpoints.
  - **Discovery timing clarified**: added detailed explanation of "At startup" vs. "On demand" behavior, specifically for the `pi update --models` command.
- **`package.json` metadata improved**: updated `description` and `keywords` for better npm discoverability and architectural accuracy.
- **Dependency model updated**: migrated `@earendil-works/*` packages to `peerDependencies` to ensure zero runtime dependencies, aligning with the `pi-package-template` convention.

## [1.0.2] - 2026-08-03

### Changed

- **Re-published with the updated README.md** intended for 1.0.1 — the 1.0.1 npm
  release accidentally shipped with the 1.0.0 README.

## [1.0.1] - 2026-08-03

### Changed

- **Extension relocated** from `index.ts` to `extensions/index.ts`, following
  pi's `extensions/` subdirectory convention. This is transparent to users —
  pi discovers extensions via the `pi.extensions` field in `package.json`, so no
  configuration or reinstallation is needed.
- **README model names verified** against actual Lemonade Server output,
  replacing artificial examples with real ones (`Qwen3-4B-GGUF`,
  `gemma-3-4b-it-GGUF`, `Qwen3-Coder-30B-A3B-Instruct-GGUF`). The setup command
  `lemonade status` was corrected to `lemonade list --downloaded`.
- **Cost field description corrected** — the field mapping table now describes
  `cost` as "not reported by server" rather than "zero".

### Removed

- **`LEMONADE_TIMEOUT_MS` environment variable** removed from documentation —
  the discovery timeout was never configurable in 1.0.0 (remained a fixed
  4000ms constant).
- **Provider-level `compat` override section** removed from README — `compat`
  flags are set with sensible defaults and can still be overridden per-model via
  `models.json` `modelOverrides`.
- **`thinkingLevelMap` override section** removed from README — effort levels
  are not exposed and thinking is always disabled.
- **Persistent memory section** removed from README — `supportsStore: false` was
  already documented in the 1.0.0 Known Issues; the separate section was
  redundant.

## [1.0.0] - 2026-08-02

### Added

- **Automatic model discovery** from the Lemonade Server's `GET /v1/models`
  endpoint. Every downloaded model is then queried via the Ollama-compatible
  `POST /api/show` (mandatory), and only those reporting both `completion` and
  `tools` capabilities are registered — non-LLM deployments (embeddings,
  image generation, etc.) are excluded.
- **Context length enrichment** from the Ollama-compatible `POST /api/show`
  endpoint (`model_info["{id}.context_length"]`), which is mandatory and takes
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
  they would corrupt `lemonade/{id}` CLI/TUI selection.
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

[1.0.4]: https://github.com/okulev/pi-provider-lemonade/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/okulev/pi-provider-lemonade/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/okulev/pi-provider-lemonade/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/okulev/pi-provider-lemonade/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/okulev/pi-provider-lemonade/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/okulev/pi-provider-lemonade/releases/tag/v1.0.0
