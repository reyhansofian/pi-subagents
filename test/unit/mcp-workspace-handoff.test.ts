import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { resolvePiLaunchToolPlan } from "../../src/runs/shared/child-tool-plan.ts";
import { SERENA_READ_TOOLS } from "../../src/runs/shared/mcp-workspace-handoff.ts";

function fixture() {
	const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-serena-handoff-")));
	const receiptPath = path.join(workspace, ".pi", "mcp-handoffs", "serena.json");
	fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
	const receipt = {
		version: 1,
		workspace,
		leaseId: "a".repeat(64),
		bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
		observedAtMs: Date.now(),
		definition: { url: "http://127.0.0.1:32123/mcp", includeTools: [...SERENA_READ_TOOLS], exposeResources: false, lifecycle: "eager" },
		tools: SERENA_READ_TOOLS.map(name => ({ name, description: name, inputSchema: { type: "object" } })),
	};
	const bytes = JSON.stringify(receipt);
	fs.writeFileSync(receiptPath, bytes);
	return { workspace, receiptPath, binding: { "pi-mcp-adapter/1": { path: receiptPath, sha256: createHash("sha256").update(bytes).digest("hex") } } } as const;
}

describe("MCP workspace handoff", () => {
	it("resolves exactly the receipt tools without global MCP metadata", () => {
		const value = fixture();
		try {
			const plan = resolvePiLaunchToolPlan({ cwd: value.workspace, mcpDirectTools: SERENA_READ_TOOLS.map(name => `serena/${name}`), extensionBindings: value.binding });
			assert.deepEqual(plan.effectiveMcpTools.sort(), SERENA_READ_TOOLS.map(name => `serena_${name}`).sort());
		} finally { fs.rmSync(value.workspace, { recursive: true, force: true }); }
	});

	it("fails closed after invalidation and on cross-workspace reuse", () => {
		const value = fixture();
		const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-serena-other-")));
		try {
			assert.throws(() => resolvePiLaunchToolPlan({ cwd: other, mcpDirectTools: ["serena/read_file"], extensionBindings: value.binding }), /not canonical for this workspace/);
			fs.rmSync(value.receiptPath);
			assert.throws(() => resolvePiLaunchToolPlan({ cwd: value.workspace, mcpDirectTools: ["serena/read_file"], extensionBindings: value.binding }));
		} finally {
			fs.rmSync(value.workspace, { recursive: true, force: true });
			fs.rmSync(other, { recursive: true, force: true });
		}
	});
});
