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
 * - HTTP-level retries (408, 409, 429, 5xx) via retryProviderRequest
 * - Mid-stream SSE event retries (429, retryable: true) via retryStreamLoop
 */

import OpenAI from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type {
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "@earendil-works/pi-ai";
import type { OpenAICompletionsOptions } from "@earendil-works/pi-ai/api/openai-completions";
import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	parseStreamingJson,
} from "@earendil-works/pi-ai";
import { convertMessages as sdkConvertMessages } from "@earendil-works/pi-ai/api/openai-completions";

/** Extended options for Lemonade completions with retry config. */
export interface LemonadeCompletionsOptions extends OpenAICompletionsOptions {
	maxRetries?: number;
}

// ── Retry configuration (authoritative, imported by index.ts) ──────────────

/** Total time budget for chat completion retries. */
export const DEFAULT_RETRY_BUDGET_SEC = 120;
/** Max retries to fit within the budget, assuming SDK exponential backoff (0.5, 1, 2, 4, 8...). */
export const DEFAULT_MAX_RETRIES =
	Math.floor((DEFAULT_RETRY_BUDGET_SEC - 7.5) / 8) + 4;
/** Max delay for a single retry attempt (caps Retry-After headers). */
export const DEFAULT_MAX_RETRY_DELAY_SEC = 60;

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
 * Check if a chunk is a Lemonade error event.
 *
 * Lemonade emits errors as SSE events: `data: {"error": {...}}`
 * The OpenAI SDK yields these as plain objects (not ChatCompletionChunk),
 * so we detect them by presence of an `error` property and absence of
 * the expected `choices` array.
 * NOTE: In practice the OpenAI SDK throws APIError before yielding, so
 * the real error formatting happens in the catch block below. This path
 * is kept as a defensive fallback.
 */
function isLemonadeErrorChunk(
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

const HF_HUB_PREFIX_RE = /^\/.*\/huggingface\/hub\//;

/** Exponential backoff with jitter, matching provider-retry.ts. */
function getRetryDelayMs(retryIndex: number): number {
	const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
	return Math.min(
		exponentialDelay * (1 - Math.random() * 0.25),
		DEFAULT_MAX_RETRY_DELAY_SEC * 1000,
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

interface StreamRetryOptions {
	maxRetries?: number;
	signal?: AbortSignal;
}

/**
 * Retry a streaming loop on mid-stream Lemonade errors.
 *
 * The `streamFn` is called in a loop. If it throws a Lemonade error that is
 * retryable, we back off and retry. Non-retryable errors and exhausted retries
 * propagate the error.
 */
async function retryStreamLoop<T>(
	streamFn: () => Promise<T>,
	options?: StreamRetryOptions,
): Promise<T> {
	const maxRetries = options?.maxRetries ?? 0;
	let retriesRemaining = maxRetries;

	for (;;) {
		try {
			return await streamFn();
		} catch (error) {
			if (options?.signal?.aborted) throw error;
			if (retriesRemaining <= 0) throw error;

			// Check for Lemonade error shape in the thrown error
			const lemonadeError = (error as { error?: LemonadeErrorShape })?.error;
			if (lemonadeError && isRetryableError(lemonadeError)) {
				const retryIndex = maxRetries - retriesRemaining;
				retriesRemaining--;
				await abortableSleep(
					getRetryDelayMs(retryIndex),
					options?.signal,
				);
				continue;
			}

			throw error;
		}
	}
}

// ── Compat resolution ───────────────────────────────────────────────────────

interface ResolvedCompat {
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
}

function getCompat(model: Model<"openai-completions">): ResolvedCompat {
	const compat = model.compat;
	return {
		supportsStore: compat?.supportsStore ?? true,
		supportsDeveloperRole: compat?.supportsDeveloperRole ?? true,
		supportsReasoningEffort: compat?.supportsReasoningEffort ?? true,
		supportsUsageInStreaming: compat?.supportsUsageInStreaming ?? true,
		supportsFinishReason: true,
		maxTokensField: compat?.maxTokensField ?? "max_completion_tokens",
		requiresToolResultName: compat?.requiresToolResultName ?? false,
		requiresAssistantAfterToolResult:
			compat?.requiresAssistantAfterToolResult ?? false,
		requiresThinkingAsText: compat?.requiresThinkingAsText ?? false,
		requiresReasoningContentOnAssistantMessages:
			compat?.requiresReasoningContentOnAssistantMessages ?? false,
		thinkingFormat: compat?.thinkingFormat ?? "openai",
		supportsStrictMode: compat?.supportsStrictMode ?? true,
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

function buildParams(
	model: Model<"openai-completions">,
	context: Context,
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

	if (compat.supportsStore) {
		params.store = false;
	}

	if (options?.maxTokens) {
		if (compat.maxTokensField === "max_tokens") {
			// pi-lens-ignore: no-as-any,no-any-type
			(params as any).max_tokens = options.maxTokens;
		} else {
			params.max_completion_tokens = options.maxTokens;
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

	// reasoning_effort (OpenAI-style, the default for Lemonade)
	if (
		options?.reasoningEffort &&
		model.reasoning &&
		compat.supportsReasoningEffort
	) {
		// pi-lens-ignore: no-as-any,no-any-type
		(params as any).reasoning_effort = options.reasoningEffort;
	}

	return params;
}

// ── Usage parsing ───────────────────────────────────────────────────────────

function parseChunkUsage(rawUsage: {
	prompt_tokens?: number;
	completion_tokens?: number;
	prompt_cache_hit_tokens?: number;
	prompt_tokens_details?: {
		cached_tokens?: number;
		cache_write_tokens?: number;
	};
	completion_tokens_details?: { reasoning_tokens?: number };
}): AssistantMessage["usage"] {
	const promptTokens = rawUsage.prompt_tokens || 0;
	const cacheReadTokens =
		rawUsage.prompt_tokens_details?.cached_tokens ??
		rawUsage.prompt_cache_hit_tokens ??
		0;
	const cacheWriteTokens =
		rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	const outputTokens = rawUsage.completion_tokens || 0;

	return {
		input,
		output: outputTokens,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || 0,
		totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function mapStopReason(
	reason: ChatCompletionChunk.Choice["finish_reason"] | string,
): { stopReason: AssistantMessage["stopReason"]; errorMessage?: string } {
	if (reason === null) return { stopReason: "stop" };
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
export const stream: StreamFunction<
	"openai-completions",
	LemonadeCompletionsOptions
	// pi-lens-ignore: high-complexity,high-fan-out
> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: LemonadeCompletionsOptions,
): AssistantMessageEventStream => {
	const eventStream = createAssistantMessageEventStream();

	// `output` declared at this scope so the retry catch block can mutate it.
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};

	// pi-lens-ignore: high-complexity,high-fan-out
	const executeStream = async () => {
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

		const requestOptions = {
			...(options?.signal ? { signal: options.signal } : {}),
			...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
			maxRetries: 0,
		};

		const { data: openaiStream, response } = await client.chat.completions
			.create(params, requestOptions)
			.withResponse();

		await options?.onResponse?.(
			{
				status: response.status,
				headers: Object.fromEntries(response.headers.entries()),
			},
			model,
		);

		eventStream.push({ type: "start", partial: output });

		let textBlock: TextContent | null = null;
		let thinkingBlock: ThinkingContent | null = null;
		let hasFinishReason = false;
		const toolCallBlocksByIndex = new Map<number, StreamingToolCallBlock>();
		const toolCallBlocksById = new Map<string, StreamingToolCallBlock>();
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
				if (isRetryableError(err)) {
					// Throw the error shape so retryStreamLoop can catch and retry.
					const retryError = new Error(
						`Lemonade mid-stream retryable error: ${err.message}` +
							(err.status_code === undefined ? "" : ` (status ${err.status_code})`) +
							(err.code ? ` [${err.code}]` : ""),
					) as Error & { error: LemonadeErrorShape };
					retryError.error = err;
					throw retryError;
				}
				// Non-retryable error — terminate the stream with full error details.
				output.stopReason = "error";
				output.errorMessage = formatLemonadeError(err);
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
                const serverModel = typedChunk.model;
                // Lemonade may return the full GGUF cache path;
                // strip `/*/huggingface/hub/` prefix for readability.
                const match = serverModel.match(HF_HUB_PREFIX_RE);
                const resolvedModel =
                    match
                        ? serverModel.slice((match.index ?? 0) + match[0].length)
                        : serverModel;
                output.responseModel ||= resolvedModel;
            }
			if (typedChunk.usage) {
				output.usage = parseChunkUsage(typedChunk.usage);
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
				signal: options?.signal,
			});
		} catch (error) {
			// Clean up partial content blocks
			const partial = output.content;
			for (const block of partial) {
				// pi-lens-ignore: ts-delete-property
				delete (block as { index?: number }).index;
				// pi-lens-ignore: ts-delete-property
				delete (block as { partialArgs?: string }).partialArgs;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			if (!output.errorMessage) {
				// OpenAI SDK throws APIError with the raw Lemonade error shape
				// in `error.error` (SSE: data: {"error": {...}}). Extract and
				// format with full diagnostic fields (status_code, type, etc).
				const lemonadeError = (error as { error?: LemonadeErrorShape })?.error;
				if (
					lemonadeError &&
					typeof lemonadeError === "object" &&
					"message" in lemonadeError &&
					// retryStreamLoop already formatted this via formatLemonadeError;
					// avoid double-formatting its synthetic Error.
					!(
						error instanceof Error && error.message.startsWith("Lemonade mid-stream")
					)
				) {
					output.errorMessage = formatLemonadeError(
						lemonadeError as LemonadeErrorShape,
					);
				} else {
					output.errorMessage =
						error instanceof Error ? error.message : String(error);
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
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	getClientApiKey(
		model.provider,
		options?.apiKey,
		options?.headers as Record<string, string | null> | undefined,
	);

	return stream(model, context, { ...options } as LemonadeCompletionsOptions);
};
