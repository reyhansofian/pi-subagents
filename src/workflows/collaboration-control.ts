import * as fs from "node:fs";
import { Type } from "typebox";
import { decodeCollaboration, readCollaborationJson, type CollaborationJson } from "./collaboration-json.ts";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writePrivateAtomicJson } from "../shared/atomic-json.ts";

export interface CollaborationControl {
	version: 1;
	id: string;
	epoch: string;
	manifestVersion: number;
	sequence: number;
	action: "ceiling" | "pause-admissions" | "resume-admissions" | "stop";
	ceiling?: number;
}
const identity = Type.String({ pattern: "^[a-zA-Z0-9-]{1,128}$" });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const controlFields = { version: Type.Literal(1), id: identity, epoch: identity, manifestVersion: positive, sequence: positive };
const controlSchema = Type.Union([
	Type.Object({ ...controlFields, action: Type.Literal("ceiling"), ceiling: Type.Integer({ minimum: 1, maximum: 256 }) }, { additionalProperties: false }),
	Type.Object({ ...controlFields, action: Type.Union([Type.Literal("pause-admissions"), Type.Literal("resume-admissions"), Type.Literal("stop")]) }, { additionalProperties: false }),
]);
const controlSnapshotSchema = Type.Object({
	epoch: identity,
	manifest: Type.Object({ manifestVersion: positive }, { additionalProperties: true }),
	summary: Type.Object({ controlSequence: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })) }, { additionalProperties: true }),
}, { additionalProperties: true });
export function validateCollaborationControl(value: CollaborationJson | CollaborationControl): CollaborationControl {
	const source = JSON.stringify(value);
	if (Buffer.byteLength(source) > 4096) throw new Error("Invalid bounded collaboration control.");
	return decodeCollaboration(controlSchema, readCollaborationJson(source), "Invalid collaboration control.");
}

/** Parent/operator-only mailbox. Worker write grants never include this directory. */
export function requestCollaborationControl(artifactDir: string, action: CollaborationControl["action"], ceiling?: number): string {
	const snapshot = decodeCollaboration(controlSnapshotSchema, readCollaborationJson(fs.readFileSync(path.join(artifactDir, "snapshot.json"), "utf8")), "Invalid control snapshot.");
	const pending: CollaborationControl = { version: 1, id: randomUUID(), epoch: snapshot.epoch, manifestVersion: snapshot.manifest.manifestVersion, sequence: (snapshot.summary.controlSequence ?? 0) + 1, action };
	if (ceiling !== undefined) pending.ceiling = ceiling;
	const request = validateCollaborationControl(pending);
	const directory = path.join(artifactDir, "control");
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	// One pending safety command, not a Promise queue. A second sender must wait.
	const file = path.join(directory, "request.json");
	const candidate = path.join(directory, "candidate-" + request.id + ".json");
	writePrivateAtomicJson(candidate, request);
	try { fs.linkSync(candidate, file); } finally { fs.unlinkSync(candidate); }
	return request.id;
}

export function watchCollaborationControl(artifactDir: string, changed: () => void) {
	const directory = path.join(artifactDir, "control"), file = path.join(directory, "request.json");
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	let pending = fs.existsSync(file), failed = false;
	const watcher = fs.watch(directory, (_event, name) => {
		if (name?.toString() === "request.json") { pending = true; changed(); }
	});
	watcher.on("error", () => { failed = true; changed(); });
	return {
		read(): CollaborationControl | undefined {
			if (failed) throw new Error("Collaboration control watcher failed; advancement must stop.");
			if (!pending) return;
			pending = false;
			if (!fs.existsSync(file)) return;
			const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
			try {
				const info = fs.fstatSync(fd);
				if (!info.isFile() || info.size > 4096) throw new Error("Collaboration control exceeds the 4 KiB bound.");
				return validateCollaborationControl(readCollaborationJson(fs.readFileSync(fd, "utf8")));
			} finally { fs.closeSync(fd); }
		},
		ack(request: CollaborationControl, state: "applied" | "rejected") {
			writePrivateAtomicJson(path.join(directory, "receipt.json"), { version: 1, id: request.id, epoch: request.epoch, state });
			fs.unlinkSync(file);
		},
		close() { watcher.close(); },
	};
}
