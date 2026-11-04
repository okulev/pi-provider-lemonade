/**
 * Fork-owned copy of the pi-ai transcript helpers that `convertMessages`
 * (src/pi-ai-compat/convert-messages.ts) needs.
 *
 * Provenance: @earendil-works/pi-ai 1.5.0, `dist/utils/transcript.js`
 * (verbatim subset — only the functions in `convertMessages`' transitive
 * closure: resolveTranscript, resolveTranscriptTools and their callees;
 * createInitialSystemMessage/normalizeContext/getCurrentSystemPrompt/
 * toToolDeclaration/declarationsEqual/getToolStateChanges/getDeclaredTools/
 * hasToolRedefinitions are not part of the closure and are not copied).
 * `contentText` and `getSystemMessageText` are re-imported from the pi-ai
 * root entry instead of copied (root-exported). Owning this file lets pi-ai
 * live in `peerDependencies` (avoids the host-provided-packages warning).
 * Synced whenever the @earendil-works/pi-ai devDependency pin moves — the procedure lives in the repository's agent docs. Do not edit the logic here
 * except to mirror an upstream change.
 */
import {
	contentText,
	type Message,
	type SystemMessage,
	type Tool,
} from "@earendil-works/pi-ai";

function isSystemMessage(message: Message): message is SystemMessage {
	return message.role === "system";
}

/** Return the leading system message, if the transcript starts with one. */
export function getInitialSystemMessage(messages: Message[]): SystemMessage | undefined {
	const first = messages[0];
	return first && isSystemMessage(first) ? first : undefined;
}

/** Resolve the tools available after applying every transcript delta in order. */
export function getCurrentTools(messages: Message[]): Tool[] {
	const tools = new Map<string, Tool>();
	for (const message of messages) {
		if (!isSystemMessage(message))
			continue;
		for (const tool of message.toolsRemoved ?? [])
			tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? [])
			tools.set(tool.name, tool);
	}
	return [...tools.values()];
}

/**
 * Replay every system message into one leading system message holding the current
 * prompt and tools. Later `content` is appended to the base prompt, `sections` are
 * patched by name, and tools are resolved with {@link getCurrentTools}.
 */
export function getCurrentSystemMessage(messages: Message[]): SystemMessage | undefined {
	const content: string[] = [];
	const sections = new Map<string, string | null>();
	let timestamp: number | undefined;
	for (const message of messages) {
		if (!isSystemMessage(message))
			continue;
		timestamp ??= message.timestamp;
		const text = contentText(message.content);
		if (text.length > 0)
			content.push(text);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null)
				sections.delete(name);
			else
				sections.set(name, value);
		}
	}
	const tools = getCurrentTools(messages);
	if (timestamp === undefined && tools.length === 0)
		return undefined;
	return {
		role: "system",
		content: content.join("\n\n"),
		...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
		...(tools.length > 0 ? { toolsAdded: tools } : {}),
		timestamp: timestamp ?? 0,
	};
}

/**
 * Rebuild the transcript for APIs without mid-conversation system messages: the replayed
 * system message leads, and every later system message is dropped.
 */
export function collapseSystemMessages(context: { messages: Message[] }): { messages: Message[] } {
	const head = getCurrentSystemMessage(context.messages);
	const messages = context.messages.filter((message) => message.role !== "system");
	return { messages: head ? [head, ...messages] : messages };
}

/** Keep later system messages in place when the model accepts them; otherwise collapse them. */
export function resolveTranscript(
	context: { messages: Message[] },
	supportsMidConvoSystemMessages: boolean | undefined,
): { messages: Message[] } {
	return supportsMidConvoSystemMessages ? context : collapseSystemMessages(context);
}

/** Whether tool history contains a removal or same-name redeclaration that an addition-only transport cannot replay. */
export function hasNonAdditiveToolChanges(messages: Message[]): boolean {
	return findLastNonAdditiveToolChange(messages.filter(isSystemMessage)) >= 0;
}

/** Index of the last system message with a removal or same-name redeclaration, or -1. */
function findLastNonAdditiveToolChange(systemMessages: readonly SystemMessage[]): number {
	// A name declared before counts as a redeclaration even after its removal: Kimi K3 ignores a
	// removed tool that a later tool message declares again (verified October 2026).
	const declared = new Set<string>();
	let last = -1;
	for (let index = 0; index < systemMessages.length; index++) {
		const message = systemMessages[index];
		if ((message.toolsRemoved?.length ?? 0) > 0)
			last = index;
		for (const tool of message.toolsAdded ?? []) {
			if (declared.has(tool.name))
				last = index;
			declared.add(tool.name);
		}
	}
	return last;
}

/**
 * How a transport can express tool changes after the first request.
 *
 * - `"none"`: only the top-level tool list exists; it always holds the current tools.
 * - `"additions"`: tools can be added at a later message, but not removed or redefined.
 * - `"changes"`: every tool, including the initial ones, is declared in place, and a later
 *   declaration under the same name replaces the earlier one. Removals are not expressible on
 *   the wire, so the transport announces them as text and the removed tools stay declared.
 */
export type TranscriptToolSupport = "none" | "additions" | "changes";

export interface TranscriptTools {
	/** Tools sent in the top-level request field. */
	requestTools: Tool[];
	/**
	 * Number of leading system messages whose tool changes `requestTools` already holds. Every
	 * later system message carries its own tool changes in place.
	 */
	foldedSystemMessages: number;
}

/**
 * Split tool declarations between the top-level request field and in-place changes.
 *
 * With `"changes"`, the top-level list stays empty and every system message, including the
 * leading one, declares its tools in place: an in-place declaration can replace an earlier
 * in-place one, but not a top-level one. With `"additions"`, a removal or redefinition cannot be
 * expressed in place, so the top-level list becomes the tool state after the last such change;
 * later additions stay anchored, and the cached prefix is invalidated once per removal instead
 * of on every later addition. With `"none"`, the top-level list is the current tool set.
 */
export function resolveTranscriptTools(messages: Message[], support: TranscriptToolSupport): TranscriptTools {
	const systemMessages = messages.filter(isSystemMessage);
	if (support === "none") {
		return { requestTools: getCurrentTools(systemMessages), foldedSystemMessages: systemMessages.length };
	}
	if (support === "changes")
		return { requestTools: [], foldedSystemMessages: 0 };
	const folded = Math.max(
		getInitialSystemMessage(messages) ? 1 : 0,
		findLastNonAdditiveToolChange(systemMessages) + 1,
	);
	return { requestTools: getCurrentTools(systemMessages.slice(0, folded)), foldedSystemMessages: folded };
}
