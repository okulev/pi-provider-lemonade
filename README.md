# pi-provider-lemonade

[Pi](https://pi.dev) extension that registers your local
[Lemonade Server](https://lemonade-server.ai) as a provider and **discovers its
downloaded models automatically**. Add a model to the server, and
it is available in `/model` — no manual `models.json` updates required.

Works with pi **0.83 and later** (verified through 0.87) — the extension
adapts at runtime to each pi version's provider API, so no per-version setup
is needed. On a pi release that the extension has not been verified against,
streaming should still work — but if it misbehaves (missing system prompt or
tools, unexpected request errors), you can switch to pi's built-in
OpenAI-compatible streaming, which is always generation-matched to your pi
(see [Choosing the streaming mode](#choosing-the-streaming-mode)).

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

### Configuration file

The extension's own settings live in `pi-provider-lemonade.json` in the
agent directory (`PI_CODING_AGENT_DIR`, or `~/.pi/agent` by default — the
same directory as `auth.json` and `models.json`):

```json
{
  "discoveryTimeoutMs": 20000,
  "streamingMode": "extension",
  "startupScan": true
}
```

All keys are optional; a missing file means all defaults.

| Key | Default | Purpose |
| --- | --- | --- |
| `discoveryTimeoutMs` | `20000` | Overall budget for one model-discovery pass, covering `/v1/models`, `/v1/health` and every `/api/show` together (individual requests are still capped at 4 seconds). Raise it only for very large model catalogs |
| `streamingMode` | `"extension"` | `"extension"` — this extension's streaming layer (Lemonade error reporting and retry tuning); `"builtin"` — pi's built-in OpenAI-compatible streaming (see [Choosing the streaming mode](#choosing-the-streaming-mode)) |
| `startupScan` | platform: `true` on Linux, `false` elsewhere | Run the background network scan at pi startup (it pre-populates the `/login` server list). Off by default on macOS/Windows because the scan's inbound UDP makes the OS firewall prompt about the node process. The on-demand **Scan local network…** in `/login` is never affected |

The file takes precedence over the deprecated sources (the
`LEMONADE_DISCOVERY_TIMEOUT_MS` env var and the models.json
`x-pi-provider-lemonade` header), is re-read on every `/reload`, and a
malformed file never blocks startup — it is reported once and the defaults
apply.

### Server Connection

The extension connects to your local Lemonade server using the following environment variables:

| Variable | Default | Purpose |
| ---------- | --------- | ---------- |
| `LEMONADE_HOST` | `127.0.0.1` | Server host — a bare host, `host:port`, or a full `http://`/`https://` URL (parsed exactly like the Lemonade SDK CLI's `LEMONADE_HOST`) |
| `LEMONADE_PORT` | `13305` | Server port — used unless `LEMONADE_HOST` already carries an explicit port |
| `LEMONADE_DISCOVERY_TIMEOUT_MS` *(deprecated)* | `20000` | **Deprecated** — use `discoveryTimeoutMs` in the [configuration file](#configuration-file) instead. Still honored when the file does not set the key; a startup notice points at the replacement |

`LEMONADE_HOST` accepts the same forms the `lemonade` CLI does: a bare
host (`127.0.0.1`), `host:port` (`192.168.1.100:13305`), or a full URL
(`http://192.168.1.100:13305`, `https://llm.example.com`). Trailing
path/query/fragment is stripped, and the scheme selects `http` or `https` —
so `LEMONADE_HOST=https://llm.example.com` connects over TLS. IPv6 hosts
are supported (`::1` or `[::1]:13305`).

> An explicit port in `LEMONADE_HOST` wins over `LEMONADE_PORT`; a scheme
> without a port (`http://host`) falls back to 80/443 unless
> `LEMONADE_PORT` is set. A port that does not parse or is out of range is
> never used — the extension falls back to `LEMONADE_PORT` (or `13305`)
> and says so in the startup notice.

### Authentication

You can configure the server in two ways:

1. **Pi Credential (Preferred):** Run `/login lemonade` inside the Pi TUI. It shows a **server list** — the URL from a previous login (when one is stored), the `LEMONADE_HOST`/`LEMONADE_PORT` base, and any servers found by the network scan (below) — each annotated with a live `online`/`offline` status — plus **Scan local network…** and **Enter custom URL…**. Pick a server (or scan again, or type a URL: a full `http://`/`https://` URL, a `host:port`, or a bare host), then enter the **API key** (the prompt names the server you picked); both are stored in the credential. The credential takes priority over the environment for live requests and model refreshes, so a server behind a reverse proxy (a `https://` URL, or one with a path prefix) can be pointed at without touching your shell.

   **Server discovery:** at pi startup (on by default on Linux only — on
   macOS/Windows the scan's inbound UDP would make the OS firewall prompt
   about the node process; override with `"startupScan"` in the
   [configuration file](#configuration-file)) the extension runs a short
   background scan of the local network — the Lemonade UDP beacon (the same
   mechanism as `lemonade scan`) plus direct probes of localhost, the default
   gateway, and your local subnets. The result is kept for the session and
   offered in `/login`; **Scan local network…** (every platform) re-runs it.
   When the scan finds nothing it names the addresses it probed, so an empty
   result tells you exactly what to check.
2. **Environment Variables:** Set `LEMONADE_API_KEY` — or `LEMONADE_ADMIN_API_KEY`, which takes precedence when both are set, exactly like the `lemonade` CLI (the server accepts the admin key on regular `/v1` endpoints too) — and point `LEMONADE_HOST`/`LEMONADE_PORT` at the server.

*Note: Provider-level configuration in `models.json` (like `baseUrl` or `apiKey`) is not supported because this extension uses dynamic discovery. Use the `/login` credential or environment variables instead.*

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

**Note:** The `/model` dialog shows the last-known catalog immediately and then
refreshes it in the background (a "Refreshing model catalogs…" status), so a
model you just downloaded usually appears the next time you open it — no
`/reload` needed.

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

The `vision` capability is not a filtering criterion — it enables image input: such models are registered with `input: ["text", "image"]`, so you can paste or drag images into the prompt and they reach the model as OpenAI `image_url` content parts. Caveats: vision models without an `mmproj` companion file fail on image input ([lemonade-sdk/lemonade#955](https://github.com/lemonade-sdk/lemonade/issues/955)), and image tokens consume the text context window.

To optimize your workflow, models are automatically sorted by priority: **pinned** models first, followed by **loaded** models, then **downloaded local** models, and finally **unloaded cloud** models.

Two empty-looking outcomes are different and are reported differently:

- **Server unreachable, or `/api/show` cannot determine capabilities** — a single
  `discovery-failed` fallback model is registered (no extra startup warning —
  the model name is the signal), so the provider still shows up in `/model`
  with an explanatory name. Start the server and run `/reload` to repopulate.
- **Server reachable but nothing usable** (no downloaded model, or none reporting
  `completion` + `tools`) — the provider registers **no models** and shows an
  informational notice instead of a warning. Deleting your last model really does
  empty the list (and the cached copy); download one and run `/reload` to
  repopulate it.

### When Discovery Happens

- **At startup:** Automatically performed whenever the `pi` CLI is launched (e.g., starting a TUI session or running `pi --list-models`). **Note:** Initial discovery at startup cannot use the `/login` credential and will rely on the `LEMONADE_ADMIN_API_KEY`/`LEMONADE_API_KEY` environment variables (or the default placeholder) and the `LEMONADE_HOST`/`LEMONADE_PORT` base URL.
- **On demand:** Triggered when you run `/reload` in the TUI, `pi update --models` in the CLI, or open `/model` in the TUI (the dialog refreshes the catalog in the background while it is open). These actions trigger a model refresh that **uses the `/login` credential if available** — the stored key *and* the stored server URL — taking priority over environment variables.

*Note: Since `pi update --models` is a CLI command, it first performs the "At startup" discovery (using the env key) and then immediately performs the "On demand" refresh (using the login credential).*

A discovery pass is bounded: every request shares the discovery timeout
(`discoveryTimeoutMs` in pi-provider-lemonade.json, default 20 s) on top of
its own 4-second timeout, and a refresh cancelled by pi
(`/reload`, interrupting a session) aborts the in-flight requests and skips the
`/api/show` batches that have not started. A pass that runs out of budget or is
cancelled degrades to the `discovery-failed` fallback (or keeps the previous
catalog on a refresh — pi then shows its standard "model catalog could not
be refreshed; using cached models" warning) — it never publishes a
half-queried model list.

Discovered models are cached in `~/.pi/agent/models-store.json` for faster restarts and offline access.

### Model Properties

The following properties are derived automatically and can be overridden in `models.json`:

| Pi Field | Source / Default |
| --- | --- |
| `contextWindow` | From `/api/show` → `/v1/models` → 128,000 |
| `maxTokens` | 16,384 (reduced to what still fits in `contextWindow` — [see below](#overriding-models-via-modelsjson)) |
| `cost` | From `/v1/models` `cost_input_per_million` / `cost_output_per_million` (USD/1M tokens; 0 for local models). Per-message `usage.cost` is priced from these rates |
| `reasoning` | `true` when the model reports the `thinking` capability, or when its id is in a family of builtin models with a verified thinking toggle (the catalog labels only some of them — see [Thinking level control](#thinking-level-control)), `false` otherwise |
| `thinkingLevelMap` | `{ off, medium }` only by default, for reasoning models (see [Thinking level control](#thinking-level-control) for the wider per-model maps) |
| `input` | `["text", "image"]` when the model reports the `vision` capability (image paste/drag in the TUI works; the llama.cpp backend loads the `mmproj` companion automatically), otherwise `["text"]` |
| `compat` | `supportsDeveloperRole` / `supportsStore` `false`, `maxTokensField: "max_tokens"`, plus builtin-model `thinkingFormat` heuristics (see [Thinking level control](#thinking-level-control)) — all other compat flags resolve to their defaults |

## Overriding models via `models.json`

The extension only reads the four Lemonade CLI environment variables
(`LEMONADE_HOST`, `LEMONADE_PORT`, `LEMONADE_API_KEY`,
`LEMONADE_ADMIN_API_KEY`) and its own
[configuration file](#configuration-file) —
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
body last, so they override any named field — this is how backend-specific
knobs (llama.cpp/vLLM/SGLang endpoints) reach the wire. Three structurally
reserved keys (`stream`, `model`, `messages`) are skipped in that merge — they
must keep their computed values, and a `samplingParams` override of any of
them would corrupt the request. **No other key is filtered:** a
`samplingParams` entry named `tools`, `tool_choice`, `max_tokens`,
`temperature`, `stream_options`, `store`, or `reasoning_effort` silently
replaces the value the extension computed, so use `samplingParams` only for
keys the extension does not set itself. The output cap is reduced to the
tokens still available in `contextWindow`, with a margin that scales with
the window (floored at 256 output tokens) — a fixed margin would leave a
small-context model able to generate almost nothing.

Provider-level `headers` in `models.json` are also read by this extension:
the `x-pi-provider-lemonade` header selects the streaming backend — it is
deprecated in favor of `streamingMode` in the
[configuration file](#configuration-file) (see
[Choosing the streaming mode](#choosing-the-streaming-mode)).

## Thinking level control

Models whose `/api/show` reports the `thinking` capability — or whose id
is in a family of builtin models with a verified thinking toggle (see the
builtin-models fallback below) — are registered with `reasoning: true`, so
Pi's thinking-level selector works: the selected level is sent with every
request. By default only two levels are exposed — off and medium —
matching the built-in llama.cpp provider: local templates understand at
most a boolean or a few levels, and the rest would be guessed. Three
builtin-model families accept a graded effort, and get a wider per-model
level map instead: **Qwen3.8** (its template enforces a strict
`xhigh`/`medium`/`low` enum, so the accepted range is offered as
`low`/`medium`/`xhigh` — `minimal` and `high` are hidden as duplicates), and
**gpt-oss** and **Muse-Glimmer** (free-form effort strings, so the full
`none`/`minimal`/`low`/`medium`/`high` range is offered; `xhigh` is
hidden).

The wire payload depends on the model. The format is chosen by **id
heuristics for the Lemonade builtin models catalog** (derived from the
builtin models' chat templates — Lemonade does not expose the template
itself; template-based detection is requested upstream in
[lemonade-sdk/lemonade#3644](https://github.com/lemonade-sdk/lemonade/issues/3644)):

| Model ids | Format | What goes on the wire |
| --- | --- | --- |
| Qwen3.8 | `qwen` | top-level `enable_thinking` + `reasoning_effort` (the mapped level) |
| Qwen3/3.5/3.6 (except 3.8), MiniCPM (4.1/5/V-4.5+/o-4.5), GLM-4.5/4.7, Nemotron-3, Ornith-1.5, DeepSeek-V4, PromptBridge, SmolLM3, Gemma-4 | `qwen-chat-template` | `chat_template_kwargs: { enable_thinking, preserve_thinking }` |
| DeepSeek-R1-Distill | `deepseek` | `thinking: { type: "enabled"/"disabled" }` |
| LFM2.5 | `chat-template` | `chat_template_kwargs: { thinking }` (boolean) |
| Muse-Glimmer | `chat-template` | `chat_template_kwargs: { reasoning_strength }` (the selected level; omitted when off) |
| everything else | `openai` (default) | `reasoning_effort: "medium"` / `"none"` — `none` is llama.cpp's hard per-request disable |

<details>
<summary>Why the formats differ (per-family rationale)</summary>

- **Qwen3.8** uses `qwen` (not `qwen-chat-template`): its template reads
  `enable_thinking` **and** a strict `reasoning_effort` enum
  (`xhigh`/`medium`/`low`), and thinking defaults ON, so the server
  stripping a top-level `enable_thinking: true` is harmless; OFF goes
  through the server's disable path.
- The **`enable_thinking`-kwarg families** read the boolean, not
  `reasoning_effort`. Gemma-4 is not labelled `reasoning` in the catalog
  (its template defaults to thinking OFF), so the hint is inert there
  unless you override `reasoning: true` — which then gives a working
  off/medium toggle. Gemma-3 is excluded: its `/think` prompt tokens have
  no kwarg equivalent.
- **DeepSeek-R1-Distill** templates are static always-on, so the payload
  is inert but consistent. **Muse-Glimmer** is always-on; its template
  renders a free-form `Reasoning strength: <value>.` system-prompt
  directive, so the strength is the only control it has.
- The **`openai` default** is correct for gpt-oss (its
  `reasoning_effort` is a free-form string the template renders verbatim)
  and simply inert for the always-on families (Bonsai, Jan,
  Phi-4-mini-reasoning). `off` is not a valid `reasoning_effort` value,
  which is why the level map does not copy the built-in provider's
  `off: "off"`.
</details>

The heuristics are best-effort and can misfire on a user model that shares
an id pattern with a builtin model but uses a different template — override
per-model in `models.json` if needed.

Models that report no `thinking` capability and whose id is not in a
toggle family of builtin models are registered with `reasoning: false`: no thinking
parameters are sent and the selector is hidden. A server that reports
`thinking` for no model at all is assumed to predate the capability, so
every model keeps the toggle. To re-enable the selector on a specific
model, override `reasoning: true` in `models.json`.

**Builtin-models reasoning fallback.** The catalog labels only some
thinking-capable models as `reasoning`, so a builtin model with a verified
template toggle gets `reasoning: true` automatically — the matching
`thinkingFormat` hint is already in `compat`, so no override is needed.
The family set is deliberately stricter than the format rules (always-on
families and non-thinking variants are out): a false positive would show a
thinking selector that does nothing.

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

To provide these enhancements, the extension streams through a specialized
`lemonade-completions` layer by default (which still leverages the OpenAI
SDK for core communication) instead of pi's built-in
`openai-completions` implementation — see
[Choosing the streaming mode](#choosing-the-streaming-mode).

- **Automatic Retries**: To ensure a smooth experience, the extension automatically retries chat completions with exponential backoff if it encounters HTTP 429 (Rate Limit) or 5xx (Server Error) responses — mid-stream or before the first chunk — honoring the server's `Retry-After` header when present. Once any content has been emitted, a failing stream is not retried (re-running it would duplicate the partial output); the error surfaces instead.
- **Detailed Error Messages**: If a request fails, the Pi TUI now displays full diagnostic fields from the Lemonade server (such as status codes and error types), making it easier to diagnose connectivity or server-side issues.
- **Stalled streams**: the retries above cover the request phase and pre-content failures. If the server accepts a request, starts streaming, and then stops sending chunks without closing the connection (a backend that hung mid-generation), the stream has **no idle timeout** — the OpenAI SDK's request timeout is cleared as soon as the response headers arrive, so a stalled stream does not time out on its own. Abort the turn to interrupt it. A mid-stream stall watchdog is deliberately not implemented, to stay aligned with pi's own providers.

### Choosing the streaming mode

By default, requests are streamed through the extension's
`lemonade-completions` layer (the retries and diagnostics above). If you move
to a pi release that this extension has not been verified against and
streaming misbehaves — missing system prompt or tools, unexpected request
errors — set `"streamingMode": "builtin"` in
[pi-provider-lemonade.json](#configuration-file) to use pi's **built-in**
OpenAI-compatible streaming instead, which is always generation-matched to
your pi:

```json
{
  "streamingMode": "builtin"
}
```

Recognized values:

- `"extension"` (default) — use the extension's layer.
- `"builtin"` — use pi's built-in OpenAI-compatible streaming (no
  Lemonade-specific retries or diagnostics).

The mode is read when the extension loads (a `/reload` re-reads the file),
and the active choice is confirmed with a one-time startup notice.

<details>
<summary>Deprecated: the models.json <code>x-pi-provider-lemonade</code> header</summary>

The header in the lemonade provider's `models.json` `headers` still works
when the file does not set `streamingMode` (`"openai-completions"` = builtin,
`"lemonade-completions"` = extension). It is a private extension channel: pi
does not interpret it, and it rides on the request to the Lemonade server,
where it is ignored. The file value takes precedence, and a startup notice
points at the replacement.

</details>

## Closed Development

While this package is open source, its development is not:

- Only npm-distributed files are kept in [the GitHub repository](https://github.com/okulev/pi-provider-lemonade).
  Development files (tests, type configs) are not published to npm or hosted on GitHub.
- Only issues are allowed; pull requests are disabled.
  If you find a bug or have a feature request, please [open an issue](https://github.com/okulev/pi-provider-lemonade/issues).

## License

[MIT](./LICENSE)
