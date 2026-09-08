import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerSubagentCodeMode } from "../../src/extension/code-mode.ts";

const pi = { events: { on() {}, emit() {} } } as unknown as ExtensionAPI;
const parameters = Type.Object({ task: Type.String() });

describe("subagent Code Mode registration", () => {
	it("resolves Code Mode from Pi's separately managed user packages", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-code-mode-"));
		const packageDir = path.join(agentDir, "npm", "node_modules", "@howaboua", "pi-codex-conversion");
		fs.mkdirSync(packageDir, { recursive: true });
		fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
			name: "@howaboua/pi-codex-conversion", type: "module", exports: { "./code-mode": { import: "./code-mode.js" } },
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

	it("adapts the registered tool and unregisters it", async () => {
		const tool: ToolDefinition<typeof parameters, undefined> = {
			name: "subagent", label: "Subagent", description: "delegate", parameters,
			async execute() { return { content: [], details: undefined }; },
		};
		let adapted: unknown;
		let unregistered = false;
		const registered = registerSubagentCodeMode(pi, tool, async () => ({
			adaptToolForCodeMode(candidate: unknown, options: { usage: string }) {
				assert.equal(candidate, tool);
				assert.equal(options.usage, "await tools.subagent({...})");
				return candidate;
			},
			registerCodeModeExtensionTools(candidatePi: ExtensionAPI, provider: () => readonly unknown[]) {
				assert.equal(candidatePi, pi);
				[adapted] = provider();
				return { unregister() { unregistered = true; } };
			},
		}));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(adapted, tool);
		registered.unregister();
		assert.equal(unregistered, true);
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
