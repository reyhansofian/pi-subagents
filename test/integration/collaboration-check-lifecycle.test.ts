import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { executeWorkflowHostCommand } from "../../src/workflows/host-command.ts";
import { collaborationSandboxTools } from "../../src/runs/shared/collaboration-launch.ts";
import { assertCollaborationQuiescent } from "../../src/runs/shared/collaboration-quiescence.ts";
import type { CollaborationNamespaceIdentity } from "../../src/runs/shared/collaboration-sandbox.ts";

it("confined check waits for durable initialization permit, rejects live namespace transfer, and drains on abort", { timeout: 20000 }, async () => {
	const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-check-ticket-")));
	const owned = path.join(workspace, "owned"); fs.mkdirSync(owned);
	const tools = collaborationSandboxTools(), node = fs.realpathSync.native(process.execPath);
	const marker = path.join(owned, "started");
	const script = 'require("fs").writeFileSync("owned/started","STARTED");setInterval(()=>{},1000);';
	const command = JSON.stringify(node) + " -e " + JSON.stringify(script);
	const makeSandbox = () => ({
		workspace, hostSocketIsolation: true, initializationToken: randomUUID(),
		namespaceRoot: fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-check-init-"))),
		readPaths: [], writePaths: [owned], runtimePaths: ["/nix/store", "/proc"],
		command: tools.shell, args: ["-c", 'read -r permit; [ "$permit" = PERMIT ] || exit 1; exec "$@"', "check-init", tools.shell, "-c", command],
		env: { PATH: process.env.PATH ?? "", HOME: owned, TMPDIR: owned }, tools,
	});
	const initializationFailure = executeWorkflowHostCommand({
		key: "startup-rejected", params: { kind: "command", command, timeoutMs: 3000 },
		cwd: workspace, defaultOutputPath: path.join(workspace, "startup-rejected.log"), signal: new AbortController().signal,
		sandbox: { ...makeSandbox(), tools: { ...tools, unshare: node } }, onSandboxInitialized() { throw new Error("Unexpected initialization"); },
	});
	await assert.rejects(initializationFailure, /quiescence-unproven/);
	assert.equal(fs.existsSync(marker), false);
	const failed = await executeWorkflowHostCommand({
		key: "durability-refused", params: { kind: "command", command, timeoutMs: 3000 },
		cwd: workspace, defaultOutputPath: path.join(workspace, "failed.log"), signal: new AbortController().signal,
		sandbox: makeSandbox(), onSandboxInitialized(identity) {
			assert.equal(fs.existsSync(marker), false, "No application check may precede the parent permit.");
			assert.throws(() => assertCollaborationQuiescent(identity), /still exists/);
			throw new Error("Synthetic durable initialization failure");
		},
	});
	assert.equal(failed.ok, false); assert.equal(fs.existsSync(marker), false);
	const controller = new AbortController();
	let observed: CollaborationNamespaceIdentity | undefined;
	const checking = executeWorkflowHostCommand({
		key: "durability-accepted", params: { kind: "command", command, timeoutMs: 10000 },
		cwd: workspace, defaultOutputPath: path.join(workspace, "accepted.log"), signal: controller.signal,
		sandbox: makeSandbox(), onSandboxInitialized(identity) {
			assert.equal(fs.existsSync(marker), false);
			observed = identity;
		},
	});
	const deadline = Date.now() + 5000;
	while (!fs.existsSync(marker)) {
		if (Date.now() > deadline) throw new Error("Actual confined check did not start.");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(observed); assert.throws(() => assertCollaborationQuiescent(observed), /still exists/);
	controller.abort();
	const ended = await checking;
	assert.equal(ended.state, "stopped");
	assertCollaborationQuiescent(observed);
});
