/**
 * Fork-owned copy of the pi-ai simple-options helpers the fork's request
 * builder needs.
 *
 * Provenance: @earendil-works/pi-ai 1.3.0, `dist/api/simple-options.js`
 * (verbatim subset — resolveSamplingParams and clampMaxTokensToContext plus
 * their constants; buildBaseOptions, the thinking-budget helpers and
 * adjustMaxTokensForThinking are not used by the fork and are not copied).
 * `clampThinkingLevel` is re-imported from the pi-ai root entry
 * (root-exported); `estimateContextTokens` comes from the sibling copy
 * ./estimate.ts. Owning this file lets pi-ai live in `peerDependencies`
 * (avoids the host-provided-packages warning). Synced whenever the
 * @earendil-works/pi-ai devDependency pin moves — the
 * procedure lives in the repository's agent docs.
 * Do not edit the logic here except to mirror an upstream change.
 */
import {
	clampThinkingLevel,
	type Message,
	type Model,
	type ModelThinkingLevel,
	type SamplingParams,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { estimateContextTokens } from "./estimate.ts";

const CONTEXT_SAFETY_TOKENS = 4096;
const MIN_MAX_TOKENS = 1;

export function clampMaxTokensToContext(
	model: Model<"openai-completions">,
	context: TranscriptContext | readonly Message[],
	maxTokens: number,
): number {
	if (model.contextWindow <= 0)
		return Math.max(MIN_MAX_TOKENS, maxTokens);
	const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
	return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}

export function resolveSamplingParams(
	model: Model<"openai-completions">,
	thinkingLevel: ModelThinkingLevel,
	requestParams?: SamplingParams,
): SamplingParams | undefined {
	const effectiveThinkingLevel = clampThinkingLevel(model, thinkingLevel);
	const thinkingLevelParams = model.samplingParamsByThinkingLevel?.[effectiveThinkingLevel];
	return model.samplingParams || thinkingLevelParams || requestParams
		? { ...model.samplingParams, ...thinkingLevelParams, ...requestParams }
		: undefined;
}
