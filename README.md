# pi-provider-lemonade

[Pi](https://pi.dev) extension that registers your local
[Lemonade Server](https://lemonade-server.ai) as a provider and **discovers its
downloaded models automatically**. Add a model to the server, and
it is available in `/model` — no manual `models.json` updates required.

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
| `LEMONADE_HOST` | `127.0.0.1` | Server host address |
| `LEMONADE_PORT` | `13305` | Server port |

The connection is established via `http://${LEMONADE_HOST}:${LEMONADE_PORT}`.

### Authentication

You can authenticate with the server in two ways:

1. **Pi Credential (Preferred):** Run `/login lemonade` inside the Pi TUI. This is the most reliable method and takes priority for live requests and model refreshes.
2. **Environment Variable:** Set the `LEMONADE_API_KEY` variable.

*Note: Provider-level configuration in `models.json` (like `baseUrl` or `apiKey`) is not supported because this extension uses dynamic discovery. Use environment variables or `/login` instead.*

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

If no capable models are found, a `discovery-failed` fallback model is provided.

### When Discovery Happens

- **At startup:** Automatically performed whenever the `pi` CLI is launched (e.g., starting a TUI session or running `pi --list-models`). **Note:** Initial discovery at startup cannot use the `/login` credential and will rely on the `LEMONADE_API_KEY` environment variable (or the default placeholder).
- **On demand:** Triggered when you run `/reload` in the TUI or `pi update --models` in the CLI. These actions trigger a model refresh that **uses the `/login` credential if available**, taking priority over environment variables.

*Note: Since `pi update --models` is a CLI command, it first performs the "At startup" discovery (using the env key) and then immediately performs the "On demand" refresh (using the login credential).*

Discovered models are cached in `~/.pi/agent/models-store.json` for faster restarts and offline access.

### Model Properties

The following properties are derived automatically and can be overridden in `models.json`:

| Pi Field | Source / Default |
| --- | --- |
| `contextWindow` | From `/api/show` → `/v1/models` → 128,000 |
| `maxTokens` | 16,384 (clamped to `contextWindow`) |
| `reasoning` | `false` (uses model's default thinking) |
| `input` | `["text"]` |
| `compat` | `maxTokensField: "max_tokens"`, others `false` |

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

## Thinking level control is not exposed

Extended thinking controls (`reasoning`, `thinkingLevelMap`) are **not exposed** because Pi does not send `reasoning_effort` parameters to the Lemonade server. This means you cannot control or customize thinking behavior.

**However:** `reasoning: false` does NOT mean the model will refrain from thinking. The model uses its **built-in default thinking behavior** as configured when the model was built. Reasoning-capable models like Qwen3 and DeepSeek will still think according to their internal defaults — Pi simply doesn't attempt to modify that behavior.

This limitation exists because Lemonade's chat endpoint does not yet support per-request thinking level configuration (see [lemonade-sdk/lemonade#1511](https://github.com/lemonade-sdk/lemonade/issues/1511)).

## Closed Development

While this package is open source, its development is not:

- Only npm-distributed files are kept in [the GitHub repository](https://github.com/okulev/pi-provider-lemonade).
  Development files (tests, type configs) are not published to npm or hosted on GitHub.
- Only issues are allowed; pull requests are disabled.
  If you find a bug or have a feature request, please [open an issue](https://github.com/okulev/pi-provider-lemonade/issues).

## License

[MIT](./LICENSE)
