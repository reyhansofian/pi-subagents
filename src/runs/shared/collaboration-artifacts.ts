import * as fs from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { decodeCollaboration, readCollaborationJson, collaborationObject, type CollaborationJson, type CollaborationJsonObject } from "../../workflows/collaboration-json.ts";
const ackSchema = Type.Object({
	executionToken: Type.String(), manifestVersion: Type.Integer({ minimum: 1 }),
	bindings: Type.Record(Type.String(), Type.Object({ path: Type.String(), version: Type.Integer({ minimum: 1 }), digest: Type.String() }, { additionalProperties: false })),
}, { additionalProperties: false });
const envelopeSchema = Type.Object({ runId: Type.Optional(Type.String()), id: Type.Optional(Type.String()), state: Type.Optional(Type.String()) }, { additionalProperties: true });
import { evaluateAcceptance, acceptanceFailureMessage } from "./acceptance.ts";
import type { ResolvedAcceptanceConfig } from "../../shared/types.ts";
interface CollaborationArtifactProjection { close(): void; flush(): void; ended(code: number | null, signal: string | null): Promise<void> }

import * as path from "node:path";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { watchAsyncControlInbox, requestAsyncInterrupt, requestAsyncTimeout, requestAsyncStop, requestAsyncSteer } from "../background/control-channel.ts";

/** Parent-only projection. Worker files are proposals, never authority or approvals. */
export function projectCollaborationArtifacts(input: {
	privateRoot: string; parentDir: string; resultPath: string; runId: string;
	processInstanceId: string; hostPid: number; stop(): void;
	bindings: Record<string, { path: string; version: number; digest: string }>;
	executionToken: string; manifestVersion: number; onDependencyAck(): void;
	hostStatus: Omit<import("../../shared/types.ts").AsyncStatus, "pid" | "processTerminal">;
	acceptance: ResolvedAcceptanceConfig; agent: string; model: string; thinking?: string; cwd: string;
}): CollaborationArtifactProjection {
	let closed = false, queued = false, acknowledged = false, terminalObserved = false;
	const maximum = 256 * 1024;
	const hostStatus = structuredClone(input.hostStatus);
	if (!Value.Check(Type.Object({}, { additionalProperties: true }), hostStatus)) throw new Error("Parent launch status is absent.");
	function proposal(name: string): CollaborationJson | undefined {
		const file = path.join(input.privateRoot, name);
		if (!fs.existsSync(file)) return undefined;
		const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		try {
			const info = fs.fstatSync(fd);
			if (!info.isFile() || info.nlink > 1 || info.size > maximum) throw new Error("Native proposal is not a bounded regular file.");
			const bytes = Buffer.alloc(maximum + 1);
			let total = 0, count: number;
			while (total < bytes.length && (count = fs.readSync(fd, bytes, total, bytes.length - total, null)) > 0) total += count;
			if (total > maximum) throw new Error("Native proposal grew past its byte bound.");
			return readCollaborationJson(bytes.subarray(0, total).toString("utf8"));
		} finally { fs.closeSync(fd); }
	}
	function currentParentStatus(): CollaborationJsonObject {
		const fd = fs.openSync(path.join(input.parentDir, "status.json"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		try {
			if (fs.fstatSync(fd).size > maximum) throw new Error("Parent status exceeds its byte bound.");
			const value = readCollaborationJson(fs.readFileSync(fd, "utf8"));
			const record = decodeCollaboration(Type.Record(Type.String(), Type.Unknown()), value, "Invalid parent status.");
			return collaborationObject(value, Object.keys(record), "Parent status");
		} finally { fs.closeSync(fd); }
	}
	function flush(): void {
		if (!acknowledged) {
			const rawAck = proposal("dependency-ack.json");
			if (rawAck !== undefined) {
				const ack = decodeCollaboration(ackSchema, rawAck, "Invalid dependency acknowledgment.");
				if (ack.executionToken !== input.executionToken || ack.manifestVersion !== input.manifestVersion || JSON.stringify(ack.bindings) !== JSON.stringify(input.bindings)) throw new Error("Obsolete dependency acknowledgment.");
				input.onDependencyAck();
				writePrivateAtomicJson(path.join(input.parentDir, "dependency-proceed.json"), { executionToken: input.executionToken, manifestVersion: input.manifestVersion });
				acknowledged = true;
			}
		}
		for (const [name, destination] of [["status.json", path.join(input.parentDir, "status.json")]] as const) {
			if (terminalObserved) continue;
			let raw: CollaborationJson | undefined;
			try { raw = proposal(name); }
			catch (error) {
				if (error instanceof SyntaxError || Value.Check(Type.Object({ code: Type.Literal("ENOENT") }, { additionalProperties: true }), error)) continue;
				input.stop(); throw error;
			}
			if (raw === undefined) continue;
			decodeCollaboration(envelopeSchema, raw, "Malformed native result proposal.");
			// SAFETY: The envelope schema establishes an object; JSON parsing constrains all retained proposal fields to JSON values.
			const row = raw as CollaborationJsonObject;
			if (row.runId !== input.runId && row.id !== input.runId) { input.stop(); throw new Error("Obsolete or foreign native result proposal."); }
			const next = { ...currentParentStatus(), state: "running", pid: input.hostPid, pidNamespaceScope: fs.readlinkSync("/proc/self/ns/pid"), processTerminal: { version: 1, state: "pending", runId: input.runId, runnerProcessInstanceId: input.processInstanceId }, collaboration: { version: 1, authority: "parent-projected", proposedState: row.state, runnerProcessInstanceId: input.processInstanceId, progressClaim: row.steps ?? row.progress ?? null } };
			writePrivateAtomicJson(destination, next);
		}
	}
	const watcher = fs.watch(input.privateRoot, () => {
		if (closed || queued) return;
		queued = true;
		queueMicrotask(() => { queued = false; if (!closed) { try { flush(); } catch { input.stop(); } } });
	});
	// Reuse the portable native inbox. The parent alone consumes authoritative
	// requests and routes their unchanged payloads into a worker-private inbox.
	const control = watchAsyncControlInbox(input.parentDir, {
		onInterrupt: () => { requestAsyncInterrupt(input.privateRoot); },
		onTimeout: () => { requestAsyncTimeout(input.privateRoot); },
		onStop: (request) => { requestAsyncStop(input.privateRoot, request); },
		onSteer: (request) => { requestAsyncSteer(input.privateRoot, request); },
		onError: () => input.stop(),
	});
	return { flush, async ended(code, signal) {
		terminalObserved = true;
		let raw: CollaborationJson | undefined;
		try { flush(); raw = proposal("result.json"); } catch { raw = undefined; }
		if (code === 0 && signal === null && Value.Check(Type.Object({ id: Type.String(), runId: Type.Optional(Type.String()), success: Type.Boolean(), results: Type.Array(Type.Object({ output: Type.String(), acceptance: Type.Optional(Type.Unknown()) }, { additionalProperties: true }), { minItems: 1, maxItems: 1 }) }, { additionalProperties: true }), raw) && (raw.runId === input.runId || raw.id === input.runId)) {
			const claim = raw.results[0]!;
			const claimedReport = Value.Check(Type.Object({ childReport: Type.Object({}, { additionalProperties: true }) }, { additionalProperties: true }), claim.acceptance) ? claim.acceptance.childReport : undefined;
			const output = claim.output + (claimedReport ? "\n```acceptance-report\n" + JSON.stringify(claimedReport) + "\n```" : "");
			const acceptance = await evaluateAcceptance({ acceptance: input.acceptance, output, cwd: input.cwd });
			const failure = acceptanceFailureMessage(acceptance);
			const success = raw.success && !(input.acceptance.explicit && failure);
			const step = { agent: input.agent, model: input.model, thinking: input.thinking, output: claim.output, success, exitCode: success ? 0 : 1, acceptance };
			writePrivateAtomicJson(path.join(input.parentDir, "status.json"), { ...currentParentStatus(), state: success ? "complete" : "failed", steps: [{ ...step, status: success ? "completed" : "failed" }], collaboration: { version: 1, authority: "parent-evaluated", workerClaimsAreUntrusted: true } });
			const result = { runId: input.runId, id: input.runId, success, error: failure, results: [step] };
			writePrivateAtomicJson(input.resultPath, result);
			return;
		}
		if (code !== 0 || signal !== null || !fs.existsSync(input.resultPath)) {
			const error = "Native namespace ended without a result proposal; exit=" + code + ", signal=" + signal;
			writePrivateAtomicJson(input.resultPath, { runId: input.runId, id: input.runId, success: false, error, results: [] });
			writePrivateAtomicJson(path.join(input.parentDir, "status.json"), { runId: input.runId, state: "failed", error, pid: input.hostPid, steps: [] });
		}
	}, close() { if (closed) return; closed = true; watcher.close(); control(); } };
}
