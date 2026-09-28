import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildSessionEvent, ChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import type { StepSteerHandler } from "../../src/runs/background/run-child-session.ts";
import { runSingleStepInner } from "../../src/runs/background/subagent-runner.ts";

const deadline = 120_000;
const failure = (id = "one"): ChildSessionEvent => ({ type: "tool_result_end", toolCallId: id, toolName: "exec", message: {
	role: "toolResult", toolCallId: id, toolName: "exec", isError: true, content: [{ type: "text", text: "bad tool call" }],
} });
const start = (id = "next", name = "exec"): ChildSessionEvent => ({ type: "tool_execution_start", toolCallId: id, toolName: name, args: {} });
const end = (id = "next", name = "exec"): ChildSessionEvent => ({ type: "tool_execution_end", toolCallId: id, toolName: name });
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
		parentSessionId: "parent", runId: "deadline", childAgentName: "worker", childIndex: 0, sessionName: "deadline", systemPrompt: "Test." });
	const run = runChildSession({ factory, launch, prompt: "Task: recover", appendChildEvent() {}, writeOutputLine() {},
		registerSteer: (handler) => { steer = handler; }, registerInterrupt: (handler) => { interrupt = handler; },
		registerStop: (handler) => { stop = handler; }, registerTimeout: (handler) => { timeout = handler; } });
	return { run, send: (event: ChildSessionEvent) => emit(event), finish: () => finishPrompt(),
		steer: () => steer, interrupt: () => interrupt?.(), stop: () => stop?.(), timeout: () => timeout?.(),
		get aborts() { return aborts; }, get disposals() { return disposals; }, get prompts() { return prompts; } };
}

async function ready() { const child = session(); await Promise.resolve(); await Promise.resolve(); assert.equal(child.prompts, 1); return child; }

describe("detached post-tool-error assistant request deadline", () => {
	it("initiates timeout at two minutes and force-settles when prompt ignores abort", async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		const child = await ready();
		child.send(failure());
		t.mock.timers.tick(deadline - 1);
		assert.equal(child.aborts, 0);
		t.mock.timers.tick(1);
		assert.equal(child.aborts, 1);
		t.mock.timers.tick(3_000);
		const result = await child.run;
		assert.equal(result.exitCode, 1);
		assert.equal(result.timedOut, true);
		assert.match(result.error ?? "", /post-tool-error assistant request.*120000ms/i);
		assert.equal(child.disposals, 1);
		assert.equal(child.prompts, 1);
	});

	it("does not extend an armed deadline for repeated failure, heartbeats, updates or steering", async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		const child = await ready();
		child.send(failure());
		t.mock.timers.tick(deadline - 10);
		child.send(failure());
		child.send({ type: "message_start" });
		child.send({ type: "message_update" });
		child.send({ type: "child_watchdog_status", phase: "active" });
		assert.equal((await child.steer()?.({ text: "continue", mode: "steer" } as Parameters<StepSteerHandler>[0]))?.state, "delivered");
		t.mock.timers.tick(10);
		assert.equal(child.aborts, 1);
		child.finish();
		await child.run;
	});

	it("clears on completed assistant message and on successful prompt settlement", async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		const child = await ready();
		child.send(failure());
		child.send(assistant());
		t.mock.timers.tick(deadline + 1);
		assert.equal(child.aborts, 0);
		child.finish();
		const result = await child.run;
		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "Recovered");
		assert.equal(child.disposals, 1);
		t.mock.timers.tick(deadline);
		assert.equal(child.aborts, 0);
	});

	it("lets healthy recovery finish with a terminal assistant answer", async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		const child = await ready();
		child.send(failure());
		child.send({ ...assistant("Done"), message: { ...(assistant("Done").message as object), stopReason: "stop" } });
		child.finish();
		assert.equal((await child.run).exitCode, 0);
		t.mock.timers.tick(deadline);
		assert.equal(child.aborts, 0);
	});

	it("new tool clears old interval; overlapping active supervisor tool is protected", async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		const child = await ready();
		child.send(failure());
		child.send(start("long", "contact_supervisor"));
		t.mock.timers.tick(deadline + 1);
		assert.equal(child.aborts, 0);
		child.send(failure("another"));
		t.mock.timers.tick(deadline);
		assert.equal(child.aborts, 0);
		child.send(end("long", "contact_supervisor"));
		assert.equal(child.aborts, 1);
		child.finish();
		assert.equal((await child.run).timedOut, true);
	});

	it("later failure starts fresh interval; unfailed requests stay unbounded", async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		const child = await ready();
		child.send(start());
		child.send(end());
		child.send({ ...failure(), message: { ...(failure().message as object), isError: false } });
		t.mock.timers.tick(deadline + 1);
		assert.equal(child.aborts, 0);
		child.send(failure());
		t.mock.timers.tick(deadline - 1);
		child.send(start());
		child.send(end());
		child.send(failure("next"));
		t.mock.timers.tick(1);
		assert.equal(child.aborts, 0);
		t.mock.timers.tick(deadline - 1);
		assert.equal(child.aborts, 1);
		child.finish();
		await child.run;
	});

	it("clears on explicit interrupt, stop and shorter timeout instead of overriding their reasons", async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		for (const kind of ["interrupt", "stop", "timeout"] as const) {
			const child = await ready();
			child.send(failure());
			child[kind]();
			child.finish();
			const result = await child.run;
			t.mock.timers.tick(deadline);
			assert.equal(child.aborts, 1);
			assert.equal(child.disposals, 1);
			assert.doesNotMatch(result.error ?? "", /post-tool-error/i);
			assert.equal(result.timedOut === true, kind === "timeout");
		}
	});

	it("returns a failed runner step to the parent without fallback or prompt replay", async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		const cwd = mkdtempSync(join(tmpdir(), "post-error-runner-"));
		let prompts = 0;
		let creates = 0;
		let prompted!: () => void;
		const promptReady = new Promise<void>((resolve) => { prompted = resolve; });
		const factory: ChildSessionFactory = {
			async create() {
				creates++;
				let emit: (event: ChildSessionEvent) => void = () => {};
				return {
					subscribe(listener) { emit = listener; return () => {}; },
					prompt() { prompts++; emit(failure()); prompted(); return new Promise<void>(() => {}); },
					async abort() {}, async dispose() {}, async steer() {}, async followUp() {},
					messages: [], sessionId: "scripted", sessionFile: undefined, modelId: undefined,
				};
			},
			async dispose() {},
		};
		try {
			const run = runSingleStepInner({ agent: "worker", task: "Recover", context: "fresh",
				modelCandidates: ["model/primary", "model/fallback"], waitToolEnabled: false, completionGuard: false },
				{ cwd, id: "runner-deadline", flatIndex: 0, flatStepCount: 1, previousOutput: "", placeholder: "{previous}",
					outputFile: join(cwd, "output.log"), sessionEnabled: false, childSessions: factory });
			await promptReady;
			t.mock.timers.tick(deadline + 3_000);
			for (let i = 0; i < 20; i++) await Promise.resolve();
			// The runner's own asynchronous finalization can schedule a later cleanup timer.
			t.mock.timers.tick(10_000);
			const result = await run;
			assert.equal(result.exitCode, 1);
			assert.equal(result.timedOut, true);
			assert.match(result.error ?? "", /post-tool-error assistant request.*120000ms/i);
			assert.equal(result.modelAttempts?.length, 1);
			assert.equal(creates, 1);
			assert.equal(prompts, 1);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});
});
