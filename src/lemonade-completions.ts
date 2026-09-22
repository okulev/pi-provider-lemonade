/**
 * Lemonade Server completions — openai-completions fork with Lemonade error
 * shape recognition and mid-stream 429 retry support.
 *
 * Based on @earendil-works/pi-ai openai-completions.ts. Differences:
 * - Detects Lemonade mid-stream SSE error events (error.type, error.status_code,
 *   error.details.retryable) as described in .pi/lemonade-error-shapes.md
 * - Retries on SSE event error status_code 429 with exponential backoff
 * - Uses model.compat directly (Lemonade models always set it explicitly)
 *
 * Retry policy mirrors provider-retry.ts:
 * - HTTP-level retries (408, 409, 429, 5xx, connection failures) plus
 *   `Retry-After` / `retry-after-ms` honouring via retryProviderRequest
 * - Mid-stream SSE event retries (429, retryable: true) via retryStreamLoop,
 *   only while no content has been emitted yet
 */

import OpenAI from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type {
	AssistantMessage,
	ChatTemplateKwargValue,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	TextContent,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	ToolCall,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import type { OpenAICompletionsOptions } from "@earendil-works/pi-ai/api/openai-completions";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import {
	type AssistantMessageEventStream,
	calculateCost,
	clampThinkingLevel,
	createAssistantMessageEventStream,
	parseStreamingJson,
} from "@earendil-works/pi-ai";
import { convertMessages as sdkConvertMessages } from "@earendil-works/pi-ai/api/openai-completions";

/** Extended options for Lemonade completions with retry config. */
export interface LemonadeCompletionsOptions extends OpenAICompletionsOptions {
	maxRetries?: number;
	/**
	 * Thinking level selected in the TUI. The agent loop passes it as
	 * `reasoning` (SimpleStreamOptions); it is normalized to
	 * `reasoningEffort` before request params are built (see
	 * `resolveReasoningEffort`).
	 */
	reasoning?: ThinkingLevel;
}

// ── Retry configuration (authoritative, imported by index.ts) ──────────────

/** Upper bound on the whole retry backoff sequence, in seconds — see
 *  {@linkcode DEFAULT_MAX_RETRIES} for how many attempts fit inside it. It
 *  bounds *sleeping* only: request time is not counted. */
export const DEFAULT_RETRY_BUDGET_SEC = 120;
/** Max retries that fit inside {@linkcode DEFAULT_RETRY_BUDGET_SEC} given the
 *  backoff in `getRetryDelayMs`: the first four steps are 0.5 + 1 + 2 + 4 =
 *  7.5 s and every later step is capped at 8 s, so `4 + (budget − 7.5) / 8`
 *  steps sum to the budget (18 steps ≈ 119.5 s). The 25 % jitter in
 *  `getRetryDelayMs` only ever shortens a step, so the sum is an upper bound.
 *  A server-supplied `Retry-After` is bounded separately (and rejected above
 *  `maxRetryDelayMs`), so it does not extend this sequence. */
export const DEFAULT_MAX_RETRIES =
	Math.floor((DEFAULT_RETRY_BUDGET_SEC - 7.5) / 8) + 4;
/** Max delay for a single retry attempt (caps Retry-After headers). */
export const DEFAULT_MAX_RETRY_DELAY_SEC = 60;
/** {@linkcode DEFAULT_MAX_RETRY_DELAY_SEC} in ms — default cap for `options.maxRetryDelayMs`. */
export const DEFAULT_MAX_RETRY_DELAY_MS = DEFAULT_MAX_RETRY_DELAY_SEC * 1000;

// ── Lemonade error types ────────────────────────────────────────────────────

/** Lemonade SSE error shape (all variants share `error.message` and `error.type`). */
interface LemonadeErrorShape {
	message: string;
	type: string;
	status_code?: number;
	status?: number;
	code?: string;
	details?: {
		code?: string;
		retryable?: boolean;
		backend?: string;
		reason?: string;
	};
}

/**
 * Format a Lemonade error shape into a rich error message with all
 * available diagnostic fields: status_code, type, code, details.code,
 * details.backend, details.reason.
 */
function formatLemonadeError(err: LemonadeErrorShape): string {
	const parts: string[] = [err.message];
	const sc = getErrorCode(err);
	if (sc !== undefined) parts.push(`status ${sc}`);
	if (err.type) parts.push(err.type);
	if (err.code) parts.push(`[${err.code}]`);
	if (err.details?.code) parts.push(`[${err.details.code}]`);
	if (err.details?.backend) parts.push(err.details.backend);
	if (err.details?.reason) parts.push(err.details.reason);
	return parts.join(", ");
}

/**
 * Resolve the terminal error message for a thrown error.
 *
 * The OpenAI SDK nests the raw Lemonade error shape under `error.error`
 * (SSE: data: {"error": {...}}), and the synthetic "Lemonade mid-stream"
 * error from the defensive `isLemonadeErrorChunk` branch does the same —
 * both are formatted from the shape so every diagnostic field
 * (status_code, type, code, details.*) survives. The synthetic error's own
 * message only names message/status/code, so it is used only as the
 * "retries exhausted" prefix, not as the report itself (the old guard
 * skipped formatting for it, which dropped `details.*` on that path).
 * Anything without a nested shape falls back to the plain message.
 */
export function terminalErrorMessage(error: unknown): string {
	const lemonadeError = (error as { error?: LemonadeErrorShape })?.error;
	if (
		lemonadeError &&
		typeof lemonadeError === "object" &&
		"message" in lemonadeError
	) {
		const synthetic =
			error instanceof Error && error.message.startsWith("Lemonade mid-stream");
		return synthetic
			? `Retries exhausted: ${formatLemonadeError(lemonadeError)}`
			: formatLemonadeError(lemonadeError);
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * Check if a chunk is a Lemonade error event.
 *
 * Lemonade emits errors as SSE events: `data: {"error": {...}}`
 * The OpenAI SDK yields these as plain objects (not ChatCompletionChunk),
 * so we detect them by presence of an `error` property and absence of
 * the expected `choices` array.
 * NOTE: In practice the OpenAI SDK throws APIError before yielding, so
 * the real error formatting happens in the catch block below. This path
 * is kept as a defensive fallback in case a future SDK version stops
 * throwing on `data.error` — and is exported so the detection itself stays
 * covered by a unit test even though the branch it guards is unreachable
 * today.
 */
export function isLemonadeErrorChunk(
	chunk: unknown,
): chunk is { error: LemonadeErrorShape } {
	if (typeof chunk !== "object" || chunk === null) return false;
	const obj = chunk as Record<string, unknown>;
	// Must have `error` property and NOT have `choices` (which all real chunks have)
	return "error" in obj && "choices" in obj === false;
}

/**
 * Extract the effective status code from a Lemonade error shape.
 * Lemonade uses `status_code` (OpenAI convention), `status` (synthesized),
 * or infers from the error type. Returns undefined if no status is available.
 */
function getErrorCode(err: LemonadeErrorShape): number | undefined {
	if (typeof err.status_code === "number") return err.status_code;
	if (typeof err.status === "number") return err.status;
	return undefined;
}

/**
 * Check if a Lemonade error is retryable.
 *
 * Retryable conditions:
 * - status_code 429 (rate limit)
 * - status_code 408, 409 (request-level retryable)
 * - status_code >= 500 (server error)
 * - details.retryable === true (backend watchdog, etc.)
 */
function isRetryableError(err: LemonadeErrorShape): boolean {
	const code = getErrorCode(err);
	if (
		code === 429 ||
		code === 408 ||
		code === 409 ||
		(code !== undefined && code >= 500)
	) {
		return true;
	}
	if (err.details?.retryable === true) {
		return true;
	}
	return false;
}

// ── Retry utilities (from provider-retry.ts, reimplemented) ─────────────────

/** Exponential backoff with jitter, matching provider-retry.ts, capped per step. */
function getRetryDelayMs(
	retryIndex: number,
	maxRetryDelayMs: number = DEFAULT_MAX_RETRY_DELAY_MS,
): number {
	const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
	return Math.min(
		exponentialDelay * (1 - Math.random() * 0.25),
		Math.max(0, maxRetryDelayMs),
	);
}

/** Sleep that respects AbortSignal. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request aborted"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Request aborted"));
		};
		const timeout = setTimeout(
			() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			Math.max(0, ms),
		);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * The part of the OpenAI SDK error surface this fork needs for HTTP-level
 * retry: the status and the response headers (`retry-after`). The SDK's own
 * retry timer ignores `AbortSignal`, which is why requests are issued with
 * `maxRetries: 0` and wrapped by {@link retryProviderRequest} instead.
 */
interface ProviderHttpError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
}

function isProviderHttpError(error: unknown): error is ProviderHttpError {
	if (
		!(error instanceof Error) ||
		!("status" in error) ||
		!("headers" in error)
	) {
		return false;
	}
	const httpError = error as ProviderHttpError;
	return (
		(httpError.status === undefined || typeof httpError.status === "number") &&
		(httpError.headers === undefined || httpError.headers instanceof Headers)
	);
}

/**
 * Retryability of the HTTP response itself, mirroring the pinned OpenAI SDK
 * policy (same rules as pi-ai's `utils/provider-retry.ts`, which is not
 * reachable from the package exports map — review when either is upgraded).
 * `x-should-retry` wins over the status table; a missing status means the
 * request never got a response (connection error), which is retryable.
 *
 * SSE-embedded Lemonade errors are thrown while *iterating* the stream, so
 * they never reach this predicate — they are judged by `isRetryableStreamError`
 * in the stream loop. Each failure is retried by at most one layer: an error
 * with an HTTP status is retried here and is rejected by the stream predicate
 * (see the narrowed `isRetryable` in `stream`), while status-less
 * SSE-embedded errors never reach this predicate.
 */
function isRetryableHttpError(error: ProviderHttpError): boolean {
	const shouldRetry = error.headers?.get("x-should-retry");
	if (shouldRetry === "true") return true;
	if (shouldRetry === "false") return false;
	if (error.status === undefined) return true;
	return (
		error.status === 408 ||
		error.status === 409 ||
		error.status === 429 ||
		error.status >= 500
	);
}

/**
 * Validate a server-requested delay against `maxRetryDelayMs`.
 *
 * A delay above `maxRetryDelayMs` fails instead of sleeping: a backend
 * asking for ten minutes would hold the whole agent turn open (pi-ai
 * parity). The cap always applies — a caller-supplied 0 means "no delays
 * at all" (matching getRetryDelayMs, which floors the exponential backoff
 * at 0 too), not "unlimited". A negative delay is invalid by contract and
 * fails as well: it would clamp to a 0 ms sleep and collapse the backoff
 * into an instant retry. Both call sites in `getHttpRetryDelayMs` already
 * normalize their negative cases to the exponential schedule before calling
 * here, so this is defense-in-depth against a future caller forgetting the
 * guard.
 */
function validateServerRetryDelayMs(
	delayMs: number,
	maxRetryDelayMs: number | undefined,
	providerErrorMessage: string,
): number {
	const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (delayMs < 0) {
		throw new Error(
			`Server requested a negative retry delay (${delayMs}ms). ${providerErrorMessage}`,
		);
	}
	if (delayMs > maxDelayMs) {
		throw new Error(
			`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${providerErrorMessage}`,
		);
	}
	return delayMs;
}

/**
 * `retry-after-ms` → `retry-after` (seconds or HTTP date) → exponential
 * backoff, all capped by `maxRetryDelayMs`. A value that cannot be honoured
 * (garbage, or negative — a negative delay would clamp to a 0 ms sleep and
 * collapse the whole backoff into an instant retry) falls through to the
 * next source, like the `retry-after` garbage/past-date cases below.
 */
function getHttpRetryDelayMs(
	error: ProviderHttpError,
	retryIndex: number,
	maxRetryDelayMs: number | undefined,
): number {
	const retryAfterMs = error.headers?.get("retry-after-ms");
	if (retryAfterMs) {
		const value = Number.parseFloat(retryAfterMs);
		if (!Number.isNaN(value) && value >= 0) {
			return validateServerRetryDelayMs(
				value,
				maxRetryDelayMs,
				error.message,
			);
		}
	}

	const retryAfter = error.headers?.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		let delayMs = Number.isNaN(seconds)
			? Date.parse(retryAfter) - Date.now()
			: seconds * 1000;
		// A value that is neither seconds nor an HTTP date parses to NaN, and
		// a past HTTP date parses to a negative delay; both would become an
		// immediate retry (setTimeout clamps to 0), so fall back to the
		// exponential schedule.
		if (!Number.isFinite(delayMs) || delayMs < 0)
			delayMs = getRetryDelayMs(retryIndex, maxRetryDelayMs);
		return validateServerRetryDelayMs(delayMs, maxRetryDelayMs, error.message);
	}

	return getRetryDelayMs(retryIndex, maxRetryDelayMs);
}

interface HttpRetryOptions {
	maxRetries?: number;
	maxRetryDelayMs?: number;
	signal?: AbortSignal;
}

/**
 * HTTP-level retry for the initial request — the equivalent of upstream pi's
 * `retryProviderRequest` (`@earendil-works/pi-ai/utils/provider-retry` is not
 * exported from the package, so it is reproduced here). Without it, a plain
 * `429`/`5xx` JSON error (no Lemonade `error.status_code` in the body) was
 * fatal and `Retry-After` was ignored, because the SDK client is created with
 * `maxRetries: 0`.
 */
async function retryProviderRequest<T>(
	request: () => Promise<T>,
	options?: HttpRetryOptions,
): Promise<T> {
	const maxRetries = options?.maxRetries ?? 0;
	let retriesRemaining = maxRetries;

	for (;;) {
		try {
			// Each retry is a fresh SDK request, so X-Stainless-Retry-Count stays zero.
			return await request();
		} catch (error) {
			if (options?.signal?.aborted) throw error;
			if (
				retriesRemaining <= 0 ||
				!isProviderHttpError(error) ||
				!isRetryableHttpError(error)
			) {
				throw error;
			}
			const retryIndex = maxRetries - retriesRemaining;
			retriesRemaining--;
			await abortableSleep(
				getHttpRetryDelayMs(error, retryIndex, options?.maxRetryDelayMs),
				options?.signal,
			);
		}
	}
}

interface StreamRetryOptions {
	maxRetries?: number;
	/** Upper bound for a single backoff step (pi-ai `StreamOptions.maxRetryDelayMs`). */
	maxRetryDelayMs?: number;
	signal?: AbortSignal;
	/**
	 * Retryability predicate for the thrown error. Defaults to
	 * {@link isRetryableStreamError}; `stream` narrows it so an attempt that has
	 * already streamed content is never retried.
	 */
	isRetryable?: (error: unknown) => boolean;
}

/**
 * Default retryability for the loop: the Lemonade error shape the SDK nests
 * under `error.error` (SSE error events and Lemonade JSON error bodies).
 */
function isRetryableStreamError(error: unknown): boolean {
	const lemonadeError = (error as { error?: LemonadeErrorShape })?.error;
	return Boolean(lemonadeError && isRetryableError(lemonadeError));
}

/**
 * Retry a streaming loop on mid-stream Lemonade errors.
 *
 * The `streamFn` is called in a loop. If it throws a retryable error, we back
 * off and retry. Non-retryable errors and exhausted retries propagate the
 * error.
 */
async function retryStreamLoop<T>(
	streamFn: () => Promise<T>,
	options?: StreamRetryOptions,
): Promise<T> {
	const maxRetries = options?.maxRetries ?? 0;
	const isRetryable = options?.isRetryable ?? isRetryableStreamError;
	let retriesRemaining = maxRetries;

	for (;;) {
		try {
			return await streamFn();
		} catch (error) {
			if (options?.signal?.aborted) throw error;
			if (retriesRemaining <= 0) throw error;

			if (isRetryable(error)) {
				const retryIndex = maxRetries - retriesRemaining;
				retriesRemaining--;
				await abortableSleep(
					getRetryDelayMs(retryIndex, options?.maxRetryDelayMs),
					options?.signal,
				);
				continue;
			}

			throw error;
		}
	}
}

// ── Compat resolution ───────────────────────────────────────────────────────

/** The `Model<"openai-completions">` compat shape (the `models.json` surface). */
type CompatInput = NonNullable<Model<"openai-completions">["compat"]>;

/**
 * Compat keys this fork resolves to a concrete value. Every *other* compat key
 * is passed through untouched — see `ResolvedCompat`.
 */
type ResolvedCompatKeys =
	| "supportsStore"
	| "supportsDeveloperRole"
	| "supportsReasoningEffort"
	| "supportsUsageInStreaming"
	| "supportsFinishReason"
	| "maxTokensField"
	| "requiresToolResultName"
	| "requiresAssistantAfterToolResult"
	| "requiresThinkingAsText"
	| "requiresReasoningContentOnAssistantMessages"
	| "thinkingFormat"
	| "supportsStrictMode"
	| "chatTemplateKwargs"
	| "chatTemplateArgs";

/**
 * The compat object handed to `convertMessages` and `buildParams`.
 *
 * It is `CompatInput` minus the keys this fork defaults explicitly, so every
 * other compat flag a user sets in `models.json`
 * (`supportsThinkingTokenBudget`, `deferredToolsMode`, `supportsOpenAIGrammarTools`,
 * `cacheControlFormat`, `sendSessionAffinityHeaders`, …) survives resolution
 * instead of being silently dropped. pi-ai resolves 24 keys from its own
 * `getCompat` (with `baseUrl` auto-detection); this fork whitelisted 14, which
 * meant anything outside the list never reached `convertMessages` — the
 * resolved object is passed to it in place of `model.compat`.
 *
 * Note: passing a key through makes it visible to the request builder, not
 * necessarily acted on — the request-body features this fork never implemented
 * (cloud-only routing, prompt-cache retention, session-affinity headers,
 * `thinking_token_budget`) are still not emitted, as documented in the
 * lemonade-streaming skill.
 */
type ResolvedCompat = Omit<CompatInput, ResolvedCompatKeys> & {
	supportsStore: boolean;
	supportsDeveloperRole: boolean;
	supportsReasoningEffort: boolean;
	supportsUsageInStreaming: boolean;
	supportsFinishReason: boolean;
	maxTokensField: "max_tokens" | "max_completion_tokens";
	requiresToolResultName: boolean;
	requiresAssistantAfterToolResult: boolean;
	requiresThinkingAsText: boolean;
	requiresReasoningContentOnAssistantMessages: boolean;
	thinkingFormat: string;
	supportsStrictMode: boolean;
	chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>;
	chatTemplateArgs?: Record<string, ChatTemplateKwargValue>;
};

/**
 * Resolve `model.compat` to concrete values. Lemonade models always set their
 * compat explicitly (`toModel`), so pi-ai's `baseUrl` auto-detection is not
 * reproduced here — only the defaults for keys Lemonade servers do not need to
 * opt into. Unknown/unlisted keys pass through unchanged.
 */
function getCompat(model: Model<"openai-completions">): ResolvedCompat {
	const compat = model.compat;
	return {
		...compat,
		supportsStore: compat?.supportsStore ?? true,
		supportsDeveloperRole: compat?.supportsDeveloperRole ?? true,
		supportsReasoningEffort: compat?.supportsReasoningEffort ?? true,
		supportsUsageInStreaming: compat?.supportsUsageInStreaming ?? true,
		supportsFinishReason: compat?.supportsFinishReason ?? true,
		maxTokensField: compat?.maxTokensField ?? "max_completion_tokens",
		requiresToolResultName: compat?.requiresToolResultName ?? false,
		requiresAssistantAfterToolResult:
			compat?.requiresAssistantAfterToolResult ?? false,
		requiresThinkingAsText: compat?.requiresThinkingAsText ?? false,
		requiresReasoningContentOnAssistantMessages:
			compat?.requiresReasoningContentOnAssistantMessages ?? false,
		thinkingFormat: compat?.thinkingFormat ?? "openai",
		supportsStrictMode: compat?.supportsStrictMode ?? true,
		chatTemplateKwargs: compat?.chatTemplateKwargs,
		chatTemplateArgs: compat?.chatTemplateArgs,
	};
}

// ── Client & request helpers ────────────────────────────────────────────────

function getClientApiKey(
	provider: string,
	apiKey: string | undefined,
	headers?: Record<string, string | null>,
): string {
	if (apiKey) return apiKey;
	if (headers) {
		for (const [key, value] of Object.entries(headers)) {
			if (
				(key.toLowerCase() === "authorization" ||
					key.toLowerCase() === "cf-aig-authorization") &&
				value !== null &&
				value.trim().length > 0
			) {
				return "unused";
			}
		}
	}
	throw new Error(`No API key for provider: ${provider}`);
}

function createClient(
	model: Model<"openai-completions">,
	apiKey: string,
	optionsHeaders?: Record<string, string | null>,
	fetch?: typeof globalThis.fetch,
) {
	const headers: Record<string, string> = {
		...(model.headers as Record<string, string> | undefined),
	};
	if (optionsHeaders) {
		for (const [key, value] of Object.entries(optionsHeaders)) {
			if (value !== null) {
				headers[key] = value;
			}
		}
	}

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: headers,
	});
}

// ── Param building ──────────────────────────────────────────────────────────

/**
 * Resolve the effective reasoning effort for request building.
 *
 * The TUI agent loop passes the selected thinking level as
 * `options.reasoning` (SimpleStreamOptions) — NOT as `reasoningEffort`.
 * pi-ai's built-in openai-completions `streamSimple` clamps it to a level
 * the model supports and re-passes it as `reasoningEffort` before calling
 * the internal stream. This fork's `streamSimple` delegates straight to
 * `stream`, so the same normalization must happen here; otherwise
 * `applyThinkingParams` sees `reasoningEffort === undefined` and
 * `qwen-chat-template` sends `enable_thinking: false` even with thinking
 * enabled.
 */
function resolveReasoningEffort(
	model: Model<"openai-completions">,
	options: LemonadeCompletionsOptions | undefined,
): ThinkingLevel | undefined {
	if (options?.reasoningEffort !== undefined) return options.reasoningEffort;
	const reasoning = options?.reasoning;
	if (!reasoning) return undefined;
	const clamped = clampThinkingLevel(model, reasoning);
	return clamped === "off" ? undefined : clamped;
}

/**
 * Apply thinking/reasoning request parameters based on
 * `compat.thinkingFormat`. Mirrors pi-ai openai-completions so that
 * models.json `modelOverrides` (thinkingFormat, chatTemplateKwargs,
 * thinkingLevelMap) behave identically to the built-in provider.
 */
// pi-lens-ignore: high-complexity,high-fan-out
function applyThinkingParams(
	params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	compat: ResolvedCompat,
): void {
	if (!model.reasoning) return;
	const effort = resolveReasoningEffort(model, options);
	const enabled = effort !== undefined;

	if (compat.thinkingFormat === "zai") {
		// pi-lens-ignore: no-as-any,no-any-type
		const zaiParams = params as any;
		zaiParams.thinking = effort
			? { type: "enabled", clear_thinking: false }
			: { type: "disabled" };
		if (effort && compat.supportsReasoningEffort) {
			const mapped = model.thinkingLevelMap?.[effort];
			const value = mapped === undefined ? effort : mapped;
			if (typeof value === "string") zaiParams.reasoning_effort = value;
		}
		return;
	}

	if (compat.thinkingFormat === "qwen") {
		// pi-lens-ignore: no-as-any,no-any-type
		const qwenParams = params as any;
		qwenParams.enable_thinking = enabled;
		if (effort && compat.supportsReasoningEffort) {
			const value = model.thinkingLevelMap?.[effort] ?? effort;
			if (typeof value === "string") qwenParams.reasoning_effort = value;
		}
		return;
	}

	if (compat.thinkingFormat === "qwen-chat-template") {
		// pi-lens-ignore: no-as-any,no-any-type
		(params as any).chat_template_kwargs = {
			enable_thinking: enabled,
			preserve_thinking: true,
		};
		return;
	}

	if (compat.thinkingFormat === "chat-template") {
		const kwargs = buildChatTemplateValues(
			model,
			options,
			compat.chatTemplateKwargs,
		);
		if (kwargs) {
			// pi-lens-ignore: no-as-any,no-any-type
			(params as any).chat_template_kwargs = kwargs;
		}
		return;
	}

	if (compat.thinkingFormat === "baseten") {
		// pi-lens-ignore: no-as-any,no-any-type
		const basetenParams = params as any;
		const args = buildChatTemplateValues(
			model,
			options,
			compat.chatTemplateArgs,
		);
		if (args) basetenParams.chat_template_args = args;
		if (compat.supportsReasoningEffort) {
			const mapped = effort
				? model.thinkingLevelMap?.[effort]
				: model.thinkingLevelMap?.off;
			const value = mapped === undefined ? effort : mapped;
			if (typeof value === "string") basetenParams.reasoning_effort = value;
		}
		return;
	}

	if (compat.thinkingFormat === "deepseek") {
		// pi-lens-ignore: no-as-any,no-any-type
		const deepseekParams = params as any;
		if (effort) {
			deepseekParams.thinking = { type: "enabled" };
		} else if (model.thinkingLevelMap?.off !== null) {
			deepseekParams.thinking = { type: "disabled" };
		}
		if (effort && compat.supportsReasoningEffort) {
			deepseekParams.reasoning_effort =
				model.thinkingLevelMap?.[effort] ?? effort;
		}
		return;
	}

	if (compat.thinkingFormat === "openrouter") {
		// pi-lens-ignore: no-as-any,no-any-type
		const openRouterParams = params as any;
		if (effort) {
			openRouterParams.reasoning = {
				effort: model.thinkingLevelMap?.[effort] ?? effort,
			};
		} else if (model.thinkingLevelMap?.off !== null) {
			openRouterParams.reasoning = {
				effort: model.thinkingLevelMap?.off ?? "none",
			};
		}
		return;
	}

	if (compat.thinkingFormat === "ant-ling") {
		if (effort) {
			const value = model.thinkingLevelMap?.[effort];
			if (typeof value === "string") {
				// pi-lens-ignore: no-as-any,no-any-type
				(params as any).reasoning = { effort: value };
			}
		}
		return;
	}

	if (compat.thinkingFormat === "together") {
		// pi-lens-ignore: no-as-any,no-any-type
		const togetherParams = params as any;
		togetherParams.reasoning = { enabled };
		if (effort && compat.supportsReasoningEffort) {
			togetherParams.reasoning_effort =
				model.thinkingLevelMap?.[effort] ?? effort;
		}
		return;
	}

	if (compat.thinkingFormat === "string-thinking") {
		// pi-lens-ignore: no-as-any,no-any-type
		const stringThinkingParams = params as any;
		if (effort) {
			stringThinkingParams.thinking =
				model.thinkingLevelMap?.[effort] ?? effort;
		} else if (model.thinkingLevelMap?.off !== null) {
			stringThinkingParams.thinking =
				model.thinkingLevelMap?.off ?? "none";
		}
		return;
	}

	// "openai" (default): OpenAI-style reasoning_effort
	if (effort && compat.supportsReasoningEffort) {
		// pi-lens-ignore: no-as-any,no-any-type
		(params as any).reasoning_effort =
			model.thinkingLevelMap?.[effort] ?? effort;
	} else if (!effort && compat.supportsReasoningEffort) {
		const offValue = model.thinkingLevelMap?.off;
		if (typeof offValue === "string") {
			// pi-lens-ignore: no-as-any,no-any-type
			(params as any).reasoning_effort = offValue;
		}
	}
}

/**
 * Resolve `chatTemplateKwargs`/`chatTemplateArgs` entries, expanding
 * `{ "$var": "thinking.enabled" | "thinking.effort" }` placeholders
 * against the current thinking state. Mirrors pi-ai.
 */
function buildChatTemplateValues(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	values: Record<string, ChatTemplateKwargValue> | undefined,
): Record<string, ChatTemplateKwargValue> | undefined {
	if (!values) return undefined;
	const resolved: Record<string, ChatTemplateKwargValue> = {};
	for (const [key, value] of Object.entries(values)) {
		const entry = resolveChatTemplateKwargValue(model, options, value);
		if (entry !== undefined) resolved[key] = entry;
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/**
 * Resolve a single `chatTemplateKwargs`/`chatTemplateArgs` value.
 * Literals pass through; `{ "$var": ... }` placeholders expand against
 * the current thinking state, with `omitWhenOff` dropping the key when
 * thinking is off. Mirrors pi-ai.
 */
function resolveChatTemplateKwargValue(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	value: ChatTemplateKwargValue,
): ChatTemplateKwargValue | undefined {
	if (typeof value !== "object" || value === null) return value;
	const effort = resolveReasoningEffort(model, options);
	if (!effort && value.omitWhenOff) return undefined;
	if (value.$var === "thinking.enabled") return effort !== undefined;
	const mapped = effort
		? model.thinkingLevelMap?.[effort]
		: model.thinkingLevelMap?.off;
	if (mapped === undefined) return effort;
	return typeof mapped === "string" ? mapped : undefined;
}

/**
 * pi-ai's fixed prompt reserve (`CONTEXT_SAFETY_TOKENS` in
 * `pi-ai/api/simple-options`), used as the reserve for large context windows.
 */
const PI_CONTEXT_SAFETY_TOKENS = 4096;
/** Lower bound for the prompt reserve on small local context windows. */
const LOCAL_MIN_RESERVE_TOKENS = 512;
/** Floor for the output budget when the prompt already fills the window. */
const LOCAL_MIN_OUTPUT_TOKENS = 256;

/**
 * Tokens to leave free for the prompt: pi-ai's 4096 for large windows, scaled
 * down (never below 512) for the small windows local servers run.
 */
function localContextReserveTokens(contextWindow: number): number {
	return Math.min(
		PI_CONTEXT_SAFETY_TOKENS,
		Math.max(LOCAL_MIN_RESERVE_TOKENS, Math.floor(contextWindow / 8)),
	);
}

/**
 * Clamp an output budget for a local server.
 *
 * pi-ai's `clampMaxTokensToContext()` reserves a fixed 4096 tokens between the
 * estimated prompt and the output budget, and floors the result at its
 * `MIN_MAX_TOKENS` of 1. That is right for cloud models but lethal at the
 * context window sizes Lemonade serves: a 4096-token model gets
 * `max_tokens: 1` and answers with a single token. Here the reserve scales with
 * the window — `min(4096, max(512, ctx / 8))` — so behaviour matches upstream
 * from 32768 tokens up, while small models keep a usable budget. A prompt that
 * already fills the window still gets `LOCAL_MIN_OUTPUT_TOKENS` rather than 1:
 * local servers clamp generation to their own `n_ctx`, and one token is never a
 * useful answer.
 *
 * The token estimate itself stays pi-ai's — `estimateContextTokens()` is not
 * exported — by inflating the window by the difference between pi-ai's fixed
 * reserve and ours, so its arithmetic evaluates `ctx - estimate - reserve`.
 */
function clampMaxTokensForLocalContext(
	model: Model<"openai-completions">,
	context: ProviderContext,
	maxTokens: number | undefined,
): number {
	// No cap requested (no `options.maxTokens`, no model `maxTokens`).
	if (!maxTokens) return 0;
	// Unknown context window: trust whatever cap the model advertises.
	if (model.contextWindow <= 0) return maxTokens;
	const reserve = localContextReserveTokens(model.contextWindow);
	const clamped = clampMaxTokensToContext(
		{
			...model,
			contextWindow:
				model.contextWindow + (PI_CONTEXT_SAFETY_TOKENS - reserve),
		},
		context,
		maxTokens,
	);
	return Math.min(
		maxTokens,
		Math.max(Math.min(maxTokens, LOCAL_MIN_OUTPUT_TOKENS), clamped),
	);
}

function buildParams(
	model: Model<"openai-completions">,
	context: ProviderContext,
	options?: OpenAICompletionsOptions,
	compat: ResolvedCompat = getCompat(model),
): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
	// pi-lens-ignore: no-as-any,no-any-type
	const messages = sdkConvertMessages(model, context, compat as any);

	const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: model.id,
		messages,
		stream: true,
	};

	if (compat.supportsUsageInStreaming !== false) {
		// pi-lens-ignore: no-as-any,no-any-type
		(params as any).stream_options = { include_usage: true };
	}

	// Faithful port of pi-ai: when the server *supports* the `store`
	// parameter, explicitly opt out of OpenAI's persistent memory with
	// `store: false`; when it does not, the parameter is omitted entirely
	// (an unknown field would be rejected). `supportsStore: false` (the
	// discovered-model default) therefore sends nothing.
	if (compat.supportsStore) {
		params.store = false;
	}

	// `maxTokens` is derived from the model, not only from the request: pi-ai
	// fills `options.maxTokens` from `model.maxTokens` in `buildBaseOptions`
	// (`pi-ai/api/simple-options`), which the built-in `streamSimple` calls but
	// this fork's does not (it delegates straight to `stream`). The agent loop
	// never sets `options.maxTokens` for ordinary turns — only compaction does
	// — so deriving it here is what makes `models.json` `modelOverrides.maxTokens`
	// (and the discovered `maxTokens`) reach the wire. The budget is clamped to
	// the tokens still available in `model.contextWindow`, with the reserve
	// scaled to the window instead of pi-ai's fixed 4096 — see
	// `clampMaxTokensForLocalContext`.
	const maxTokens = clampMaxTokensForLocalContext(
		model,
		context,
		options?.maxTokens ?? model.maxTokens,
	);
	if (maxTokens) {
		if (compat.maxTokensField === "max_tokens") {
			// pi-lens-ignore: no-as-any,no-any-type
			(params as any).max_tokens = maxTokens;
		} else {
			params.max_completion_tokens = maxTokens;
		}
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	const activeTools = context.tools;
	if (activeTools && activeTools.length > 0) {
		params.tools = activeTools.map((tool) => ({
			type: "function" as const,
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters as Record<string, unknown>,
				...(compat.supportsStrictMode ? { strict: false } : {}),
			},
		}));
	}

	if (options?.toolChoice) {
		params.tool_choice = options.toolChoice;
	}

	// Thinking/reasoning request parameters — mirrors pi-ai's
	// openai-completions thinkingFormat handling so models.json
	// modelOverrides (thinkingFormat, chatTemplateKwargs, thinkingLevelMap)
	// behave the same as the built-in provider.
	applyThinkingParams(params, model, options, compat);

	// Last so custom keys override the named request fields.
	// `model.samplingParams` (models.json `modelOverrides.samplingParams`) is
	// merged over by the per-request value — pi-ai does this merge in
	// `buildBaseOptions`, which this fork bypasses, so it happens here instead.
	// Structurally reserved keys are skipped: `stream` must stay true (this is
	// a streaming request), `model` must stay the model id, and `messages` must
	// stay the converted conversation — a samplingParams override of any of
	// them would corrupt the request. No other key is filtered: an override of
	// a fork-computed field (`tools`, `max_tokens`, `temperature`, …) silently
	// wins — that is the documented escape hatch for backend-specific knobs,
	// but it also means a stray `tools`/`max_tokens` entry clobbers the
	// computed value (see the README's models.json note).
	const samplingParams =
		model.samplingParams || options?.samplingParams
			? { ...model.samplingParams, ...options?.samplingParams }
			: undefined;
	if (samplingParams) {
		const reserved = new Set(["stream", "model", "messages"]);
		const overrides = Object.fromEntries(
				Object.entries(samplingParams).filter(([key]) => !reserved.has(key)),
		);
		Object.assign(params, overrides);
	}

	return params;
}

// ── Usage parsing ───────────────────────────────────────────────────────────

function parseChunkUsage(
	rawUsage: {
		prompt_tokens?: number;
		completion_tokens?: number;
		cached_tokens?: number;
		prompt_cache_hit_tokens?: number;
		prompt_tokens_details?: {
			cached_tokens?: number;
			cache_write_tokens?: number;
		};
		completion_tokens_details?: { reasoning_tokens?: number };
	},
	model: Model<"openai-completions">,
): AssistantMessage["usage"] {
	const promptTokens = rawUsage.prompt_tokens || 0;
	// Providers disagree about where cache reads are reported: OpenAI nests
	// `prompt_tokens_details.cached_tokens`, DeepSeek uses
	// `prompt_cache_hit_tokens`, and Ollama/Lemonade-style backends (like Kimi)
	// put `cached_tokens` at the top level of the usage object. Cache writes stay
	// separate and are never subtracted from the read count. Mirrors upstream
	// openai-completions.ts.
	const cacheReadTokens =
		rawUsage.prompt_tokens_details?.cached_tokens ??
		rawUsage.prompt_cache_hit_tokens ??
		rawUsage.cached_tokens ??
		0;
	const cacheWriteTokens =
		rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	const outputTokens = rawUsage.completion_tokens || 0;

	const usage: AssistantMessage["usage"] = {
		input,
		output: outputTokens,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || 0,
		totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	// pi prices messages through calculateCost (per-million rates from
	// `model.cost`, tiers included). Skipping it left every Lemonade message
	// reporting zero cost even when pricing was configured in models.json.
	// Local models default to all-zero rates, so this stays exactly zero there.
	calculateCost(model, usage);
	return usage;
}

function mapStopReason(reason: string): {
	stopReason: AssistantMessage["stopReason"];
	errorMessage?: string;
} {
	// Only reachable with a truthy finish_reason: the chunk loop gates the call
	// on `if (choice.finish_reason)`, so null/undefined never arrive here.
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return {
				stopReason: "error",
				errorMessage: "Provider finish_reason: content_filter",
			};
		case "network_error":
			return {
				stopReason: "error",
				errorMessage: "Provider finish_reason: network_error",
			};
		default:
			return {
				stopReason: "error",
				errorMessage: `Provider finish_reason: ${reason}`,
			};
	}
}

// ── Stream implementation ───────────────────────────────────────────────────

interface StreamingToolCallBlock extends ToolCall {
	partialArgs?: string;
	streamIndex?: number;
}

type StreamingBlock = TextContent | ThinkingContent | StreamingToolCallBlock;

/**
 * Main streaming function for Lemonade Server.
 *
 * Uses the OpenAI SDK to parse the response stream, but intercepts
 * Lemonade-specific error events mid-stream and retries on 429 / retryable
 * errors per lemonade-error-shapes.md.
 */
/**
 * Appended to the error message when a retryable error arrives after content
 * has already streamed (see the retry guard in `stream`).
 */
const RETRY_SUPPRESSED_NOTE = " (retryable, but output had already started — not retried)";

// ── pi ≥ 0.86 transcript normalization ─────────────────────────────────────

/**
 * pi ≥ 0.86 hands providers a normalized *transcript context* instead of the
 * legacy `Context`: the system prompt and tool declarations are no longer on
 * the context but are carried by system messages inside `messages` (the
 * leading system message holds the base prompt in `content`, named prompt
 * sections in `sections`, and the initial tools in `toolsAdded`; later system
 * messages append prompt text, replace or remove sections, and add or remove
 * tools). pi ≤ 0.85 still sends the legacy shape (`systemPrompt`/`tools` on
 * the context, no system messages).
 *
 * The pi-ai `convertMessages` this fork reuses is generation-dependent:
 * 0.84/0.85 read `context.systemPrompt` and silently drop `system`-role
 * messages in the list, while 0.86/0.87 reads the system messages in the list and
 * ignores `context.systemPrompt`. The fold below emits *both* encodings —
 * `systemPrompt` on the context **and** a synthetic leading system message —
 * so exactly one system prompt reaches the wire on any pi ≥ 0.83 runtime
 * with the 0.87.x local pi-ai this package pins. The current tool set
 * (replaying `toolsAdded`/`toolsRemoved` in transcript order) goes on
 * `context.tools`, which this fork's `buildParams` reads directly.
 */

/**
 * What the fork actually receives: pi ≥ 0.86 passes the branded
 * `TranscriptContext` (prompt/tools carried by the transcript's system
 * messages), pi ≤ 0.85 passes the legacy context with `systemPrompt`/`tools`
 * on it. The intersection covers both, and the brand survives the fold
 * below, so the result stays a valid `TranscriptContext` for pi-ai's 0.87
 * `convertMessages` / `clampMaxTokensToContext`.
 */
type ProviderContext = TranscriptContext & {
	systemPrompt?: string;
	tools?: Tool[];
};

/** A `system`-role message as pi ≥ 0.86 carries it in the transcript. */
interface TranscriptSystemMessage {
	role: "system";
	content: string | TextContent[];
	sections?: Record<string, string | null>;
	toolsAdded?: Tool[];
	toolsRemoved?: { name: string }[];
	timestamp?: number;
}

/**
 * Content text of one system message (mirrors pi-ai's `contentText` join
 * semantics). Sections are handled separately by the replay in
 * {@linkcode normalizeTranscriptContext}: the merged prompt carries the
 * *final* section state, not each message's own.
 */
function systemMessageContent(message: TranscriptSystemMessage): string {
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
}

/**
 * Fold any pi ≥ 0.83 context into the dual-encoded shape described in the
 * section header: one `systemPrompt` (all system-message content replayed in
 * transcript order, then the *final* state of their named sections —
 * replaced by name, `null` removes — matching pi-ai's own
 * `getCurrentSystemMessage`/`getSystemMessageText` replay), a synthetic
 * leading system message carrying the same text, the current `tools` set on
 * the context, and `messages` without system entries.
 *
 * Contexts with no prompt and no system messages pass through unchanged,
 * and an already-folded context (single leading system message mirroring
 * `systemPrompt`, no sections or tool deltas) is returned unchanged — the
 * fold is idempotent, so it is safe to run on every request. A genuine
 * pi ≥ 0.86 transcript never has `context.systemPrompt` set, so the
 * idempotency guard cannot misfire on real input.
 */
export function normalizeTranscriptContext(context: ProviderContext): ProviderContext {
	const messages = context.messages;
	const systemMessages = messages.filter((message) => message.role === "system");

	// Nothing to fold: no system messages and no prompt to re-encode.
	if (
		systemMessages.length === 0 &&
		(context.systemPrompt === undefined || context.systemPrompt.length === 0)
	) {
		return context;
	}

	// Idempotency guard (see above).
	const first = systemMessages[0];
	if (
		systemMessages.length === 1 &&
		messages[0] === first &&
		typeof first.content === "string" &&
		first.content === context.systemPrompt &&
		first.sections === undefined &&
		first.toolsAdded === undefined &&
		first.toolsRemoved === undefined
	) {
		return context;
	}

	const contentParts: string[] = [];
	const sections = new Map<string, string>();
	const tools = new Map<string, Tool>();
	for (const message of systemMessages) {
		const content = systemMessageContent(message);
		if (content.length > 0) contentParts.push(content);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
	}

	const promptParts = [
		context.systemPrompt,
		...contentParts,
		...sections.values(),
	].filter((part) => part !== undefined && part.length > 0);
	const systemPrompt = promptParts.length > 0 ? promptParts.join("\n\n") : undefined;
	return {
		...context,
		...(systemPrompt ? { systemPrompt } : {}),
		...(tools.size > 0 ? { tools: [...tools.values()] } : {}),
		messages: [
			...(systemPrompt
				? [{ role: "system" as const, content: systemPrompt, timestamp: 0 }]
				: []),
			...messages.filter((message) => message.role !== "system"),
		],
	};
}

/** Zeroed usage for a fresh attempt / a stream that never reported usage. */
function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export const stream: StreamFunction<
	"openai-completions",
	LemonadeCompletionsOptions
	// pi-lens-ignore: high-complexity,high-fan-out
> = (
	model: Model<"openai-completions">,
	context: ProviderContext,
	options?: LemonadeCompletionsOptions,
): AssistantMessageEventStream => {
	// Fold the context once per request: pi ≥ 0.86 sends a transcript context
	// (prompt/tools carried by system messages in the transcript), pi ≤ 0.85
	// sends the legacy `Context`. `buildParams` and pi-ai's `convertMessages`
	// then see the same dual-encoded fields on every pi ≥ 0.83 (see the
	// transcript normalization section above). No-op for prompt-less contexts.
	context = normalizeTranscriptContext(context);

	const eventStream = createAssistantMessageEventStream();

	// `output` declared at this scope so the retry catch block can mutate it.
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};

	// Emitted once per `stream()` call rather than once per attempt: a retry
	// starts from a fresh message, but the consumer already has its placeholder.
	let started = false;
	// Set when a retryable error was not retried because content had already
	// streamed, so the terminal error message can explain why.
	let retrySuppressed = false;

	// pi-lens-ignore: high-complexity,high-fan-out
	const executeStream = async () => {
		// `output` outlives a single attempt, so each attempt has to reset what
		// the previous one accumulated: otherwise a retry appends its text to the
		// partial message of the attempt that failed (both ended up in the final
		// assistant message, with duplicate text_start/text_end events) and the
		// failed attempt's usage/stopReason/responseId leak into the successful
		// retry. Retries are additionally suppressed once any content has been
		// emitted (see `retryStreamLoop` below), so nothing already shown to the
		// consumer is ever discarded and re-sent.
		output.content = [];
		output.usage = emptyUsage();
		output.stopReason = "pending";
		output.errorMessage = undefined;
		output.responseId = undefined;
		output.responseModel = undefined;

		const apiKey = getClientApiKey(
			model.provider,
			options?.apiKey,
			options?.headers as Record<string, string | null> | undefined,
		);

		const client = createClient(
			model,
			apiKey,
			options?.headers as Record<string, string | null> | undefined,
			options?.fetch,
		);

		const compat = getCompat(model);
		let params = buildParams(
			model,
			context,
			options as OpenAICompletionsOptions,
			compat,
		);
		const nextParams = await options?.onPayload?.(params, model);
		if (nextParams !== undefined) {
			params =
				nextParams as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
		}

		// The SDK's own retry timer ignores AbortSignal and cannot judge Lemonade
		// error shapes, so requests go out with `maxRetries: 0`. HTTP-level retry
		// (status table + `Retry-After`, abortible) happens in
		// `retryProviderRequest`; SSE-embedded Lemonade errors are handled by
		// `retryStreamLoop`, which only retries while nothing has streamed yet.
		const requestOptions = {
			...(options?.signal ? { signal: options.signal } : {}),
			...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
			maxRetries: 0,
		};

		const { data: openaiStream, response } = await retryProviderRequest(
			() => client.chat.completions.create(params, requestOptions).withResponse(),
			{
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal,
			},
		);

		await options?.onResponse?.(
			{
				status: response.status,
				headers: Object.fromEntries(response.headers.entries()),
			},
			model,
		);

		// Emitted once per call (see `started`): a retried attempt must not push a
		// second `start` for the same assistant message.
		if (!started) {
			eventStream.push({ type: "start", partial: output });
			started = true;
		}

		let textBlock: TextContent | null = null;
		let thinkingBlock: ThinkingContent | null = null;
		let hasFinishReason = false;
		const toolCallBlocksByIndex = new Map<number, StreamingToolCallBlock>();
		const toolCallBlocksById = new Map<string, StreamingToolCallBlock>();
		let lastToolCallBlock: StreamingToolCallBlock | undefined;
		const blocks = output.content as StreamingBlock[];
		const getContentIndex = (block: StreamingBlock) => blocks.indexOf(block);

		const finishBlock = (block: StreamingBlock) => {
			const contentIndex = getContentIndex(block);
			if (contentIndex === -1) return;
			if (block.type === "text") {
				eventStream.push({
					type: "text_end",
					contentIndex,
					content: block.text,
					partial: output,
				});
			} else if (block.type === "thinking") {
				eventStream.push({
					type: "thinking_end",
					contentIndex,
					content: block.thinking,
					partial: output,
				});
			} else if (block.type === "toolCall") {
				block.arguments = parseStreamingJson(block.partialArgs);
				// pi-lens-ignore: ts-delete-property
				delete block.partialArgs;
				// pi-lens-ignore: ts-delete-property
				delete block.streamIndex;
				eventStream.push({
					type: "toolcall_end",
					contentIndex,
					toolCall: block,
					partial: output,
				});
			}
		};

		const ensureTextBlock = () => {
			if (!textBlock) {
				textBlock = { type: "text", text: "" };
				blocks.push(textBlock);
				eventStream.push({
					type: "text_start",
					contentIndex: getContentIndex(textBlock),
					partial: output,
				});
			}
			return textBlock;
		};

		const ensureThinkingBlock = (thinkingSignature: string) => {
			if (!thinkingBlock) {
				thinkingBlock = { type: "thinking", thinking: "", thinkingSignature };
				blocks.push(thinkingBlock);
				eventStream.push({
					type: "thinking_start",
					contentIndex: getContentIndex(thinkingBlock),
					partial: output,
				});
			}
			return thinkingBlock;
		};

		// pi-lens-ignore: high-complexity
		const ensureToolCallBlock = (toolCall: {
			index?: number;
			id?: string;
			function?: { name?: string; arguments?: string };
		}) => {
			const streamIndex =
				typeof toolCall.index === "number" ? toolCall.index : undefined;
			const name = toolCall.function?.name ?? "";
			let block =
				streamIndex === undefined
					? undefined
					: toolCallBlocksByIndex.get(streamIndex);
			if (!block && toolCall.id) {
				block = toolCallBlocksById.get(toolCall.id);
			}
			if (!block && streamIndex === undefined && !toolCall.id) {
				// A continuation chunk carrying neither index nor id (some
				// OpenAI-compatible backends send the id only on the first
				// chunk) would otherwise create a duplicate block per chunk —
				// append to the most recent tool call instead.
				block = lastToolCallBlock;
			}
			if (!block) {
				block = {
					type: "toolCall",
					id: toolCall.id || "",
					name,
					arguments: {},
					partialArgs: "",
					streamIndex,
				};
				if (streamIndex !== undefined)
					toolCallBlocksByIndex.set(streamIndex, block);
				if (toolCall.id) toolCallBlocksById.set(toolCall.id, block);
				blocks.push(block);
				eventStream.push({
					type: "toolcall_start",
					contentIndex: getContentIndex(block),
					partial: output,
				});
			}
			if (streamIndex !== undefined && block.streamIndex === undefined) {
				block.streamIndex = streamIndex;
				toolCallBlocksByIndex.set(streamIndex, block);
			}
			if (toolCall.id) toolCallBlocksById.set(toolCall.id, block);
			if (!block.name && name) block.name = name;
			lastToolCallBlock = block;
			return block;
		};

		// ── SSE chunk processing with Lemonade error detection ──

		for await (const chunk of openaiStream) {
			if (!chunk || typeof chunk !== "object") continue;

			// Lemonade error detection: the OpenAI SDK yields Lemonade error
			// events as plain objects with an `error` property and no `choices`.
			// On 429 / retryable errors, we throw to trigger retryStreamLoop.
			if (isLemonadeErrorChunk(chunk)) {
				const err = chunk.error;
				if (isRetryableError(err) && output.content.length === 0) {
					// Throw the error shape so retryStreamLoop can catch and retry.
					const retryError = new Error(
						`Lemonade mid-stream retryable error: ${err.message}` +
							(err.status_code === undefined ? "" : ` (status ${err.status_code})`) +
							(err.code ? ` [${err.code}]` : ""),
					) as Error & { error: LemonadeErrorShape };
					retryError.error = err;
					throw retryError;
				}
				// Non-retryable error — terminate the stream with full error
				// details. Anything already streamed is kept: a retry would append
				// its text under the partial answer the consumer is already
				// rendering, so a mid-stream error after content is reported, not
				// retried.
				const partialNote =
					output.content.length > 0 ? RETRY_SUPPRESSED_NOTE : "";
				output.stopReason = "error";
				output.errorMessage = `${formatLemonadeError(err)}${partialNote}`;
				for (const block of blocks) finishBlock(block);
				eventStream.push({ type: "error", reason: "error", error: output });
				eventStream.end();
				return;
			}

			// Standard OpenAI chunk processing
			const typedChunk = chunk as ChatCompletionChunk;

			output.responseId ||= typedChunk.id;
			if (
				typeof typedChunk.model === "string" &&
				typedChunk.model.length > 0 &&
				typedChunk.model !== model.id
			) {
				output.responseModel ||= typedChunk.model;
			}
			if (typedChunk.usage) {
				output.usage = parseChunkUsage(typedChunk.usage, model);
			}

			const choice = Array.isArray(typedChunk.choices)
				? typedChunk.choices[0]
				: undefined;
			if (!choice) continue;

			if (choice.finish_reason) {
				output.rawStopReason = choice.finish_reason;
				const result = mapStopReason(choice.finish_reason);
				output.stopReason = result.stopReason;
				if (result.errorMessage) output.errorMessage = result.errorMessage;
				hasFinishReason = true;
			}

			if (choice.delta) {
				// Text content
				if (
					choice.delta.content !== null &&
					choice.delta.content !== undefined &&
					choice.delta.content.length > 0
				) {
					const block = ensureTextBlock();
					block.text += choice.delta.content;
					eventStream.push({
						type: "text_delta",
						contentIndex: getContentIndex(block),
						delta: choice.delta.content,
						partial: output,
					});
				}

				// Thinking/reasoning content
				const deltaFields = choice.delta as Record<string, unknown>;
				const reasoningFields = [
					"reasoning_content",
					"reasoning",
					"reasoning_text",
				];
				const foundReasoningField = reasoningFields.find(
					(f) =>
						typeof deltaFields[f] === "string" &&
						(deltaFields[f] as string).length > 0,
				);
				if (foundReasoningField) {
					const delta = deltaFields[foundReasoningField] as string;
					// pi-lens-ignore: deep-nesting
					if (delta.length > 0) {
						const block = ensureThinkingBlock(foundReasoningField);
						block.thinking += delta;
						eventStream.push({
							type: "thinking_delta",
							contentIndex: getContentIndex(block),
							delta,
							partial: output,
						});
					}
				}

				// Tool calls
				if (choice.delta.tool_calls) {
					for (const toolCall of choice.delta.tool_calls as Array<{
						index?: number;
						id?: string;
						function?: { name?: string; arguments?: string };
					}>) {
						const block = ensureToolCallBlock(toolCall);
						if (!block.id && toolCall.id) {
							block.id = toolCall.id;
							toolCallBlocksById.set(toolCall.id, block);
						}
						const name = toolCall.function?.name;
						if (!block.name && name) block.name = name;

						let deltaStr = "";
						if (toolCall.function?.arguments) {
							deltaStr = toolCall.function.arguments;
							block.partialArgs =
								(block.partialArgs ?? "") + toolCall.function.arguments;
							block.arguments = parseStreamingJson(block.partialArgs);
						}
						eventStream.push({
							type: "toolcall_delta",
							contentIndex: getContentIndex(block),
							delta: deltaStr,
							partial: output,
						});
					}
				}
			}
		}

		// ── Post-stream finalization ──

		for (const block of blocks) {
			finishBlock(block);
		}

		if (options?.signal?.aborted) {
			throw new Error("Request was aborted");
		}
		// Unreachable at runtime ("aborted" is only assigned in the catch
		// below, which always throws) — but it narrows the mutable
		// `output.stopReason` union for the `done` event below, whose
		// `reason` does not include "aborted".
		if (output.stopReason === "aborted") {
			throw new Error("Request was aborted");
		}
		if (!hasFinishReason && !compat.supportsFinishReason) {
			output.stopReason = output.content.some((block) => block.type === "toolCall")
				? "toolUse"
				: "stop";
		}
		if (output.stopReason === "error") {
			throw new Error(
				output.errorMessage || "Provider returned an error stop reason",
			);
		}
		if (
			(compat.supportsFinishReason && !hasFinishReason) ||
			output.stopReason === "pending"
		) {
			throw new Error("Stream ended without finish_reason");
		}

		eventStream.push({
			type: "done",
			reason: output.stopReason,
			message: output,
		});
		eventStream.end();
	};

	// Wrap in retry loop for mid-stream 429 / retryable errors
	(async () => {
		try {
			await retryStreamLoop(executeStream, {
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal,
				isRetryable: (error) => {
					// A pre-stream HTTP failure already consumed its full retry budget
					// inside retryProviderRequest; only status-less errors (SSE-embedded
					// Lemonade errors, thrown while iterating) reach the stream-layer
					// backoff. Without this guard a 429 with a Lemonade-shaped body was
					// retried by BOTH layers — (maxRetries+1)² requests instead of
					// maxRetries+1, up to ~48 min of backoff at the defaults.
					if (isProviderHttpError(error) && error.status !== undefined)
						return false;
					if (!isRetryableStreamError(error)) return false;
					if (output.content.length === 0) return true;
					// Once content reached the consumer, a retry would duplicate it
					// in the same assistant message (upstream pi only retries before
					// the stream starts), so surface the error instead.
					retrySuppressed = true;
					return false;
				},
			});
		} catch (error) {
			// Clean up partial content blocks — mirror finishBlock, which
			// clears both streaming scratch fields on a completed tool call.
			const partial = output.content;
			for (const block of partial) {
				// pi-lens-ignore: ts-delete-property
				delete (block as { partialArgs?: string }).partialArgs;
				// pi-lens-ignore: ts-delete-property
				delete (block as { streamIndex?: number }).streamIndex;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			if (!output.errorMessage) {
				// `error.error` carries the raw Lemonade shape (the SDK's
				// APIError and the defensive synthetic mid-stream error) —
				// `terminalErrorMessage` formats it with full diagnostics.
				output.errorMessage = terminalErrorMessage(error);
				if (
					retrySuppressed &&
					!output.errorMessage?.endsWith(RETRY_SUPPRESSED_NOTE)
				) {
					output.errorMessage = `${output.errorMessage ?? ""}${RETRY_SUPPRESSED_NOTE}`;
				}
			}
			eventStream.push({
				type: "error",
				reason: output.stopReason,
				error: output,
			});
			eventStream.end();
		}
	})();

	return eventStream;
};

export const streamSimple: StreamFunction<
	"openai-completions",
	SimpleStreamOptions
> = (
	model: Model<"openai-completions">,
	context: ProviderContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	// No fail-fast key check here: `stream`'s `executeStream` runs the same
	// `getClientApiKey` check, and its error surfaces as an error event —
	// a synchronous throw here would make `streamSimple` behave differently
	// from `stream` for the same missing-key condition.
	return stream(model, context, { ...options } as LemonadeCompletionsOptions);
};
