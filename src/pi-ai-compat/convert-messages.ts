/**
 * Fork-owned copy of pi-ai's `convertMessages`/`convertTools` from
 * `api/openai-completions.ts`.
 *
 * Provenance: @earendil-works/pi-ai 1.5.0,
 * `dist/api/openai-completions.js` (verbatim: convertMessages, convertTools
 * and their file-local helpers — the is*ContentBlock guards, the OpenAI
 * reasoning-detail parsers, isOpenAICompletionsReasoningField — plus the
 * `OpenAICompletionsOptions`/`ConvertCompletionsMessagesOptions` types from
 * the corresponding .d.ts). External helpers live in sibling copies:
 * ./hash.ts, ./sanitize-unicode.ts, ./transcript.ts,
 * ./transform-messages.ts, ./constrained-sampling.ts; `getSystemMessageText`
 * and `renderSystemMessageUpdate` are re-imported from the pi-ai root entry
 * (root-exported). Owning this file lets pi-ai live in `peerDependencies`
 * (avoids the host-provided-packages warning). Synced whenever the
 * @earendil-works/pi-ai devDependency pin moves — the
 * procedure lives in the repository's agent docs.
 * Do not edit the logic here except to mirror an upstream change.
 */
import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { FunctionParameters } from "openai/resources/shared.js";
import {
	getSystemMessageText,
	renderSystemMessageUpdate,
	type ImageContent,
	type Model,
	type OpenAICompletionsCompat,
	type StreamOptions,
	type TextContent,
	type ThinkingBudgets,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	getGrammarToolInput,
	getJsonSchemaToolParameters,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import { shortHash } from "./hash.ts";
import { sanitizeSurrogates } from "./sanitize-unicode.ts";
import { resolveTranscript, resolveTranscriptTools } from "./transcript.ts";
import { transformMessages } from "./transform-messages.ts";

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Token budgets per thinking level. Used when `compat.thinkingTokenBudgetField` or `compat.supportsThinkingTokenBudget` is set, or by `{ "$var": "thinking.budget" }`. */
	thinkingBudgets?: ThinkingBudgets;
}

export interface ConvertCompletionsMessagesOptions {
	grammarToolInputProperties?: ReadonlyMap<string, string>;
}

/**
 * The compat shape `convertMessages` expects: upstream's
 * `ResolvedOpenAICompletionsCompat` (required-everything minus the keys that
 * stay optional). Callers whose resolved compat only fills part of this cast.
 */
export type ConvertMessagesCompat = Omit<
	Required<OpenAICompletionsCompat>,
	| "cacheControlFormat"
	| "supportsThinkingTokenBudget"
	| "thinkingTokenBudgetField"
	| "supportsMidConvoSystemMessages"
	| "supportsMidConvoToolAdditions"
	| "vllmPriority"
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	supportsThinkingTokenBudget?: OpenAICompletionsCompat["supportsThinkingTokenBudget"];
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
	supportsMidConvoSystemMessages?: OpenAICompletionsCompat["supportsMidConvoSystemMessages"];
	supportsMidConvoToolAdditions?: OpenAICompletionsCompat["supportsMidConvoToolAdditions"];
	vllmPriority?: OpenAICompletionsCompat["vllmPriority"];
};

type ReasoningDetail = {
	id?: string | null;
	format?: string;
	index?: number;
} & (
	| { type: "reasoning.summary"; summary: string }
	| { type: "reasoning.encrypted"; data: string }
	| { type: "reasoning.text"; text: string; signature?: string | null }
);

/** Assistant wire message plus the non-standard reasoning fields pi-ai adds. */
type AssistantChatMessage = ChatCompletionMessageParam & {
	reasoning_details?: ReasoningDetail[];
	reasoning?: string;
	reasoning_content?: string;
	reasoning_text?: string;
};

/** Any transcript content block; the guards below narrow these unions. */
type ContentBlock = TextContent | ThinkingContent | ToolCall | ImageContent;

function isTextContentBlock(block: ContentBlock): block is TextContent {
	return block.type === "text";
}

function isThinkingContentBlock(block: ContentBlock): block is ThinkingContent {
	return block.type === "thinking";
}

function isToolCallBlock(block: ContentBlock): block is ToolCall {
	return block.type === "toolCall";
}

function isImageContentBlock(block: ContentBlock): block is ImageContent {
	return block.type === "image";
}

function isReasoningDetailObject(detail: unknown): detail is Record<string, unknown> {
	return typeof detail === "object" && detail !== null && !Array.isArray(detail);
}

function hasValidCommonReasoningDetailFields(candidate: Record<string, unknown>): boolean {
	return (
		(candidate.id === undefined || candidate.id === null || typeof candidate.id === "string") &&
		(candidate.format === undefined || typeof candidate.format === "string") &&
		(candidate.index === undefined || typeof candidate.index === "number")
	);
}

function isOpenAIReasoningDetail(detail: unknown): detail is ReasoningDetail {
	if (!isReasoningDetailObject(detail) || !hasValidCommonReasoningDetailFields(detail)) {
		return false;
	}
	switch (detail.type) {
		case "reasoning.summary":
			return typeof detail.summary === "string";
		case "reasoning.encrypted":
			return typeof detail.data === "string";
		case "reasoning.text":
			return (
				typeof detail.text === "string" &&
				(detail.signature === undefined || detail.signature === null || typeof detail.signature === "string")
			);
		default:
			return false;
	}
}

function parseOpenAIReasoningDetails(signature: string | undefined): ReasoningDetail[] | undefined {
	if (!signature)
		return undefined;
	try {
		const parsed = JSON.parse(signature) as unknown;
		return Array.isArray(parsed) && parsed.length > 0 && parsed.every(isOpenAIReasoningDetail)
			? (parsed as ReasoningDetail[])
			: undefined;
	}
	catch {
		return undefined;
	}
}

function parseLegacyEncryptedReasoningDetail(signature: string | undefined): ReasoningDetail | undefined {
	if (!signature)
		return undefined;
	try {
		const parsed = JSON.parse(signature) as unknown;
		return isOpenAIReasoningDetail(parsed) &&
			parsed.type === "reasoning.encrypted" &&
			typeof parsed.id === "string" &&
			parsed.id.length > 0 &&
			parsed.data.length > 0
			? parsed
			: undefined;
	}
	catch {
		return undefined;
	}
}

const OPENAI_COMPLETIONS_REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text"] as const;
type OpenAICompletionsReasoningField = (typeof OPENAI_COMPLETIONS_REASONING_FIELDS)[number];

function isOpenAICompletionsReasoningField(field: string): field is OpenAICompletionsReasoningField {
	return (OPENAI_COMPLETIONS_REASONING_FIELDS as readonly string[]).includes(field);
}

type ConvertToolsResult = OpenAI.Chat.Completions.ChatCompletionTool | {
	type: "custom";
	custom: {
		name: string;
		description?: string;
		format: {
			type: "grammar";
			grammar: {
				syntax: string;
				definition: string;
			};
		};
	};
};

function convertTools(tools: Tool[], compat: ConvertMessagesCompat): ConvertToolsResult[] {
	return tools.map((tool): ConvertToolsResult => {
		const grammar = resolveGrammarConstrainedSampling(tool, compat.supportsOpenAIGrammarTools);
		if (grammar) {
			return {
				type: "custom",
				custom: {
					name: tool.name,
					description: tool.description,
					format: {
						type: "grammar",
						grammar: {
							syntax: grammar.format,
							definition: grammar.definition,
						},
					},
				},
			} satisfies ConvertToolsResult;
		}
		const strict = resolveJsonSchemaStrictSampling(tool, compat.supportsStrictMode !== false);
		return {
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: getJsonSchemaToolParameters(tool, strict) as FunctionParameters,
				// Only include strict if provider supports it. Some reject unknown fields.
				...(compat.supportsStrictMode !== false && { strict: strict ?? false }),
			},
		} satisfies OpenAI.Chat.Completions.ChatCompletionTool;
	});
}

export function convertMessages(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	compat: ConvertMessagesCompat,
	options?: ConvertCompletionsMessagesOptions,
): ChatCompletionMessageParam[] {
	const normalizedContext = resolveTranscript(context, compat.supportsMidConvoSystemMessages);
	const params: ChatCompletionMessageParam[] = [];
	const normalizeToolCallId = (id: string): string => {
		// Handle pipe-separated IDs from OpenAI Responses API
		// Format: {call_id}|{id} where {id} can be 400+ chars with special chars (+, /, =)
		// These come from providers like github-copilot, openai-codex, opencode
		// Extract just the call_id part and normalize it
		// Multiple tool calls in the same turn can share call_id but differ by item_id.
		// Preserve item-level uniqueness when replaying into Chat Completions, which
		// requires distinct tool call ids.
		if (id.includes("|")) {
			// Sanitize to allowed chars and truncate to 40 chars (OpenAI limit)
			const separatorIndex = id.indexOf("|");
			const callId = id.slice(0, separatorIndex).replace(/[^a-zA-Z0-9_-]/g, "_");
			const itemId = id.slice(separatorIndex + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
			const combinedId = itemId.length > 0 ? `${callId}_${itemId}` : callId;
			if (combinedId.length <= 40) {
				return combinedId;
			}
			const hash = shortHash(id).slice(0, 8);
			const prefix = callId.slice(0, Math.max(1, 40 - hash.length - 1));
			return `${prefix}_${hash}`;
		}
		if (model.provider === "openai")
			return id.length > 40 ? id.slice(0, 40) : id;
		return id;
	};
	const transformedMessages = transformMessages(normalizedContext.messages, model, (id) => normalizeToolCallId(id));
	const transcriptTools = resolveTranscriptTools(
		normalizedContext.messages,
		compat.supportsMidConvoSystemMessages === true && compat.supportsMidConvoToolAdditions === true
			? "additions"
			: "none",
	);
	const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";

	let lastRole: string | null = null;
	let systemIndex = 0;
	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		// Some providers don't allow user messages directly after tool results
		// Insert a synthetic assistant message to bridge the gap
		if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && msg.role === "user") {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}
		if (msg.role === "system") {
			// transformMessages keeps system messages in order, so their position matches the transcript.
			const addedTools = systemIndex++ >= transcriptTools.foldedSystemMessages ? (msg.toolsAdded ?? []) : [];
			if (addedTools.length > 0) {
				const kimiToolMessage = {
					role: "system",
					tools: convertTools(addedTools, compat),
				};
				params.push(kimiToolMessage as unknown as ChatCompletionMessageParam);
			}
			const text = i === 0 ? getSystemMessageText(msg) : renderSystemMessageUpdate(msg);
			if (text.length > 0) {
				params.push({ role: instructionRole, content: sanitizeSurrogates(text) });
			}
		}
		else if (msg.role === "user") {
			if (typeof msg.content === "string") {
				params.push({
					role: "user",
					content: sanitizeSurrogates(msg.content),
				});
			}
			else {
				const content = msg.content
					.filter((item) => item.type !== "text" || item.text.length > 0)
					.map((item):
						| OpenAI.Chat.Completions.ChatCompletionContentPartText
						| OpenAI.Chat.Completions.ChatCompletionContentPartImage => {
						if (item.type === "text") {
							return {
								type: "text",
								text: sanitizeSurrogates(item.text),
							};
						}
						else {
							return {
								type: "image_url",
								image_url: {
									url: `data:${item.mimeType};base64,${item.data}`,
								},
							};
						}
					});
				if (content.length === 0)
					continue;
				params.push({
					role: "user",
					content,
				});
			}
		}
		else if (msg.role === "assistant") {
			// Some providers don't accept null content, use empty string instead
			const assistantMsg: AssistantChatMessage = {
				role: "assistant",
				content: compat.requiresAssistantAfterToolResult ? "" : null,
			};
			const assistantTextParts = msg.content
				.filter(isTextContentBlock)
				.filter((block) => block.text.trim().length > 0)
				.map((block): OpenAI.Chat.Completions.ChatCompletionContentPartText => ({
					type: "text",
					text: sanitizeSurrogates(block.text),
				}));
			const assistantText = assistantTextParts.map((part) => part.text).join("");
			const thinkingBlocks = msg.content.filter(isThinkingContentBlock);
			const toolCalls = msg.content.filter(isToolCallBlock);
			const signedReasoningDetails = thinkingBlocks
				.map((block) => parseOpenAIReasoningDetails(block.thinkingSignature))
				.find((details) => details !== undefined);
			const legacyReasoningDetails = toolCalls
				.map((toolCall) => parseLegacyEncryptedReasoningDetail(toolCall.thoughtSignature))
				.filter((detail) => detail !== undefined);
			const preservedReasoningDetails = signedReasoningDetails ??
				(legacyReasoningDetails.length > 0 ? legacyReasoningDetails : undefined);
			const nonEmptyThinkingBlocks = thinkingBlocks.filter((block) => block.thinking.trim().length > 0);
			if (nonEmptyThinkingBlocks.length > 0) {
				if (compat.requiresThinkingAsText) {
					// Convert thinking blocks to plain text (no tags to avoid model mimicking them)
					const thinkingText = nonEmptyThinkingBlocks
						.map((block) => sanitizeSurrogates(block.thinking))
						.join("\n\n");
					assistantMsg.content = [{ type: "text", text: thinkingText }, ...assistantTextParts];
				}
				else {
					// Always send assistant content as a plain string (OpenAI Chat Completions
					// API standard format). Sending as an array of {type:"text", text:"..."}
					// objects is non-standard and causes some models (e.g. DeepSeek V3.2 via
					// NVIDIA NIM) to mirror the content-block structure literally in their
					// output, producing recursive nesting like [{'type':'text','text':'[{...}]'}].
					if (assistantText.length > 0) {
						assistantMsg.content = assistantText;
					}
					// reasoning_details is the structured alternative to a raw reasoning field.
					if (!preservedReasoningDetails) {
						// Use the signature from the first thinking block if available (for llama.cpp server + gpt-oss)
						let signature = nonEmptyThinkingBlocks[0].thinkingSignature;
						if (model.provider === "opencode-go" && signature === "reasoning") {
							signature = "reasoning_content";
						}
						if (signature && isOpenAICompletionsReasoningField(signature)) {
							assistantMsg[signature] = nonEmptyThinkingBlocks.map((block) => block.thinking).join("\n");
						}
					}
				}
			}
			else if (assistantText.length > 0) {
				// Always send assistant content as a plain string (OpenAI Chat Completions
				// API standard format). Sending as an array of {type:"text", text:"..."}
				// objects is non-standard and causes some models (e.g. DeepSeek V3.2 via
				// NVIDIA NIM) to mirror the content-block structure literally in their
				// output, producing recursive nesting like [{'type':'text','text':'[{...}]'}].
				assistantMsg.content = assistantText;
			}
			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((tc): OpenAI.Chat.Completions.ChatCompletionMessageToolCall => {
					const customInputProperty = options?.grammarToolInputProperties?.get(tc.name);
					if (customInputProperty !== undefined) {
						return {
							id: tc.id,
							type: "custom",
							custom: {
								name: tc.name,
								input: sanitizeSurrogates(getGrammarToolInput(tc.name, tc.arguments, customInputProperty)),
							},
						} as OpenAI.Chat.Completions.ChatCompletionMessageToolCall;
					}
					return {
						id: tc.id,
						type: "function",
						function: {
							name: tc.name,
							arguments: JSON.stringify(tc.arguments),
						},
					};
				});
			}
			if (preservedReasoningDetails) {
				assistantMsg.reasoning_details = preservedReasoningDetails;
			}
			if (
				compat.requiresReasoningContentOnAssistantMessages &&
				model.reasoning &&
				assistantMsg.reasoning_content === undefined
			) {
				assistantMsg.reasoning_content = "";
			}
			// Skip assistant messages that have no content and no tool calls.
			// Some providers require "either content or tool_calls, but not none".
			// Other providers also don't accept empty assistant messages.
			// This handles aborted assistant responses that got no content.
			const content = assistantMsg.content;
			const hasContent =
				content !== null &&
				content !== undefined &&
				(typeof content === "string" ? content.length > 0 : content.length > 0);
			if (!hasContent && !assistantMsg.tool_calls) {
				continue;
			}
			params.push(assistantMsg);
		}
		else if (msg.role === "toolResult") {
			const imageBlocks: { type: "image_url"; image_url: { url: string } }[] = [];
			let j = i;
			for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
				const toolMsg = transformedMessages[j];
				if (toolMsg.role !== "toolResult")
					continue;
				// Extract text and image content
				const textResult = toolMsg.content
					.filter(isTextContentBlock)
					.map((block) => block.text)
					.join("\n");
				const hasImages = toolMsg.content.some((c) => c.type === "image");
				// Always send tool result with text (or placeholder if only images)
				const hasText = textResult.trim().length > 0;
				const toolResultText = hasText ? textResult : hasImages ? "(see attached image)" : "(no tool output)";
				// Some providers require the 'name' field in tool results
				const toolResultMsg: OpenAI.Chat.Completions.ChatCompletionToolMessageParam = {
					role: "tool",
					content: sanitizeSurrogates(toolResultText),
					tool_call_id: toolMsg.toolCallId,
				};
				if (compat.requiresToolResultName && toolMsg.toolName) {
					// The OpenAI SDK type omits `name` here, but some providers require it.
					(toolResultMsg as { name?: string }).name = toolMsg.toolName;
				}
				params.push(toolResultMsg);
				if (hasImages && model.input.includes("image")) {
					for (const block of toolMsg.content) {
						if (isImageContentBlock(block)) {
							imageBlocks.push({
								type: "image_url",
								image_url: {
									url: `data:${block.mimeType};base64,${block.data}`,
								},
							});
						}
					}
				}
			}
			i = j - 1;
			if (imageBlocks.length > 0) {
				if (compat.requiresAssistantAfterToolResult) {
					params.push({
						role: "assistant",
						content: "I have processed the tool results.",
					});
				}
				params.push({
					role: "user",
					content: [
						{
							type: "text",
							text: "Attached image(s) from tool result:",
						},
						...imageBlocks,
					],
				});
				lastRole = "user";
			}
			else {
				lastRole = "toolResult";
			}
			continue;
		}
		lastRole = msg.role;
	}
	return params;
}
