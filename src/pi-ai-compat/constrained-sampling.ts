/**
 * Fork-owned copy of the pi-ai constrained-sampling helpers that
 * `convertMessages`/`convertTools` (src/pi-ai-compat/convert-messages.ts)
 * need.
 *
 * Provenance: @earendil-works/pi-ai 1.3.0,
 * `dist/api/constrained-sampling.js` (verbatim subset — makeStrictJsonSchema
 * and its private closure, getJsonSchemaToolParameters, getGrammarToolInput,
 * resolveJsonSchemaStrictSampling, resolveGrammarConstrainedSampling and
 * inferGrammarInputProperty; appendGrammarToolInputJsonDelta and
 * createGrammarToolInputProperties are streaming-side and not in the convert
 * closure). Self-contained upstream: no pi-ai imports needed. Owning this
 * file lets pi-ai live in `peerDependencies` (avoids the
 * host-provided-packages warning). Synced by the pi-ai-compat-sync skill —
 * see .agents/skills/pi-ai-compat-sync/SKILL.md. Do not edit the logic here
 * except to mirror an upstream change.
 */
import type { Tool } from "@earendil-works/pi-ai";

/** Returns true when a provider's strict mode rejects this schema keyword with this value. */
export type UnsupportedStrictSchemaKeywordCheck = (key: string, value: unknown) => boolean;

export interface GrammarConstrainedSampling {
	format: "lark" | "regex";
	definition: string;
	inputProperty: string;
}

export function getGrammarToolInput(
	toolName: string,
	arguments_: Record<string, unknown>,
	inputProperty: string,
): string {
	const input = arguments_[inputProperty];
	if (typeof input !== "string") {
		throw new Error(`Grammar tool call "${toolName}" requires argument "${inputProperty}" to be a string.`);
	}
	return input;
}

class UnsupportedStrictJsonSchemaError extends Error {}

const UNSUPPORTED_STRICT_SCHEMA_KEYS = [
	"$ref",
	"$defs",
	"definitions",
	"allOf",
	"oneOf",
	"patternProperties",
	"dependentSchemas",
	"dependencies",
	"unevaluatedProperties",
	"propertyNames",
	"contains",
	"prefixItems",
	"not",
	"if",
	"then",
	"else",
];

// JSON Schema node shape used by the strict-mode walker. Tool parameter
// schemas arrive as `Record<string, unknown>`-style objects; the walker only
// ever reads/writes the keys below.
type SchemaNode = Record<string, unknown> & {
	type?: unknown;
	properties?: unknown;
	items?: unknown;
	anyOf?: unknown;
	required?: unknown;
	additionalProperties?: unknown;
	const?: unknown;
	enum?: unknown;
};

function isJsonSchemaObject(value: unknown): value is SchemaNode {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStructuredSchema(schema: unknown): boolean {
	if (!isJsonSchemaObject(schema))
		return false;
	const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
	return (
		(types as unknown[]).includes("object") ||
		(types as unknown[]).includes("array") ||
		schema.properties !== undefined ||
		schema.items !== undefined
	);
}

function schemaAllowsNull(schema: unknown): boolean {
	if (!isJsonSchemaObject(schema))
		return false;
	if (schema.type === "null" || (Array.isArray(schema.type) && (schema.type as unknown[]).includes("null")))
		return true;
	if (schema.const === null || (Array.isArray(schema.enum) && (schema.enum as unknown[]).includes(null)))
		return true;
	return Array.isArray(schema.anyOf) && (schema.anyOf as unknown[]).some((variant) => schemaAllowsNull(variant));
}

function makeJsonSchemaNodeStrict(schema: SchemaNode, isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck): void {
	if (!isJsonSchemaObject(schema)) {
		throw new UnsupportedStrictJsonSchemaError("boolean schemas are unsupported");
	}
	for (const key of UNSUPPORTED_STRICT_SCHEMA_KEYS) {
		if (schema[key] !== undefined) {
			throw new UnsupportedStrictJsonSchemaError(`${key} schemas are unsupported`);
		}
	}
	if (isUnsupportedKeyword) {
		for (const [key, value] of Object.entries(schema)) {
			if (isUnsupportedKeyword(key, value)) {
				throw new UnsupportedStrictJsonSchemaError(`${key}: ${JSON.stringify(value)} is unsupported`);
			}
		}
	}
	if (schema.anyOf !== undefined) {
		if (!Array.isArray(schema.anyOf) || (schema.anyOf as unknown[]).length === 0) {
			throw new UnsupportedStrictJsonSchemaError("anyOf must contain at least one schema");
		}
		for (const variant of schema.anyOf as unknown[]) {
			if (isStructuredSchema(variant)) {
				throw new UnsupportedStrictJsonSchemaError("object and array unions are unsupported");
			}
			makeJsonSchemaNodeStrict(variant as SchemaNode, isUnsupportedKeyword);
		}
	}
	if (schema.items !== undefined) {
		if (Array.isArray(schema.items)) {
			throw new UnsupportedStrictJsonSchemaError("tuple schemas are unsupported");
		}
		makeJsonSchemaNodeStrict(schema.items as SchemaNode, isUnsupportedKeyword);
	}
	const isObjectSchema = schema.type === "object";
	if (schema.properties !== undefined && !isObjectSchema) {
		throw new UnsupportedStrictJsonSchemaError("properties require type object");
	}
	if (!isObjectSchema)
		return;
	if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
		throw new UnsupportedStrictJsonSchemaError("schema-valued or true additionalProperties is unsupported");
	}
	if (schema.properties !== undefined && !isJsonSchemaObject(schema.properties)) {
		throw new UnsupportedStrictJsonSchemaError("object properties must be a schema map");
	}
	if (
		schema.required !== undefined &&
		(!Array.isArray(schema.required) || (schema.required as unknown[]).some((key) => typeof key !== "string"))
	) {
		throw new UnsupportedStrictJsonSchemaError("object required must be a string array");
	}
	const properties = (schema.properties ?? {}) as Record<string, SchemaNode>;
	const propertyNames = Object.keys(properties);
	const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
	if ([...required].some((key) => !propertyNames.includes(key))) {
		throw new UnsupportedStrictJsonSchemaError("required contains an unknown property");
	}
	for (const [key, property] of Object.entries(properties)) {
		makeJsonSchemaNodeStrict(property, isUnsupportedKeyword);
		if (!required.has(key) && !schemaAllowsNull(property)) {
			properties[key] = { anyOf: [property, { type: "null" }] };
		}
	}
	schema.required = propertyNames;
	schema.additionalProperties = false;
}

/** Convert a tool schema to the strict subset expected by provider constrained sampling. */
export function makeStrictJsonSchema(
	schema: Tool["parameters"],
	isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck,
): Record<string, unknown> {
	const cloned = structuredClone(schema) as unknown;
	if (!isJsonSchemaObject(cloned)) {
		throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
	}
	makeJsonSchemaNodeStrict(cloned, isUnsupportedKeyword);
	if (cloned.type !== "object") {
		throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
	}
	return cloned;
}

export function getJsonSchemaToolParameters(tool: Tool, strict: boolean | undefined): Tool["parameters"] {
	return strict === true ? (makeStrictJsonSchema(tool.parameters) as Tool["parameters"]) : tool.parameters;
}

function inferGrammarInputProperty(tool: Tool): string {
	const schema = tool.parameters as SchemaNode;
	if (schema.type !== "object") {
		throw new Error("grammar constrained sampling requires an object parameter schema");
	}
	if (
		!Array.isArray(schema.required) ||
		schema.required.length !== 1 ||
		typeof schema.required[0] !== "string"
	) {
		throw new Error("grammar constrained sampling requires exactly one required string property");
	}
	const inputProperty = schema.required[0];
	const properties = schema.properties as Record<string, SchemaNode> | undefined;
	if (!properties?.[inputProperty]) {
		throw new Error(`grammar constrained sampling requires a properties entry for ${inputProperty}`);
	}
	if (properties[inputProperty]?.type !== "string") {
		throw new Error(`grammar constrained sampling property ${inputProperty} must have type string`);
	}
	return inputProperty;
}

/**
 * Decide whether a JSON-schema tool is sent in strict mode. `isUnsupportedKeyword` lets a provider
 * reject extra keywords its strict mode does not accept, so "prefer" tools fall back to non-strict.
 */
export function resolveJsonSchemaStrictSampling(
	tool: Tool,
	supportsStrictMode: boolean,
	isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck,
): boolean | undefined {
	const config = tool.constrainedSampling;
	if (!config || config.type !== "json_schema")
		return undefined;
	if (supportsStrictMode) {
		try {
			makeStrictJsonSchema(tool.parameters, isUnsupportedKeyword);
			return true;
		}
		catch (error) {
			if (!(error instanceof UnsupportedStrictJsonSchemaError))
				throw error;
			if (config.strict !== "require")
				return undefined;
			throw new Error(`Tool "${tool.name}" requires JSON-schema constrained sampling, but ${error.message}.`);
		}
	}
	if (config.strict === "require") {
		throw new Error(`Tool "${tool.name}" requires JSON-schema constrained sampling, but strict tools are unsupported.`);
	}
	return undefined;
}

export function resolveGrammarConstrainedSampling(
	tool: Tool,
	supportsOpenAIGrammarTools: boolean,
): GrammarConstrainedSampling | undefined {
	const config = tool.constrainedSampling;
	if (!config || config.type !== "grammar") {
		return undefined;
	}
	if (!supportsOpenAIGrammarTools) {
		return undefined;
	}
	const larkDefinition = config.variants.openai_lark;
	const regexDefinition = config.variants.openai_regex;
	const hasLarkDefinition = typeof larkDefinition === "string" && larkDefinition.trim().length > 0;
	const hasRegexDefinition = typeof regexDefinition === "string" && regexDefinition.trim().length > 0;
	if (!hasLarkDefinition && !hasRegexDefinition) {
		throw new Error(`Tool "${tool.name}" cannot use grammar constrained sampling: no supported grammar variant was provided.`);
	}
	try {
		return {
			format: hasLarkDefinition ? "lark" : "regex",
			definition: (hasLarkDefinition ? larkDefinition : regexDefinition) as string,
			inputProperty: inferGrammarInputProperty(tool),
		};
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Tool "${tool.name}" cannot use grammar constrained sampling: ${message}.`);
	}
}
