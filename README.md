# pi-provider-lemonade

[Pi](https://pi.dev) extension that registers your local
[Lemonade Server](https://lemonade-server.ai) as a provider and **discovers its
downloaded models automatically**. Add a model to the server, and
it is available in `/model` — no manual `models.json` updates required.

Works with pi **0.83 and later** (verified through 0.86) — the extension
adapts at runtime to each pi version's provider API, so no per-version setup
is needed. On a pi release newer than 0.86 it shows a one-time startup
warning explaining how to fall back to pi's built-in OpenAI-compatible
streaming (see [Choosing the streaming backend](#choosing-the-streaming-backend)).

## Quick Start

1. **Prepare your models:**
   Ensure your [Lemonade Server](https://lemonade-server.ai) is running and you have downloaded at least one model.
   - **In Web UI / Desktop App:** Use the **"Downloaded Only"** checkbox to quickly see which models are ready.
   - **In CLI:** Run `lemonade list --downloaded`.

2. **Install the extension:**
   Install into Pi via the CLI:

   ```sh
   pi install npm:pi-provider-lemonade
   ```

3. **Select a model:**
   Inside the Pi TUI, run:

   ```
   /model
   ```

   (or use the `ctrl-l` keybinding). Pick any `lemonade/...` entry from the list.

4. **Refresh the catalog:**
   If you download new models, update the list without restarting:

   ```
   /reload
   ```

   (or `pi update --models` in the CLI).

## Configuration

### Server Connection

The extension connects to your local Lemonade server using the following environment variables:

| Variable | Default | Purpose |
| ---------- | --------- | ---------- |
| `LEMONADE_HOST` | `127.0.0.1` | Server host — a bare host, `host:port`, or a full `http://`/`https://` URL (parsed exactly like the Lemonade SDK CLI's `LEMONADE_HOST`) |
| `LEMONADE_PORT` | `13305` | Server port — used unless `LEMONADE_HOST` already carries an explicit port |
| `LEMONADE_DISCOVERY_TIMEOUT_MS` | `20000` | Overall budget for one model-discovery pass, covering `/v1/models`, `/v1/health` and every `/api/show` together. Individual requests are still capped at 4 seconds. Raise it only for very large model catalogs; a server that never answers costs this budget, not one timeout per model |

`LEMONADE_HOST` is parsed by a faithful port of the Lemonade SDK's
`lemon::utils::parse_target_url`, so it accepts the same forms the `lemonade`
CLI does: a bare host (`127.0.0.1`), `host:port` (`192.168.1.100:13305`), or
a full URL (`http://192.168.1.100:13305`, `https://llm.example.com`). Trailing
path/query/fragment is stripped, and the scheme selects `http` or `https` — so
`LEMONADE_HOST=https://llm.example.com` connects over TLS (port 443 unless
`LEMONADE_PORT` or an explicit URL port says otherwise). IPv6 hosts are
supported (`::1` or `[::1]:13305`). When `LEMONADE_HOST` is a bare
`host`/`host:port` the connection is `http://`.

> Note: an explicit port in `LEMONADE_HOST` wins over `LEMONADE_PORT`. A
> scheme without a port (`http://host`, `https://host`) falls back to 80/443
> unless `LEMONADE_PORT` is set — matching the SDK CLI's `!explicit_port`
> semantics.

> Typo safety: a port that does not parse (`LEMONADE_HOST=host:abc`) or an
> out-of-range `LEMONADE_PORT` is never used to build the URL — the extension
> falls back to `LEMONADE_PORT` when that is valid, otherwise `13305`, and says
> so in the startup notice (`ignoring the invalid port in LEMONADE_HOST
> ("host:abc"), using 13305`). Same for `LEMONADE_DISCOVERY_TIMEOUT_MS`.

### Authentication

You can authenticate with the server in two ways:

1. **Pi Credential (Preferred):** Run `/login lemonade` inside the Pi TUI. This is the most reliable method and takes priority for live requests and model refreshes.
2. **Environment Variable:** Set `LEMONADE_API_KEY` — or `LEMONADE_ADMIN_API_KEY`, which takes precedence when both are set, exactly like the `lemonade` CLI (the server accepts the admin key on regular `/v1` endpoints too).

*Note: Provider-level configuration in `models.json` (like `baseUrl` or `apiKey`) is not supported because this extension uses dynamic discovery. Use environment variables or `/login` instead.*

> **Transport security:** unless `LEMONADE_HOST` uses an `https://` scheme, the
> connection is plain `http://` — and a bearer key (from `LEMONADE_API_KEY` or
> `/login lemonade`) then travels **unencrypted** on every request, including
> discovery. That is fine on your own machine (the default `127.0.0.1`), but
> for a server on another host set an `https://` `LEMONADE_HOST` (or tunnel
> it), and prefer `/login lemonade` over putting the key in a shell environment
> where other processes can read it.

## Using models

Select a model with any of:

```sh
pi --model 'lemonade/gemma-3-4b-it-GGUF'
pi --models 'lemonade/*'    # cycle every Lemonade model with Ctrl+P
/model                      # inside the TUI, pick a lemonade/… entry
ctrl-l                      # with keybinding
```

Model IDs containing forward slashes (`/`) or whitespace (common with cloud backends like OpenRouter) are automatically handled: the raw ID is sent to the server for compatibility, while a sanitized version is displayed in the TUI.

`pi --list-models lemonade` shows all discovered models with their context
window, output cap, thinking, and image support.

**Note:** The `/model` command only displays already-discovered models - it does NOT make HTTP requests.

## Model Discovery

The extension automatically discovers models downloaded on your Lemonade server. Only models with `downloaded: true` are included.

### How it Works

The extension first lists models via the OpenAI-compatible `GET /v1/models` endpoint, then queries each one via the Ollama-compatible `POST /api/show` endpoint to verify its capabilities. Only models supporting **both** `completion` and `tools` are registered:

| /api/show `capabilities` | Included? |
| --- | --- |
| `["completion", "tools", …]` | ✅ Yes |
| `["completion", …]` (no tools) | ❌ No |
| `["embedding", …]` | ❌ No |
| Others (image, transcription, etc.) | ❌ No |

To optimize your workflow, models are automatically sorted by priority: **pinned** models first, followed by **loaded** models, then **downloaded local** models, and finally **unloaded cloud** models.

Two empty-looking outcomes are different and are reported differently:

- **Server unreachable, or `/api/show` cannot determine capabilities** — a single
  `discovery-failed` fallback model is registered and pi warns at startup, so the
  provider still shows up in `/model` with an explanatory name.
- **Server reachable but nothing usable** (no downloaded model, or none reporting
  `completion` + `tools`) — the provider registers **no models** and shows an
  informational notice instead of a warning. Deleting your last model really does
  empty the list (and the cached copy); download one and run `/reload` to
  repopulate it.

### When Discovery Happens

- **At startup:** Automatically performed whenever the `pi` CLI is launched (e.g., starting a TUI session or running `pi --list-models`). **Note:** Initial discovery at startup cannot use the `/login` credential and will rely on the `LEMONADE_ADMIN_API_KEY`/`LEMONADE_API_KEY` environment variables (or the default placeholder).
- **On demand:** Triggered when you run `/reload` in the TUI or `pi update --models` in the CLI. These actions trigger a model refresh that **uses the `/login` credential if available**, taking priority over environment variables.

*Note: Since `pi update --models` is a CLI command, it first performs the "At startup" discovery (using the env key) and then immediately performs the "On demand" refresh (using the login credential).*

A discovery pass is bounded: every request shares `LEMONADE_DISCOVERY_TIMEOUT_MS`
(default 20 s) on top of its own 4-second timeout, and a refresh cancelled by pi
(`/reload`, interrupting a session) aborts the in-flight requests and skips the
`/api/show` batches that have not started. A pass that runs out of budget or is
cancelled degrades to the `discovery-failed` fallback (or keeps the previous
catalog on a refresh) — it never publishes a half-queried model list.

Discovered models are cached in `~/.pi/agent/models-store.json` for faster restarts and offline access.

### Model Properties

The following properties are derived automatically and can be overridden in `models.json`:

| Pi Field | Source / Default |
| --- | --- |
| `contextWindow` | From `/api/show` → `/v1/models` → 128,000 |
| `maxTokens` | 16,384 (reduced to what still fits in `contextWindow` — [see below](#overriding-models-via-modelsjson)) |
| `cost` | From `/v1/models` `cost_input_per_million` / `cost_output_per_million` (USD/1M tokens; 0 for local models). Per-message `usage.cost` is priced from these rates |
| `reasoning` | `true` — thinking level control is exposed (see [Thinking level control](#thinking-level-control)) |
| `input` | `["text"]` |
| `compat` | `supportsDeveloperRole` / `supportsStore` `false`, `maxTokensField: "max_tokens"` (all other compat flags resolve to their defaults) |

## Overriding models via `models.json`

The extension only reads five environment variables (`LEMONADE_HOST`,
`LEMONADE_PORT`, `LEMONADE_API_KEY`, `LEMONADE_ADMIN_API_KEY`,
`LEMONADE_DISCOVERY_TIMEOUT_MS`) —
everything else
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

`maxTokens` and `samplingParams` overrides apply to the request itself:
`maxTokens` is sent as `max_tokens` on every request (otherwise the backend
applies its own default) and `samplingParams` keys are merged into the request
body last, so they override any named field. The output cap is reduced to the
tokens still available in `contextWindow`, but the margin left for the prompt
scales with the window — `min(4096, max(512, ctx / 8))`, with the result floored
at 256 output tokens. Pi's fixed 4,096-token margin would leave a model with a
4k context window able to generate exactly one token.

Provider-level `headers` in `models.json` are also read by this extension:
the `x-pi-provider-lemonade` header selects the streaming backend
([Choosing the streaming backend](#choosing-the-streaming-backend)).

## Thinking level control

Discovered models are registered with `reasoning: true`, so Pi's
thinking-level selector works: the selected level is sent with every request.
By default (the `openai` thinking format) it goes on the wire as
`reasoning_effort`; with thinking off, nothing is sent.

To turn thinking off for one model or change the wire format, override it in
`~/.pi/agent/models.json`:

```json
{
  "providers": {
    "lemonade": {
      "modelOverrides": {
        "gemma-3-4b-it-GGUF": { "reasoning": false },
        "DeepSeek-R1-0528-Llama-3.1-8B-Instruct-GGUF": {
          "compat": { "thinkingFormat": "deepseek" }
        }
      }
    }
  }
}
```

| `thinkingFormat` | What goes on the wire |
| --- | --- |
| `"openai"` (default) | `reasoning_effort` (the selected level) |
| `"qwen"` | top-level `enable_thinking: true/false` |
| `"qwen-chat-template"` | `chat_template_kwargs: { enable_thinking, preserve_thinking }` |
| `"deepseek"` | `thinking: { type: "enabled"/"disabled" }` |
| `"chat-template"` | your `chatTemplateKwargs`, with `{"$var": "thinking.enabled"}` / `"thinking.effort"` placeholders expanded |

If a format sends fields your server rejects, the request fails server-side —
start a fresh session (or drop the override) rather than expecting a fallback.

## Reliability & Diagnostics

To provide these enhancements, the extension replaces the standard `openai-completions` implementation with a specialized `lemonade-completions` layer (which still leverages the OpenAI SDK for core communication).

- **Automatic Retries**: To ensure a smooth experience, the extension automatically retries chat completions with exponential backoff if it encounters HTTP 429 (Rate Limit) or 5xx (Server Error) responses — mid-stream or before the first chunk — honoring the server's `Retry-After` header when present. Once any content has been emitted, a failing stream is not retried (re-running it would duplicate the partial output); the error surfaces instead.
- **Detailed Error Messages**: If a request fails, the Pi TUI now displays full diagnostic fields from the Lemonade server (such as status codes and error types), making it easier to diagnose connectivity or server-side issues.

### Choosing the streaming backend

By default, requests are streamed through the extension's
`lemonade-completions` layer (the retries and diagnostics above). If you move
to a pi release that this extension has not been verified against and
streaming misbehaves — missing system prompt or tools, unexpected request
errors — you can switch the provider to pi's **built-in** OpenAI-compatible
streaming instead, which is always generation-matched to your pi:

```json
{
  "providers": {
    "lemonade": {
      "headers": {
        "x-pi-provider-lemonade": "openai-completions"
      }
    }
  }
}
```

Recognized values:

- `openai-completions` — use pi's built-in OpenAI-compatible streaming (no
  Lemonade-specific retries or diagnostics).
- `lemonade-completions` — use the extension's layer (the default; also
  silences the untested-version startup warning).

The header is a private extension channel: pi does not interpret it, and it
rides on the request to the Lemonade server, where it is ignored. The value is
read on every request, so it takes effect as soon as pi has re-read
`models.json`. On startup the extension confirms the active choice with a
notice, and warns once when running on an untested pi version without a
recognized value.

## Closed Development

While this package is open source, its development is not:

- Only npm-distributed files are kept in [the GitHub repository](https://github.com/okulev/pi-provider-lemonade).
  Development files (tests, type configs) are not published to npm or hosted on GitHub.
- Only issues are allowed; pull requests are disabled.
  If you find a bug or have a feature request, please [open an issue](https://github.com/okulev/pi-provider-lemonade/issues).

## License

[MIT](./LICENSE)
