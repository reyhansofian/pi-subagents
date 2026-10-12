import * as fs from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readCollaborationSnapshot, validateCollaborationRecovery, reuseCollaborationCompletion } from "./collaboration-recovery.ts";
import { watchCollaborationControl } from "./collaboration-control.ts";
import { inspectCollaborationJournal } from "./collaboration-journal.ts";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { normalizeCollaborationManifest, collaborationDigest, collaborationResourcePath, type CollaborationManifest, type CollaborationPackage, type CollaborationCheck } from "./collaboration-manifest.ts";
import { acquireSessionLease } from "../runs/shared/session-lease.ts";
import { registerCollaborationLaunch, verifyCollaborationRuntime, collaborationSandboxTools, type CollaborationLaunchHandle } from "../runs/shared/collaboration-launch.ts";
import { executeWorkflowHostCommand } from "./host-command.ts";
import { writePrivateAtomicJson } from "../shared/atomic-json.ts";
import { TEMP_ROOT_DIR } from "../shared/types.ts";
import type { WorkflowScriptChildResult } from "./scripted-workflow.ts";

import type { CollaborationNeverSpawned } from "./collaboration-schema.ts";

export interface CollaborationPackageState {
	neverSpawned?: CollaborationNeverSpawned;
	id: string;
	state: "blocked" | "ready" | "reserved" | "running" | "validating" | "completed" | "failed" | "interrupted";
	executionId?: string;
	outputDigests?: Record<string, string>;
	completionContractDigest?: string;
	completionInputs?: Record<string, { path: string; version: number; digest: string; packageId?: string; executionId?: string }>;
	completionPrerequisites?: Record<string, string>;
	nativeArtifactDir?: string;
	runId?: string;
	pid?: number;
	reason?: string;
	completionManifestVersion?: number;
	reusedFrom?: { epoch: string; manifestVersion: number; executionId?: string };
}
export interface CollaborationSummary {
	runId: string;
	manifestVersion: number;
	controlSequence: number;
	barrier: "none" | "admissions-paused" | "stop";
	effectiveConfiguration: Record<string, CollaborationPackage["configuration"]>;
	state: "completed" | "blocked" | "failed" | "interrupted";
	residents: number;
	ceiling: number;
	capacityLimit: number;
	packages: CollaborationPackageState[];
	ownership: Array<{ packageId: string; executionId?: string; reads: string[]; writes: string[]; exclusive: string[] }>;
	pendingConsequential: { barrier: "none" | "admissions-paused" | "stop"; controlSequence: number };
	publications: Record<string, { version: number; digest: string; packageId?: string; executionId?: string }>;
	candidateDigest?: string;
	verification: "pending" | "passed" | "failed";
	reconciliation?: CollaborationPackageState;
	activeCheck?: { id: string; executionId: string; namespace?: import("../runs/shared/collaboration-sandbox.ts").CollaborationNamespaceIdentity };
	activeChecks?: Array<NonNullable<CollaborationSummary["activeCheck"]>>;
	artifacts: { snapshot: string; journal: string };
	measurementCompleteness: { coordination: false; workerUsage: false };
}
export interface CollaborationOptions {
	signal: AbortSignal;
	launch: (key: string, params: Parameters<import("./scripted-workflow.ts").RunWorkflowScriptOptions["launch"]>[1], signal: AbortSignal, admission: { admitted: boolean; batch: boolean }) => Promise<WorkflowScriptChildResult>;
	admit?: (calls: Array<{ key: string; params: Parameters<import("./scripted-workflow.ts").RunWorkflowScriptOptions["launch"]>[1] }>, signal: AbortSignal) => void | Promise<void>;
	onStatus?: (summary: CollaborationSummary) => void;
	maximumResidentCapacity?: number;
	recovery?: Parameters<typeof validateCollaborationRecovery>[0];
}
function overlaps(a: string, b: string): boolean { return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep); }
function compatible(manifest: CollaborationManifest, a: { reads: string[]; writes: string[]; exclusive: string[] }, b: { reads: string[]; writes: string[]; exclusive: string[] }): boolean {
	if (a.exclusive.some((r) => b.exclusive.includes(r))) return false;
	const resolve = (r: string) => collaborationResourcePath(manifest, r);
	return !a.writes.some((r) => [...b.reads, ...b.writes].some((s) => overlaps(resolve(r), resolve(s))))
		&& !b.writes.some((r) => a.reads.some((s) => overlaps(resolve(r), resolve(s))));
}
/** Linux authority is independent of caller-controlled TMPDIR and artifact roots. */
export function collaborationAuthorityRoot(): string {
	if (process.platform !== "linux" || !process.getuid) throw new Error("shared-workspace-unsupported: Linux workspace authority is required.");
	const root = "/tmp/pi-subagents-collaboration-uid-" + process.getuid();
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const info = fs.lstatSync(root);
	if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || fs.realpathSync.native(root) !== root) throw new Error("Workspace authority directory is not a private canonical owner-controlled directory.");
	return root;
}
export function collaborationArtifactDirectory(manifest: Pick<CollaborationManifest, "workspace" | "runId">): string {
	const identity = createHash("sha256").update(fs.realpathSync.native(manifest.workspace)).digest("hex");
	return path.join(collaborationAuthorityRoot(), "collaborations", identity, manifest.runId);
}
function workerBrief(manifest: CollaborationManifest, pkg: CollaborationPackage, publications: CollaborationSummary["publications"]): string {
	return [
		"Shared-workspace package " + pkg.id + ", manifest version " + manifest.manifestVersion + ".",
		"RLM_WORKSPACE=" + manifest.workspace, "Goal: " + pkg.goal, "Rationale: " + pkg.rationale,
		"Constraints: " + JSON.stringify([...manifest.constraints, ...pkg.constraints]),
		"Completion: " + JSON.stringify(pkg.completion),
		"Owned directories: " + JSON.stringify(pkg.writes.map((r) => collaborationResourcePath(manifest, r))),
		"Current dependencies: " + JSON.stringify(pkg.reads.map((r) => ({ resource: r, path: collaborationResourcePath(manifest, r), publication: publications[r] }))),
		"Do not widen ownership. Propose shared changes through contact_supervisor before editing them. A message is not authorization.",
		"Checks run after the entire confined process tree stops: " + JSON.stringify(pkg.checks.map((c) => ({ id: c.id, command: c.command }))),
		"Return changed files, check evidence and remaining concerns. Do not launch siblings or mutate VCS/control/runtime assets.",
	].join("\n");
}

/** Journal-first durability fence shared by coordinator persistence and retained checks. */
export function writeCollaborationState(input: {
	fd: number; snapshot: string; epoch: string; manifestDigest: string; sequence: number;
	manifest: CollaborationManifest; summary: CollaborationSummary; event: string; detail: unknown;
	writeSnapshot?: typeof writePrivateAtomicJson;
}): void {
	const record = JSON.stringify({ version: 1, sequence: input.sequence, observedAtMs: Date.now(), epoch: input.epoch, manifestDigest: input.manifestDigest, event: input.event, detail: input.detail }) + "\n";
	if (Buffer.byteLength(record) > 64 * 1024) throw new Error("Consequential event exceeds the 64 KiB byte bound.");
	if (fs.fstatSync(input.fd).size + Buffer.byteLength(record) > 8 * 1024 * 1024) throw new Error("Collaboration journal reached its 8 MiB bound; advancement is paused, history is preserved.");
	// writeFileSync completes partial writes before the durability fence.
	fs.writeFileSync(input.fd, record); fs.fsyncSync(input.fd);
	const payload = { version: 1, epoch: input.epoch, manifestDigest: input.manifestDigest, sequence: input.sequence, manifest: input.manifest, summary: input.summary };
	if (Buffer.byteLength(JSON.stringify(payload)) > 1024 * 1024) throw new Error("Coordination snapshot exceeds its 1 MiB byte bound.");
	(input.writeSnapshot ?? writePrivateAtomicJson)(input.snapshot, payload);
	const snapshotFd = fs.openSync(input.snapshot, "r"); try { fs.fsyncSync(snapshotFd); } finally { fs.closeSync(snapshotFd); }
	const dirFd = fs.openSync(path.dirname(input.snapshot), "r"); try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}
/** Revoke synchronously before the first await; only the native owner can supply proof. */
export async function settleCollaborationFailure(input: {
	launch: CollaborationLaunchHandle; state: CollaborationPackageState; signal: AbortSignal; cause: unknown;
	reconciliation?: boolean; storageFailed: () => boolean; markQuiescenceUnproven: () => void;
	persist: (event: string, detail: unknown) => void;
}): Promise<void> {
	const proof = input.launch.finalizeNeverSpawned();
	let error = input.cause;
	try { await input.launch.stopAndDrain(); } catch (drainError) {
		input.markQuiescenceUnproven();
		if (!input.reconciliation) error = drainError;
	}
	if (Value.Check(Type.Object({ code: Type.Literal("quiescence-unproven") }, { additionalProperties: true }), error)) input.markQuiescenceUnproven();
	input.state.state = input.signal.aborted ? "interrupted" : "failed";
	input.state.reason = (input.reconciliation ? String(error) : error instanceof Error ? error.message : String(error)).slice(0, 2048);
	if (proof) {
		if (proof.packageId !== input.state.id || proof.executionId !== input.state.executionId) throw new Error("Obsolete failure settlement.");
		input.state.neverSpawned = proof;
	}
	if (!input.storageFailed()) input.persist(input.reconciliation ? "reconciliation-failed" : "interrupted", {
		...(input.reconciliation ? {} : { packageId: input.state.id }), executionId: input.state.executionId,
		reason: input.state.reason, ...(proof ? { neverSpawned: proof } : {}),
	});
}

/** Lifecycle-driven orchestration inside the existing workflow host. No model polling. */
export async function runCollaboration(value: Parameters<typeof normalizeCollaborationManifest>[0], options: CollaborationOptions): Promise<CollaborationSummary> {
	const controller = new AbortController();
	const signal = AbortSignal.any([options.signal, controller.signal]);
	const manifest = normalizeCollaborationManifest(value);
	verifyCollaborationRuntime(manifest);
	const authorityRoot = collaborationAuthorityRoot();
	if (overlaps(manifest.workspace, authorityRoot)) throw new Error("shared-workspace-unsupported: ticket workspace overlaps parent authority storage.");
	const artifactDir = collaborationArtifactDirectory(manifest);
	fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
	const snapshot = path.join(artifactDir, "snapshot.json"), journal = path.join(artifactDir, "journal.jsonl");
	const prior = fs.existsSync(snapshot) ? readCollaborationSnapshot(snapshot) : undefined;
	const recovery = options.recovery && prior ? validateCollaborationRecovery(options.recovery, prior, manifest) : undefined;
	if (options.recovery && !prior) throw new Error("Recovery has no historical snapshot.");
	const lease = acquireSessionLease({ sessionFile: manifest.workspace, runId: manifest.runId, sourceRunId: manifest.workflowId }, {
		rootDir: path.join(collaborationAuthorityRoot(), "workspace-leases"),
		proveWritersStopped: (owner) => Boolean(recovery && prior && owner.token === prior.epoch && owner.runId === manifest.runId),
	});
	// Never reclaim an interrupted multi-writer run from a heartbeat/PID shortcut.
	lease.updateWriter({ state: "spawning" });
	const manifestDigest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
	const summary: CollaborationSummary = {
		runId: manifest.runId, manifestVersion: manifest.manifestVersion, controlSequence: 0, barrier: "none", effectiveConfiguration: Object.fromEntries(manifest.packages.map((pkg) => [pkg.id, pkg.configuration])), state: "blocked", residents: 0, ceiling: manifest.concurrency, capacityLimit: options.maximumResidentCapacity ?? 256,
		packages: manifest.packages.map((p) => ({ id: p.id, state: "blocked" })), ownership: [], pendingConsequential: { barrier: "none", controlSequence: 0 },
		publications: Object.fromEntries(manifest.resources.filter((r) => r.initialPublication).map((r) => [r.id, { ...r.initialPublication! }])),
		verification: "pending", artifacts: { snapshot, journal }, measurementCompleteness: { coordination: false, workerUsage: false },
	};
	let sequence = 0, storageFailed = false, quiescenceUnproven = false;
	const activeChecks = new Map<string, NonNullable<CollaborationSummary["activeCheck"]>>();
	const active = new Map<string, { pkg: CollaborationPackage; stop(): void; promise: Promise<void> }>();
	let recoveryJournal: ReturnType<typeof inspectCollaborationJournal>, fd: number;
	try {
		recoveryJournal = inspectCollaborationJournal(journal);
		if (recoveryJournal.trailingPartial) fs.renameSync(journal, path.join(artifactDir, "journal.interrupted-" + randomUUID() + ".jsonl"));
		sequence = recoveryJournal.sequence;
		fd = fs.openSync(journal, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
		if (!fs.fstatSync(fd).isFile()) { fs.closeSync(fd); throw new Error("Collaboration journal must be a regular file."); }
	} catch (error) {
		// This owner has not granted a worker any authority yet.
		lease.updateWriter({ state: "none" }); lease.release(); throw error;
	}
	let wakeControl: (() => void) | undefined;
	const controls = watchCollaborationControl(artifactDir, () => {
		try { applyControl(); } catch { controller.abort(); abort(); }
		wakeControl?.();
	});
	function applyControl(): void {
		const control = controls.read();
		if (!control) return;
		if (control.epoch !== lease.owner.token || control.manifestVersion !== manifest.manifestVersion || control.sequence !== summary.controlSequence + 1) {
			persist("control-rejected", { id: control.id, reason: "obsolete-generation" }); controls.ack(control, "rejected"); return;
		}
		summary.controlSequence = control.sequence;
		if (control.action === "ceiling") summary.ceiling = control.ceiling!;
		else if (control.action === "pause-admissions") summary.barrier = "admissions-paused";
		else if (control.action === "resume-admissions") summary.barrier = "none";
		else { summary.barrier = "stop"; controller.abort(); abort(); }
		persist("control-applied", control); controls.ack(control, "applied");
	}
	function persist(event: string, detail: Parameters<typeof JSON.stringify>[0] = null): void {
		if (storageFailed) throw new Error("Collaboration storage failed; admission remains frozen.");
		try {
			summary.ownership = [...summary.packages, ...(summary.reconciliation ? [summary.reconciliation] : [])].filter((state) => active.has(state.id) || ["reserved", "running", "validating"].includes(state.state)).map((state) => {
				const pkg = manifest.packages.find((pkg) => pkg.id === state.id) ?? manifest.reconciliation!;
				return { packageId: state.id, executionId: state.executionId, reads: pkg.reads, writes: pkg.writes, exclusive: pkg.exclusive };
			});
			summary.pendingConsequential = { barrier: summary.barrier, controlSequence: summary.controlSequence };
			summary.activeChecks = [...activeChecks.values()];
			writeCollaborationState({ fd, snapshot, epoch: lease.owner.token, manifestDigest, sequence: ++sequence, manifest, summary, event, detail });
		} catch (error) {
			storageFailed = true;
			for (const worker of active.values()) worker.stop();
			throw error;
		}
		try { options.onStatus?.(structuredClone(summary)); } catch { /* Optional observational telemetry cannot authorize work. */ }
	}
	async function check(checks: CollaborationCheck[], prefix: string): Promise<boolean> {
		for (const c of checks) {
			if (signal.aborted) return false;
			const tools = collaborationSandboxTools();
			const namespaceRoot = fs.mkdtempSync(path.join(TEMP_ROOT_DIR, "collaboration-check-ns-"));
			const privateRoot = fs.mkdtempSync(path.join(TEMP_ROOT_DIR, "collaboration-check-private-"));
			const executionId = randomUUID();
			const checkState: NonNullable<CollaborationSummary["activeCheck"]> = { id: prefix + "." + c.id, executionId };
			activeChecks.set(executionId, checkState); persist("check-reserved", checkState);
			const waitAndCheck = 'read -r permit; [ "$permit" = PERMIT ] || exit 1; exec "$@"';
			const result = await executeWorkflowHostCommand({
				key: prefix + "." + c.id, params: { kind: "command", command: c.command, timeoutMs: c.timeoutMs },
				cwd: manifest.workspace, defaultOutputPath: path.join(artifactDir, prefix + "." + c.id + ".log"), signal: signal,
				onSandboxInitialized(identity) {
					if (signal.aborted || activeChecks.get(executionId) !== checkState) throw new Error("Obsolete check startup.");
					checkState.namespace = identity; persist("check-initialized", checkState);
				},
				sandbox: {
					workspace: manifest.workspace, hostSocketIsolation: true, initializationToken: randomUUID(), namespaceRoot,
					readPaths: c.reads.map((r) => collaborationResourcePath(manifest, r)), writePaths: c.writes.map((r) => collaborationResourcePath(manifest, r)),
					privateWritePaths: [privateRoot], runtimePaths: [...manifest.runtime.assets.map((r) => r.path), "/nix/store", "/proc"],
					command: tools.shell, args: ["-c", waitAndCheck, "confined-check", tools.shell, "-c", c.command], env: { PATH: process.env.PATH ?? "", HOME: privateRoot, TMPDIR: privateRoot }, tools,
				},
			});
			if (!checkState.namespace) throw new Error("quiescence-unproven: check namespace identity is absent.");
			const { assertCollaborationQuiescent } = await import("../runs/shared/collaboration-quiescence.ts");
			assertCollaborationQuiescent(checkState.namespace);
			activeChecks.delete(executionId);
			persist("check", { key: prefix + "." + c.id, ok: result.ok, outputPath: result.outputPath });
			if (!result.ok) return false;
		}
		return true;
	}
	const abort = () => { for (const worker of active.values()) worker.stop(); };
	signal.addEventListener("abort", abort);
	try {
		if (prior) {
			if (prior.sequence !== recoveryJournal.sequence) throw new Error("Journal/snapshot divergence requires explicit recovery inspection; mutations were not retried.");
			if (prior.manifestDigest !== manifestDigest && !recovery) throw new Error("A changed manifest requires an explicitly authorized amendment; prior history is preserved.");
			if (!recovery && [...prior.summary.packages, ...(prior.summary.reconciliation ? [prior.summary.reconciliation] : [])].some((p) => ["running", "reserved", "interrupted", "failed", "validating"].includes(p.state))) throw new Error("Interrupted mutations require explicit recovery inspection and runtime quiescence; no blind retry.");
			const history = path.join(artifactDir, "history"); fs.mkdirSync(history, { recursive: true, mode: 0o700 });
			const historicalBytes = fs.readdirSync(history).reduce((total, name) => total + fs.statSync(path.join(history, name)).size, 0);
			if (historicalBytes + fs.statSync(snapshot).size > 32 * 1024 * 1024) throw new Error("Historical snapshots reached their 32 MiB byte bound; history is preserved, advancement is paused.");
			const historical = path.join(history, prior.epoch + "-" + prior.sequence + ".json");
			if (!fs.existsSync(historical)) fs.copyFileSync(snapshot, historical, fs.constants.COPYFILE_EXCL);
			for (const state of prior.summary.packages) if (state.state === "completed" && (!recovery || recovery.reuseCompleted.includes(state.id))) {
				reuseCollaborationCompletion(prior, manifest, state);
				Object.assign(summary.packages.find((p) => p.id === state.id)!, state, { completionManifestVersion: state.completionManifestVersion ?? prior.manifest.manifestVersion, reusedFrom: { epoch: prior.epoch, manifestVersion: prior.manifest.manifestVersion, executionId: state.executionId } });
				for (const [id, publication] of Object.entries(prior.summary.publications)) if (publication.packageId === state.id) summary.publications[id] = publication;
			}
			if (recovery) persist("approved-recovery", { approval: recovery.approval, historicalSnapshot: historical, priorEpoch: prior.epoch, priorManifestVersion: prior.manifest.manifestVersion, reusedCompleted: recovery.reuseCompleted, retryPackages: recovery.retryPackages, inspectedWorkspaceDigest: recovery.workspaceDigest });
		}
		persist("enrolled");
		while (!signal.aborted && !storageFailed) {
			applyControl();
			if (summary.barrier === "stop") break;
			let admitted = false, waitsChanged = false;
			const wait = (state: CollaborationPackageState, reason: string, ready = false) => {
				const next = ready ? "ready" : "blocked";
				if (state.reason !== reason || state.state !== next) waitsChanged = true;
				state.reason = reason; state.state = next;
			};
			for (const pkg of manifest.packages) {
				const state = summary.packages.find((p) => p.id === pkg.id)!;
				if (state.state !== "blocked" && state.state !== "ready") continue;
				const dependencies = [...pkg.prerequisites, ...pkg.requires.map((r) => r.packageId)];
				if (dependencies.some((id) => summary.packages.find((p) => p.id === id)?.state !== "completed")) { wait(state, "prerequisite"); continue; }
				if (pkg.requires.some((r) => summary.publications[r.resourceId]?.version !== r.version || summary.publications[r.resourceId]?.packageId !== r.packageId)) { wait(state, "publication-version"); continue; }
				if (!Array.from(active.values()).every((other) => compatible(manifest, pkg, other.pkg))) { wait(state, "resource-conflict"); continue; }
				if (summary.barrier !== "none") { wait(state, "admission-barrier", true); continue; }
				if (active.size >= Math.min(summary.ceiling, summary.capacityLimit)) { wait(state, "capacity", true); continue; }
				for (const resourceId of pkg.reads) {
					if (pkg.writes.includes(resourceId)) continue;
					const current = summary.publications[resourceId];
					if (!current || current.digest !== collaborationDigest(collaborationResourcePath(manifest, resourceId))) throw new Error("Unpublished or stale dependency: " + resourceId);
				}
				const executionId = randomUUID(), key = manifest.runId + "." + pkg.id;
				state.state = "reserved"; state.executionId = executionId; delete state.reason;
				// Invalidate complete overlapping publications before any writer starts.
				for (const resourceId of Object.keys(summary.publications)) if (pkg.writes.some((w) => overlaps(collaborationResourcePath(manifest, w), collaborationResourcePath(manifest, resourceId)))) delete summary.publications[resourceId];
				summary.residents++;
				persist("reserved", { packageId: pkg.id, executionId, reads: pkg.reads, writes: pkg.writes, exclusive: pkg.exclusive });
				const completionInputs = Object.fromEntries(pkg.reads.filter((id) => !pkg.writes.includes(id)).map((id) => [id, { path: collaborationResourcePath(manifest, id), ...summary.publications[id]! }]));
				const completionPrerequisites = Object.fromEntries(pkg.prerequisites.map((id) => [id, summary.packages.find((p) => p.id === id)!.executionId!]));
				const launch = registerCollaborationLaunch({
					manifest, pkg, binding: { epoch: lease.owner.token, manifestDigest, executionId },
					bindings: Object.fromEntries(pkg.reads.filter((id) => !pkg.writes.includes(id)).map((id) => [id, { path: collaborationResourcePath(manifest, id), version: summary.publications[id]!.version, digest: summary.publications[id]!.digest }])),
					onDependencyAck() { persist("dependency-refresh-acknowledged", { packageId: pkg.id, executionId, manifestVersion: manifest.manifestVersion }); },
					onStarted(pid, runId, configuration, nativeArtifactDir) {
						summary.effectiveConfiguration[pkg.id] = configuration;
						if (state.executionId !== executionId) throw new Error("Obsolete execution start.");
						state.pid = pid; state.runId = runId; state.nativeArtifactDir = nativeArtifactDir; state.state = "running"; persist("started", { packageId: pkg.id, executionId, pid, runId });
					},
				});
				const params = {
					...pkg.configuration, task: workerBrief(manifest, pkg, summary.publications), cwd: manifest.workspace,
					async: true, workflowAwaitAsync: true, worktree: false, context: "fresh", collaborationGrant: launch.token,
					// Native run artifacts retain reports; do not redirect workers into workspace receipts.
					output: false, outputMode: "inline",
				};
				const operation = Promise.resolve().then(async () => {
					await options.admit?.([{ key, params }], signal);
					const result = await options.launch(key, params, signal, { admitted: Boolean(options.admit), batch: false });
					await launch.drain();
					persist("drain-confirmed", { packageId: pkg.id, executionId });
					if (!result.ok || signal.aborted) throw new Error(result.error ?? "Native package failed or stopped.");
					state.state = "validating";
					if (!await check(pkg.checks, pkg.id)) throw new Error("Package checks failed.");
					for (const publication of pkg.publishes) summary.publications[publication.resourceId] = { version: publication.version, digest: collaborationDigest(collaborationResourcePath(manifest, publication.resourceId)), packageId: pkg.id, executionId };
					state.completionContractDigest = createHash("sha256").update(JSON.stringify(pkg)).digest("hex");
					state.completionInputs = completionInputs; state.completionPrerequisites = completionPrerequisites;
					state.outputDigests = Object.fromEntries(pkg.writes.map((resourceId) => [resourceId, collaborationDigest(collaborationResourcePath(manifest, resourceId))]));
					state.state = "completed"; state.completionManifestVersion = manifest.manifestVersion; persist("published", { packageId: pkg.id, executionId, publications: pkg.publishes });
				}).catch(async (cause: unknown) => {
					await settleCollaborationFailure({ launch, state, signal, cause, storageFailed: () => storageFailed,
						markQuiescenceUnproven: () => { quiescenceUnproven = true; }, persist });
				}).finally(() => {
					launch.dispose(); active.delete(pkg.id); summary.residents--;
					if (!storageFailed) persist("resident-released", { packageId: pkg.id, executionId });
				});
				active.set(pkg.id, { pkg, stop: launch.stop, promise: operation }); admitted = true;
			}
			if (waitsChanged) persist("waits-updated");
			if (!active.size) break;
			const controlChanged = new Promise<void>((resolve) => { wakeControl = resolve; });
			try { await Promise.race([...Array.from(active.values(), (worker) => worker.promise), controlChanged]); }
			finally { wakeControl = undefined; }
			if (!admitted && summary.packages.some((p) => p.state === "failed")) break;
		}
		if (signal.aborted || storageFailed) abort();
		await Promise.allSettled(Array.from(active.values(), (worker) => worker.promise));
		if (summary.packages.every((p) => p.state === "completed") && !signal.aborted && summary.barrier !== "stop") {
			// All launch drains are complete. No implementation writer is resident.
			summary.candidateDigest = collaborationDigest(manifest.workspace); persist("candidate-established", summary.candidateDigest);
			summary.verification = await check(manifest.combinedChecks, "combined") ? "passed" : "failed";
			const afterChecks = collaborationDigest(manifest.workspace);
			if (afterChecks !== summary.candidateDigest) { summary.verification = "failed"; persist("candidate-mutated-during-check"); }
			if ((summary.verification === "failed" || recovery?.retryPackages.includes(manifest.reconciliation?.id ?? "")) && manifest.reconciliation && !signal.aborted) {
				const pkg = manifest.reconciliation;
				const state: CollaborationPackageState = { id: pkg.id, state: "reserved", executionId: randomUUID() };
				summary.reconciliation = state; summary.residents = 1; summary.verification = "pending";
				persist("exclusive-reconciliation-reserved", { packageId: pkg.id, executionId: state.executionId, candidateDigest: summary.candidateDigest });
				const bindings = Object.fromEntries(pkg.reads.filter((id) => !pkg.writes.includes(id)).map((id) => [id, { path: collaborationResourcePath(manifest, id), version: summary.publications[id]?.version ?? manifest.manifestVersion, digest: collaborationDigest(collaborationResourcePath(manifest, id)) }]));
				const launch = registerCollaborationLaunch({ manifest, pkg, binding: { epoch: lease.owner.token, manifestDigest, executionId: state.executionId! }, bindings, readArtifacts: manifest.combinedChecks.map((c) => path.join(artifactDir, "combined." + c.id + ".log")),
					onDependencyAck() { persist("reconciliation-refresh-acknowledged", { executionId: state.executionId }); },
					onStarted(pid, runId, configuration, nativeArtifactDir) { summary.effectiveConfiguration[pkg.id] = configuration; state.pid = pid; state.runId = runId; state.nativeArtifactDir = nativeArtifactDir; state.state = "running"; persist("reconciliation-started", { pid, runId }); },
				});
				const key = manifest.runId + "." + pkg.id;
				const params = { ...pkg.configuration, task: workerBrief(manifest, pkg, summary.publications) + "\\nConcrete combined verification failed. Read the concrete failed check logs: " + JSON.stringify(manifest.combinedChecks.map((c) => path.join(artifactDir, "combined." + c.id + ".log"))) + ". Repair only the declared integration scope; other writers have stopped.", cwd: manifest.workspace, async: true, workflowAwaitAsync: true, worktree: false, context: "fresh", collaborationGrant: launch.token, output: false, outputMode: "inline" };
				const abortReconciliation = () => launch.stop();
				signal.addEventListener("abort", abortReconciliation);
				try {
					await options.admit?.([{ key, params }], signal);
					const result = await options.launch(key, params, signal, { admitted: Boolean(options.admit), batch: false });
					await launch.drain();
					if (!result.ok || !await check(pkg.checks, pkg.id)) throw new Error("Exclusive reconciliation failed.");
					state.state = "completed"; state.completionManifestVersion = manifest.manifestVersion; state.outputDigests = Object.fromEntries(pkg.writes.map((id) => [id, collaborationDigest(collaborationResourcePath(manifest, id))]));
					for (const id of pkg.writes) delete summary.publications[id];
					for (const publication of pkg.publishes) summary.publications[publication.resourceId] = { version: publication.version, digest: collaborationDigest(collaborationResourcePath(manifest, publication.resourceId)), packageId: pkg.id, executionId: state.executionId };
					summary.candidateDigest = collaborationDigest(manifest.workspace);
					persist("reconciliation-completed", { executionId: state.executionId, candidateDigest: summary.candidateDigest });
					summary.verification = await check(manifest.combinedChecks, "combined-after-reconciliation") && collaborationDigest(manifest.workspace) === summary.candidateDigest ? "passed" : "failed";
				} catch (error) {
					const settlement = settleCollaborationFailure({ launch, state, signal, cause: error, reconciliation: true,
						storageFailed: () => storageFailed, markQuiescenceUnproven: () => { quiescenceUnproven = true; }, persist });
					summary.verification = "failed";
					await settlement;
				} finally { signal.removeEventListener("abort", abortReconciliation); launch.dispose(); summary.residents = 0; }
			}
			summary.state = summary.verification === "passed" ? "completed" : "failed";
		} else summary.state = signal.aborted || summary.barrier === "stop" ? "interrupted" : summary.packages.some((p) => p.state === "failed") ? "failed" : "blocked";
		persist("settled");
		return structuredClone(summary);
	} finally {
		signal.removeEventListener("abort", abort);
		abort();
		await Promise.allSettled(Array.from(active.values(), (worker) => worker.promise));
		controls.close();
		fs.closeSync(fd);
		if (!active.size && !activeChecks.size && !quiescenceUnproven && !storageFailed) { lease.updateWriter({ state: "none" }); lease.release(); }
	}
}
