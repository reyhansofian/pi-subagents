import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChildSessionEvent, ChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import type { StepSteerHandler } from "../../src/runs/background/run-child-session.ts";

const failure = (id = "one"): ChildSessionEvent => ({ type: "tool_result_end", toolCallId: id, toolName: "exec", message: {
	role: "toolResult", toolCallId: id, toolName: "exec", isError: true, content: [{ type: "text", text: "bad tool call" }],
} });
const assistant = (text = "Recovered"): ChildSessionEvent => ({ type: "message_end", message: {
	role: "assistant", content: [{ type: "text", text }], stopReason: "toolUse",
} });

function session() {
	let emit: (event: ChildSessionEvent) => void = () => {};
	let finishPrompt: () => void = () => {};
	let aborts = 0;
	let disposals = 0;
	let prompts = 0;
	let steer: StepSteerHandler | undefined;
	let interrupt: (() => void) | undefined;
	let stop: (() => void) | undefined;
	let timeout: (() => void) | undefined;
	const factory: ChildSessionFactory = {
		async create() {
			return {
				subscribe(listener) { emit = listener; return () => { emit = () => {}; }; },
			prompt() { prompts++; return new Promise<void>((resolve) => { finishPrompt = resolve; }); },
			async abort() { aborts++; }, async dispose() { disposals++; }, async steer() {}, async followUp() {},
			messages: [], sessionId: "scripted", sessionFile: undefined, modelId: undefined,
		};
		},
		async dispose() {},
	};
	const launch = buildInProcessChildLaunch({ cwd: process.cwd(), host: "parent", sessionEnabled: false,
		allowNestedSubagents: false, waitToolEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
		parentSessionId: "parent", runId: "deadline", childAgentName: "worker", childIndex: 0, sessionName: "recovery", systemPrompt: "Test." });
	const run = runChildSession({ factory, launch, prompt: "Task: recover", appendChildEvent() {}, writeOutputLine() {},
		registerSteer: (handler) => { steer = handler; }, registerInterrupt: (handler) => { interrupt = handler; },
		registerStop: (handler) => { stop = handler; }, registerTimeout: (handler) => { timeout = handler; } });
	return { run, send: (event: ChildSessionEvent) => emit(event), finish: () => finishPrompt(),
		steer: () => steer, interrupt: () => interrupt?.(), stop: () => stop?.(), timeout: () => timeout?.(),
		get aborts() { return aborts; }, get disposals() { return disposals; }, get prompts() { return prompts; } };
}

async function ready() { const child = session(); await Promise.resolve(); await Promise.resolve(); assert.equal(child.prompts, 1); return child; }

describe("ordinary tool failure recovery without an implicit deadline", () => {
	it("leaves a failed tool and quiet thinking alive past the former two-minute ceiling", async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		const child = await ready();
		child.send(failure());
		t.mock.timers.tick(180_000);
		assert.equal(child.aborts, 0);
		child.send({ ...assistant("Recovered later"), message: { ...(assistant("Recovered later").message as object), stopReason: "stop" } });
		child.finish();
		const result = await child.run;
		assert.equal(result.exitCode, 0);
		assert.notEqual(result.timedOut, true);
		assert.equal(result.finalOutput, "Recovered later");
		assert.equal(child.disposals, 1);
	});

	it("does not abort a blocking supervisor request after a failed tool", async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		const child = await ready();
		child.send(failure());
		child.send({ type: "tool_execution_start", toolCallId: "ask", toolName: "contact_supervisor", args: {} });
		t.mock.timers.tick(180_000);
		assert.equal(child.aborts, 0);
		child.send({ type: "tool_execution_end", toolCallId: "ask", toolName: "contact_supervisor" });
		child.send({ ...assistant("Supervisor replied"), message: { ...(assistant("Supervisor replied").message as object), stopReason: "stop" } });
		child.finish();
		assert.equal((await child.run).exitCode, 0);
	});

	it("still obeys an explicit narrower run timeout", async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		const child = await ready();
		child.send(failure());
		t.mock.timers.tick(5_000);
		child.timeout();
		child.finish();
		const result = await child.run;
		assert.equal(result.timedOut, true);
		assert.equal(child.aborts, 1);
		assert.doesNotMatch(result.error ?? "", /post-tool-error/i);
	});
});
