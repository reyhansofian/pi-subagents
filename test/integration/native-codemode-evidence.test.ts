import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createDefaultChildSessionFactory, createToolEvidenceCollector, type ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
import { findHostPeerPackageDir } from "../../src/runs/background/runner-aliases.ts";
import { extractChildWrittenOutput } from "../../src/runs/shared/single-output.ts";

const nativeTargets = [
	{ version: "0.99.2", env: "PI_SUBAGENTS_TEST_SDK_ROOT" },
	{ version: "1.0.0", env: "PI_SUBAGENTS_TEST_PI1_SDK_ROOT" },
] as const;

function verifySelectedHost(root: string, version: string): void {
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, version);
	const fixtureModules = fs.realpathSync(path.dirname(path.dirname(root))) + path.sep;
	for (const peer of ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "@earendil-works/chord", "typebox"]) {
		const selected = findHostPeerPackageDir(root, peer);
		assert.ok(selected && fs.realpathSync(selected).startsWith(fixtureModules), peer + " must belong to selected fixture");
		if (peer.startsWith("@earendil-works/")) assert.equal(JSON.parse(fs.readFileSync(path.join(selected, "package.json"), "utf8")).version, version, peer);
	}
}

for (const target of nativeTargets) test('Pi ' + target.version + ' child loads native codemode and emits attributed nested read', { skip: !process.env[target.env] && 'Set ' + target.env + ' to isolated Pi ' + target.version + ' package root', timeout: 30_000 }, async (t) => {
	const root = process.env[target.env]!;
	verifySelectedHost(root, target.version);
	const pi = await import(pathToFileURL(path.join(root, "dist/index.js")).href);
	const aiRoot = findHostPeerPackageDir(root, "@earendil-works/pi-ai");
	assert.ok(aiRoot, "pi-ai must belong to selected host");
	const ai = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-native-codemode-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = cwd;
	t.after(() => { if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; fs.rmSync(cwd, { recursive: true, force: true }); });
	fs.writeFileSync(path.join(cwd, "sample.txt"), "fixture\n");
	const faux = ai.fauxProvider({ provider: "native-evidence", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	faux.setResponses([
		ai.fauxAssistantMessage(ai.fauxToolCall("codemode", { code: "text(await tools.read({path: 'sample.txt'})); text(await tools.write({path: 'report.md', content: 'child report'}))" }), { stopReason: "toolUse" }),
		ai.fauxAssistantMessage("done"),
	]);
	const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
	const launch = {
		cwd, projectTrusted: true, storage: { kind: "memory" }, model: "native-evidence/local",
		tools: ["codemode", "read", "write"], extensionPaths: [], ambientExtensions: false,
		hooks: [{ name: "fixture-provider", factory: (api: any) => api.registerProvider(faux.provider) }],
		noSkills: true, noContextFiles: true, runtime: {},
	} as ChildSessionLaunch;
	const session = await factory.create(launch);
	t.after(async () => { await session.dispose(); await factory.dispose(); });
	const collector = createToolEvidenceCollector();
	const events: Array<Record<string, unknown>> = [];
	session.subscribe((event) => { collector.observe(event); if (event.type === "tool_execution_end") events.push(event); });
	await session.prompt("Read the fixture using codemode.");
	assert.ok(events.some((event) => event.toolName === "read" && typeof event.parentToolCallId === "string" && event.isError === false), JSON.stringify(events));
	assert.equal(collector.successfulNames().includes("read"), true);
	assert.ok(events.some((event) => event.toolName === "write" && typeof event.parentToolCallId === "string" && event.isError === false), JSON.stringify(events));
	assert.equal(extractChildWrittenOutput(session.messages, path.join(cwd, "report.md"), cwd), "child report", JSON.stringify({ events, messages: session.messages }));
});

test("Pi 0.87.1 child invokes direct read without claiming native codemode", { skip: !process.env.PI_SUBAGENTS_TEST_LEGACY_SDK_ROOT && "Set PI_SUBAGENTS_TEST_LEGACY_SDK_ROOT to isolated Pi 0.87.1 package root", timeout: 30_000 }, async (t) => {
	const root = process.env.PI_SUBAGENTS_TEST_LEGACY_SDK_ROOT!;
	verifySelectedHost(root, "0.87.1");
	const pi = await import(pathToFileURL(path.join(root, "dist/index.js")).href);
	const ai = await import(pathToFileURL(path.join(path.dirname(root), "pi-ai/dist/index.js")).href);
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, "0.87.1");
	assert.equal(typeof pi.createCodemodeExtension, "undefined");
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-legacy-direct-"));
	const prior = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = cwd;
	t.after(() => { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; fs.rmSync(cwd, { recursive: true, force: true }); });
	fs.writeFileSync(path.join(cwd, "sample.txt"), "fixture\n");
	const faux = ai.fauxProvider({ provider: "legacy-evidence", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("read", { path: "sample.txt" }), { stopReason: "toolUse" }), ai.fauxAssistantMessage("done")]);
	const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
	await assert.rejects(factory.create({ cwd, projectTrusted: true, storage: { kind: "memory" }, model: "legacy-evidence/local", tools: ["codemode"], extensionPaths: [], ambientExtensions: false, hooks: [{ name: "fixture-provider", factory: (api: any) => api.registerProvider(faux.provider) }], noSkills: true, noContextFiles: true, runtime: {} } as ChildSessionLaunch), /Pi host does not support native codemode/);
	const session = await factory.create({ cwd, projectTrusted: true, storage: { kind: "memory" }, model: "legacy-evidence/local", tools: ["read"], extensionPaths: [], ambientExtensions: false, hooks: [{ name: "fixture-provider", factory: (api: any) => api.registerProvider(faux.provider) }], noSkills: true, noContextFiles: true, runtime: {} } as ChildSessionLaunch);
	t.after(async () => { await session.dispose(); await factory.dispose(); });
	const collector = createToolEvidenceCollector();
	session.subscribe(collector.observe);
	await session.prompt("Read the fixture directly.");
	assert.ok(collector.successfulNames().includes("read"));
	assert.equal(collector.successfulNames().includes("codemode"), false);
});

for (const target of nativeTargets) test('Pi ' + target.version + ' child loads and invokes a generic explicitly selected extension', { skip: !process.env[target.env] && 'Set ' + target.env + ' to isolated Pi ' + target.version + ' package root', timeout: 30_000 }, async (t) => {
	const root = process.env[target.env]!;
	verifySelectedHost(root, target.version);
	const pi = await import(pathToFileURL(path.join(root, "dist/index.js")).href);
	const aiRoot = findHostPeerPackageDir(root, "@earendil-works/pi-ai");
	assert.ok(aiRoot, "pi-ai must belong to selected host");
	const ai = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-generic-extension-"));
	const prior = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = cwd;
	t.after(() => { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; fs.rmSync(cwd, { recursive: true, force: true }); });
	const extensionPath = path.join(cwd, "probe.mjs");
	fs.writeFileSync(extensionPath, 'export default function (pi) { pi.registerTool({ name: "probe", label: "Probe", description: "Synthetic probe", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "fixture-ok" }], details: {} }; } }); }');
	const faux = ai.fauxProvider({ provider: "generic-extension", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("probe", {}), { stopReason: "toolUse" }), ai.fauxAssistantMessage("done")]);
	const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
	const session = await factory.create({ cwd, projectTrusted: true, storage: { kind: "memory" }, model: "generic-extension/local", tools: ["probe"], extensionPaths: [extensionPath], ambientExtensions: false, hooks: [{ name: "fixture-provider", factory: (api: any) => api.registerProvider(faux.provider) }], noSkills: true, noContextFiles: true, runtime: {} } as ChildSessionLaunch);
	t.after(async () => { await session.dispose(); await factory.dispose(); });
	const collector = createToolEvidenceCollector();
	session.subscribe(collector.observe);
	await session.prompt("Invoke probe.");
	assert.deepEqual(collector.successfulNames(), ["probe"]);
	assert.ok(session.messages.some((message) => message.role === "toolResult" && message.toolName === "probe" && message.content.some((part) => part.type === "text" && part.text === "fixture-ok")));
});

for (const target of nativeTargets) test('Pi ' + target.version + ' untrusted child does not credit a blocked read', { skip: !process.env[target.env] && 'Set ' + target.env + ' to isolated Pi ' + target.version + ' package root', timeout: 30_000 }, async (t) => {
	const root = process.env[target.env]!;
	verifySelectedHost(root, target.version);
	const pi = await import(pathToFileURL(path.join(root, "dist/index.js")).href);
	const aiRoot = findHostPeerPackageDir(root, "@earendil-works/pi-ai");
	assert.ok(aiRoot, "pi-ai must belong to selected host");
	const ai = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-denied-read-"));
	const prior = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = cwd;
	t.after(() => { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; fs.rmSync(cwd, { recursive: true, force: true }); });
	fs.writeFileSync(path.join(cwd, "sample.txt"), "fixture\n");
	const faux = ai.fauxProvider({ provider: "denied-read", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("read", { path: "sample.txt" }), { stopReason: "toolUse" }), ai.fauxAssistantMessage("done")]);
	const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
	const session = await factory.create({ cwd, projectTrusted: false, storage: { kind: "memory" }, model: "denied-read/local", tools: ["read"], extensionPaths: [], ambientExtensions: false, hooks: [
		{ name: "fixture-provider", factory: (api: any) => api.registerProvider(faux.provider) },
		{ name: "deny-read", factory: (api: any) => api.on("tool_call", (event: any) => event.toolName === "read" ? { block: true, reason: "fixture denied" } : undefined) },
	], noSkills: true, noContextFiles: true, runtime: {} } as ChildSessionLaunch);
	t.after(async () => { await session.dispose(); await factory.dispose(); });
	const collector = createToolEvidenceCollector();
	const ends: Array<Record<string, unknown>> = [];
	session.subscribe((event) => { collector.observe(event); if (event.type === "tool_execution_end") ends.push(event); });
	await session.prompt("Read the fixture.");
	assert.ok(ends.some((event) => event.toolName === "read" && event.isError === true), JSON.stringify(ends));
	assert.deepEqual(collector.successfulNames(), []);
});
