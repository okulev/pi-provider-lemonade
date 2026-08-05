/**
 * Lemonade Server provider for pi
 * ─────────────────────────────────
 * Registers your local Lemonade Server as a pi provider and **discovers its
 * downloaded models automatically** at `GET /v1/models`, then exposes them
 * through Lemonade's OpenAI-compatible API.
 *
 * Only models that are already downloaded locally appear in the catalogue, so
 * every model registered here is immediately usable without a download step.
 *
 * What is read from the server:
 *
 *   - `GET /v1/models` payload:
 *     - `id`             → pi model id / name
 *     - `max_context_window` → `contextWindow` fallback when `/api/show`
 *                              does not report a context length
 *     - `downloaded`     → only `true` models are included
 *
 *   - Ollama-compatible `POST /api/show` — called for every downloaded model;
 *     **mandatory** — the response determines whether the model is included:
 *     - `capabilities`  → included only when both `"completion"` and `"tools"`
 *                          are present. Ollama reports at most: completion, embedding, tools, vision, thinking. A model with `"completion"` but no `"tools"` is excluded, as are non-LLM deployments.
 *     - `model_info["<id>.context_length"]` → authoritative `contextWindow`,
 *                          takes priority over `max_context_window`.
 *
 * Models are filtered by their Ollama capabilities — only those that report
 * both `"completion"` and `"tools"` appear in the catalogue. Recipe and label
 * fields from `/v1/models` are not consulted. Reasoning and vision detection
 * are disabled: Lemonade's chat endpoint uses the model's default behavior,
 * and pi only sends text input
 * (see https://github.com/lemonade-sdk/lemonade/issues/1511).
 *
 * Everything else — context window, output cap, reasoning overrides, compat
 * flags — can be customised per-model via `~/.pi/agent/models.json`
 * `modelOverrides` without touching this extension.
 *
 * Select a model with any of:
 *   pi --model 'lemonade/gemma-3-4b-it-GGUF'
 *   pi --models 'lemonade/*'          # cycle every Lemonade model with Ctrl+P
 *   /model                            # inside the TUI, pick a lemonade/… entry
 *
 * Discovery never blocks pi from starting: if the server is down, unreachable,
 * or slow, the provider is still registered with a single `discovery-failed`
 * model and a one-time warning, so it works again as soon as the server is back.
 *
 * Zero runtime dependencies. Install: `pi install npm:pi-provider-lemonade`
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import type {
	ApiKeyCredential,
	AuthResult,
	Model,
	Provider,
	ProviderStreamOptions,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";

// ── defaults ────────────────────────────────────────────────────────────────

/** Lemonade Server's built-in default host and port (matches `lemonade --help`). */
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "13305";
const DEFAULT_PROVIDER = "lemonade";
/** How long the initial /v1/models fetch may take before falling back. */
const DEFAULT_TIMEOUT_MS = 4000;
/** Output cap for models whose server does not expose one. */
const DEFAULT_MAX_OUTPUT_TOKENS = 16384;
/** Fallback context window used when both `max_context_window` (from /v1/models)
 *  and the Ollama /api/show `context_length` are missing or non-positive. */
const DEFAULT_CONTEXT_WINDOW = 128000;

// ── Config ────────────────────────────────────────────────────────────────────

export interface LemonadeModel {
	id: string;
	created?: number;
	object?: string;
	owned_by?: string;
	checkpoint?: string;
	recipe?: string; // still present in /v1/models; no longer used for filtering
	size?: number;
	max_context_window?: number;
	/** Capabilities reported by the mandatory Ollama-compatible `/api/show`
	 *  request — populated during discovery. A model is only included when this
	 *  reports both `"completion"` and `"tools"`. */
	capabilities?: string[];
	/** Context length from the Ollama-compatible `/api/show` endpoint,
	 *  populated during discovery. Takes priority over `max_context_window`. */
	contextLength?: number;
	downloaded?: boolean;
	suggested?: boolean;
	update_available?: boolean;
	labels?: string[];
}

export interface LemonadeConfig {
	/** Full API base URL ending in `/v1`. */
	baseUrl: string;
	/** API key sent as `Authorization: Bearer`. */
	apiKey: string;
	provider: string;
	timeoutMs: number;
	maxOutputTokens: number;
	contextWindow: number;
}

/** Read configuration from the environment. Called on every extension load (and /reload). */
export function readConfig(
	_env: Record<string, string | undefined> = (
		globalThis as { process?: NodeJS.Process }
	).process?.env as Record<string, string | undefined>,
): LemonadeConfig {
	const host = _env.LEMONADE_HOST || DEFAULT_HOST;
	const port = _env.LEMONADE_PORT || DEFAULT_PORT;
	return {
		baseUrl: buildBaseUrl(host, port),
		// Lemonade ignores the key unless LEMONADE_API_KEY is set server-side, but
		// pi requires a non-empty one to consider the provider authenticated.
		apiKey: _env.LEMONADE_API_KEY || "sk-lemonade-local",
		provider: DEFAULT_PROVIDER,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
		contextWindow: DEFAULT_CONTEXT_WINDOW,
	};
}

/** Construct a base URL from host and port (without `/v1`). */
export function buildBaseUrl(host: string, port: string | number): string {
	const trimmed = host.trim().replace(/\/+$/, "");
	return `http://${trimmed}:${port}`;
}

/** Case-insensitive glob over a model id. */
export function globMatch(pattern: string, id: string): boolean {
	const rx = pattern
		.split("")
		.map((c) =>
			c === "*" // pi-lens-ignore: nested-ternary
				? ".*"
				: c === "?" // pi-lens-ignore: nested-ternary
					? "."
					: c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
		)
		.join("");
	return new RegExp(`^${rx}$`, "i").test(id);
}

/** `http://host:port` → `host:port`, for the provider's display name. */
function displayHost(baseUrl: string): string {
	return baseUrl.replace(/^https?:\/\//, "").replace(/:\d+$/, "");
}

// ── model filtering & mapping ────────────────────────────────────────────────

/**
 * Should this Lemonade model entry appear in the pi catalogue?
 *
 * Two criteria:
 * 1. `downloaded === true` — the model is already present locally.
 * 2. The mandatory `/api/show` request populated `capabilities` with both
 *    `"completion"` and `"tools"` — confirming it is a chat-completion LLM
 *    (not image generation, embeddings, speech-to-text, etc.).
 *
 * Recipe and labels are intentionally NOT consulted — capability detection
 * from `/api/show` is the source of truth: Lemonade uses distinct backends
 * that do not expose `completion`+`tools` capabilities and are therefore
 * excluded here.
 */

/**
 * Sanitize a model ID by replacing control characters,
 * forward slash, and whitespace with `_`.
 *
 * Replaced characters:
 * - `/` - would corrupt the `lemonade/<id>` selection format
 * - Whitespace (`\s`) - breaks CLI/TUI model selection
 * - Control characters (U+0000-U+001F, U+007F-U+009F) - non-printable, cause issues in logs/CLI
 */
export function sanitizeModelId(id: string): string {
	return id.replace(/[\x00-\x1f\x7f-\x9f\s\/]/g, "_");
}

export function isChatCompletionLLM(m: LemonadeModel): boolean {
	if (!m.downloaded) return false;
	const caps = m.capabilities;
	return (
		Array.isArray(caps) && caps.includes("completion") && caps.includes("tools")
	);
}

/**
 * Map one `/v1/models` entry to a pi `Model<"openai-completions">`.
 *
 * - `reasoning` is always `false` — Lemonade's chat endpoint uses the model's
 *   default thinking behavior, and pi should not try to toggle it
 *   (see https://github.com/lemonade-sdk/lemonade/issues/1511).
 * - `input` is always `["text"]` — pi only sends text, even to vision-capable
 *   models, because Lemonade's OpenAI-compatible endpoint handles image input
 *   differently from pi's `input` field semantics.
 * - `thinkingLevelMap` is `undefined` — effort levels are not exposed.
 * - `cost` is zero because local inference has no token cost.
 * - `compat.supportsDeveloperRole` is `false` because Lemonade expects a
 *   `"system"` role (not `"developer"`).
 * - `compat.supportsStore` is `false` — local servers don't support OpenAI's
 *   persistent memory / store feature.
 * - `compat.supportsReasoningEffort` is `false` — local servers don't support
 *   per-request thinking effort levels.
 * - `compat.maxTokensField` is `"max_tokens"` because Lemonade accepts it for
 *   both `/completions` and `/chat/completions`.
 *
 * All numeric fields (`contextWindow`, `maxTokens`) can be overridden per-model
 * or provider-wide via `models.json` `modelOverrides`.
 */
export function toModel(
	m: LemonadeModel,
	config: LemonadeConfig = readConfig({}),
): Model<"openai-completions"> {
	const cw = m.contextLength ?? m.max_context_window;
	// Treat a missing or non-positive value as absent: a value of
	// 0 would otherwise zero out `contextWindow` and the output cap.
	const ctx = !cw || cw <= 0 ? config.contextWindow : cw;

	return {
		id: sanitizeModelId(m.id),
		name: sanitizeModelId(m.id),
		api: "openai-completions",
		provider: config.provider,
		baseUrl: config.baseUrl + "/v1",
		reasoning: false, // Lemonade uses the model's default thinking (lemonade-sdk/lemonade#1511)
		input: ["text"] as ("text" | "image")[], // pi only sends text input
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: ctx,
		maxTokens: Math.max(1, Math.min(config.maxOutputTokens, ctx)),
		compat: {
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
	};
}

/** The single model registered when discovery fails — keeps the provider alive. */
export function fallbackModels(
	config: LemonadeConfig = readConfig({}),
): Model<"openai-completions">[] {
	return [toModel({ id: "discovery-failed", downloaded: true }, config)];
}

// ── Ollama-compatible /api/show (mandatory capability source) ────────────────
//
// Lemonade Server exposes an Ollama-compatible POST /api/show endpoint in
// addition to its OpenAI-compatible GET /v1/models. While /v1/models gives us
// model ids, download status, and a `max_context_window` hint, only /api/show
// reports the model's `capabilities` — the authoritative signal for whether a
// model is a chat-completion LLM (it must report both `"completion"` and
// `"tools"`) versus an image, embedding, or transcription model.
//
// /api/show is therefore **mandatory**: every downloaded model is queried, and
// a model that does not report both capabilities is excluded. A per-model
// failure (non-2xx, parse error, network error) leaves `capabilities` unset,
// which means the model is excluded — if all models fail the endpoint is
// effectively unavailable and discovery degrades to the fallback model.
//
// /api/show also carries the authoritative context length
// (`model_info["<id>.context_length"]`), which takes priority over
// `max_context_window` from /v1/models.

/** Ollama-compatible /api/show response. */
interface OllamaShowResponse {
	capabilities?: string[];
	model_info?: Record<string, unknown>;
}

/** Result extracted from a single /api/show response. */
interface OllamaShowResult {
	capabilities?: string[];
	contextLength?: number;
}

const OLLAMA_CONCURRENCY = 5;

/** Find the context length inside an Ollama model_info object by looking for
 *  a *.context_length key with a positive numeric value. Returns undefined
 *  when absent or non-positive. */
function extractOllamaContextLength(
	modelInfo: Record<string, unknown> | undefined,
): number | undefined {
	if (!modelInfo) return undefined;
	for (const [key, value] of Object.entries(modelInfo)) {
		if (!key.endsWith(".context_length")) continue;
		const num = Number(value);
		if (Number.isFinite(num) && num > 0) return num;
	}
	return undefined;
}

/** Fetch capabilities and context length for a single model from /api/show.
 *  Returns undefined on any failure (non-ok status, parse error, etc.)
 *  so the caller excludes the model — /api/show is the source of truth
 *  for capability, and a missing response means the capabilities are
 *  unknown, which is treated as non-completion-capable. */
// pi-lens-ignore: long-parameter-list
async function fetchOllamaShow(
	baseUrl: string,
	modelId: string,
	fetchImpl: typeof fetch,
	bearer: string,
	timeoutMs: number,
): Promise<OllamaShowResult | undefined> {
	const controller = new AbortController();
	const id = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchImpl(`${baseUrl}/api/show`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${bearer}`,
			},
			body: JSON.stringify({ model: modelId, verbose: true }),
			signal: controller.signal,
		});
		if (!res.ok) return undefined;
		const payload = (await res.json()) as OllamaShowResponse;
		return {
			capabilities: payload.capabilities,
			contextLength: extractOllamaContextLength(payload.model_info),
		};
	} catch {
		return undefined;
	} finally {
		clearTimeout(id);
	}
}

/** Query /api/show for every model in the list and attach each model's
 *  `capabilities` and `contextLength`. Models are processed in bounded-
 *  parallel batches. Per-model failures leave `capabilities` unset (the
 *  model is later excluded by `isChatCompletionLLM`). Never throws. */
async function fetchOllamaCapabilities(
	models: LemonadeModel[],
	config: LemonadeConfig,
	fetchImpl: typeof fetch,
	bearer: string,
): Promise<LemonadeModel[]> {
	if (models.length === 0) return models;
	const enriched = models.map((m) => ({ ...m }));
	const { baseUrl, timeoutMs } = config;
	for (let i = 0; i < enriched.length; i += OLLAMA_CONCURRENCY) {
		const batch = enriched.slice(i, i + OLLAMA_CONCURRENCY);
		const results = await Promise.allSettled(
			batch.map((m) =>
				fetchOllamaShow(baseUrl, m.id, fetchImpl, bearer, timeoutMs),
			),
		);
		for (let j = 0; j < results.length; j++) {
			const result = results[j];
			if (result.status === "fulfilled" && result.value !== undefined) {
				batch[j].capabilities = result.value.capabilities;
				batch[j].contextLength = result.value.contextLength;
			}
		}
	}
	return enriched;
}

// ── discovery ────────────────────────────────────────────────────────────────

/**
 * Fetch and map the server's downloaded model list.
 *
 * 1. `GET /v1/models` — collect downloaded models.
 * 2. `POST /api/show` (mandatory) — attach `capabilities` and `contextLength`.
 * 3. Filter by `completion`+`tools` capability, map to pi `Model` objects.
 *
 * Resolves to `{ models, error }` rather than rejecting: a discovery failure
 * degrades to `fallbackModels()` and never takes pi's startup down.
 */
// pi-lens-ignore: long-parameter-list
export async function discoverModels(
	config: LemonadeConfig,
	fetchImpl: typeof fetch = fetch,
	_env: Record<string, string | undefined> = ((
		globalThis as { process?: NodeJS.Process }
	).process?.env as Record<string, string | undefined>) ?? {},
	signal?: AbortSignal,
	// optional bearer key from the `/login lemonade` credential, so discovery
	// authenticates with the same key live requests use (not just config/env).
	credentialKey?: string,
): Promise<{ models: Model<"openai-completions">[]; error?: string }> {
	let entries: LemonadeModel[];

	try {
		const bearer = credentialKey ?? config.apiKey;
		const res = await fetchImpl(`${config.baseUrl}/v1/models`, {
			headers: { Authorization: `Bearer ${bearer}` },
			signal: signal ?? AbortSignal.timeout(config.timeoutMs),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

		const payload = (await res.json()) as { data?: LemonadeModel[] };
		entries = (payload?.data ?? []).filter(
			(m): m is LemonadeModel =>
				typeof m?.id === "string" && m.id.length > 0 && m.downloaded === true, // only locally-present models
		);
		if (entries.length === 0)
			throw new Error("server returned no downloaded models");

		// 2. Query the Ollama-compatible /api/show for every downloaded model.
		//    This is mandatory — /api/show is the source of truth for `capabilities`
		//    (which models are chat-completion LLMs) and the authoritative
		//    context length. Per-model failures leave capabilities unset,
		//    which excludes the model; if all fail, the endpoint is unavailable
		//    and the final filter below produces "no completion+tools-capable
		//    models" → graceful fallback.
		try {
			entries = await fetchOllamaCapabilities(
				entries,
				config,
				fetchImpl,
				bearer,
			);
		} catch {
			// Defensive: fetchOllamaCapabilities never throws, but stay safe.
		}

		// 3. Keep only models whose /api/show reports both "completion" and
		//    "tools" capabilities.
		entries = entries.filter((m) => isChatCompletionLLM(m));
		if (entries.length === 0)
			throw new Error("server returned no completion+tools-capable models");
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { models: fallbackModels(config), error: reason };
	}

	const models = entries.map((m) => toModel(m, config));
	return { models };
}

// ── credential resolution ────────────────────────────────────────────────────

const PLACEHOLDER_API_KEY = "sk-lemonade-local";

/** Resolve the API key for live API requests (not model discovery).
 *
 * Priority:
 * 1. `auth.json` entry (via `/login lemonade`) — `credential.key`
 * 2. `LEMONADE_API_KEY` from the injected `AuthContext.env` (read in `resolve`)
 * 3. `process.env.LEMONADE_API_KEY` (fallback for non-Node hosts)
 * 4. Placeholder `sk-lemonade-local` (ignored by the server when no auth is configured)
 */
function resolveApiKey(
	credential?: { key?: string },
	envKey?: string,
): {
	apiKey: string;
	source: string;
} {
	if (credential?.key) {
		return { apiKey: credential.key, source: "stored API key" };
	}
	if (envKey) {
		return { apiKey: envKey, source: "LEMONADE_API_KEY environment variable" };
	}
	return {
		apiKey: PLACEHOLDER_API_KEY,
		source: "placeholder (server has no auth)",
	};
}

// ── extension factory ────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
	const config = readConfig();
	const env =
		((globalThis as { process?: NodeJS.Process }).process?.env as Record<
			string,
			string | undefined
		>) ?? {};
	const initial = await discoverModels(config, fetch, env);

	// Current discovered catalog. `refreshModels` retains the last-known-good
	// list on failure and persists successful fetches through the provider store.
	let currentModels = initial.models;

	pi.registerProvider({
		id: config.provider,
		name: `Lemonade (${displayHost(config.baseUrl)})`,
		baseUrl: config.baseUrl + "/v1",
		auth: {
			apiKey: {
				name: "Lemonade Server API key",
				async login(interaction): Promise<ApiKeyCredential> {
					const key = await interaction.prompt({
						type: "secret",
						message:
							"Lemonade API key (leave empty if server doesn't require auth)",
					});
					return {
						type: "api_key",
						key: key || PLACEHOLDER_API_KEY,
					};
				},
				async resolve({ ctx, credential }): Promise<AuthResult | undefined> {
					// read the key through the injected AuthContext.env DI surface
					// (works in browsers and Node test harnesses), keeping process.env
					// only as a fallback for non-Node hosts.
					const envKey = await ctx.env("LEMONADE_API_KEY");
					const procEnv = (
						(globalThis as { process?: NodeJS.Process }).process?.env as Record<
							string,
							string | undefined
						>
					)?.LEMONADE_API_KEY;
					const resolved = resolveApiKey(credential, envKey ?? procEnv);
					// `AuthResult.auth.apiKey` is what pi attaches to requests as
					// Authorization: Bearer <key>. The key must be nested under `auth`,
					// not returned at the top level of the result.
					return {
						auth: { apiKey: resolved.apiKey },
						source: resolved.source,
					};
				},
			},
		},
		getModels: () => currentModels,
		/** Live re-discovery: pi calls this during model refresh and /reload,
		 *  so new downloads appear without a process restart. On a discovery
		 *  failure it returns early (no throw) so the last-known-good catalog
		 *  — or the initial baseline — is retained instead of being replaced. */
		async refreshModels(
			this: void,
			context: RefreshModelsContext,
		): Promise<void> {
			const stored = await context.store.read();
			if (stored) {
				currentModels = stored.models.filter(
					(m): m is Model<"openai-completions"> =>
						m.provider === config.provider && m.api === "openai-completions",
				);
			}
			if (!context.allowNetwork || context.signal?.aborted) return;
			// `force` (if provided by the caller) is accepted but currently a no-op:
			// the provider has no freshness/etag checks, so a refresh always
			// re-fetches unconditionally. It can gate a future early-exit once
			// staleness detection exists.
			// Thread the `/login lemonade` credential's bearer into discovery so
			// a key stored via /login authenticates refresh requests too.
			const credentialKey =
				context.credential?.type === "api_key"
					? context.credential.key
					: undefined;
			const { models, error } = await discoverModels(
				config,
				fetch,
				env,
				context.signal,
				credentialKey,
			);
			if (error) return;
			currentModels = models;
			if (!context.signal?.aborted) {
				await context.store.write({
					models: currentModels,
					checkedAt: Date.now(),
				});
			}
		},
		// Lemonade is OpenAI-compatible chat/completions: dispatch through the
		// openai-completions streaming implementation via the api registry.
		stream: (model, context, options) =>
			stream(model, context, options as ProviderStreamOptions | undefined),
		streamSimple: (model, context, options) =>
			streamSimple(model, context, options),
	} as Provider<"openai-completions">);

	if (!initial.error) return;

	const message =
		`Model discovery from ${config.baseUrl}/v1 failed (${initial.error}). ` +
		`Registered provider "${config.provider}" with a single "discovery-failed" model. ` +
		`Start the server and run /reload, or set LEMONADE_HOST/LEMONADE_PORT.`;

	let warned = false;
	pi.on(
		"session_start",
		// pi-lens-ignore: async-noise
		async (_event: SessionStartEvent, ctx: ExtensionContext) => {
			if (warned) return; // session_start also fires on reload/switch — warn once per process
			warned = true;
			if (ctx.hasUI) {
				ctx.ui.notify(`[pi-provider-lemonade] ${message}`, "warning");
			} else {
				console.warn(`[pi-provider-lemonade] ${message}`); // pi-lens-ignore: no-console-except-error,console-statement
			}
		},
	);
}
