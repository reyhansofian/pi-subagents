import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { collectCurrentLaunchToolEvidence, type ChildSessionEvent, type ChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { makeAgent } from "../support/helpers.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
const assistant = (text: string): ChildSessionEvent => ({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text }], model: "mock/test-model", stopReason: "stop", usage },
} as ChildSessionEvent);
const details = (name: string) => ({ codeMode: true, status: "result", traces: [{ name, status: "done" }] });

function scriptedFactory(events: ChildSessionEvent[], writes: Array<{ path: string; content: string }> = []): ChildSessionFactory {
	return {
		async create(launch) {
			const listeners = new Set<(event: ChildSessionEvent) => void>();
			const messages: AgentMessage[] = [];
			return {
				subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
				async prompt() {
					for (const file of writes) {
						const target = resolve(launch.cwd, file.path);
						mkdirSync(dirname(target), { recursive: true });
						writeFileSync(target, file.content);
					}
					for (const event of [{ type: "agent_start" }, ...events] as ChildSessionEvent[]) {
						if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) messages.push(event.message);
						for (const listener of listeners) listener(event);
					}
					for (const event of [{ type: "agent_end", messages: [...messages], willRetry: false }, { type: "agent_settled" }] as ChildSessionEvent[]) {
						for (const listener of listeners) listener(event);
					}
				},
				async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
				messages, sessionId: "scripted", modelId: launch.model,
			};
		},
		async dispose() {},
	};
}

function launch(cwd: string) {
	return buildInProcessChildLaunch({ cwd, host: "parent", sessionEnabled: false, model: "baseten/model-a", tools: ["read", "exec"],
		allowNestedSubagents: false, waitToolEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
		parentSessionId: "parent", runId: "live-events", childAgentName: "worker", childIndex: 0, sessionName: "live events", systemPrompt: "Test live events." });
}

describe("live Code Mode mutation evidence", () => {
	it("deduplicates paired successful tool end events as private evidence", () => {
		const toolResults: Message[] = [];
		const indexes = new Map();
		collectCurrentLaunchToolEvidence({
			type: "tool_result_end",
			toolCallId: "read-1",
			message: { role: "toolResult", toolCallId: "read-1", toolName: "read", isError: false, content: [{ type: "text", text: "result" }], timestamp: 1 },
		}, toolResults, indexes);
		collectCurrentLaunchToolEvidence({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false }, toolResults, indexes);
		assert.equal(toolResults.length, 1);
		assert.equal(toolResults[0]?.toolName, "read");
		assert.equal(toolResults[0]?.isError, false);

		const reverseToolResults: Message[] = [];
		const reverseIndexes = new Map();
		collectCurrentLaunchToolEvidence({ type: "tool_execution_end", toolCallId: "read-2", toolName: "read", isError: false }, reverseToolResults, reverseIndexes);
		collectCurrentLaunchToolEvidence({
			type: "tool_result_end",
			toolCallId: "read-2",
			message: { role: "toolResult", toolCallId: "read-2", toolName: "read", isError: false, content: [{ type: "text", text: "result" }], timestamp: 1 },
		}, reverseToolResults, reverseIndexes);
		assert.equal(reverseToolResults.length, 1);

		const failedToolResults: Message[] = [];
		const failedIndexes = new Map();
		collectCurrentLaunchToolEvidence({ type: "tool_result_end", toolCallId: "read-3", message: { role: "toolResult", toolCallId: "read-3", toolName: "read", isError: false, content: [], timestamp: 1 } }, failedToolResults, failedIndexes);
		collectCurrentLaunchToolEvidence({ type: "tool_execution_end", toolCallId: "read-3", toolName: "read", isError: true }, failedToolResults, failedIndexes);
		assert.equal(failedToolResults.length, 1);
		assert.notEqual(failedToolResults[0]?.isError, false);

		const reverseFailedToolResults: Message[] = [];
		const reverseFailedIndexes = new Map();
		collectCurrentLaunchToolEvidence({ type: "tool_execution_end", toolCallId: "read-4", toolName: "read", isError: false }, reverseFailedToolResults, reverseFailedIndexes);
		collectCurrentLaunchToolEvidence({ type: "tool_result_end", toolCallId: "read-4", message: { role: "toolResult", toolCallId: "read-4", toolName: "read", isError: true, content: [], timestamp: 1 } }, reverseFailedToolResults, reverseFailedIndexes);
		assert.equal(reverseFailedToolResults.length, 1);
		assert.notEqual(reverseFailedToolResults[0]?.isError, false);

		const malformedToolResults: Message[] = [];
		const malformedIndexes = new Map();
		collectCurrentLaunchToolEvidence({ type: "tool_result_end", toolCallId: "read-5", message: { role: "toolResult", toolCallId: "read-5", toolName: "read", isError: false, content: [], timestamp: 1 } }, malformedToolResults, malformedIndexes);
		collectCurrentLaunchToolEvidence({ type: "tool_execution_end", toolCallId: "read-5", toolName: "read" }, malformedToolResults, malformedIndexes);
		assert.equal(malformedToolResults.length, 1);
		assert.notEqual(malformedToolResults[0]?.isError, false);
	});

	it("keeps read-only foreground and background runs non-mutating", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "code-mode-read-"));
		const events = [{ type: "tool_execution_update", toolName: "exec", partialResult: { details: details("read") } } as ChildSessionEvent, assistant("read complete")];
		try {
			const foreground = await runSync(cwd, [makeAgent("reader", { tools: ["read"] })], "reader", "Inspect files", { childSessionFactory: scriptedFactory(events) });
			const background = await runChildSession({ factory: scriptedFactory(events), launch: launch(cwd), prompt: "Inspect files", appendChildEvent() {}, writeOutputLine() {} });
			assert.equal(foreground.exitCode, 0, foreground.error);
			assert.equal(foreground.effects?.fileMutation?.attempted, false);
			assert.equal(background.exitCode, 0, background.error);
			assert.equal(background.observedMutationAttempt, false);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});

	it("reports nested untracked creation and verifies its bytes", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "code-mode-untracked-"));
		const file = "nested/new.txt";
		const events = [{ type: "tool_execution_update", toolName: "exec", partialResult: { details: details("apply_patch") } } as ChildSessionEvent, assistant("created nested file")];
		const factory = scriptedFactory(events, [{ path: file, content: "nested bytes\n" }]);
		try {
			const result = await runSync(cwd, [makeAgent("worker", { completionGuard: true })], "worker", "Implement the nested file", { childSessionFactory: factory, agentContract: { version: 1 } });
			assert.equal(result.exitCode, 0, result.error);
			assert.equal(result.effects?.fileMutation?.attempted, true);
			assert.equal(readFileSync(join(cwd, file), "utf8"), "nested bytes\n");
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});

	it("retains early background mutation after more than 50 read-only updates and verifies external bytes", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "code-mode-background-"));
		const external = mkdtempSync(join(tmpdir(), "code-mode-artifact-"));
		const artifact = join(external, "result.md");
		const updates = [
			{ type: "tool_execution_update", toolName: "exec", partialResult: { details: details("apply_patch") } } as ChildSessionEvent,
			...Array.from({ length: 60 }, () => ({ type: "tool_execution_update", toolName: "exec", partialResult: { details: details("read") } } as ChildSessionEvent)),
			assistant("external artifact complete"),
		];
		try {
			const result = await runChildSession({ factory: scriptedFactory(updates, [{ path: artifact, content: "external bytes\n" }]), launch: launch(cwd), prompt: "Create external artifact", appendChildEvent() {}, writeOutputLine() {} });
			assert.equal(result.exitCode, 0, JSON.stringify(result));
			assert.equal(result.observedMutationAttempt, true);
			assert.equal(readFileSync(artifact, "utf8"), "external bytes\n");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(external, { recursive: true, force: true });
		}
	});
});
