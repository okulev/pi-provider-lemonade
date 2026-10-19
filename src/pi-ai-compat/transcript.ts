/**
 * Fork-owned copy of the pi-ai transcript helpers that `convertMessages`
 * (src/pi-ai-compat/convert-messages.ts) needs.
 *
 * Provenance: @earendil-works/pi-ai 1.3.0, `dist/utils/transcript.js`
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
	const declared = new Set<string>();
	for (const message of messages) {
		if (!isSystemMessage(message))
			continue;
		if ((message.toolsRemoved?.length ?? 0) > 0)
			return true;
		for (const tool of message.toolsAdded ?? []) {
			if (declared.has(tool.name))
				return true;
			declared.add(tool.name);
		}
	}
	return false;
}

/**
 * Split tool declarations between the top-level request field and in-place additions.
 * Transports that can anchor additions at a system message keep the initial tools at the
 * top and load later ones where they appear; that only works when no tool was removed or
 * redeclared, so everything else sends the current tool list.
 */
export function resolveTranscriptTools(
	messages: Message[],
	supportsToolAdditions: boolean,
): { requestTools: Tool[]; anchorsAdditions: boolean } {
	const anchorsAdditions = supportsToolAdditions && !hasNonAdditiveToolChanges(messages);
	return {
		requestTools: anchorsAdditions
			? (getInitialSystemMessage(messages)?.toolsAdded ?? [])
			: getCurrentTools(messages),
		anchorsAdditions,
	};
}
