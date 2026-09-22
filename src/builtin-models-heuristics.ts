/**
 * Id-based compat heuristics for Lemonade's **builtin** models.
 *
 * Derived from the builtin-model ground-truth analysis (fetched chat
 * templates for every builtin model; see the dev-only heuristics report in
 * this repository). Lemonade does not expose the chat template through its
 * API (`/api/show` hard-codes `template: ""`; lemonade-sdk/lemonade#3644
 * requests template exposure), so the model id is the best available signal
 * for which wire mechanism the model's template consumes.
 *
 * This module is deliberately separate from the core discovery/mapping logic
 * in `index.ts`: the rules are best-effort, cover only the builtin models
 * catalog, and can misfire on a user model that shares an id pattern but
 * uses a different template. `models.json` `compat` overrides always win.
 *
 * Vision is intentionally **not** heurised here: the `vision` capability
 * from `/api/show` is the only trustworthy signal (a user model with a
 * builtin-like id may have no `mmproj` companion).
 */
import type {
	ChatTemplateKwargValue,
	OpenAICompletionsCompat,
	ThinkingLevelMap,
} from "@earendil-works/pi-ai";

/** Compat hints for one builtin model id (or `undefined` — see below). */
export interface BuiltinModelsCompatHints {
	/**
	 * `compat.thinkingFormat` for the id's family. `undefined` means the
	 * default `openai` format applies — correct for gpt-oss (its templates
	 * read `reasoning_effort`, which llama.cpp handles natively) and inert
	 * for the always-on families (Bonsai, Jan, Muse-Glimmer,
	 * Phi-4-mini-reasoning), whose templates emit static `\n` tags
	 * or take a system-prompt directive no pi format covers.
	 */
	thinkingFormat?: OpenAICompletionsCompat["thinkingFormat"];
	/**
	 * `compat.chatTemplateKwargs` for families whose templates read a
	 * non-standard kwarg. Currently only LFM2.5 (boolean `thinking`).
	 */
	chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>;
}

/**
 * Builtin-model compat hints for a model id.
 *
 * Every rule is verified against the fetched template of at least one
 * member of its family (lemonade main @ 25a73ab, 2026-09-22):
 *
 * - `qwen` — Qwen3.8: its template reads the `enable_thinking` kwarg
 *   **and** a strict `reasoning_effort` enum (`xhigh`/`medium`/`low`,
 *   `high`→`xhigh`). Thinking defaults ON, so the `qwen` format is safe
 *   here despite the server stripping a top-level `enable_thinking: true`
 *   (the template falls back to ON); OFF is handled by the server's
 *   disable path, and the mapped `reasoning_effort` reaches llama.cpp
 *   natively (the same wire path gpt-oss uses).
 * - `deepseek` — DeepSeek-R1-Distill: static `\n` always-on; the
 *   payload is inert but consistent.
 * - `qwen-chat-template` — templates that read the `enable_thinking`
 *   jinja kwarg: Qwen3/3.5/3.6 (all recipes), MiniCPM 4.1/5/V-4.5+/
 *   o-4.5, GLM-4.5/4.7, Nemotron-3, Ornith-1.5 (Qwen3.5-based — no
 *   "qwen" in the id), DeepSeek-V4 (defaults to thinking OFF),
 *   PromptBridge, SmolLM3, Cogito-v2, and Gemma-4 (`gemma-4`/`gemma4`
 *   — the canonical template reads the kwarg in both directions and
 *   injects `<|think|>` itself when enabled). Gemma-3 is excluded (its
 *   `/think` prompt tokens have no kwarg equivalent). Works for both ON
 *   and OFF on llama.cpp and vLLM: Lemonade's server-side thinking
 *   normalization strips a top-level `enable_thinking: true`, so the
 *   `qwen` format cannot turn thinking on.
 * - `chat-template` + kwargs — LFM2.5 reads a boolean `thinking` kwarg;
 *   Muse-Glimmer reads a free-form `reasoning_strength` string (rendered
 *   into the system prompt as `Reasoning strength: <value>.`), resolved
 *   from the selected thinking level via `$var: "thinking.effort"` and
 *   omitted when thinking is off (the model is always-on — the strength
 *   is the only control it has).
 */
export function builtinModelsCompatHints(id: string): BuiltinModelsCompatHints | undefined {
	const n = id.toLowerCase();
	if (/deepseek-r1/.test(n)) return { thinkingFormat: "deepseek" };
	if (/qwen3\.8/.test(n)) return { thinkingFormat: "qwen" };
	if (
		/qwen|minicpm|nemotron|promptbridge|smollm3|ornith|deepseek-v4|gemma-?4|cogito/.test(
			n,
		) ||
		/glm-4\.[57]/.test(n)
	) {
		return { thinkingFormat: "qwen-chat-template" };
	}
	if (/^lfm2\.5(-| )/.test(n)) {
		return {
			thinkingFormat: "chat-template",
			chatTemplateKwargs: { thinking: { $var: "thinking.enabled" } },
		};
	}
	if (/muse-glimmer/.test(n)) {
		return {
			thinkingFormat: "chat-template",
			chatTemplateKwargs: {
				reasoning_strength: { $var: "thinking.effort", omitWhenOff: true },
			},
		};
	}
	return undefined;
}

/**
 * Per-model `thinkingLevelMap` for builtin models whose templates accept
 * graded thinking effort (see the heuristics report, section 10).
 * Returns `undefined` for every other id — the caller keeps the
 * restricted `{ off, medium }` default.
 *
 * - Qwen3.8 — strict enum `xhigh`/`medium`/`low` (`high` is an alias for
 *   `xhigh`, anything else raises a template exception): the accepted
 *   range is exposed as-is — `low`/`medium`/`xhigh`; `minimal` is hidden
 *   (it would be a duplicate of `low`) and `high` is hidden (a duplicate
 *   of `xhigh`). * - gpt-oss — `reasoning_effort` is a free-form string the template
 *   renders verbatim (trained on the OpenAI-style levels): the full
 *   `none`/`minimal`/`low`/`medium`/`high` range, `xhigh` hidden.
 * - Muse-Glimmer — `reasoning_strength` is a free-form string (default
 *   `high`): the same range as gpt-oss, delivered through
 *   `chatTemplateKwargs` (see `builtinModelsCompatHints`).
 */
export function builtinModelsThinkingLevelMap(id: string): ThinkingLevelMap | undefined {
	const n = id.toLowerCase();
	if (/qwen3\.8/.test(n)) {
		return {
			off: "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: null,
			xhigh: "xhigh",
		};
	}
	if (/gpt-oss/.test(n) || /muse-glimmer/.test(n)) {
		return {
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
		};
	}
	return undefined;
}

/**
 * Whether the id belongs to a family of builtin models with a
 * **verified working thinking toggle** (a template kwarg the
 * server/backend can set).
 *
 * Stricter than the format rules above, because it drives `reasoning`
 * detection in `toModel`: a false positive would show a thinking
 * selector that does nothing. Deliberately excluded (no toggle — the
 * selector would be dead):
 *
 * - Qwen3 Instruct-2507 / Coder / Next / VL — non-thinking only
 * - Qwen2.5 and older — no thinking
 * - MiniCPM3 / 4-8B / V-4 / o-2.6 — no kwarg in the template
 * - DeepSeek-R1-Distill — static always-on
 * - Bonsai, Jan, Muse-Glimmer, Phi-4-mini-reasoning — static always-on
 * - gpt-oss — the GGUF variants are catalog-labelled; the ONNX variant's
 *   backend does no thinking handling
 *
 * All included families are verified in the fetched template of at least
 * one member (lemonade main @ 25a73ab, 2026-09-22). The catalog labels
 * only some of these as `reasoning` (mostly the GGUF variants of
 * families whose vLLM variants are labelled), so this recovers the rest.
 */
export function isBuiltinModelsThinkingFamily(id: string): boolean {
	const n = id.toLowerCase();
	return (
		/qwen3-(?!coder|next|vl|.*instruct-2507)/.test(n) ||
		/qwen3\.[5-9]/.test(n) ||
		/deepseek-v4/.test(n) ||
		/minicpm(4\.1|5|[-_ ]?v-4\.[56]|-o-4\.5)/.test(n) ||
		/glm-4\.[57]/.test(n) ||
		/nemotron-3/.test(n) ||
		/^lfm2\.5(-| )/.test(n) ||
		/promptbridge/.test(n) ||
		/smollm3/.test(n) ||
		/ornith/.test(n) ||
		/gemma-?4/.test(n) ||
		/cogito/.test(n)
	);
}
