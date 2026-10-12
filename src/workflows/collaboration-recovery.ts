import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { decodeCollaboration, readCollaborationJson, type CollaborationJson } from "./collaboration-json.ts";
import { collaborationSnapshotSchema, collaborationRecoverySchema, collaborationNeverSpawnedSchema } from "./collaboration-schema.ts";
import * as path from "node:path";
import { DIRS } from "../shared/types.ts";
import { assertCollaborationQuiescent, collaborationNamespaceSchema } from "../runs/shared/collaboration-quiescence.ts";
import { collaborationDigest, collaborationResourcePath, type CollaborationManifest } from "./collaboration-manifest.ts";
import type { CollaborationSummary } from "./collaboration.ts";

export interface CollaborationRecovery {
	epoch: string;
	sequence: number;
	workspaceDigest: string;
	/** Existing approval provenance supplied by the authorized parent, not a child proposal. */
	approval: { authority: "user" | "supervisor"; reference: string };
	retryPackages: string[];
	reuseCompleted: string[];
}
export interface CollaborationSnapshot {
	version: 1; epoch: string; sequence: number; manifestDigest: string;
	manifest: CollaborationManifest; summary: CollaborationSummary;
}
export function readCollaborationSnapshot(file: string): CollaborationSnapshot {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const info = fs.fstatSync(fd);
		if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Collaboration recovery snapshot exceeds its byte bound.");
		const source = fs.readFileSync(fd, "utf8");
		// Reject ambiguity at every enclosing object before last-key-wins decoding.
		const tokens = source.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/gu) ?? [];
		const objects: Array<Set<string> | undefined> = [];
		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index]!;
			if (token.startsWith('"') && tokens[index + 1] === ":") {
				const key = JSON.parse(token) as string, object = objects.at(-1);
				if (object?.has(key)) throw new Error("Invalid duplicate recovery snapshot object key.");
				object?.add(key);
			} else if (token === "{") objects.push(new Set());
			else if (token === "[") objects.push(undefined);
			else if (token === "}" || token === "]") objects.pop();
		}
		const decoded = decodeCollaboration(collaborationSnapshotSchema, readCollaborationJson(source), "Invalid collaboration recovery snapshot.");
		// SAFETY: The complete persisted domain structure is checked above. Enrollment owns semantic/path validation.
		const result = decoded as CollaborationSnapshot;
		return result;
	} finally { fs.closeSync(fd); }
}
export function validateCollaborationRecovery(value: CollaborationJson | CollaborationRecovery, prior: CollaborationSnapshot, manifest: CollaborationManifest): CollaborationRecovery {
	const source = JSON.stringify(value);
	if (Buffer.byteLength(source) > 16 * 1024) throw new Error("Explicit bounded recovery inspection is required.");
	const row = decodeCollaboration(collaborationRecoverySchema, readCollaborationJson(source), "Invalid collaboration recovery decision.");
	if (row.epoch !== prior.epoch || row.sequence !== prior.sequence || row.workspaceDigest !== collaborationDigest(manifest.workspace)
		|| !row.approval.reference.trim()
		|| row.retryPackages.some((id) => ![...manifest.packages, ...(manifest.reconciliation ? [manifest.reconciliation] : [])].some((pkg) => pkg.id === id))
		|| row.reuseCompleted.some((id) => !manifest.packages.some((pkg) => pkg.id === id))
		|| new Set([...row.retryPackages, ...row.reuseCompleted]).size !== row.retryPackages.length + row.reuseCompleted.length
		|| manifest.workspace !== prior.manifest.workspace || manifest.runId !== prior.manifest.runId || manifest.workflowId !== prior.manifest.workflowId
		|| manifest.manifestVersion < prior.manifest.manifestVersion) throw new Error("Recovery is stale, incompatible, uninspected or lacks parent approval provenance.");
	if (JSON.stringify(manifest) !== JSON.stringify(prior.manifest) && manifest.manifestVersion <= prior.manifest.manifestVersion) throw new Error("A changed manifest must advance its version.");
	for (const state of [...prior.summary.packages, ...(prior.summary.reconciliation ? [prior.summary.reconciliation] : [])]) {
		if (["running", "reserved", "interrupted", "failed", "validating"].includes(state.state) && !row.retryPackages.includes(state.id)) throw new Error("Partial mutation requires an explicit inspected retry decision: " + state.id);
	}
	for (const id of row.reuseCompleted) {
		const state = prior.summary.packages.find((pkg) => pkg.id === id);
		if (!state) throw new Error("Completed reuse lacks historical identity: " + id);
		reuseCollaborationCompletion(prior, manifest, state);
		const producers = [...manifest.packages.find((pkg) => pkg.id === id)!.prerequisites, ...Object.values(state.completionInputs!).flatMap((binding) => binding.packageId ? [binding.packageId] : [])];
		if (producers.some((producer) => row.retryPackages.includes(producer) || !row.reuseCompleted.includes(producer))) throw new Error("Stale completed consumer cannot be reused while its producer is retried: " + id);
	}
	proveCollaborationSnapshotQuiescent(prior);
	return row;
}
/** A dead coordinator alone is not proof that detached namespace writers ended. */
export function proveCollaborationSnapshotQuiescent(prior: CollaborationSnapshot): void {
	for (const check of [...(prior.summary.activeChecks ?? []), ...(prior.summary.activeCheck ? [prior.summary.activeCheck] : [])]) {
		if (!check.namespace) throw new Error("quiescence-unproven: check startup lacks trusted namespace identity.");
		assertCollaborationQuiescent(check.namespace);
	}
	for (const state of [...prior.summary.packages, ...(prior.summary.reconciliation ? [prior.summary.reconciliation] : [])]) {
		if (state.neverSpawned !== undefined) {
			const proof = decodeCollaboration(collaborationNeverSpawnedSchema, readCollaborationJson(JSON.stringify(state.neverSpawned)), "Invalid never-spawned proof.");
			const states = [...prior.summary.packages, ...(prior.summary.reconciliation ? [prior.summary.reconciliation] : [])];
			const packages = [...prior.manifest.packages, ...(prior.manifest.reconciliation ? [prior.manifest.reconciliation] : [])];
			if (!["failed", "interrupted"].includes(state.state)
				|| proof.epoch !== prior.epoch || proof.manifestDigest !== prior.manifestDigest
				|| proof.manifestDigest !== createHash("sha256").update(JSON.stringify(prior.manifest)).digest("hex")
				|| proof.manifestVersion !== prior.manifest.manifestVersion || proof.manifestVersion !== prior.summary.manifestVersion
				|| proof.collaborationRunId !== prior.manifest.runId || proof.collaborationRunId !== prior.summary.runId
				|| proof.packageId !== state.id || proof.executionId !== state.executionId
				|| packages.filter((pkg) => pkg.id === state.id).length !== 1
				|| states.filter((other) => other.id === state.id).length !== 1
				|| states.filter((other) => other.executionId === state.executionId).length !== 1
				|| ["runId", "pid", "nativeArtifactDir", "outputDigests", "completionContractDigest", "completionInputs", "completionPrerequisites", "completionManifestVersion", "reusedFrom"].some((key) => Object.hasOwn(state, key))
				|| Object.values(prior.summary.publications).some((publication) => publication.packageId === state.id || publication.executionId === state.executionId))
				throw new Error("quiescence-unproven: never-spawned proof is stale, conflicting or not bound to one terminal attempt.");
			continue;
		}
		if (state.state === "blocked" || state.state === "ready") continue;
		if (!state.runId || !/^[A-Za-z0-9._-]+$/u.test(state.runId)) throw new Error("quiescence-unproven: interrupted startup lacks native identity.");
		const file = path.join(state.nativeArtifactDir ?? path.join(DIRS.async, state.runId), "collaboration-namespace.json");
		const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		try {
			if (fs.fstatSync(fd).size > 4096) throw new Error("Namespace identity exceeds its bound.");
			assertCollaborationQuiescent(decodeCollaboration(collaborationNamespaceSchema, readCollaborationJson(fs.readFileSync(fd, "utf8")), "Invalid native namespace identity."));
		} finally { fs.closeSync(fd); }
	}
}
export function reuseCollaborationCompletion(prior: CollaborationSnapshot, manifest: CollaborationManifest, state: CollaborationSummary["packages"][number]): void {
	const oldPackage = prior.manifest.packages.find((pkg) => pkg.id === state.id);
	const pkg = manifest.packages.find((entry) => entry.id === state.id);
	if (state.neverSpawned !== undefined || !oldPackage || !pkg || state.state !== "completed" || !state.completionInputs || !state.completionPrerequisites
		|| state.completionContractDigest !== createHash("sha256").update(JSON.stringify(oldPackage)).digest("hex")
		|| JSON.stringify(pkg) !== JSON.stringify(oldPackage)
		|| JSON.stringify(Object.keys(state.completionInputs).sort()) !== JSON.stringify(pkg.reads.filter((id) => !pkg.writes.includes(id)).sort())
		|| !Object.entries(state.completionInputs).every(([id, binding]) => {
			const publication = prior.summary.publications[id];
			const currentInitial = manifest.resources.find((resource) => resource.id === id)?.initialPublication;
			const historicalInitial = prior.manifest.resources.find((resource) => resource.id === id)?.initialPublication;
			return publication && currentInitial?.version === historicalInitial?.version && currentInitial?.digest === historicalInitial?.digest
				&& (binding.packageId !== undefined || (binding.version === currentInitial?.version && binding.digest === currentInitial?.digest))
				&& binding.path === collaborationResourcePath(manifest, id) && binding.version === publication.version && binding.digest === publication.digest
				&& binding.digest === collaborationDigest(binding.path) && binding.packageId === publication.packageId && binding.executionId === publication.executionId
				&& (!binding.packageId || Boolean(binding.executionId));
		})
		|| JSON.stringify(Object.keys(state.completionPrerequisites).sort()) !== JSON.stringify([...pkg.prerequisites].sort())
		|| !Object.entries(state.completionPrerequisites).every(([id, execution]) => Boolean(execution) && prior.summary.packages.find((p) => p.id === id)?.executionId === execution)
		|| JSON.stringify(pkg.writes) !== JSON.stringify(oldPackage.writes)
		|| JSON.stringify(pkg.publishes) !== JSON.stringify(oldPackage.publishes)
		|| !pkg.writes.every((resourceId) => {
			const oldPath = collaborationResourcePath(prior.manifest, resourceId), currentPath = collaborationResourcePath(manifest, resourceId);
			return oldPath === currentPath && state.outputDigests?.[resourceId] === collaborationDigest(currentPath);
		})) throw new Error("Completed work is not content-compatible: " + state.id);
}
