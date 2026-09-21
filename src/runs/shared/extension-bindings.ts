import { AsyncLocalStorage } from "node:async_hooks";

export const PI_SUBAGENT_EXTENSION_BINDINGS_ENV = "PI_SUBAGENT_EXTENSION_BINDINGS";
export const EXTENSION_BINDING_CONTEXT_KEY = Symbol.for("pi-subagents.extension-binding-context.v1");
export const MAX_EXTENSION_BINDING_NAMESPACES = 16;
export const MAX_EXTENSION_BINDINGS_BYTES = 16 * 1024;
export const MAX_EXTENSION_BINDINGS_DEPTH = 16;
export const MAX_EXTENSION_BINDINGS_PROPERTIES = 256;

const EXTENSION_BINDING_NAMESPACE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62})\/[1-9][0-9]{0,8}$/;

export type ExtensionBindingJson = null | boolean | number | string | ReadonlyArray<ExtensionBindingJson> | { readonly [key: string]: ExtensionBindingJson };
export type ExtensionBindings = Readonly<Record<string, ExtensionBindingJson>>;

export interface NormalizedExtensionBindings {
	value: ExtensionBindings;
	json: string;
}

export interface ExtensionBindingContext {
	readonly extensionBindingsJson: string | undefined;
	readonly mcpDirectTools: string | undefined;
}

export interface ExtensionBindingContextChannel {
	readonly version: 1;
	run<T>(context: ExtensionBindingContext, callback: () => T): T;
	getStore(): ExtensionBindingContext | undefined;
}

const INVALID_CONTEXT = "Invalid pi-subagents extension-binding context v1";
const CONTEXT_KEYS = ["extensionBindingsJson", "mcpDirectTools"];
const CHANNEL_KEYS = ["getStore", "run", "version"];

function invalidContext(): Error {
	return new Error(INVALID_CONTEXT);
}

function exactFrozenDataObject(value: unknown, keys: string[]): Record<string, unknown> {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidContext();
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw invalidContext();
		if (!Object.isFrozen(value) || Object.getOwnPropertySymbols(value).length > 0) throw invalidContext();
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Object.keys(descriptors).sort().join("\0") !== keys.join("\0")) throw invalidContext();
		for (const key of keys) {
			const descriptor = descriptors[key]!;
			if (!descriptor.enumerable || !("value" in descriptor)) throw invalidContext();
		}
		return value as Record<string, unknown>;
	} catch {
		throw invalidContext();
	}
}

function validateContext(value: unknown): asserts value is ExtensionBindingContext {
	const context = exactFrozenDataObject(value, CONTEXT_KEYS);
	if ((context.extensionBindingsJson !== undefined && typeof context.extensionBindingsJson !== "string")
		|| (context.mcpDirectTools !== undefined && typeof context.mcpDirectTools !== "string")) throw invalidContext();
}

function validateChannel(value: unknown): asserts value is ExtensionBindingContextChannel {
	const channel = exactFrozenDataObject(value, CHANNEL_KEYS);
	if (channel.version !== 1 || typeof channel.run !== "function" || typeof channel.getStore !== "function") throw invalidContext();
}

export function createExtensionBindingContext(extensionBindingsJson: string | undefined, mcpDirectTools: string | undefined): ExtensionBindingContext {
	return Object.freeze({ extensionBindingsJson, mcpDirectTools });
}

export function installExtensionBindingContext(target: object = globalThis): ExtensionBindingContextChannel {
	let descriptor: PropertyDescriptor | undefined;
	try { descriptor = Object.getOwnPropertyDescriptor(target, EXTENSION_BINDING_CONTEXT_KEY); }
	catch { throw invalidContext(); }
	if (descriptor) {
		if (descriptor.enumerable || descriptor.configurable || !("value" in descriptor) || descriptor.writable) throw invalidContext();
		validateChannel(descriptor.value);
		return descriptor.value;
	}
	const storage = new AsyncLocalStorage<ExtensionBindingContext>();
	const channel: ExtensionBindingContextChannel = Object.freeze({
		version: 1,
		run<T>(context: ExtensionBindingContext, callback: () => T): T {
			validateContext(context);
			if (typeof callback !== "function") throw invalidContext();
			return storage.run(context, callback);
		},
		getStore: () => storage.getStore(),
	});
	try {
		Object.defineProperty(target, EXTENSION_BINDING_CONTEXT_KEY, { value: channel, enumerable: false, writable: false, configurable: false });
	} catch {
		throw invalidContext();
	}
	return channel;
}

const extensionBindingContextChannel = installExtensionBindingContext();

export function runWithExtensionBindingContext<T>(context: ExtensionBindingContext, callback: () => T): T {
	validateContext(context);
	return extensionBindingContextChannel.run(context, callback);
}

function canonicalizeJson(value: unknown, path: string, depth: number, seen: Set<object>, propertyCount: { value: number }): ExtensionBindingJson {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON numbers.`);
		return value;
	}
	if (typeof value !== "object") throw new Error(`${path} must contain only plain JSON values.`);
	if (depth > MAX_EXTENSION_BINDINGS_DEPTH) throw new Error(`${path} exceeds the maximum nesting depth of ${MAX_EXTENSION_BINDINGS_DEPTH}.`);
	if (seen.has(value)) throw new Error(`${path} must not contain cycles.`);
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const output: ExtensionBindingJson[] = [];
			for (let index = 0; index < value.length; index++) {
				if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(`${path} must not contain sparse arrays.`);
				output.push(canonicalizeJson(value[index], `${path}[${index}]`, depth + 1, seen, propertyCount));
			}
			return Object.freeze(output);
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must contain only plain JSON objects.`);
		if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${path} must not contain symbol keys.`);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const output: Record<string, ExtensionBindingJson> = {};
		for (const key of Object.keys(descriptors).sort()) {
			const descriptor = descriptors[key]!;
			if (!descriptor.enumerable || !("value" in descriptor)) throw new Error(`${path}.${key} must be an enumerable data property.`);
			propertyCount.value += 1;
			if (propertyCount.value > MAX_EXTENSION_BINDINGS_PROPERTIES) throw new Error(`extensionBindings exceeds ${MAX_EXTENSION_BINDINGS_PROPERTIES} total properties.`);
			Object.defineProperty(output, key, { value: canonicalizeJson(descriptor.value, `${path}.${key}`, depth + 1, seen, propertyCount), enumerable: true, writable: false, configurable: false });
		}
		return Object.freeze(output);
	} finally {
		seen.delete(value);
	}
}

export function normalizeExtensionBindings(input: unknown): NormalizedExtensionBindings | undefined {
	if (input === undefined) return undefined;
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("extensionBindings must be a plain JSON object.");
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) throw new Error("extensionBindings must be a plain JSON object.");
	const keys = Object.keys(input);
	if (keys.length > MAX_EXTENSION_BINDING_NAMESPACES) throw new Error(`extensionBindings supports at most ${MAX_EXTENSION_BINDING_NAMESPACES} namespaces.`);
	for (const key of keys) {
		if (!EXTENSION_BINDING_NAMESPACE.test(key)) throw new Error(`extensionBindings namespace '${key}' must use a package-like name followed by '/<positive-version>'.`);
	}
	const value = canonicalizeJson(input, "extensionBindings", 0, new Set(), { value: 0 }) as ExtensionBindings;
	const json = JSON.stringify(value);
	const bytes = Buffer.byteLength(json, "utf8");
	if (bytes > MAX_EXTENSION_BINDINGS_BYTES) throw new Error(`extensionBindings canonical JSON is ${bytes} bytes; maximum is ${MAX_EXTENSION_BINDINGS_BYTES}.`);
	return { value, json };
}

export function encodeExtensionBindings(input: ExtensionBindings | undefined): string | undefined {
	return input === undefined ? undefined : normalizeExtensionBindings(input)!.json;
}

export function omitExtensionBindingsEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const { [PI_SUBAGENT_EXTENSION_BINDINGS_ENV]: _extensionBindings, ...sanitized } = env;
	return sanitized;
}
