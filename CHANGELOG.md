# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-09-22

### Added

- **Multi-server `/login lemonade`**: `/login lemonade` now shows a
  **server list** — the URL from a previous login (when one is stored),
  the `LEMONADE_HOST`/`LEMONADE_PORT` base, and any servers found by the
  local network scan (below) — each annotated with a live `online`/`offline`
  status — plus **Scan local network…** and **Enter custom URL…**. The
  selected server's URL and the API key (the prompt names the server you
  picked) are stored in the credential, and the credential takes priority
  over the environment for live requests and model refreshes — so a server
  behind a reverse proxy (an `https://` URL, or one with a path prefix) can
  be pointed at without touching the shell.
- **Local network scan**: at pi startup (on by default on Linux only — on
  macOS/Windows the scan's inbound UDP makes the OS firewall prompt about
  the node process; override with `startupScan` in the configuration file)
  the extension listens for the Lemonade Server's UDP beacon (port 13305,
  the same mechanism as `lemonade scan`) and probes `127.0.0.1`, the default
  gateway, and every address of your local RFC1918 subnets (prefix /24 or
  smaller). The subnet sweep is the reliable path: the beacon is unusable
  while a local Lemonade app runs (its sender socket holds the beacon port)
  and a server may disable its beacon outright. The result is kept for the
  session and offered in `/login`; **Scan local network…** (every platform)
  re-runs it with a per-second countdown. When the scan finds nothing it
  names the addresses it probed, so an empty result tells you exactly what
  to check.
- **`pi-provider-lemonade.json` configuration file** (in the agent
  directory — `PI_CODING_AGENT_DIR`, or `~/.pi/agent` by default):
  `discoveryTimeoutMs` (overall budget for one discovery pass, default
  20000), `streamingMode` (`"extension"`, the default — this extension's
  streaming layer; or `"builtin"` — pi's built-in OpenAI-compatible
  streaming), and `startupScan` (force the startup scan on/off; the
  platform default is Linux-only). All keys are optional; a missing file
  means all defaults. The file takes precedence over the deprecated sources
  (below), is re-read on every `/reload`, and a malformed file never blocks
  startup — it is reported once and the defaults apply.
- **Image input for vision models**: models whose `/api/show` reports the
  `vision` capability are registered with `input: ["text", "image"]`, so
  images pasted or dragged into the prompt reach the model as OpenAI
  `image_url` content parts (the llama.cpp backend loads the `mmproj`
  companion automatically).
- **Per-model thinking level maps**: reasoning models expose a restricted
  `off`/`medium` level map by default (`off` maps to
  `reasoning_effort: "none"` — llama.cpp's hard per-request disable; `off`
  is not a valid `reasoning_effort` value, which is why this does not copy
  the built-in provider's `off: "off"`), and the builtin-model families
  whose templates accept a graded effort get a wider per-model map:
  **Qwen3.8** (`low`/`medium`/`xhigh` — its template enforces that strict
  enum, so `minimal` and `high` are hidden as duplicates) and **gpt-oss** /
  **Muse-Glimmer** (the full `none`/`minimal`/`low`/`medium`/`high` range;
  `xhigh` is hidden).
- **Builtin-model `thinkingFormat` heuristics**: ids from the Lemonade
  builtin models catalog get the wire format their chat templates expect —
  `qwen` for Qwen3.8 (its template reads `enable_thinking` and a strict
  `reasoning_effort` enum), `qwen-chat-template` for the
  `enable_thinking`-kwarg families (Qwen3/3.5/3.6, MiniCPM
  4.1/5/V-4.5+/o-4.5, GLM-4.5/4.7, Nemotron-3, Ornith-1.5, DeepSeek-V4,
  PromptBridge, SmolLM3, Gemma-4), `deepseek` for DeepSeek-R1-Distill, and
  `chat-template` with `chat_template_kwargs` for LFM2.5 (`thinking`) and
  Muse-Glimmer (`reasoning_strength`, rendered as a system-prompt
  directive). The heuristics are best-effort and can misfire on a user
  model that shares an id pattern with a builtin model but uses a different
  template — override `compat.thinkingFormat` per-model in `models.json`
  if needed.
- **Capability-based reasoning detection**: `reasoning` is now derived from
  the `/api/show` `thinking` capability instead of being hard-coded `true`
  for every model. A server that reports `thinking` for no model at all is
  assumed to predate the capability, so every model keeps the toggle; a
  model with no capability and no matching family gets
  `reasoning: false` (selector hidden, no thinking parameters sent).
- **Builtin-models reasoning fallback**: the catalog labels only some
  thinking-capable builtin models as `reasoning`, so a builtin model with a
  verified template toggle now gets `reasoning: true` automatically — 31
  models that would otherwise ship with the selector hidden. The matching
  `thinkingFormat` hint is already in `compat`, so no override is needed.
- **pi 0.87 support**: the extension is now verified through pi 0.87 (the
  `@earendil-works/pi-ai` dependency is pinned to 0.87.x).

### Changed

- **The provider is named `Lemonade`** (previously `Lemonade (<host>)`):
  the host in the name went stale after logging into a different server,
  and pi uses the provider name for the login dialog title.
- **No discovery-failure startup warning**: the single `discovery-failed`
  fallback model is the signal. Configuration warnings and the
  reachable-but-empty catalog notice are unchanged.
- **A failed model refresh now throws**, the way pi's built-in dynamic
  providers do: the last-known-good catalog is retained, and pi shows its
  standard "model catalog could not be refreshed; using cached models"
  warning instead of silently keeping the stale list.
- **`responseModel` no longer strips the `huggingface/hub/` prefix** from
  the server's raw model value — the full GGUF cache path that served the
  response is visible in diagnostics.
- **The pi-version detection and untested-pi startup warning are removed** —
  the streaming-mode escape hatch (`streamingMode: "builtin"`) is
  documented in the README instead.

### Fixed

- **Post-login catalog refresh hit the wrong server**: pi rebuilds the
  refresh credential from `resolve()`'s `auth.apiKey` + `env` only —
  `auth.baseUrl` is not part of that reconstruction — and the stored server
  URL rode solely in `auth.baseUrl`. After logging into a remote server,
  the refresh therefore re-discovered from the env base (the local one),
  and `/model` kept showing the local models while requests went to the
  remote (which answered `model_not_found` for every local model name). The
  URL now also rides in `AuthResult.env`, which pi passes into the refresh
  credential.
- A 200 `/v1/models` whose body was not a models payload (a proxy error
  page, a misrouted response) was reported as an *empty* catalog instead of
  a discovery failure.
- A truncated `models-store.json` entry made the pi 0.83 refresh reject
  with an opaque `SyntaxError`; a bad entry is now guarded like the
  non-array case (last-known-good catalog kept, one-time console warning).
- A negative `retry-after-ms` header, or a past HTTP date in
  `retry-after`, parsed to a non-positive delay and caused an immediate
  retry with no backoff; both now fall back to the exponential schedule.
  The `maxRetryDelayMs` cap is now applied to server-requested delays
  unconditionally (a caller-supplied `0` means "no delays at all").
- Tool-call chunks that carry neither an index nor an id (some backends
  send the id only on the first chunk) created a duplicate tool-call block
  per continuation chunk; they are now appended to the most recent
  tool-call block. Interrupted tool-call blocks no longer leave a dangling
  `streamIndex` in the final message content.
- A whitespace-only `LEMONADE_PORT` is treated as unset (no warning),
  matching the API-key handling; a whitespace-padded
  `LEMONADE_API_KEY`/`LEMONADE_ADMIN_API_KEY` is trimmed before use (a
  padded key never matches the server's stored value).
- `LEMONADE_DISCOVERY_TIMEOUT_MS` accepts base-10 digits only (previously
  `0x10`/`1e3` were accepted via `Number()`).
- `samplingParams` overrides of the structurally reserved keys (`stream`,
  `model`, `messages`) are skipped in the merge instead of corrupting the
  request.
- `streamSimple` no longer throws synchronously when the API key is
  missing — the error surfaces as an error event, like `stream`.
- The full Lemonade error shape (`details.code`/`backend`/`reason`) is
  reported when the retry budget is exhausted, not just the abbreviated
  message.

### Deprecated

- **`LEMONADE_DISCOVERY_TIMEOUT_MS` environment variable** — use
  `discoveryTimeoutMs` in `pi-provider-lemonade.json`. Still honored when
  the file does not set the key; a one-time startup notice points at the
  replacement.
- **The `x-pi-provider-lemonade` models.json header** — use `streamingMode`
  in `pi-provider-lemonade.json`. Still honored when the file does not set
  the key; a one-time startup notice points at the replacement.

## [1.2.0] - 2026-09-20

### Added

- `LEMONADE_HOST` now accepts the same forms as the Lemonade SDK CLI: a bare
  host (`127.0.0.1`), `host:port` (`192.168.1.100:13305`), or a full
  `http://`/`https://` URL — parsed by a faithful port of the SDK's
  `parse_target_url` (case-insensitive schemes, trailing path/query/fragment
  stripping, strict 1..65535 port validation, bracketed/raw IPv6 handling).
  The scheme selects `http`/`https`, so TLS reverse-proxy deployments
  (`LEMONADE_HOST=https://llm.example.com`) are now supported.
- **`LEMONADE_ADMIN_API_KEY` environment variable**: read with the same
  precedence as the Lemonade CLI — when both are set, the admin key overrides
  `LEMONADE_API_KEY`; the `/login lemonade` credential still wins overall.
  Previously, exporting only the admin key gave a working `lemonade` CLI but a
  401 from the extension, which was sending the placeholder key.
- **Streaming backend switch**: the `x-pi-provider-lemonade` header in the
  `lemonade` provider's `headers` (`~/.pi/agent/models.json`) selects the
  streaming backend — `openai-completions` routes requests to pi's **built-in**
  OpenAI-compatible streaming (an escape hatch for pi releases this extension
  has not been verified against), `lemonade-completions` (the default) keeps
  the extension's own streaming layer. On a pi release newer than 0.86 without
  a recognized value, the extension warns once at session start. The header
  rides on the wire to the Lemonade server, where it is ignored.
- **pi 0.86 support**: the streaming layer now understands pi 0.86's provider
  contract, where the system prompt and tool declarations live in the
  transcript's leading system message instead of `context.systemPrompt` /
  `context.tools`. On pi ≥ 0.86 every request previously lost both silently,
  and the agent loop died with no error anywhere.
- **Thinking level control**: discovered models are registered with
  `reasoning: true` — the TUI's thinking-level selector now works and the
  selected level is sent with every request (as `reasoning_effort` with the
  default `openai` format; with thinking off, nothing is sent). Previously
  every model was hard-coded `reasoning: false` because the server was
  believed to ignore per-request thinking configuration. Per-model
  `reasoning: false` in `models.json` turns it off for models that cannot act
  on thinking parameters.

### Changed

- Port precedence now matches the Lemonade CLI: an explicit port in
  `LEMONADE_HOST` wins over `LEMONADE_PORT`; a scheme without a port falls
  back to 80/443 unless `LEMONADE_PORT` is set (the CLI counts env-sourced
  values as explicit). An invalid `LEMONADE_PORT` falls back to the built-in
  default 13305.
- `buildBaseUrl` now takes the parsed parts `(host, port, isSsl)` and mirrors
  the SDK client's URL construction (IPv6 hosts bracketed); the old
  host-trimming behavior moved into the parser.
- **`@earendil-works/pi-ai` bumped to `~0.86.0`** (0.86.x only) so the
  streaming layer stays generation-matched to the pi releases it is verified
  against.

### Fixed

- **Small-context models capped to one token**: the fixed 4,096-token prompt
  reserve made models with `contextWindow` ≤ 4096 send `max_tokens: 1`
  (one-token answers). The reserve now scales with the window —
  `min(4096, max(512, ctx / 8))`, floored at 256 output tokens.
- **Mid-stream retry after partial output**: a retryable mid-stream error
  (e.g. a Lemonade 429) re-ran the stream against the same message — partial
  text was duplicated, `start`/`text_end` events fired twice, and the failed
  attempt's `usage`/`responseId` leaked into the result. A stream is never
  retried once content has been emitted.
- **HTTP-level 429/5xx before the first chunk** were fatal (the OpenAI SDK
  client runs with `maxRetries: 0`) and `Retry-After` was ignored. They are now
  retried with exponential backoff like mid-stream errors, honoring a valid
  `Retry-After` (seconds or HTTP date); a garbage value falls back to the
  exponential schedule instead of retrying instantly. A pre-stream HTTP error
  is retried by exactly one layer — previously a body carrying a Lemonade
  error shape was retried by both, up to `(maxRetries + 1)²` requests.
- **`modelOverrides.maxTokens` / `samplingParams` were ignored** — the
  streaming layer bypassed pi's option building, so `max_tokens` was never
  sent (the backend applied its own default) and `samplingParams` was dropped.
  `max_tokens` is now sent on every request and `samplingParams` keys are
  merged into the request body last, overriding any named field (custom keys
  for llama.cpp/vLLM/SGLang endpoints). `modelOverrides.compat` keys beyond the
  previously hard-coded set (e.g. `supportsFinishReason`) now pass through to
  request building.
- **`compat.thinkingFormat` from `models.json` `modelOverrides` is now
  honored** in chat-completion requests — a faithful port of pi-ai's
  openai-completions thinking-parameter handling. Previously the fork only
  ever sent OpenAI-style `reasoning_effort`, so `qwen-chat-template` /
  `chat-template` models (e.g. Qwen on llama.cpp) could never receive
  `chat_template_kwargs: { enable_thinking: false }` when thinking is toggled
  off in the TUI. Supported formats: `openai` (default, now including the
  `thinkingLevelMap.off` value when thinking is off), `qwen` (top-level
  `enable_thinking`), `qwen-chat-template` (sends both
  `chat_template_kwargs.enable_thinking` and `preserve_thinking`),
  `chat-template` (configurable `chatTemplateKwargs`
  with `{ "$var": "thinking.enabled" | "thinking.effort" }` placeholders and
  `omitWhenOff`), plus `zai`, `baseten`, `deepseek`, `openrouter`, `ant-ling`,
  `together`, and `string-thinking`.
- **`usage.cost` was hard-coded zeros** — `calculateCost(model, usage)` was
  never called, so pricing from `models.json` never reached the TUI.
  Top-level `cached_tokens` (the Ollama/Lemonade placement) is now read as
  cache reads instead of 0.
- **A reachable server with zero eligible models** was reported as a
  discovery **failure**, so `refreshModels` kept the last-known-good catalog
  forever and deleting every model never cleared pi's list. It now publishes
  an empty catalog with an informational notice (a failed `/api/show` probe
  still fails — capabilities cannot be determined, so that stays a failure).
- **Discovery had no overall deadline and ignored pi's abort signal** — a
  half-dead server cost `timeout × ceil(models / 5)` (6 models ≈ 8 s), and an
  aborted refresh kept issuing `/api/show` batches. Every request in a pass
  now shares `LEMONADE_DISCOVERY_TIMEOUT_MS` (default 20 s) on top of its own
  4-second timeout, and a cancelled refresh aborts in-flight requests and
  skips the pending batches.
- **`refreshModels` could overwrite a newer catalog** — it assigned the
  in-memory list before `publish()` and its `update` callback was an
  expression statement, so a refresh that lost pi's generation check still
  clobbered the newer in-memory catalog. The catalog is now updated only
  after a successful publish.
- **A corrupted persisted catalog** (`models` not an array in
  `~/.pi/agent/models-store.json`) made `refreshModels` reject with an opaque
  `TypeError` on both the pi 0.83 and 0.84 restore paths — the provider stayed
  stuck until the store was repaired by hand. The last-known-good catalog is
  kept with a one-time warning instead.
- **`LEMONADE_PORT` validation** now matches `LEMONADE_HOST` port strictness
  (trimmed base-10 digits, 1..65535): `99999` previously built
  `http://host:99999` (a later bare `fetch failed`) and `0x10` silently
  parsed to port 16; both are now corrected with a startup notice.
- **`LEMONADE_HOST=host:badport`** kept the parser's `-1` sentinel, so the
  base URL became `http://host:-1` and discovery failed with a bare
  `fetch failed`; an invalid `LEMONADE_DISCOVERY_TIMEOUT_MS` was also ignored
  silently. The invalid port is now corrected (`LEMONADE_PORT` when valid,
  else 13305) and the corrections are reported in the startup notice.
- **`/v1/health` merge dropped `last_use`**, so pinned/loaded groups tied at
  `last_use: 0` and sorted by raw `/v1/models` order instead of recency; a
  health entry omitting its `pinned` field enriched to `pinned: undefined`
  and silently sorted into the downloaded groups (now defaults to `false`).
- **Caller-supplied `maxRetries`/`maxRetryDelayMs`** stream options were
  overwritten with the extension's defaults, and `options.maxRetryDelayMs`
  was accepted but never read (the 60 s cap was hard-coded). Both are honored
  now.
- **`readConfig`'s default env source** was `undefined` on a non-Node host —
  the first env access threw despite the optional chaining. It now defaults
  to an empty object.

## [1.1.3] - 2026-08-15

### Changed

- `@earendil-works/pi-ai` is now a declared **runtime dependency** (`^0.84.2`,
  matching the version bundled with pi 0.84.2) instead of a devDependency. The extension
  value-imports `convertMessages` from the `@earendil-works/pi-ai/api/openai-completions`
  subpath, which pi's extension loader resolves from the extensions tree (never from the
  bundled copy, whose alias map only covers the package root and a few subpaths). With
  pi-ai only installed as a devDependency, fresh agent environments had no pi-ai in the
  extensions tree at all, and the extension failed to load with
  `Cannot find module '@earendil-works/pi-ai/api/openai-completions'`.

### Fixed

- `refreshModels` legacy (pi 0.83) branches now type-check against the 0.84.x
  `RefreshModelsContext` (no `store` property there) by going through the existing
  runtime `ctx` reference; runtime behavior is unchanged.

## [1.1.2] - 2026-08-15

### Fixed

- **Missing `openai` runtime dependency**: `lemonade-completions.ts` value-imports the
  `openai` client (`import OpenAI from "openai"`), but the package only declared it as a
  `peerDependency` (`"openai": "*"`), which pi's npm installer does not install. In a fresh
  agent environment the shared `node_modules` has no `openai` (it only exists there as a
  transitive dependency of `@earendil-works/pi-ai`, which is hoisted into the pi install
  tree, not into the extensions tree), so the extension failed to load with
  `Cannot find module 'openai'` and pi exited 1 at startup. The dependency is now declared
  explicitly (`"openai": "^6.26.0"`, matching the version pinned by `@earendil-works/pi-ai`)
  so npm installs it alongside the extension.

## [1.1.1] - 2026-08-15

### Changed

- npm version bump to 1.1.1.

## [1.1.0] - 2026-08-07

### Added

- **Mid-stream SSE Error Retries**: Implemented exponential backoff retries for chat completions when encountering HTTP 429 or 5xx errors mid-stream in `lemonade-completions.ts`.
- **Enhanced TUI Error Diagnostics**: Error messages in the pi TUI now include full Lemonade Server diagnostic fields (status code, error type, etc.) to aid troubleshooting.
- **Cost Reporting**: Added support for reporting token costs fetched from the `/v1/models` endpoint.
- **Pinned/Loaded Model Sorting**: Implemented `GET /v1/health` to detect which models are currently loaded or pinned on the server, allowing them to be sorted higher in the model list.
- **Response Model Path Cleaning**: Automatically strips the `huggingface/hub/` prefix from the `responseModel` returned by the server for cleaner logs.

### Fixed

- **Model ID Sanitization**: Raw model IDs containing forward slashes (`/`) or whitespace are now preserved in the `id` field for API calls, while a sanitized version is used for the display `name`. This ensures compatibility with servers that use paths as IDs while keeping the TUI selection stable.

### Changed

- **Project Structure**: Moved source files to `src/` for better organization.
- **Build Configuration**: Updated configuration to include all source files and enable `allowImportingTsExtensions` for improved type-checking.

## [1.0.6] - 2026-08-06

### Added

- **pi 0.84 dual-compat**: `refreshModels` supports the new `context.stored` snapshot and `context.publish()` generation-checked transaction alongside the pi 0.83 `context.store` API, detected at runtime.

### Changed

- **`globMatch` refactored** from nested ternary to if-return statements for clarity.

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

[1.3.0]: https://github.com/okulev/pi-provider-lemonade/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/okulev/pi-provider-lemonade/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/okulev/pi-provider-lemonade/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/okulev/pi-provider-lemonade/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/okulev/pi-provider-lemonade/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/okulev/pi-provider-lemonade/compare/v1.0.6...v1.1.0
[1.0.6]: https://github.com/okulev/pi-provider-lemonade/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/okulev/pi-provider-lemonade/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/okulev/pi-provider-lemonade/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/okulev/pi-provider-lemonade/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/okulev/pi-provider-lemonade/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/okulev/pi-provider-lemonade/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/okulev/pi-provider-lemonade/releases/tag/v1.0.0
