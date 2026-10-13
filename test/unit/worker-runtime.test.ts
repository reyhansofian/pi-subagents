import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerRuntime, getCurrentWorkerRuntime, workerBound } from "../../src/runs/shared/worker-runtime.ts";
import { snapshotChildLaunchBindings, snapshotChildLaunchIdentity } from "../../src/shared/child-launch-binding.ts";
import { bindRequiredChildLaunch, registerRequiredChildExtensions, resolveRequiredChildExtensions } from "../../src/shared/required-child-extensions.ts";
import { fileURLToPath } from "node:url";

const launch = Object.freeze({ runId: "logical", parentSessionId: "parent", agent: "coder", cwd: "/source", taskSha256: "a".repeat(64) });
function fixture() {
	const child = { kind: "finite" as const, deadlineAtMs: 2_000_000_100_000 };
	const enclosing = { kind: "finite" as const, deadlineAtMs: 2_000_000_090_000 };
	const controller = createWorkerRuntime(launch, Object.freeze({ required: Object.freeze({ approved: true }) }), child, [enclosing]);
	const manager = {};
	let certified = true;
	controller.attach(manager, "actual-session", () => certified);
	controller.toolStarted("actual-parent", { kind: "unbounded" });
	const handlers: Array<Record<string, (event: any) => any>> = controller.hooks.map(hook => {
		const registered: Record<string, (event: any) => any> = {};
		hook.factory({ on: (name: string, fn: (event: any) => any) => { registered[name] = fn; } } as never);
		return registered;
	});
	return { controller, manager, child, enclosing, handlers, invalidate: () => { certified = false; } };
}
test("worker handle requires actual session object; snapshots isolate host bounds and attempts", () => {
	const f = fixture();
	assert.equal(getCurrentWorkerRuntime({ sessionManager: f.manager }), f.controller.runtime);
	assert.equal(getCurrentWorkerRuntime({ sessionManager: { sessionId: "actual-session" } }), undefined);
	const snapshot = f.controller.runtime.snapshot();
	f.child.deadlineAtMs++; f.enclosing.deadlineAtMs++;
	assert.equal(snapshot.child.kind === "finite" && snapshot.child.deadlineAtMs, 2_000_000_100_000);
	assert.ok(Object.isFrozen(snapshot.enclosing[0]));
	assert.ok(Object.isFrozen(snapshot.activeTools["actual-parent"]));
	assert.throws(() => { (snapshot.enclosing[0] as any).deadlineAtMs = 3_000_000_000_000; }, TypeError);
	assert.notEqual(snapshot.attemptId, fixture().controller.runtime.snapshot().attemptId);
	assert.equal(workerBound(undefined).kind, "unbounded");
	assert.equal(workerBound(NaN).kind, "unavailable");
	f.controller.unsupported("terminal-drain-bound-unavailable");
	assert.equal(f.controller.runtime.snapshot().enclosing.at(-1)?.kind, "unavailable");
	f.controller.stop(); assert.equal(f.controller.runtime.snapshot().cancelled, true);
	f.controller.close(); assert.equal(getCurrentWorkerRuntime({ sessionManager: f.manager }), undefined);
});
test("protected native boundary freezes retained args/identity and copies raw terminal before rewrite", async () => {
	const f = fixture();
	let admitted = false;
	const arm = f.controller.runtime.armNativeBash({ parentToolCallId: "actual-parent", args: { command: "approved", timeout: 2 },
		async beforeLaunch(call, fresh) { assert.equal(call.toolCallId, "actual-parent/actual-native"); assert.equal(fresh().sessionId, "actual-session"); admitted = true; } });
	const args = { command: "approved", timeout: 2 };
	const event = { toolName: "bash", toolCallId: "actual-parent/actual-native", parentToolCallId: "actual-parent", input: args };
	f.handlers[0].tool_call(event);
	assert.throws(() => { args.command = "altered"; }, TypeError);
	assert.throws(() => { event.input = { command: "other", timeout: 2 }; }, TypeError);
	assert.throws(() => { event.toolCallId = "invented"; }, TypeError);
	await f.handlers[1].tool_call(event);
	assert.equal(admitted, true);
	const raw = { exit_code: 7, output: "native failure", truncated: false };
	f.handlers[0].tool_result({ ...event, structuredContent: raw, isError: true });
	raw.exit_code = 0; raw.output = "rewritten success";
	assert.equal(arm.observation()?.exitCode, 7);
	assert.equal(arm.observation()?.output, "native failure");
	arm.close();
});
test("unknown observation, stopping, invalid ordering/provenance and unrelated parent fail closed", async () => {
	for (const kind of ["unknown", "stop", "certificate", "parent", "mismatch"] as const) {
		const f = fixture();
		if (kind === "parent") {
			assert.throws(() => f.controller.runtime.armNativeBash({ parentToolCallId: "invented", args: { command: "approved", timeout: 2 }, async beforeLaunch() {} }), /unavailable/);
			continue;
		}
		const arm = f.controller.runtime.armNativeBash({ parentToolCallId: "actual-parent", args: { command: "approved", timeout: 2 }, async beforeLaunch() {} });
		const event = { toolName: "bash", toolCallId: "native", parentToolCallId: "actual-parent", input: { command: kind === "mismatch" ? "altered" : "approved", timeout: 2 } };
		if (kind === "mismatch") { assert.throws(() => f.handlers[0].tool_call(event), /arguments changed/); continue; }
		f.handlers[0].tool_call(event);
		if (kind === "stop") f.controller.stop();
		if (kind === "certificate") f.invalidate();
		if (kind === "unknown") {
			f.handlers[0].tool_result({ ...event, isError: true });
			assert.equal(arm.observation()?.status, "unknown");
			assert.equal(arm.observation()?.exitCode, undefined);
			arm.close();
			assert.throws(() => f.controller.runtime.armNativeBash({ parentToolCallId: "actual-parent", args: { command: "approved", timeout: 2 }, async beforeLaunch() {} }), /already armed/);
		} else await assert.rejects(f.handlers[1].tool_call(event), /unavailable/);
	}
});
test("trusted required binding is isolated, declared-only, optional and conflict-safe", async () => {
	const sessionId = "binding-unit-" + Date.now();
	const extensionPath = fileURLToPath(new URL("../../package.json", import.meta.url));
	let calls = 0;
	const payload = { required: { approved: true } };
	const registration = registerRequiredChildExtensions({ sessionId, extensions: [{ id: "required", path: extensionPath }],
		async bindLaunch(identity) { calls++; assert.ok(Object.isFrozen(identity)); return payload; } });
	const identity = snapshotChildLaunchIdentity({ ...launch, parentSessionId: sessionId });
	const required = resolveRequiredChildExtensions(sessionId);
	const binding = await bindRequiredChildLaunch(identity, required);
	payload.required.approved = false;
	assert.equal((binding?.required as any).approved, true);
	assert.equal(calls, 1);
	assert.throws(() => snapshotChildLaunchBindings({ foreign: true }, required), /not a required extension/);
	assert.throws(() => snapshotChildLaunchBindings({ required: "x".repeat(20_000) }, required), /maximum/);
	await assert.rejects(bindRequiredChildLaunch(identity, []), /changed before binding/);
	registration.dispose();
	assert.equal(await bindRequiredChildLaunch(identity, required), undefined);
	assert.deepEqual(resolveRequiredChildExtensions(sessionId), []);
});
