import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { registerSubagentCodeMode } from "../../src/extension/code-mode.ts";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

const pi = { events: { on() {}, emit() {} } } as unknown as ExtensionAPI;
const parameters = Type.Object({ task: Type.String() });

describe("subagent Code Mode registration", () => {
	it("resolves Code Mode from Pi's separately managed user packages", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-code-mode-"));
		const packageDir = path.join(agentDir, "npm", "node_modules", "@howaboua", "pi-codex-conversion");
		fs.mkdirSync(packageDir, { recursive: true });
		fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
			name: "@howaboua/pi-codex-conversion",
			type: "module",
			exports: { "./code-mode": { import: "./code-mode.js" } },
		}));
		fs.writeFileSync(path.join(packageDir, "code-mode.js"), `
			export function adaptToolForCodeMode(tool) { return tool; }
			export function registerCodeModeExtensionTools(pi, provider) {
				pi.events.emit("code-mode-registered", provider()[0]);
				return { unregister() {} };
			}
		`);
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const tool = { name: "subagent", label: "Subagent", description: "delegate", parameters, async execute() { return { content: [], details: undefined }; } };
			let resolveRegistered!: (value: unknown) => void;
			const registered = new Promise<unknown>((resolve) => { resolveRegistered = resolve; });
			const managedPi = { events: { on() {}, emit(event: string, value: unknown) { if (event === "code-mode-registered") resolveRegistered(value); } } } as unknown as ExtensionAPI;
			registerSubagentCodeMode(managedPi, tool);
			assert.equal(await Promise.race([registered, new Promise((resolve) => setTimeout(resolve, 1000))]), tool);
		} finally {
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("adapts the normal tool object and delegates structured input to its execute path", async () => {
		const signal = new AbortController().signal;
		const context = { cwd: "/tmp" };
		const updates: unknown[] = [];
		const result = { content: [{ type: "text" as const, text: "done" }], details: { mode: "single" } };
		let executeArgs: unknown[] | undefined;
		const tool: ToolDefinition<typeof parameters, { mode: string }> = {
			name: "subagent", label: "Subagent", description: "delegate", parameters,
			async execute(...args) { executeArgs = args; args[3]?.(result); return result; },
		};
		let adaptedTool: ToolDefinition<any, any, any> | undefined;
		let providerValue: unknown;
		let unregistered = false;
		const registration = { unregister() { unregistered = true; } };
		const registered = registerSubagentCodeMode(pi, tool, async () => ({
			adaptToolForCodeMode(candidate: ToolDefinition<any, any, any>, options: { usage: string }) {
				adaptedTool = candidate;
				assert.equal(options.usage, "await tools.subagent({...})");
				return { invoke: (input: unknown) => candidate.execute("code-mode-subagent", input, signal, (update) => updates.push(update), context as never) };
			},
			registerCodeModeExtensionTools(candidatePi: ExtensionAPI, provider: () => readonly unknown[]) {
				assert.equal(candidatePi, pi);
				[providerValue] = provider();
				return registration;
			},
		}));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(adaptedTool, tool);
		const invocationResult = await (providerValue as { invoke(input: unknown): Promise<unknown> }).invoke({ task: "review" });
		assert.equal(invocationResult, result);
		assert.deepEqual(executeArgs, ["code-mode-subagent", { task: "review" }, signal, executeArgs?.[3], context]);
		assert.deepEqual(updates, [result]);
		registered.unregister();
		assert.equal(unregistered, true);
	});

	it("skips absent and incompatible modules without hiding broken imports", async () => {
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (message) => warnings.push(String(message));
		try {
			const tool = { name: "subagent", label: "Subagent", description: "delegate", parameters, async execute() { return { content: [], details: undefined }; } };
			const absent = Object.assign(new Error("Cannot find package '@howaboua/pi-codex-conversion'"), { code: "ERR_MODULE_NOT_FOUND" });
			registerSubagentCodeMode(pi, tool, async () => { throw absent; });
			registerSubagentCodeMode(pi, tool, async () => ({}));
			const nested = Object.assign(new Error("Cannot find package 'broken-transitive-package'"), { code: "ERR_MODULE_NOT_FOUND" });
			registerSubagentCodeMode(pi, tool, async () => { throw nested; });
			const old = Object.assign(new Error("Package subpath './code-mode' is not defined by exports"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
			registerSubagentCodeMode(pi, tool, async () => { throw old; });
			const directory = Object.assign(new Error("Directory import '/node_modules/@howaboua/pi-codex-conversion/code-mode' is not supported"), { code: "ERR_UNSUPPORTED_DIR_IMPORT" });
			registerSubagentCodeMode(pi, tool, async () => { throw directory; });
			registerSubagentCodeMode(pi, tool, async () => ({
				adaptToolForCodeMode() { throw new Error("adapter failed"); },
				registerCodeModeExtensionTools() { return { unregister() {} }; },
			}));
			registerSubagentCodeMode(pi, tool, async () => ({
				adaptToolForCodeMode() { return {}; },
				registerCodeModeExtensionTools() { throw new Error("registration failed"); },
			}));
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			console.warn = originalWarn;
		}
		assert.deepEqual(warnings.sort(), [
			"[pi-subagents] Code Mode bridge skipped: pi-codex-conversion is not installed.",
			"[pi-subagents] Code Mode bridge skipped: pi-codex-conversion >=3.0.24 is required.",
			"[pi-subagents] Code Mode bridge skipped: pi-codex-conversion failed to load (Cannot find package 'broken-transitive-package').",
			"[pi-subagents] Code Mode bridge skipped: pi-codex-conversion >=3.0.24 is required.",
			"[pi-subagents] Code Mode bridge skipped: pi-codex-conversion >=3.0.24 is required.",
			"[pi-subagents] Code Mode bridge skipped: pi-codex-conversion failed to load (adapter failed).",
			"[pi-subagents] Code Mode bridge skipped: pi-codex-conversion failed to load (registration failed).",
		].sort());
	});

	it("unregisters a registration that resolves after cleanup", async () => {
		let resolveModule!: (module: unknown) => void;
		const loaded = new Promise<unknown>((resolve) => { resolveModule = resolve; });
		let unregisterCount = 0;
		const tool = { name: "subagent", label: "Subagent", description: "delegate", parameters, async execute() { return { content: [], details: undefined }; } };
		const registration = registerSubagentCodeMode(pi, tool, () => loaded);
		registration.unregister();
		resolveModule({
			adaptToolForCodeMode() { return {}; },
			registerCodeModeExtensionTools() { return { unregister() { unregisterCount += 1; } }; },
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(unregisterCount, 1);
	});
});
