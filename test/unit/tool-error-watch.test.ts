import assert from "node:assert/strict";
import { it } from "node:test";
import { createToolErrorWatch } from "../../src/runs/shared/tool-error-watch.ts";
import { buildControlEvent, claimControlNotification, resolveControlConfig } from "../../src/runs/shared/subagent-control.ts";

it("deduplicates one alert per failed call without suppressing the next same-tool failure", () => {
	const seen = new Set<string>();
	const event = (toolCallId: string) => buildControlEvent({ to: "needs_attention", reason: "tool_error_stall", runId: "run", agent: "worker", index: 0, currentTool: "read", toolCallId, recentFailureSummary: "denied" });
	assert.equal(claimControlNotification(resolveControlConfig(), event("first"), seen), true);
	assert.equal(claimControlNotification(resolveControlConfig(), event("first"), seen), false);
	assert.equal(claimControlNotification(resolveControlConfig(), event("second"), seen), true);
});

it("escalates one identified failed invocation only after stalled continuation", () => {
	const watch = createToolErrorWatch();
	watch.observe({ type: "tool_execution_start", toolCallId: "outer/1", toolName: "read" }, 1, "/sample");
	watch.observe({ type: "tool_execution_end", toolCallId: "outer/1", toolName: "read", isError: true }, 2);
	watch.observe({ type: "tool_result_end", message: { role: "toolResult", toolCallId: "outer/1", toolName: "read", isError: true, content: [{ type: "text", text: "access denied" }] } }, 3);
	assert.equal(watch.due(59_999, 60_000), undefined);
	assert.deepEqual(watch.due(60_002, 60_000), { tool: "read", toolCallId: "outer/1", path: "/sample", failedAt: 2, summary: "access denied" });
	watch.observe({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: "Investigating" } }, 60_003);
	assert.equal(watch.due(200_000, 60_000), undefined);
	watch.observe({ type: "tool_result_end", message: { role: "toolResult", toolCallId: "outer/1", toolName: "read", isError: true } }, 200_001);
	assert.equal(watch.due(300_000, 60_000), undefined);
});

it("keeps a failed call pending through whitespace-only assistant text and deltas", () => {
	const watch = createToolErrorWatch();
	watch.observe({ type: "tool_execution_start", toolCallId: "nested/1", toolName: "read" }, 1);
	watch.observe({ type: "tool_execution_end", toolCallId: "nested/1", toolName: "read", isError: true }, 2);
	watch.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: " \n\t" }] } }, 3);
	watch.observe({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: "  \n" } }, 4);
	assert.equal(watch.due(60_002, 60_000)?.toolCallId, "nested/1");
	watch.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall" }] } }, 60_003);
	assert.equal(watch.due(100_000, 0), undefined);
	watch.observe({ type: "tool_result_end", message: { role: "toolResult", toolCallId: "nested/1", isError: true } }, 100_001);
	assert.equal(watch.due(200_000, 0), undefined);
});

it("does not borrow sibling calls, unidentified failures, or replay after compaction", () => {
	const watch = createToolErrorWatch();
	watch.observe({ type: "tool_execution_end", toolName: "read", isError: true }, 1);
	assert.equal(watch.due(100_000, 60_000), undefined);
	watch.observe({ type: "tool_execution_start", toolCallId: "a", toolName: "read" }, 2);
	watch.observe({ type: "tool_execution_start", toolCallId: "b", toolName: "read" }, 3);
	watch.observe({ type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: true }, 4);
	watch.observe({ type: "tool_execution_end", toolCallId: "b", toolName: "read", isError: false }, 5);
	assert.equal(watch.due(60_004, 60_000)?.toolCallId, "a");
	watch.observe({ type: "compaction_start" }, 60_005);
	watch.observe({ type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: true }, 60_006);
	assert.equal(watch.due(300_000, 60_000), undefined);
});

it("does not re-alert an old failed invocation after unrelated calls evict its active record", () => {
	const watch = createToolErrorWatch();
	watch.observe({ type: "tool_execution_start", toolCallId: "old", toolName: "read" }, 1);
	watch.observe({ type: "tool_execution_end", toolCallId: "old", toolName: "read", isError: true }, 2);
	watch.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "continuing" }] } }, 3);
	for (let index = 0; index < 129; index++) watch.observe({ type: "tool_execution_start", toolCallId: String(index), toolName: "read" }, index + 4);
	watch.observe({ type: "tool_execution_start", toolCallId: "old", toolName: "read" }, 200);
	watch.observe({ type: "tool_execution_end", toolCallId: "old", toolName: "read", isError: true }, 201);
	assert.equal(watch.due(300_000, 0), undefined);
});
