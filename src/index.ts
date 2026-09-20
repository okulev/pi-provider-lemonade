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
 *     - `cost_input_per_million` / `cost_output_per_million` →
 *                          `cost.input` / `cost.output` (cloud models)
 *
 *   - `GET /v1/health` — enriches with loaded/pinned model state:
 *     - `all_models_loaded[].pinned` → models currently in memory and pinned.
 *     - `all_models_loaded[].last_use` → sort pinned/loaded by recency.
 *     - `all_models_loaded[].model_name` → matched against `/v1/models` ids.
 *     - Failure is graceful — models retain `pinned: undefined` and sort last.
 *
 *   - Ollama-compatible `POST /api/show` — called for every downloaded model;
 *     **mandatory** — the response determines whether the model is included:
 *     - `capabilities`  → included only when both `"completion"` and `"tools"`
 *                          are present. Ollama reports at most: completion, embedding, tools, vision, thinking. A model with `"completion"` but no `"tools"` is excluded, as are non-LLM deployments.
 *     - `model_info["<id>.context_length"]` → authoritative `contextWindow`,
 *                          takes priority over `max_context_window`.
 *
 * Models are filtered by their Ollama capabilities — only those that report
 * both `"completion"` and `"tools"` appear in the catalogue. They are sorted:
 * 1. **Pinned** (pinned by the user via `/v1/load`) — sorted by decreasing `last_use`.
 * 2. **Loaded** (in memory but not pinned) — sorted by decreasing `last_use`.
 * 3. **Downloaded, non-cloud** — local models not loaded, case-insensitive sort.
 * 4. **Downloaded, cloud recipe** — cloud models, lowest priority, case-insensitive sort.
 *
 * Recipe and label fields from `/v1/models` are not consulted for filtering.
 * Reasoning and vision detection are disabled: Lemonade's chat endpoint uses
 * the model's default behavior, and pi only sends text input
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
 * Runtime deps: `@earendil-works/pi-ai` (pinned to the pi-bundled version) and
 * `openai` — the SDK's convertMessages/stream helpers and the OpenAI client.
 * Install: `pi install npm:pi-provider-lemonade`
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";

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
// pi's own OpenAI-compatible streaming implementation. Under pi, this
// specifier is aliased to the host's bundled pi-ai (both install modes), so
// the "openai-completions" backend always runs the host's own generation,
// not the pi-ai the extension pins.
import {
	stream as hostStream,
	streamSimple as hostStreamSimple,
} from "@earendil-works/pi-ai/compat";
import {
	DEFAULT_MAX_RETRIES,
	DEFAULT_MAX_RETRY_DELAY_MS,
	stream,
	streamSimple,
} from "./lemonade-completions.ts";

// ── defaults ────────────────────────────────────────────────────────────────

/** Lemonade Server's built-in default host and port (matches `lemonade --help`). */
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 13305;
const DEFAULT_PROVIDER = "lemonade";
/** How long one discovery request may take before it is given up on. */
const DEFAULT_TIMEOUT_MS = 4000;
/** Overall budget for a whole discovery pass (`/v1/models` + `/v1/health` +
 *  every `/api/show`, queried five at a time). Each request keeps its own
 *  `DEFAULT_TIMEOUT_MS`; without an overall deadline a server that accepts
 *  connections but never answers could stall pi startup for
 *  `DEFAULT_TIMEOUT_MS × ceil(modelCount / OLLAMA_CONCURRENCY)` (20 models
 *  ≈ 16 s). Override with `LEMONADE_DISCOVERY_TIMEOUT_MS`. */
const DEFAULT_DISCOVERY_TIMEOUT_MS = 20000;
/** Output cap for models whose server does not expose one. */
const DEFAULT_MAX_OUTPUT_TOKENS = 16384;
/** Fallback context window used when both `max_context_window` (from /v1/models)
 *  and the Ollama /api/show `context_length` are missing or non-positive. */
const DEFAULT_CONTEXT_WINDOW = 128000;
/** Placeholder bearer when no key is configured: pi requires a non-empty
 *  key to consider the provider authenticated, and Lemonade ignores the
 *  header entirely when it runs without LEMONADE_API_KEY. (The Lemonade
 *  CLI's `launch` subcommand uses its own `"lemonade"` placeholder for the
 *  agent environment — the value is meaningless to the server either way.) */
const PLACEHOLDER_API_KEY = "sk-lemonade-local";

// ── Completions backend switch ─────────────────────────────────────────────────
//
// The `x-pi-provider-lemonade` header in the lemonade provider's models.json
// `headers` selects the streaming backend per request:
//
//   "openai-completions"   — pi's built-in OpenAI-compatible streaming
//                            (the host's pi-ai, via the compat alias above)
//   "lemonade-completions" — this extension's fork (default): Lemonade error
//                            reporting and retry tuning
//
// The header is a private extension channel: it rides on the request to the
// Lemonade server (which ignores it), and both the session-start
// notice/warning and the per-request dispatch read it.
export const COMPLETIONS_HEADER = "x-pi-provider-lemonade";
export type CompletionsMode = "lemonade-completions" | "openai-completions";

/** Newest pi version this extension has been verified against. */
const NEWEST_TESTED_PI = "0.86";

function completionsHeaderValue(
	headers?: Record<string, string | null>,
): string | undefined {
	if (!headers) return undefined;
	const exact = headers[COMPLETIONS_HEADER];
	if (exact !== undefined && exact !== null) return exact;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === COMPLETIONS_HEADER && value !== null) {
			return value;
		}
	}
	return undefined;
}

/** Resolve the streaming backend from the request headers. */
export function resolveCompletionsMode(headers?: Record<string, string | null>): {
	mode: CompletionsMode;
	value: string | undefined;
} {
	const value = completionsHeaderValue(headers);
	return {
		mode:
			value === "openai-completions"
				? "openai-completions"
				: "lemonade-completions",
		value,
	};
}

/** Whether `version` is newer than the newest pi this extension was tested on. */
export function isUntestedPiVersion(version: string | undefined): boolean {
	if (!version) return false;
	const match = /^(\d+)\.(\d+)/.exec(version);
	if (!match) return false;
	const [testedMajor, testedMinor] = NEWEST_TESTED_PI.split(".").map(Number);
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > testedMajor || (major === testedMajor && minor > testedMinor);
}

/**
 * Startup warnings for the backend switch. The untested-pi warning fires only
 * when the user made no valid explicit choice (header absent or unrecognized)
 * — either recognized value acknowledges the risk.
 */
export function completionsWarnings(
	piVersion: string | undefined,
	headerValue: string | undefined,
): string[] {
	const warnings: string[] = [];
	const recognized =
		headerValue === "openai-completions" ||
		headerValue === "lemonade-completions";
	if (headerValue !== undefined && !recognized) {
		warnings.push(
			`Invalid "${COMPLETIONS_HEADER}" value "${headerValue}" (expected "openai-completions" or "lemonade-completions") — using "lemonade-completions".`,
		);
	}
	if (isUntestedPiVersion(piVersion) && !recognized) {
		warnings.push(
			`pi ${piVersion} is newer than the newest version this extension was tested against (${NEWEST_TESTED_PI}). ` +
				`If streaming misbehaves (e.g. missing system prompt or tools, request errors), add ` +
				`"${COMPLETIONS_HEADER}": "openai-completions" to the lemonade provider's "headers" in models.json ` +
				`to use pi's built-in OpenAI-compatible streaming — or set it to "lemonade-completions" ` +
				`to keep the extension's streaming and silence this warning.`,
		);
	}
	return warnings;
}

let piVersionOverride: string | null = null;
let piVersionPromise: Promise<string | undefined> | undefined;

/** Test hook: force the detected pi version (null restores auto-detection). */
export function setPiVersionForTests(version: string | null): void {
	piVersionOverride = version;
	piVersionPromise = undefined;
}

/**
 * Detect the host pi's version, lazily and defensively:
 *  1. `VERSION` from `@earendil-works/pi-coding-agent` — under pi the bare
 *     specifier is aliased to the host's bundled copy (both install modes),
 *     so this is the host's version, not the extension's devDep;
 *  2. the `package.json` next to the executable (npm / binary install layout).
 * Unknown → `undefined`, which suppresses the untested-pi warning rather
 * than guessing.
 */
function detectPiVersion(): Promise<string | undefined> {
	piVersionPromise ??= (async () => {
		if (piVersionOverride !== null) return piVersionOverride;
		try {
			const mod: unknown = await import("@earendil-works/pi-coding-agent");
			const version = (mod as { VERSION?: unknown }).VERSION;
			if (typeof version === "string" && /^\d+\.\d+/.test(version)) {
				return version;
			}
		} catch {
			// Host bundle not resolvable (non-pi environment) — try disk.
		}
		try {
			let dir = path.dirname(process.argv[1] ?? "");
			for (let i = 0; i < 6 && dir.length > 1; i++) {
				const pkg = JSON.parse(
					await readFile(path.join(dir, "package.json"), "utf8"),
				) as { name?: unknown; version?: unknown };
				if (
					pkg.name === "@earendil-works/pi-coding-agent" &&
					typeof pkg.version === "string"
				) {
					return pkg.version;
				}
				dir = path.dirname(dir);
			}
		} catch {
			// No readable package.json — version unknown.
		}
		return undefined;
	})();
	return piVersionPromise;
}

/** Read the switch from the provider's composed auth (models.json headers). */
async function readCompletionsHeader(
	ctx: ExtensionContext,
	providerId: string,
): Promise<string | undefined> {
	try {
		const registry = ctx.modelRegistry;
		if (!registry || typeof registry.getProviderAuth !== "function") {
			return undefined;
		}
		const result = await registry.getProviderAuth(providerId);
		return completionsHeaderValue(result?.auth?.headers);
	} catch {
		return undefined;
	}
}

// ── Config ────────────────────────────────────────────────────────────────────

/**
 * One entry of Lemonade's `GET /v1/models` payload, plus the fields discovery
 * attaches while building the catalog.
 *
 * **Read:** `id`, `downloaded`, `max_context_window`, `recipe` (sorting only —
 * never for filtering), `cost_input_per_million`, `cost_output_per_million`,
 * and the discovery-populated `capabilities`, `contextLength`, `pinned`,
 * `last_use`, `_showFailed`.
 *
 * **Documented payload, never read:** `created`, `object`, `owned_by`,
 * `checkpoint`, `size`, `suggested`, `update_available`, `labels`. They are
 * declared so the parsed payload stays typed (and the test fixture honest), not
 * because anything consults them — name labels and `update_available` were
 * dropped deliberately (they are not standard Lemonade fields) and capability
 * detection comes from `/api/show`, not `labels`.
 */
export interface LemonadeModel {
	id: string;
	/** Documented payload, never read (see the interface doc). */
	created?: number;
	/** Documented payload, never read (see the interface doc). */
	object?: string;
	/** Documented payload, never read (see the interface doc). */
	owned_by?: string;
	/** Documented payload, never read (see the interface doc). */
	checkpoint?: string;
	/** Still present in `/v1/models`; used only to sort cloud recipes last. */
	recipe?: string;
	/** Documented payload, never read (see the interface doc). */
	size?: number;
	max_context_window?: number;
	/** Capabilities reported by the mandatory Ollama-compatible `/api/show`
	 *  request — populated during discovery. A model is only included when this
	 *  reports both `"completion"` and `"tools"`. */
	capabilities?: string[];
	/** Internal: set when the mandatory `/api/show` probe itself failed (transport
	 *  error or non-2xx), as distinct from a probe that answered "not capable".
	 *  A catalog that is empty only because every probe failed is a discovery
	 *  failure, not an honest "nothing usable" answer. */
	_showFailed?: boolean;
	/** Context length from the Ollama-compatible `/api/show` endpoint,
	 *  populated during discovery. Takes priority over `max_context_window`. */
	contextLength?: number;
	downloaded?: boolean;
	/** Documented payload, never read (see the interface doc). */
	suggested?: boolean;
	/** Documented payload, never read (see the interface doc). */
	update_available?: boolean;
	/** Documented payload, never read: capability detection comes from `/api/show`,
	 *  not from server-side labels (see the interface doc). */
	labels?: string[];
	/** Whether the model is currently pinned (from `GET /v1/health`).
	 *  Populated during discovery; `true` models are sorted first. */
	pinned?: boolean;
	/** Unix timestamp of last access (load or inference), from `GET /v1/health`.
	 *  Used to sort pinned and loaded models by recency. */
	last_use?: number;
	/** Input pricing in USD per 1 M tokens (cloud models only; omitted or < 0 when unknown). */
	cost_input_per_million?: number;
	/** Output pricing in USD per 1 M tokens (cloud models only; omitted or < 0 when unknown). */
	cost_output_per_million?: number;
}

export interface LemonadeConfig {
	/** Full API base URL ending in `/v1`. */
	baseUrl: string;
	/** API key sent as `Authorization: Bearer`. */
	apiKey: string;
	provider: string;
	timeoutMs: number;
	/** Overall budget for one discovery pass (see DEFAULT_DISCOVERY_TIMEOUT_MS). */
	discoveryTimeoutMs: number;
	maxOutputTokens: number;
	contextWindow: number;
	/** Corrections made to malformed environment configuration, e.g. an invalid
	 *  port in `LEMONADE_HOST`. Empty when the environment is usable as given.
	 *  Surfaced in the startup notice so a silently replaced port is visible
	 *  instead of showing up later as a confusing connection error. */
	warnings: string[];
}

/**
 * Find the colon separating host and port, or -1 when the string carries no
 * port. Bracketed IPv6 (`[::1]:8080`): the colon after `]`, if any.
 * Unbracketed: the last colon, but only if there is at most one — multiple
 * colons indicate a raw IPv6 address, which carries no port here.
 * (SDK: the port/host section of `parse_target_url`.)
 */
function findPortSeparator(remaining: string): number {
	const closeBracket = remaining.indexOf("]");
	if (remaining.startsWith("[") && closeBracket !== -1) {
		return remaining.indexOf(":", closeBracket);
	}
	let colonCount = 0;
	for (const c of remaining) {
		if (c === ":") colonCount += 1;
	}
	return colonCount <= 1 ? remaining.lastIndexOf(":") : -1;
}

/**
 * Parse a target URL or host string into its constituent parts.
 *
 * Faithful port of `lemon::utils::parse_target_url` from the Lemonade SDK
 * (`.pi/lemonade/src/cpp/server/utils/url_utils.cpp`), which parses the
 * `LEMONADE_HOST` env/CLI value. Accepted inputs (same as the SDK):
 *
 *   127.0.0.1                  host only
 *   127.0.0.1:13305            host:port
 *   http://127.0.0.1:13305     URL (case-insensitive scheme sets isSsl)
 *   https://my-server.com      scheme without port → 443 when overriding
 *   [::1]:13305 / ::1          bracketed / raw IPv6
 *   any of the above with a trailing path/query/fragment (stripped)
 *
 * @param inputHost  Raw value: host, host:port, or URL.
 * @param port       Incoming port; retained unless the URL specifies a
 *                   (valid) one, or a scheme triggers the override below.
 * @param isSsl      Incoming flag; only overwritten when a scheme matches.
 * @param overrideDefaultPort  When true and a scheme is present without an
 *                   explicit port, the port becomes 443 (https) / 80 (http).
 * @returns Parsed parts. `port === -1` flags an invalid port (SDK parity —
 *          the SDK keeps -1 and lets the connection fail).
 */
export function parseTargetUrl(
	inputHost: string,
	port: number,
	isSsl: boolean,
	overrideDefaultPort = true,
): { host: string; port: number; isSsl: boolean } {
	let remaining = inputHost;
	let hasScheme = false;

	// Case-insensitive scheme matching (SDK: starts_with_case_insensitive).
	const lower = remaining.toLowerCase();
	if (lower.startsWith("https://")) {
		isSsl = true;
		remaining = remaining.slice(8);
		hasScheme = true;
	} else if (lower.startsWith("http://")) {
		isSsl = false;
		remaining = remaining.slice(7);
		hasScheme = true;
	}

	// Strip path, query parameters, or fragments.
	const limitPos = remaining.search(/[/?#]/);
	if (limitPos !== -1) {
		remaining = remaining.slice(0, limitPos);
	}

	// Parse port and host.
	const colonPos = findPortSeparator(remaining);

	if (colonPos !== -1) {
		const host = remaining.slice(0, colonPos);
		const portStr = remaining.slice(colonPos + 1);
		// std::from_chars parity: the whole string must be base-10 digits in
		// 1..65535 (no sign, no hex, no trailing garbage).
		const parsed = /^\d+$/.test(portStr) ? Number(portStr) : NaN;
		const valid =
			Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535;
		return { host, port: valid ? parsed : -1, isSsl };
	}

	const host = remaining;
	if (hasScheme && overrideDefaultPort) {
		return { host, port: isSsl ? 443 : 80, isSsl };
	}
	return { host, port, isSsl };
}

/**
 * Enclose raw IPv6 address strings in brackets ([::1]) for use in URLs.
 * Port of `lemon::utils::bracket_host_if_ipv6`.
 */
export function bracketHostIfIpv6(host: string): string {
	if (host.includes(":") && !host.startsWith("[")) {
		return `[${host}]`;
	}
	return host;
}

/** Read configuration from the environment. Called on every extension load (and /reload). */
export function readConfig(
	// The `?? {}` makes the default honest on non-Node hosts (where
	// `process` is absent): `readConfig()` with no env then sees an empty
	// environment and the built-in defaults, instead of throwing on the
	// first `_env.LEMONADE_HOST` access.
	_env: Record<string, string | undefined> = (
		(globalThis as { process?: NodeJS.Process }).process?.env ?? {}
	) as Record<string, string | undefined>,
): LemonadeConfig {
	// LEMONADE_HOST is parsed exactly like the Lemonade SDK CLI does
	// (src/cpp/cli/main.cpp → lemon::utils::parse_target_url): it may be a
	// bare host, host:port, or a full http(s):// URL. A set LEMONADE_PORT
	// suppresses the scheme-default port override (80/443) — the SDK's
	// `!explicit_port`, since CLI11 counts env-sourced option values as
	// explicit. An invalid LEMONADE_PORT falls back to the built-in default
	// (CLI11 would reject it outright).
	const host = (_env.LEMONADE_HOST ?? "").trim() || DEFAULT_HOST;
	const portEnv = _env.LEMONADE_PORT;
	const explicitPort = portEnv !== undefined && portEnv !== "";
	// Same strictness as `parseTargetUrl`'s port validation (SDK
	// `std::from_chars` parity): trimmed, base-10 digits only, 1..65535.
	// An out-of-range value (`99999`) or a non-decimal one (`0x10`) must not
	// reach the base URL — it would only surface later as a confusing
	// connection error instead of a named correction.
	const envPortRaw = (portEnv ?? "").trim();
	const envPort = /^\d+$/.test(envPortRaw) ? Number(envPortRaw) : NaN;
	const hasValidPortEnv =
		Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535;
	// Port used when `LEMONADE_HOST` carries no (valid) port of its own.
	const initialPort = hasValidPortEnv ? envPort : DEFAULT_PORT;
	const warnings: string[] = [];
	if (explicitPort && !hasValidPortEnv) {
		warnings.push(
			`ignoring the invalid LEMONADE_PORT ("${portEnv}"), using ${initialPort}`,
		);
	}
	const parsed = parseTargetUrl(host, initialPort, false, !explicitPort);
	// `parseTargetUrl` keeps the SDK's `-1` sentinel for a malformed port: the
	// SDK CLI lets the connection fail, but pi needs a base URL it can actually
	// dial — `http://host:-1` would only produce a confusing fetch error. Fall
	// back to the port the environment asked for (`LEMONADE_PORT` when valid,
	// otherwise the built-in default) and report the correction.
	let port = parsed.port;
	if (port === -1) {
		warnings.push(
			`ignoring the invalid port in LEMONADE_HOST ("${host}"), using ${initialPort}`,
		);
		port = initialPort;
	}
	return {
		baseUrl: buildBaseUrl(parsed.host, port, parsed.isSsl),
		// Key resolution matches the Lemonade CLI: a non-empty
		// LEMONADE_ADMIN_API_KEY overrides LEMONADE_API_KEY (src/cpp/cli/
		// main.cpp). Lemonade ignores the key unless LEMONADE_API_KEY is set
		// server-side, but pi requires a non-empty one to consider the
		// provider authenticated.
		apiKey:
			_env.LEMONADE_ADMIN_API_KEY ||
			_env.LEMONADE_API_KEY ||
			PLACEHOLDER_API_KEY,
		provider: DEFAULT_PROVIDER,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		discoveryTimeoutMs: readDiscoveryTimeoutMs(_env, warnings),
		maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		warnings,
	};
}

/** Overall discovery budget: `LEMONADE_DISCOVERY_TIMEOUT_MS` when it is a
 *  positive integer, otherwise `DEFAULT_DISCOVERY_TIMEOUT_MS`. A malformed
 *  override is reported by pushing onto the caller's `warnings` array, so the
 *  startup notice can name the value that was ignored. */
function readDiscoveryTimeoutMs(
	env: Record<string, string | undefined>,
	warnings: string[],
): number {
	const raw = env.LEMONADE_DISCOVERY_TIMEOUT_MS;
	const ms = Number(raw);
	if (Number.isInteger(ms) && ms > 0) return ms;
	if (raw !== undefined && raw !== "") {
		warnings.push(
			`ignoring the invalid LEMONADE_DISCOVERY_TIMEOUT_MS ("${raw}"), using ${DEFAULT_DISCOVERY_TIMEOUT_MS}`,
		);
	}
	return DEFAULT_DISCOVERY_TIMEOUT_MS;
}

/**
 * Construct a base URL from parsed parts (without `/v1`). Mirrors the SDK
 * client's URL construction (`LemonadeClient::make_client`): scheme from
 * `isSsl`, raw IPv6 hosts bracketed, explicit port.
 */
export function buildBaseUrl(host: string, port: number, isSsl = false): string {
	return `${isSsl ? "https" : "http"}://${bracketHostIfIpv6(host)}:${port}`;
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
 * Sanitize a model ID by replacing forward slash and whitespace with `_`.
 *
 * Replaced characters:
 * - `/` - would corrupt the `lemonade/<id>` selection format
 * - Whitespace (`\s`) - breaks CLI/TUI model selection
 */
export function sanitizeModelId(id: string): string {
	return id.replace(/[\s/]/g, "_");
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
 * - `reasoning` is `true` — Lemonade supports per-request thinking
 *   configuration, so pi's thinking-level control is exposed and the selected
 *   level goes on the wire (default `openai` format → `reasoning_effort`).
 *   Models that cannot act on thinking parameters opt out per-model with
 *   `reasoning: false` in `models.json`.
 * - `input` is always `["text"]` — pi only sends text, even to vision-capable
 *   models, because Lemonade's OpenAI-compatible endpoint handles image input
 *   differently from pi's `input` field semantics.
 * - `thinkingLevelMap` is `undefined` — all standard effort levels are
 *   exposed; restrict or remap them per-model in `models.json` if needed.
 * - `cost` is derived from `/v1/models` `cost_input_per_million` /
 *   `cost_output_per_million` when present and positive; falls back to
 *   zero when the server does not report per-token pricing.
 * - `compat.supportsDeveloperRole` is `false` because Lemonade expects a
 *   `"system"` role (not `"developer"`).
 * - `compat.supportsStore` is `false` — local servers don't support OpenAI's
 *   persistent memory / store feature.
 * - `compat.supportsReasoningEffort` is deliberately not set — the fork's
 *   `getCompat` and pi-ai's `detectCompat` (escape-hatch backend) both resolve
 *   an omitted value to `true`, which the default `openai` thinking format
 *   needs in order to send `reasoning_effort`.
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

	// Cost fields from /v1/models; cloud models carry
	// cost_input_per_million / cost_output_per_million from discovery.
	const costInput =
		m.cost_input_per_million != null && m.cost_input_per_million > 0
			? m.cost_input_per_million
			: 0;
	const costOutput =
		m.cost_output_per_million != null && m.cost_output_per_million > 0
			? m.cost_output_per_million
			: 0;

	return {
		id: m.id,
		name: sanitizeModelId(m.id),
		api: "openai-completions",
		provider: config.provider,
		baseUrl: config.baseUrl + "/v1",
		reasoning: true, // thinking levels are exposed; the TUI level goes on the wire
		input: ["text"] as ("text" | "image")[], // pi only sends text input
		cost: { input: costInput, output: costOutput, cacheRead: 0, cacheWrite: 0 },
		contextWindow: ctx,
		maxTokens: Math.max(1, Math.min(config.maxOutputTokens, ctx)),
		compat: {
			supportsDeveloperRole: false,
			supportsStore: false,
			// supportsReasoningEffort is deliberately omitted — it resolves to
			// true (the default `openai` thinking format needs it to send
			// `reasoning_effort`).
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

/** `GET /v1/health` response — used to determine loaded and pinned models.
 *  Only the fields needed for discovery are typed here. */
interface HealthResponse {
	all_models_loaded?: HealthModel[];
}

/** One loaded model from `/v1/health` `all_models_loaded`. */
interface HealthModel {
	model_name: string;
	/** May be omitted by the server; a missing field means "loaded but not
	 *  pinned" (the entry is in `all_models_loaded`), never "not loaded". */
	pinned?: boolean;
	last_use?: number;
	recipe?: string;
}

/** A `fetch` bound to one path of the discovery server: adds the bearer token,
 *  the per-request timeout, and the composed abort signal (caller signal +
 *  discovery deadline), so every request in a pass shares one budget and one
 *  cancellation source instead of starting its own timer. */
type DiscoveryFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** Compose an outer signal (pi's cancellation, or the discovery deadline) with
 *  a timeout. The outer reason wins; otherwise the timeout aborts with an
 *  explicit `Error` so the fallback reason names the request that hung.
 *  `dispose()` must run when the request finishes — otherwise the timer keeps
 *  the process alive for the rest of its delay. */
function composeSignal(
	external: AbortSignal | undefined,
	timeoutMs: number,
	label: string,
): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	const onExternalAbort = () => {
		controller.abort(
			external?.reason instanceof Error
				? external.reason
				: new Error(`${label} cancelled`),
		);
	};
	if (external?.aborted) onExternalAbort();
	else external?.addEventListener("abort", onExternalAbort, { once: true });
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			external?.removeEventListener("abort", onExternalAbort);
		},
	};
}

/** Enrich models with `pinned` status from `GET /v1/health`. Models that
 *  appear in `all_models_loaded` get their `pinned` flag attached.
 *  On failure — including the discovery deadline elapsing — the health endpoint
 *  is treated as unavailable and models retain `pinned: undefined`. */
async function fetchHealthEnrichment(
	models: LemonadeModel[],
	fetchUrl: DiscoveryFetch,
): Promise<LemonadeModel[]> {
	try {
		const res = await fetchUrl("/v1/health");
		if (!res.ok) return models;
		const payload = (await res.json()) as HealthResponse;
		const loadedModels = payload.all_models_loaded ?? [];
		// Build a map of model_name → { pinned, recipe } from health.
		const healthMap = new Map(loadedModels.map((m) => [m.model_name, m]));
		return models.map((m) => {
			const health = healthMap.get(m.id);
			if (health) {
				return {
					...m,
					// In `all_models_loaded` means loaded; a missing `pinned` field
					// defaults to loaded-but-not-pinned. `undefined` stays reserved
					// for "not in health at all" (the downloaded sort groups).
					pinned: health.pinned ?? false,
					last_use: m.last_use ?? health.last_use,
					recipe: m.recipe ?? health.recipe,
				};
			}
			return m;
		});
	} catch {
		return models;
	}
}

/** Sort models by priority: pinned → loaded → downloaded (non-cloud recipe) → downloaded (cloud recipe).
 *
 *  Priority groups:
 *  1. pinned (pinned === true) — highest priority, sorted by decreasing last_use.
 *  2. loaded (in health's all_models_loaded but pinned === false) — sorted by decreasing last_use.
 *  3. downloaded with recipe !== "cloud" — local models not currently loaded, case-insensitive sort by id.
 *  4. downloaded with recipe === "cloud" — cloud models, lowest priority, case-insensitive sort by id.
 *
 *  Models not found in health (pinned === undefined) are treated as downloaded.
 */
function sortModels(models: LemonadeModel[]): LemonadeModel[] {
	function groupPriority(m: LemonadeModel): number {
		if (m.pinned === true) return 0;
		if (m.pinned === false) return 1; // loaded but not pinned
		// Not in health — downloaded, sort by recipe
		const recipe = (m.recipe ?? "").toLowerCase();
		if (recipe === "cloud") return 3;
		return 2;
	}

	return [...models].sort((a, b) => {
		const ga = groupPriority(a);
		const gb = groupPriority(b);
		if (ga !== gb) return ga - gb;
		// Pinned or loaded groups: sort by decreasing last_use (most recent first).
		if (ga < 2) {
			const aLast = a.last_use ?? 0;
			const bLast = b.last_use ?? 0;
			return bLast - aLast;
		}
		// Downloaded groups: case-insensitive sort by id.
		return a.id.toLowerCase().localeCompare(b.id.toLowerCase());
	});
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
 *  unknown, which is treated as non-completion-capable. An abort is re-thrown
 *  so a half-queried catalog is never published. */
async function fetchOllamaShow(
	fetchUrl: DiscoveryFetch,
	modelId: string,
	signal?: AbortSignal,
): Promise<OllamaShowResult | undefined> {
	try {
		const res = await fetchUrl("/api/show", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: modelId, verbose: true }),
		});
		if (!res.ok) return undefined;
		const payload = (await res.json()) as OllamaShowResponse;
		return {
			capabilities: payload.capabilities,
			contextLength: extractOllamaContextLength(payload.model_info),
		};
	} catch (err) {
		// A cancelled pass must surface: a half-queried catalog would otherwise
		// be published as if it were complete. Other failures stay per-model.
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : err;
		}
		return undefined;
	}
}

/** Query /api/show for every model in the list and attach each model's
 *  `capabilities` and `contextLength`. Models are processed in bounded-
 *  parallel batches. Per-model failures leave `capabilities` unset (the
 *  model is later excluded by `isChatCompletionLLM`). Throws only when the
 *  discovery `signal` aborts — a partially-queried catalog must not be
 *  published as if it were complete. */
async function fetchOllamaCapabilities(
	models: LemonadeModel[],
	fetchUrl: DiscoveryFetch,
	signal?: AbortSignal,
): Promise<LemonadeModel[]> {
	if (models.length === 0) return models;
	const enriched = models.map((m) => ({ ...m }));
	for (let i = 0; i < enriched.length; i += OLLAMA_CONCURRENCY) {
		// Aborted (pi cancelled, or the discovery deadline elapsed) — stop before
		// spending another batch on a server that is not going to answer.
		throwIfAborted(signal);
		const batch = enriched.slice(i, i + OLLAMA_CONCURRENCY);
		const results = await Promise.allSettled(
			batch.map((m) => fetchOllamaShow(fetchUrl, m.id, signal)),
		);
		for (let j = 0; j < results.length; j++) {
			const result = results[j];
			// Aborts are the only rejections `fetchOllamaShow` produces; anything
			// else stays a per-model miss.
			if (result.status === "rejected") throw result.reason;
			if (result.value !== undefined) {
				batch[j].capabilities = result.value.capabilities;
				batch[j].contextLength = result.value.contextLength;
			} else {
				// The probe failed — the model is excluded, but this is *not* evidence
				// that the server has nothing usable (see `_showFailed`).
				batch[j]._showFailed = true;
			}
		}
	}
	// The last batch can abort mid-flight; check again so the caller falls back
	// instead of publishing a catalog with unqueried models.
	throwIfAborted(signal);
	return enriched;
}

/** Throw the signal's own reason when aborted, so the fallback message names
 *  the real cause (deadline vs. cancellation). */
function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error
		? signal.reason
		: new Error("discovery was cancelled");
}

// ── discovery ────────────────────────────────────────────────────────────────

/**
 * Fetch and map the server's downloaded model list.
 *
 * 1. `GET /v1/models` — collect downloaded models.
 * 2. `GET /v1/health` — enrich with `pinned` status from loaded models.
 * 3. `POST /api/show` (mandatory) — attach `capabilities` and `contextLength`.
 * 4. Filter by `completion`+`tools` capability, sort, map to pi `Model` objects.
 *
 * Models are sorted: pinned → loaded → downloaded (non-cloud recipe) →
 * downloaded (cloud recipe), each group case-insensitive sorted by id.
 *
 * Resolves to `{ models, error }` rather than rejecting: a discovery failure
 * degrades to `fallbackModels()` and never takes pi's startup down.
 *
 * The whole pass shares one budget and one cancellation source: every request
 * (`/v1/models`, `/v1/health`, every `/api/show`) is bounded by
 * `config.timeoutMs` **and** by an overall `config.discoveryTimeoutMs` deadline,
 * and `signal` (pi's refresh cancellation) aborts all of them — including
 * batches of `/api/show` that have not started yet. A server that accepts
 * connections but never answers therefore costs the deadline, not
 * `timeoutMs × ceil(models / 5)`. Aborting mid-pass degrades to the fallback
 * catalog rather than publishing a partially-queried one.
 */
// pi-lens-ignore: long-parameter-list
export async function discoverModels(
	config: LemonadeConfig,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
	// optional bearer key from the `/login lemonade` credential, so discovery
	// authenticates with the same key live requests use (not just config/env).
	credentialKey?: string,
): Promise<{
	models: Model<"openai-completions">[];
	/** Transport/HTTP/parse failure — the caller keeps the `discovery-failed` model. */
	error?: string;
	/** The server answered but has nothing usable: `"no-downloaded"` when no
	 *  model is downloaded, `"no-capable"` when none reports `completion` +
	 *  `tools`. An honest empty catalog (`models: []`), not a failure — callers
	 *  must publish it, not keep a stale list. */
	empty?: "no-downloaded" | "no-capable";
}> {
	let entries: LemonadeModel[];
	const deadline = composeSignal(
		signal,
		config.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
		"discovery",
	);
	const bearer = credentialKey ?? config.apiKey;
	/** One discovery request: shared bearer header, per-request timeout, and the
	 *  composed caller/deadline signal — instead of each request starting its own
	 *  timer and ignoring pi's cancellation. */
	const fetchUrl: DiscoveryFetch = async (path, init) => {
		const scope = composeSignal(
			deadline.signal,
			config.timeoutMs,
			`discovery request ${path}`,
		);
		try {
			return await fetchImpl(`${config.baseUrl}${path}`, {
				...init,
				headers: {
					...((init?.headers ?? {}) as Record<string, string>),
					Authorization: `Bearer ${bearer}`,
				},
				signal: scope.signal,
			});
		} finally {
			scope.dispose();
		}
	};

	try {
		const res = await fetchUrl("/v1/models");
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

		const payload = (await res.json()) as { data?: LemonadeModel[] };
		entries = (payload?.data ?? []).filter(
			(m): m is LemonadeModel =>
				typeof m?.id === "string" && m.id.length > 0 && m.downloaded === true, // only locally-present models
		);
		// The server answered successfully — an empty catalog is the honest state,
		// not a transport failure. Reporting it as one would make `refreshModels`
		// keep the last-known-good list forever, so deleting every model could
		// never clear pi's catalog.
		if (entries.length === 0) return { models: [], empty: "no-downloaded" };

		// 2. Fetch /v1/health to enrich with pinned status, and query
		//    /api/show for capabilities — both in parallel.
		//    Health failure is graceful (pinned stays undefined → sorted last).
		const [healthEnriched, showEnriched] = await Promise.all([
			fetchHealthEnrichment(entries, fetchUrl),
			fetchOllamaCapabilities(entries, fetchUrl, deadline.signal),
		]);
		const healthById = new Map(healthEnriched.map((h) => [h.id, h]));
		entries = showEnriched.map((showEntry) => {
			const healthEntry = healthById.get(showEntry.id);
			return {
				...showEntry,
				pinned: healthEntry?.pinned,
				// `last_use` only arrives on the health payload, and `showEntry`
				// comes from the pre-health entries — dropping it here made the
				// pinned/loaded groups sort by `/v1/models` order instead of recency.
				last_use: showEntry.last_use ?? healthEntry?.last_use,
				recipe: showEntry.recipe ?? healthEntry?.recipe,
			};
		});

		// 3. Keep only models whose /api/show reports both "completion" and
		//    "tools" capabilities.
		entries = entries.filter((m) => isChatCompletionLLM(m));
		if (entries.length === 0) {
			// Distinguish "nothing usable on a healthy server" from "we could not
			// probe anything": a failed /api/show is not evidence of incapability, so
			// a catalog that is empty only because every probe failed stays a discovery
			// failure (startup registers `discovery-failed`, a refresh keeps the
			// last-known-good catalog instead of clearing it).
			if (showEnriched.some((m) => m._showFailed))
				throw new Error(
					"/api/show failed for every downloaded model (no capabilities could be determined)",
				);
			return { models: [], empty: "no-capable" };
		}

		// 4. Sort: pinned → loaded → downloaded (non-cloud) → downloaded (cloud).
		entries = sortModels(entries);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { models: fallbackModels(config), error: reason };
	} finally {
		// The deadline timer is ref'd: leaving it running would keep the process
		// (or a test runner) alive for the rest of the budget after discovery ends.
		deadline.dispose();
	}

	const models = entries.map((m) => toModel(m, config));
	return { models };
}

// ── credential resolution ────────────────────────────────────────────────────

/** Resolve the API key for live API requests (not model discovery).
 *
 * Priority:
 * 1. `auth.json` entry (via `/login lemonade`) — `credential.key`
 * 2. `LEMONADE_ADMIN_API_KEY` — the Lemonade CLI treats a non-empty admin
 *    key as an override of the API key (src/cpp/cli/main.cpp), and the
 *    server accepts it on regular `/v1` endpoints too
 * 3. `LEMONADE_API_KEY` from the injected `AuthContext.env` (read in `resolve`)
 * 4. `process.env` (same admin-over-api precedence; non-Node host fallback)
 * 5. Placeholder (ignored by the server when no auth is configured)
 */
function resolveApiKey(
	credential?: { key?: string },
	apiKeyEnv?: string,
	adminApiKeyEnv?: string,
): {
	apiKey: string;
	source: string;
} {
	if (credential?.key) {
		return { apiKey: credential.key, source: "stored API key" };
	}
	if (adminApiKeyEnv) {
		return {
			apiKey: adminApiKeyEnv,
			source: "LEMONADE_ADMIN_API_KEY environment variable",
		};
	}
	if (apiKeyEnv) {
		return { apiKey: apiKeyEnv, source: "LEMONADE_API_KEY environment variable" };
	}
	return {
		apiKey: PLACEHOLDER_API_KEY,
		source: "placeholder (server has no auth)",
	};
}

// ── extension factory ────────────────────────────────────────────────────────

// pi-lens-ignore: high-complexity
export default async function (pi: ExtensionAPI) {
	const config = readConfig();
	const initial = await discoverModels(config, fetch);

	// Current discovered catalog. `refreshModels` retains the last-known-good
	// list on failure and persists successful fetches through the provider store.
	let currentModels = initial.models;

	// A malformed persisted catalog entry is reported once per process (the
	// refresh runs on every /reload, so it must not be re-announced each time).
	let storeCorruptionWarned = false;
	const warnStoreCorruption = (): void => {
		if (storeCorruptionWarned) return;
		storeCorruptionWarned = true;
		// pi-lens-ignore: no-console-except-error,console-statement
		console.warn(
			`[pi-provider-lemonade] the persisted model store entry for provider ` +
				`"${config.provider}" is malformed (models is not an array) — keeping the ` +
				`last-known-good catalog; fix or delete the entry in ` +
				`~/.pi/agent/models-store.json`,
		);
	};

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
						message: "Lemonade API key (leave empty if server doesn't require auth)",
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
					const [apiKeyEnv, adminApiKeyEnv] = await Promise.all([
						ctx.env("LEMONADE_API_KEY"),
						ctx.env("LEMONADE_ADMIN_API_KEY"),
					]);
					const procEnv = (
						(globalThis as { process?: NodeJS.Process }).process?.env as Record<
							string,
							string | undefined
						>
					);
					const resolved = resolveApiKey(
						credential,
						apiKeyEnv ?? procEnv?.LEMONADE_API_KEY,
						adminApiKeyEnv ?? procEnv?.LEMONADE_ADMIN_API_KEY,
					);
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
		 *  — or the initial baseline — is retained instead of being replaced.
		 *
		 *  Dual-compatible: pi 0.83 uses context.store.read/write;
		 *  pi 0.84+ uses context.stored (read-only snapshot) +
		 *  context.publish() (generation-checked transaction). */
		async refreshModels(
			this: void,
			context: RefreshModelsContext,
		): Promise<void> {
			// Detect pi 0.84+ API at runtime (publish function exists).
			// pi-lens-ignore: no-as-any,no-any-type
			const ctx = context as any;
			const hasPublish = typeof ctx.publish === "function";

			// Restore from persisted catalog. A corrupted entry (hand-edited or
			// truncated models-store.json) must not throw out of the refresh:
			// keep the last-known-good catalog and report the bad entry once.
			if (hasPublish) {
				// pi 0.84+: context.stored is a read-only ModelsStoreEntry snapshot.
				const storedModels = ctx.stored?.models;
				if (Array.isArray(storedModels)) {
					const restored = storedModels.filter(
						// pi-lens-ignore: no-any-type
						(m: any): m is Model<"openai-completions"> =>
							m.provider === config.provider && m.api === "openai-completions",
					);
					if (
						!(await ctx.publish({
							update: () => {
								currentModels = restored;
							},
						}))
					)
						return;
				} else if (ctx.stored) {
					warnStoreCorruption();
				}
			} else {
				// pi 0.83: context.store.read() is async (property absent in 0.84+ types).
				const stored = await ctx.store.read();
				if (stored) {
					if (Array.isArray(stored.models)) {
						currentModels = stored.models.filter(
							// pi-lens-ignore: no-any-type
							(m: any): m is Model<"openai-completions"> =>
								m.provider === config.provider && m.api === "openai-completions",
						);
					} else {
						warnStoreCorruption();
					}
				}
			}

			if (!context.allowNetwork || context.signal?.aborted) return;

			// Thread the `/login lemonade` credential's bearer into discovery so
			// a key stored via /login authenticates refresh requests too.
			const credentialKey =
				context.credential?.type === "api_key" ? context.credential.key : undefined;
			const { models, error } = await discoverModels(
				config,
				fetch,
				context.signal,
				credentialKey,
			);
			// A genuine failure keeps the last-known-good catalog. A reachable server
			// with nothing usable yields `models: []` without an error, and that empty
			// list is published below — deleting every model really does clear pi's list.
			if (error) return;
			if (context.signal?.aborted) return;

			if (hasPublish) {
				// pi persists the entry, re-checks the refresh generation, and only then
				// calls `update`. Mutating `currentModels` **inside** `update` is what
				// makes this transactional: assigning before `publish` let a refresh that
				// lost the generation race overwrite the catalog a newer refresh had just
				// published, in memory (and `update: () => { currentModels; }` was a
				// no-op expression statement, so the publish path never assigned at all).
				const published = await ctx.publish({
					persist: { models, checkedAt: Date.now() },
					update: () => {
						currentModels = models;
					},
				});
				// A newer refresh won: keep its in-memory catalog, change nothing.
				if (!published) return;
			} else {
				// pi 0.83 has no generation check — persist first so a failing write
				// leaves the in-memory catalog on the last-known-good list.
				await ctx.store.write({ models, checkedAt: Date.now() });
				currentModels = models;
			}
		},
		// The streaming backend is selected per request by the
		// `x-pi-provider-lemonade` header (see the backend-switch section):
		// "openai-completions" dispatches to pi's own built-in implementation
		// — a pure pass-through, because the host passes its own native
		// context shape and its own adapter consumes it, so no transcript
		// normalization or Lemonade retry tuning applies there; anything else
		// uses this extension's fork with its Lemonade error reporting. The
		// retry defaults below are defaults only — an explicit caller-supplied
		// `maxRetries` / `maxRetryDelayMs` (e.g. from Pi settings) wins.
		stream: (model, context, options) =>
			resolveCompletionsMode(options?.headers).mode === "openai-completions"
				? hostStream(model, context, options as ProviderStreamOptions)
				: stream(model, context, {
						...options,
						maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
						maxRetryDelayMs:
							options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
					}),
		streamSimple: (model, context, options) =>
			resolveCompletionsMode(options?.headers).mode === "openai-completions"
				? hostStreamSimple(model, context, options)
				: streamSimple(model, context, {
						...options,
						maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
						maxRetryDelayMs:
							options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
					}),
	} as Provider<"openai-completions">);

	// A transport failure registers the `discovery-failed` model and warns; an
	// empty-but-reachable server registers no models at all and reports the
	// difference, so "nothing to run" is never mistaken for "server is down".
	// Malformed configuration (e.g. an invalid port in `LEMONADE_HOST`, corrected
	// in `readConfig`) is reported even when discovery succeeded — a silently
	// replaced port otherwise looks like a "wrong server" error much later.
	const notices: string[] = [...config.warnings];
	if (initial.error) {
		notices.push(
			`Model discovery from ${config.baseUrl}/v1 failed (${initial.error}). ` +
				`Registered provider "${config.provider}" with a single "discovery-failed" model. ` +
				`Start the server and run /reload, or set LEMONADE_HOST/LEMONADE_PORT.`,
		);
	} else if (initial.empty) {
		notices.push(
			`Lemonade at ${config.baseUrl}/v1 is reachable but has ` +
				(initial.empty === "no-capable"
					? "no model reporting the completion and tools capabilities"
					: "no downloaded models") +
				`. Registered provider "${config.provider}" with no models — download one and run /reload.`,
		);
	}
	// The discovery-notice handler is registered first, so consumers that
	// take `session_start[0]` in a failing or empty discovery keep hitting
	// it; the backend-switch handler below registers after it (and is the
	// only one when discovery is healthy).
	if (notices.length > 0) {
		const message = notices.join(" ");
		const level = initial.error ? "warning" : "info";

		let warned = false;
		pi.on(
			"session_start",
			// pi-lens-ignore: async-noise
			async (_event: SessionStartEvent, ctx: ExtensionContext) => {
				if (warned) return; // session_start also fires on reload/switch — warn once per process
				warned = true;
				if (ctx.hasUI) {
					ctx.ui.notify(`[pi-provider-lemonade] ${message}`, level);
				} else {
					// pi-lens-ignore: no-console-except-error,console-statement
					console.warn(`[pi-provider-lemonade] ${message}`);
				}
			},
		);
	}

	// Backend-switch notice + untested-pi warning (once per process). The
	// header is read from the provider's composed auth (models.json
	// `headers`) — the same value the per-request dispatch sees.
	let warnedCompletions = false;
	pi.on(
		"session_start",
		// pi-lens-ignore: async-noise
		async (_event: SessionStartEvent, ctx: ExtensionContext) => {
			if (warnedCompletions) return; // session_start also fires on reload/switch
			warnedCompletions = true;
			const [piVersion, headerValue] = await Promise.all([
				detectPiVersion(),
				readCompletionsHeader(ctx, config.provider),
			]);
			const notify = (text: string, level: "info" | "warning") => {
				if (ctx.hasUI) {
					ctx.ui.notify(`[pi-provider-lemonade] ${text}`, level);
				} else {
					// pi-lens-ignore: no-console-except-error,console-statement
					console.warn(`[pi-provider-lemonade] ${text}`);
				}
			};
			for (const warning of completionsWarnings(piVersion, headerValue)) {
				notify(warning, "warning");
			}
			if (headerValue === "openai-completions") {
				notify(
					`Streaming uses pi's built-in OpenAI-compatible backend (models.json "${COMPLETIONS_HEADER}": "openai-completions").`,
					"info",
				);
			}
		},
	);
}
