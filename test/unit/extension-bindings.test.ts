import assert from "node:assert/strict";
import * as os from "node:os";
import { describe, it } from "node:test";
import { launchBindingDigest } from "../../src/shared/launch-contract.ts";
import {
	MAX_EXTENSION_BINDING_NAMESPACES,
	MAX_EXTENSION_BINDINGS_BYTES,
	PI_SUBAGENT_EXTENSION_BINDINGS_ENV,
	EXTENSION_BINDING_CONTEXT_KEY,
	createExtensionBindingContext,
	type ExtensionBindings,
	installExtensionBindingContext,
	normalizeExtensionBindings,
	omitExtensionBindingsEnv,
} from "../../src/runs/shared/extension-bindings.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";

function childEnv(extensionBindings?: ExtensionBindings, host: "parent" | "runner" = "runner"): Record<string, string | undefined> {
	const normalizedExtensionBindings = normalizeExtensionBindings(extensionBindings)?.value;
	const launch = buildInProcessChildLaunch({
		host,
		cwd: os.tmpdir(),
		childAgentName: "worker",
		childIndex: 0,
		sessionEnabled: false,
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		extensionBindings: normalizedExtensionBindings,
	});
	return launch.session.processEnv ?? {};
}

function childContext(extensionBindings?: ExtensionBindings, host: "parent" | "runner" = "parent") {
	const normalizedExtensionBindings = normalizeExtensionBindings(extensionBindings)?.value;
	return buildInProcessChildLaunch({
		host, cwd: os.tmpdir(), childAgentName: "worker", childIndex: 0, sessionEnabled: false,
		inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, extensionBindings: normalizedExtensionBindings,
	}).session.extensionBindingContext;
}

describe("extension bindings", () => {
	it("canonicalizes bounded namespaced JSON and isolates it from caller mutation", () => {
		const input = { "shepherd.dispatch/1": { writeScope: ["src/a.ts"], role: "coder" } };
		const normalized = normalizeExtensionBindings(input)!;
		assert.equal(normalized.json, '{"shepherd.dispatch/1":{"role":"coder","writeScope":["src/a.ts"]}}');
		input["shepherd.dispatch/1"].role = "reviewer";
		assert.equal(normalized.json.includes("reviewer"), false);
		assert.equal(Object.isFrozen(normalized.value), true);
	});

	it("rejects malformed, oversized, and unsafe values", () => {
		assert.throws(() => normalizeExtensionBindings({ invalid: true }), /namespace/);
		assert.throws(() => normalizeExtensionBindings(Object.fromEntries(Array.from({ length: MAX_EXTENSION_BINDING_NAMESPACES + 1 }, (_, index) => [`pkg${index}\/1`, true]))), /at most/);
		assert.throws(() => normalizeExtensionBindings({ "pkg/1": "x".repeat(MAX_EXTENSION_BINDINGS_BYTES) }), /maximum/);
		assert.throws(() => normalizeExtensionBindings({ "pkg/1": Number.NaN }), /finite/);
		const cyclic: Record<string, unknown> = { "pkg/1": {} };
		(cyclic["pkg/1"] as Record<string, unknown>).self = cyclic;
		assert.throws(() => normalizeExtensionBindings(cyclic), /cycles/);
		const accessor = Object.create(null) as Record<string, unknown>;
		Object.defineProperty(accessor, "pkg/1", { enumerable: true, get: () => true });
		assert.throws(() => normalizeExtensionBindings(accessor), /data property/);
	});

	it("uses request context for parent hosts and preserves runner environment transport", () => {
		const omitted = childEnv();
		assert.equal(Object.hasOwn(omitted, PI_SUBAGENT_EXTENSION_BINDINGS_ENV), true);
		assert.equal(omitted[PI_SUBAGENT_EXTENSION_BINDINGS_ENV], undefined);
		assert.equal(childEnv({ "child/1": { z: 1, a: 2 } })[PI_SUBAGENT_EXTENSION_BINDINGS_ENV], '{"child/1":{"a":2,"z":1}}');
		assert.deepEqual(childEnv({ "child/1": true }, "parent"), {});
		assert.deepEqual(childContext({ "child/1": { z: 1, a: 2 } }), { extensionBindingsJson: '{"child/1":{"a":2,"z":1}}', mcpDirectTools: "__none__" });
		assert.deepEqual(childContext(), { extensionBindingsJson: undefined, mcpDirectTools: "__none__" });
	});

	it("installs one frozen v1 context channel and isolates nested and sibling promises", async () => {
		const target = {};
		const channel = installExtensionBindingContext(target);
		const descriptor = Object.getOwnPropertyDescriptor(target, EXTENSION_BINDING_CONTEXT_KEY)!;
		assert.deepEqual({ enumerable: descriptor.enumerable, writable: descriptor.writable, configurable: descriptor.configurable }, { enumerable: false, writable: false, configurable: false });
		assert.equal(Object.isFrozen(channel), true);
		assert.deepEqual(Object.keys(channel).sort(), ["getStore", "run", "version"]);

		const first = createExtensionBindingContext("first", "a/tool");
		const second = createExtensionBindingContext(undefined, "");
		const observed = await Promise.all([
			channel.run(first, async () => {
				await Promise.resolve();
				const nested = await channel.run(second, async () => channel.getStore());
				return [channel.getStore(), nested] as const;
			}),
			channel.run(createExtensionBindingContext("second", undefined), async () => { await Promise.resolve(); return channel.getStore(); }),
		]);
		assert.equal(observed[0][0], first);
		assert.equal(observed[0][1], second);
		assert.equal(observed[1]?.extensionBindingsJson, "second");
		assert.equal(channel.getStore(), undefined);
		await assert.rejects(() => channel.run(first, async () => { throw new Error("expected"); }), /expected/);
		assert.equal(channel.getStore(), undefined);
	});

	it("fails closed on invalid existing channels without invoking accessors", () => {
		let invoked = false;
		const target = {};
		Object.defineProperty(target, EXTENSION_BINDING_CONTEXT_KEY, { enumerable: false, configurable: false, get() { invoked = true; return undefined; } });
		assert.throws(() => installExtensionBindingContext(target), /^Error: Invalid pi-subagents extension-binding context v1$/);
		assert.equal(invoked, false);
		const missing = {};
		Object.defineProperty(missing, EXTENSION_BINDING_CONTEXT_KEY, { value: undefined, enumerable: false, writable: false, configurable: false });
		assert.throws(() => installExtensionBindingContext(missing), /^Error: Invalid pi-subagents extension-binding context v1$/);
		const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("secret payload"); } });
		try {
			installExtensionBindingContext(hostile);
			assert.fail("expected invalid context");
		} catch (error) {
			assert.equal((error as Error).message, "Invalid pi-subagents extension-binding context v1");
			assert.equal(Object.hasOwn(error as object, "cause"), false);
			assert.equal(String(error).includes("secret payload"), false);
		}
		const spoofed = new Proxy({}, { getPrototypeOf() { throw new Error("Invalid pi-subagents extension-binding context v1", { cause: "secret payload" }); } });
		const spoofedTarget = {};
		Object.defineProperty(spoofedTarget, EXTENSION_BINDING_CONTEXT_KEY, { value: spoofed, enumerable: false, writable: false, configurable: false });
		try {
			installExtensionBindingContext(spoofedTarget);
			assert.fail("expected invalid context");
		} catch (error) {
			assert.equal(Object.hasOwn(error as object, "cause"), false);
		}
	});

	it("removes ambient bindings from external runner environments", () => {
		assert.deepEqual(omitExtensionBindingsEnv({ KEEP_ME: "yes", [PI_SUBAGENT_EXTENSION_BINDINGS_ENV]: "secret" }), { KEEP_ME: "yes" });
	});

	it("changes launch provenance only when the binding changes", () => {
		const base = { definitionDigest: "definition", task: "task", inheritProjectContext: false, inheritSkills: false };
		const omitted = launchBindingDigest(base);
		const first = launchBindingDigest({ ...base, extensionBindings: normalizeExtensionBindings({ "policy/1": { role: "coder" } })!.value });
		const second = launchBindingDigest({ ...base, extensionBindings: normalizeExtensionBindings({ "policy/1": { role: "reviewer" } })!.value });
		assert.notEqual(first, omitted);
		assert.notEqual(first, second);
	});
});
