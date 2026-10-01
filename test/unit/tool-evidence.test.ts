import assert from "node:assert/strict";
import { it } from "node:test";
import { createToolEvidenceCollector } from "../../src/runs/shared/child-session.ts";

it("credits only successful, identified current-launch native calls and keeps failures authoritative", () => {
	const launch = createToolEvidenceCollector();
	launch.observe({ type: "tool_execution_start", toolCallId: "outer/1", parentToolCallId: "outer", toolName: "read" });
	launch.observe({ type: "tool_execution_start", toolCallId: "outer/2", parentToolCallId: "outer", toolName: "write" });
	launch.observe({ type: "tool_execution_end", toolCallId: "outer/1", parentToolCallId: "outer", toolName: "read", isError: false });
	launch.observe({ type: "tool_execution_end", toolCallId: "outer/2", parentToolCallId: "outer", toolName: "write", isError: false });
	launch.observe({ type: "tool_result_end", message: { role: "toolResult", toolCallId: "outer/2", toolName: "write", isError: true } });
	launch.observe({ type: "tool_execution_end", toolCallId: "outer/2", parentToolCallId: "outer", toolName: "write", isError: false });
	launch.observe({ type: "tool_execution_end", toolName: "read", isError: false });
	launch.observe({ type: "tool_execution_end", toolCallId: "outer/3", toolName: "read" });
	launch.observe({ type: "tool_result_end", message: { role: "toolResult", toolCallId: "replayed", toolName: "read", isError: false } });
	launch.observe({ type: "tool_execution_start", toolCallId: "replayed", toolName: "read" });
	assert.deepEqual(launch.successfulNames(), ["read"]);
	assert.deepEqual(createToolEvidenceCollector().successfulNames(), []);
});

it("does not turn inventory, wrappers, shell reads, declarations, or replay into execution", () => {
	const launch = createToolEvidenceCollector();
	for (const [id, name, error] of [["wrapper", "codemode", false], ["shell", "bash", false], ["denied", "read", true]] as const) {
		launch.observe({ type: "tool_execution_start", toolCallId: id, toolName: name });
		launch.observe({ type: "tool_execution_end", toolCallId: id, toolName: name, isError: error });
	}
	launch.observe({ type: "tool_execution_end", toolCallId: "historic-read", toolName: "read", isError: false });
	assert.deepEqual(launch.successfulNames(), ["codemode", "bash"]);
	launch.observe({ type: "tool_execution_start", toolCallId: "direct", toolName: "read" });
	launch.observe({ type: "tool_result_end", message: { role: "toolResult", toolCallId: "direct", toolName: "read", isError: false } });
	assert.equal(launch.successfulNames().includes("read"), true);
	assert.deepEqual(createToolEvidenceCollector().successfulNames(), []);
});

it("does not credit a completion with a different nested parent identity", () => {
	const launch = createToolEvidenceCollector();
	launch.observe({ type: "tool_execution_start", toolCallId: "nested", parentToolCallId: "parent-a", toolName: "read" });
	launch.observe({ type: "tool_execution_end", toolCallId: "nested", parentToolCallId: "parent-b", toolName: "read", isError: false });
	assert.deepEqual(launch.successfulNames(), []);
});

it("does not credit ambiguous result envelopes or mismatched invocation names", () => {
	const launch = createToolEvidenceCollector();
	launch.observe({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
	launch.observe({ type: "tool_result_end", toolCallId: "b", message: { role: "toolResult", toolCallId: "a", toolName: "read", isError: false } });
	assert.deepEqual(launch.successfulNames(), []);
	launch.observe({ type: "tool_execution_end", toolCallId: "a", toolName: "write", isError: false });
	assert.deepEqual(launch.successfulNames(), []);
});
