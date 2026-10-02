// Packed npm extension -> real detached runner -> isolated synthetic SDK session.
// node test/smoke/npm-detached-host.mjs INSTALLED_EXTENSION PI_PACKAGE_ROOT FRESH_ROOT failure|success
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const [installed, host, root, expectation] = process.argv.slice(2);
assert.ok(installed && host && root && ["failure", "success"].includes(expectation));
assert.ok(installed.includes(path.sep + "node_modules" + path.sep));
assert.equal(fs.existsSync(root), false, "use a fresh isolated fixture root");
fs.mkdirSync(root, { recursive: true });
for (const dir of ["home", "agent", "work", "sessions", "tmp"]) fs.mkdirSync(path.join(root, dir));
fs.writeFileSync(path.join(root, "work/sample.txt"), "fixture read succeeded\n");
const require = createRequire(path.join(installed, "package.json"));
const { createJiti } = await import(pathToFileURL(path.join(path.dirname(require.resolve("jiti/package.json")), "lib/jiti.mjs")).href);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { resolveHostPeerAliases, findHostPeerPackageDir } = await jiti.import(path.join(installed, "src/runs/background/runner-aliases.js"));
const manifest = JSON.parse(fs.readFileSync(path.join(host, "package.json"), "utf8"));
assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
assert.equal(manifest.version, "1.0.0");
for (const peer of ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "@earendil-works/chord", "typebox"]) {
	const selected = findHostPeerPackageDir(host, peer);
	assert.ok(selected && fs.realpathSync(selected).startsWith(fs.realpathSync(path.dirname(path.dirname(host))) + path.sep), peer);
}
const aliases = resolveHostPeerAliases(host);
assert.deepEqual(aliases.missing, expectation === "failure" ? ["@earendil-works/pi-agent-core/node"] : []);
assert.equal(aliases.aliases["@earendil-works/pi-agent-core/node"], undefined);
const lifecycle = path.join(root, "lifecycle.jsonl");
const provider = path.join(root, "provider.mjs");
fs.writeFileSync(provider, 'import fs from "node:fs";\n' +
  'import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";\n' +
  'import { SessionManager } from "@earendil-works/pi-coding-agent";\n' +
  'export default function register(pi) {\n' +
  ' const faux = fauxProvider({ provider: "isolated-detached", models: [{ id: "local" }], tokensPerSecond: 100000 });\n' +
  ' faux.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "sample.txt" }), { stopReason: "toolUse" }), fauxAssistantMessage("detached read completed")]);\n' +
  ' pi.registerProvider(faux.provider);\n' +
  ' pi.on("session_start", (_event, ctx) => { if (!(ctx.sessionManager instanceof SessionManager)) throw Error("host SDK identity mismatch"); fs.appendFileSync(' + JSON.stringify(lifecycle) + ', JSON.stringify({ event: "start", pid: process.pid, identity: true }) + "\\n"); });\n' +
  ' pi.on("session_shutdown", () => fs.appendFileSync(' + JSON.stringify(lifecycle) + ', JSON.stringify({ event: "shutdown", pid: process.pid, calls: faux.state.callCount }) + "\\n"));\n' +
  '}\n');
// Host selection precedes the compiled module's first import. The caller must launch
// with a clean environment and explicit isolated HOME, PI_CODING_AGENT_DIR and TMPDIR.
assert.equal(process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT, host);
assert.equal(process.env.PI_CODING_AGENT_DIR, path.join(root, "agent"));
assert.equal(process.env.HOME, path.join(root, "home"));
assert.equal(process.env.TMPDIR, path.join(root, "tmp"));
process.env.JITI_ALIAS = JSON.stringify(aliases.aliases);
const hostJiti = createJiti(import.meta.url, { fsCache: false, alias: aliases.aliases });
const { executeAsyncSingle } = await hostJiti.import(path.join(installed, "src/runs/background/async-execution.js"));
const launch = await executeAsyncSingle("pi-1-host-smoke", {
	agent: "worker", task: "Read sample.txt with the read tool.",
	agentConfig: { name: "worker", description: "isolated SDK probe", model: "isolated-detached/local", tools: ["read"], extensions: [provider], systemPrompt: "", systemPromptMode: "replace", inheritGlobalContext: false, inheritProjectContext: false, inheritSkills: false },
	ctx: { pi: { events: { emit() {} } }, cwd: path.join(root, "work"), currentSessionId: "isolated-parent", projectTrusted: true },
	artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
	shareEnabled: false, sessionRoot: path.join(root, "sessions"), maxSubagentDepth: 1, acceptance: false, timeoutMs: 25000,
});
fs.writeFileSync(path.join(root, "launch.json"), JSON.stringify(launch, null, 2));
if (expectation === "failure") {
	assert.equal(launch.isError, true);
	assert.match(launch.content[0].text, /does not provide @earendil-works\/pi-agent-core\/node/);
	assert.equal(fs.existsSync(lifecycle), false, "no SDK child should start on alias failure");
	console.log("PASS real Pi 1.0 packed detached pre-fix alias failure");
} else {
	assert.notEqual(launch.isError, true, JSON.stringify(launch));
	const dir = launch.details.asyncDir;
	const deadline = Date.now() + 35000;
	let status;
	do {
		status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
		if (["complete", "failed", "stopped"].includes(status.state)) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	fs.writeFileSync(path.join(root, "final-status.json"), JSON.stringify(status, null, 2));
	assert.equal(status.state, "complete", JSON.stringify(status));
	const events = fs.readFileSync(lifecycle, "utf8").trim().split("\n").map(JSON.parse);
	assert.deepEqual(events.map((event) => event.event), ["start", "shutdown"]);
	assert.equal(events[0].identity, true);
	assert.equal(events[1].calls, 2);
	assert.ok(status.steps[0].recentTools.some((entry) => entry.tool === "read" && entry.args === "sample.txt"));
	assert.match(fs.readFileSync(status.outputFile, "utf8"), /detached read completed/);
	const terminal = path.join(dir, "process-terminal.json");
	while (Date.now() < deadline && (!fs.existsSync(terminal) || JSON.parse(fs.readFileSync(terminal, "utf8")).state !== "observed")) await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(JSON.parse(fs.readFileSync(terminal, "utf8")).state, "observed");
	console.log("PASS real Pi 1.0 packed detached read, settlement, host identity and observed cleanup");
}
