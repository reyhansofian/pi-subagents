import { randomUUID } from "node:crypto";
import type { ChildLaunchIdentity, ChildLaunchBindings } from "../../shared/required-child-extensions.ts";
import type { ExtensionBindingJson } from "./extension-bindings.ts";

export type WorkerBound = Readonly<{ kind: "finite"; deadlineAtMs: number } | { kind: "unbounded" } | { kind: "unavailable"; reason: string }>;
export interface WorkerFacts {
	launch: Readonly<ChildLaunchIdentity>;
	sessionId: string;
	attemptId: string;
	cwd: string;
	observedAtMs: number;
	state: "running" | "stopping" | "closed";
	cancelled: boolean;
	child: WorkerBound;
	enclosing: readonly WorkerBound[];
	activeTools: Readonly<Record<string, WorkerBound>>;
}
export interface NativeCall {
	toolCallId: string;
	parentToolCallId: string;
	args: Readonly<{ command: string; timeout: number }>;
	cwd: string;
	observedAtMs: number;
}
export interface NativeObservation extends NativeCall {
	status: "normal-result" | "unknown";
	exitCode?: number;
	output?: string;
	truncated?: boolean;
	completedAtMs: number;
}
export interface WorkerRuntime {
	snapshot(): Readonly<WorkerFacts>;
	binding(extensionId: string): ExtensionBindingJson | undefined;
	armNativeBash(input: {
		parentToolCallId: string;
		args: Readonly<{ command: string; timeout: number }>;
		beforeLaunch(call: Readonly<NativeCall>, fresh: () => Readonly<WorkerFacts>): Promise<void>;
	}): { observation(): Readonly<NativeObservation> | undefined; close(): void };
}
interface Registry { version: 1; sessions: WeakMap<object, WorkerRuntime> }
function registry(): Registry {
	const root = globalThis as Record<PropertyKey, unknown>;
	const key = Symbol.for("pi-subagents.worker-runtime.v1");
	const existing = root[key];
	if (existing === undefined) return root[key] = { version: 1, sessions: new WeakMap() } as Registry;
	if (!existing || typeof existing !== "object" || !("version" in existing) || existing.version !== 1 || !("sessions" in existing) || !(existing.sessions instanceof WeakMap)) throw new Error("Invalid worker runtime registry.");
	return existing as Registry;
}
export function getCurrentWorkerRuntime(ctx: { sessionManager: object }): WorkerRuntime | undefined {
	return registry().sessions.get(ctx.sessionManager);
}
export function workerBound(deadlineAtMs: number | undefined): WorkerBound {
	return deadlineAtMs === undefined ? Object.freeze({ kind: "unbounded" })
		: Number.isSafeInteger(deadlineAtMs) && deadlineAtMs >= 0 ? Object.freeze({ kind: "finite", deadlineAtMs })
		: Object.freeze({ kind: "unavailable", reason: "invalid-host-deadline" });
}
function snapshotBound(bound: WorkerBound): WorkerBound {
	if (bound.kind === "finite") return workerBound(bound.deadlineAtMs);
	return Object.freeze(bound.kind === "unbounded" ? { kind: "unbounded" } : { kind: "unavailable", reason: bound.reason });
}

type Event = { toolName: string; toolCallId: string; parentToolCallId?: string; input: unknown; structuredContent?: unknown; isError?: boolean };
/** Internal host controller. It does not execute tools or grant verification authority. */
export function createWorkerRuntime(launch: Readonly<ChildLaunchIdentity>, bindings: ChildLaunchBindings, child: WorkerBound, enclosing: readonly WorkerBound[]) {
	const attemptId = randomUUID();
	const ownedChild = snapshotBound(child);
	const ownedEnclosing = Object.freeze(enclosing.map(snapshotBound));
	let sessionId = "";
	let state: WorkerFacts["state"] = "running";
	let cancelled = false;
	let unsupported: WorkerBound | undefined;
	let valid = false;
	let nativeValid: () => boolean = () => false;
	let sessionManager: object | undefined;
	const activeTools: Record<string, WorkerBound> = Object.create(null);
	const activeParents = new Set<string>();
	type Arm = { input: Parameters<WorkerRuntime["armNativeBash"]>[0]; call?: Readonly<NativeCall>; args?: unknown; observation?: Readonly<NativeObservation>; closed: boolean };
	let arm: Arm | undefined;
	const snapshot = (): Readonly<WorkerFacts> => Object.freeze({
		launch, sessionId, attemptId, cwd: launch.cwd, observedAtMs: Date.now(), state, cancelled,
		child: ownedChild, enclosing: unsupported ? Object.freeze([...ownedEnclosing, unsupported]) : ownedEnclosing, activeTools: Object.freeze({ ...activeTools }),
	});
	const runtime: WorkerRuntime = Object.freeze({
		snapshot,
		binding: (id: string) => bindings[id],
		armNativeBash(input: Parameters<WorkerRuntime["armNativeBash"]>[0]) {
			if (!valid || state !== "running" || cancelled || !nativeValid() || arm || !activeParents.has(input.parentToolCallId)) throw new Error("Native verification boundary unavailable or already armed.");
			if (typeof input.args.command !== "string" || !Number.isSafeInteger(input.args.timeout) || input.args.timeout <= 0 || Object.keys(input.args).some(key => key !== "command" && key !== "timeout")) throw new Error("Invalid protected bash arguments.");
			const current: Arm = { input: { ...input, args: Object.freeze({ ...input.args }) }, closed: false };
			arm = current;
			return Object.freeze({
				observation: () => current.observation,
				close() {
					// Missing raw terminal evidence keeps the arm occupied: no overlapping retry.
					current.closed = true;
					if (current.observation?.status === "normal-result" && arm === current) arm = undefined;
				},
			});
		},
	});
	const first = (event: Event): void => {
		if (event.toolName !== "bash" || !arm || event.parentToolCallId !== arm.input.parentToolCallId) return;
		if (!valid || !nativeValid() || arm.call) throw new Error("Protected native call identity unavailable.");
		const args = event.input as Record<string, unknown>;
		if (!args || args.command !== arm.input.args.command || args.timeout !== arm.input.args.timeout || Object.keys(args).some(key => key !== "command" && key !== "timeout")) throw new Error("Protected native arguments changed.");
		Object.freeze(args);
		for (const key of ["toolName", "toolCallId", "parentToolCallId", "input"] as const) Object.defineProperty(event, key, { value: event[key], enumerable: true, writable: false, configurable: false });
		arm.args = args;
		arm.call = Object.freeze({ toolCallId: event.toolCallId, parentToolCallId: event.parentToolCallId!, args: args as NativeCall["args"], cwd: launch.cwd, observedAtMs: Date.now() });
	};
	const last = async (event: Event): Promise<void> => {
		if (event.toolName !== "bash" || !arm || event.parentToolCallId !== arm.input.parentToolCallId) return;
		if (!arm.call || event.toolCallId !== arm.call.toolCallId || event.input !== arm.args || !valid || !nativeValid() || cancelled || state !== "running") throw new Error("Protected native final admission unavailable.");
		await arm.input.beforeLaunch(arm.call, snapshot);
		if (!valid || !nativeValid() || cancelled || state !== "running") throw new Error("Worker stopped during final admission.");
	};
	const result = (event: Event): void => {
		if (!arm?.call || event.toolName !== "bash" || event.toolCallId !== arm.call.toolCallId || event.parentToolCallId !== arm.call.parentToolCallId || event.input !== arm.args) return;
		const value = event.structuredContent as Record<string, unknown> | undefined;
		const normal = value && Number.isInteger(value.exit_code) && typeof value.output === "string" && typeof value.truncated === "boolean";
		arm.observation = Object.freeze({ ...arm.call, completedAtMs: Date.now(), status: normal ? "normal-result" : "unknown",
			...(normal ? { exitCode: value.exit_code as number, output: value.output as string, truncated: value.truncated as boolean } : {}),
		});
		if (arm.closed && arm.observation.status === "normal-result") arm = undefined;
	};
	return {
		runtime,
		hooks: [
			{ name: "pi-subagents:worker-first", factory(pi: any) { pi.on("tool_call", first); pi.on("tool_result", result); } },
			{ name: "pi-subagents:worker-last", factory(pi: any) { pi.on("tool_call", last); } },
		],
		attach(manager: object, id: string, certifyNative: () => boolean) {
			sessionManager = manager; sessionId = id; nativeValid = certifyNative;
			if (!nativeValid()) throw new Error("Selected bash is not the native builtin.");
			valid = true; registry().sessions.set(manager, runtime);
		},
		toolStarted(id: string, bound: WorkerBound) { activeParents.add(id); activeTools[id] = snapshotBound(bound); },
		toolEnded(id: string) { activeParents.delete(id); delete activeTools[id]; },
		unsupported(reason: string) { unsupported = Object.freeze({ kind: "unavailable", reason }); },
		stop() { cancelled = true; state = "stopping"; },
		close() { state = "closed"; valid = false; if (sessionManager) registry().sessions.delete(sessionManager); },
	};
}
export type WorkerRuntimeController = ReturnType<typeof createWorkerRuntime>;
