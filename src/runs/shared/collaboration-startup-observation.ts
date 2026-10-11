import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import { decodeCollaboration, readCollaborationJson } from "../../workflows/collaboration-json.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { verifyCollaborationRuntime } from "./collaboration-launch.ts";
import type { CollaborationManifest } from "../../workflows/collaboration-manifest.ts";

const text = Type.String({ minLength: 1, maxLength: 4096 });
const names = Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 256 });
export const startupObservationSchema = Type.Object({
	version: Type.Literal(1),
	binding: Type.Object({
		runId: text, executionToken: text, manifestVersion: Type.Integer({ minimum: 1 }),
		processInstanceId: text, candidateRoot: text, sdkRoot: text,
		adapter: Type.Object({ path: text, digest: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }),
	}, { additionalProperties: false }),
	phase: Type.Union([Type.Literal("loaded"), Type.Literal("bound")]),
	extensions: Type.Array(Type.Object({
		path: text, resolvedPath: Type.Optional(text), tools: names,
	}, { additionalProperties: false }), { maxItems: 64 }),
	errors: Type.Array(Type.Object({ path: text, kind: Type.Union([Type.Literal("load-error"), Type.Literal("bind-error")]) }, { additionalProperties: false }), { maxItems: 64 }),
	session: Type.Optional(Type.Object({
		id: text, model: text, thinking: text, registeredTools: names, activeTools: names,
	}, { additionalProperties: false })),
}, { additionalProperties: false });
export type CollaborationStartupObservation = Static<typeof startupObservationSchema>;
export type CollaborationStartupFacts = Omit<CollaborationStartupObservation, "version" | "binding">;
export type CollaborationStartupBinding = CollaborationStartupObservation["binding"];
const MAX_BYTES = 128 * 1024;

/** Constructed by the confined runner. No caller hooks or manifest-selected output paths. */
export function createCollaborationStartupSink(privateRoot: string, binding: CollaborationStartupBinding): (facts: CollaborationStartupFacts) => void {
	const owned = structuredClone(binding);
	return (facts) => {
		const value = { version: 1, binding: owned, ...facts };
		const source = JSON.stringify(value);
		if (Buffer.byteLength(source) > MAX_BYTES) throw new Error("Confined startup observation exceeds its byte bound.");
		decodeCollaboration(startupObservationSchema, readCollaborationJson(source), "Invalid confined startup observation.");
		writePrivateAtomicJson(path.join(privateRoot, "context7-startup.json"), value);
	};
}

/** Parent proof check only. This validates observations, never authorizes execution or acceptance. */
export function readCollaborationStartupObservation(file: string, expected: CollaborationStartupBinding, manifest: CollaborationManifest): CollaborationStartupObservation {
	verifyCollaborationRuntime(manifest);
	if (!manifest.runtime.assets.some(asset => asset.path === expected.candidateRoot) ||
		!manifest.runtime.assets.some(asset => asset.path === expected.sdkRoot) ||
		manifest.runtime.context7?.path !== expected.adapter.path || manifest.runtime.context7.digest !== expected.adapter.digest ||
		manifest.manifestVersion !== expected.manifestVersion) throw new Error("Startup observation authority does not match readonly runtime enrollment.");
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const info = fs.fstatSync(fd);
		if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES) throw new Error("Startup observation is not a bounded regular file.");
		const bytes = Buffer.alloc(MAX_BYTES + 1);
		let count = 0, read: number;
		while (count < bytes.length && (read = fs.readSync(fd, bytes, count, bytes.length - count, null)) > 0) count += read;
		if (count > MAX_BYTES) throw new Error("Startup observation grew past its byte bound.");
		const result = decodeCollaboration(startupObservationSchema, readCollaborationJson(bytes.subarray(0, count).toString("utf8")), "Invalid startup observation.");
		if (JSON.stringify(result.binding) !== JSON.stringify(expected)) throw new Error("Startup observation belongs to a wrong or stale execution.");
		if (result.phase !== "bound" || result.errors.length || !result.session) throw new Error("Startup observation does not establish successful native binding.");
		return result;
	} finally { fs.closeSync(fd); }
}
