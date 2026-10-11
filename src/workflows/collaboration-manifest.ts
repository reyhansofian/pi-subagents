import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { collaborationObject as object, collaborationString as text, collaborationInteger as integer, collaborationArray as list, readCollaborationJson, type CollaborationJson } from "./collaboration-json.ts";

export interface CollaborationResource {
	id: string;
	kind: "path" | "exclusive";
	path?: string;
	initialPublication?: { version: number; digest: string };
}
export interface CollaborationCheck {
	id: string;
	command: string;
	timeoutMs: number;
	reads: string[];
	writes: string[];
	exclusive: string[];
}
export interface CollaborationPackage {
	id: string;
	goal: string;
	rationale: string;
	constraints: string[];
	completion: string[];
	reads: string[];
	writes: string[];
	exclusive: string[];
	prerequisites: string[];
	requires: { packageId: string; resourceId: string; version: number }[];
	publishes: { resourceId: string; version: number }[];
	checks: CollaborationCheck[];
	configuration: { agent: string; model?: string; thinking?: string };
}
export interface CollaborationRuntime {
	/** Explicit offline providers need no network. Otherwise enroll the selected native Codex route. */
	network: "openai-codex" | "none";
	/** Explicit test-only hosted documentation route, separate from provider authority. */
	context7?: { path: string; digest: string };
	/** Fixed runtime assets outside the ticket workspace. Each tree is hashed at enrollment. */
	assets: { path: string; digest: string }[];
	/** Host-approved immutable extension identities and their declared effects. */
	extensions: { path: string; digest: string; effects: ("local-filesystem" | "provider-network" | "context7-network")[] }[];
	/** Explicit names only. Values come from the existing host configuration and never enter artifacts. */
	environment: string[];
}
export interface CollaborationManifest {
	schemaVersion: 1;
	workflowId: string;
	runId: string;
	manifestVersion: number;
	workspace: string;
	goal: string;
	rationale: string;
	constraints: string[];
	completion: string[];
	concurrency: number;
	resources: CollaborationResource[];
	packages: CollaborationPackage[];
	combinedChecks: CollaborationCheck[];
	reconciliation?: CollaborationPackage;
	runtime: CollaborationRuntime;
}
export function collaborationDigest(root: string): string {
	const hash = createHash("sha256");
	let count = 0;
	function record(value: string | Buffer): void {
		const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
		hash.update(String(bytes.length) + ":"); hash.update(bytes);
	}
	function visit(current: string, relative: string, depth: number): void {
		if (++count > 100_000 || depth > 64) throw new Error("Content identity exceeds bounded enrollment limits; narrow resources.");
		const info = fs.lstatSync(current);
		record(relative);
		if (info.isSymbolicLink()) { record("symlink"); record(fs.readlinkSync(current)); }
		else if (info.isFile()) {
			record("file"); record(String(info.mode & 0o111));
			const fd = fs.openSync(current, "r");
			try {
				record(String(info.size));
				const buffer = Buffer.allocUnsafe(64 * 1024);
				let read: number;
				while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
			} finally { fs.closeSync(fd); }
		} else if (info.isDirectory()) {
			record("directory");
			for (const entry of fs.readdirSync(current).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
				if (depth === 0 && (entry === ".git" || entry === ".jj")) continue;
				visit(path.join(current, entry), relative ? relative + "/" + entry : entry, depth + 1);
			}
		} else throw new Error("Special files cannot form a publication: " + current);
	}
	visit(root, "", 0);
	return hash.digest("hex");
}
function id(value: CollaborationJson | undefined, label: string): string {
	const result = text(value, label, 128);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(result)) throw new Error(label + " must be a safe identifier.");
	return result;
}
const ids = (value: CollaborationJson | undefined, label: string) => {
	const result = list(value, label, id);
	if (new Set(result).size !== result.length) throw new Error(label + " contains duplicates.");
	return result;
};
const texts = (value: CollaborationJson | undefined, label: string) => list(value, label, (v, l) => text(v, l), 32);
function check(value: CollaborationJson | undefined, label: string): CollaborationCheck {
	const row = object(value, ["id", "command", "timeoutMs", "reads", "writes", "exclusive"], label);
	return { id: id(row.id, label), command: text(row.command, label, 16384), timeoutMs: integer(row.timeoutMs, label, 86400000), reads: ids(row.reads, label), writes: ids(row.writes, label), exclusive: ids(row.exclusive, label) };
}
function configuration(config: import("./collaboration-json.ts").CollaborationJsonObject, label: string): CollaborationPackage["configuration"] {
	const result: CollaborationPackage["configuration"] = { agent: id(config.agent, label) };
	if (config.model !== undefined) result.model = text(config.model, label, 256);
	if (config.thinking !== undefined) result.thinking = text(config.thinking, label, 32);
	return result;
}
function workPackage(value: CollaborationJson | undefined, label: string): CollaborationPackage {
	const row = object(value, ["id", "goal", "rationale", "constraints", "completion", "reads", "writes", "exclusive", "prerequisites", "requires", "publishes", "checks", "configuration"], label);
	const config = object(row.configuration, ["agent", "model", "thinking"], label + ".configuration");
	return {
		id: id(row.id, label), goal: text(row.goal, label), rationale: text(row.rationale, label),
		constraints: texts(row.constraints, label), completion: texts(row.completion, label),
		reads: ids(row.reads, label), writes: ids(row.writes, label), exclusive: ids(row.exclusive, label), prerequisites: ids(row.prerequisites, label),
		requires: list(row.requires, label, (v, l) => { const r = object(v, ["packageId", "resourceId", "version"], l); return { packageId: id(r.packageId, l), resourceId: id(r.resourceId, l), version: integer(r.version, l) }; }),
		publishes: list(row.publishes, label, (v, l) => { const r = object(v, ["resourceId", "version"], l); return { resourceId: id(r.resourceId, l), version: integer(r.version, l) }; }),
		checks: list(row.checks, label, check, 32),
		configuration: configuration(config, label),
	};
}
export function collaborationResourcePath(manifest: CollaborationManifest, resourceId: string): string {
	const resource = manifest.resources.find((r) => r.id === resourceId);
	if (!resource || resource.kind !== "path" || !resource.path) throw new Error("Unknown path resource " + resourceId);
	return path.join(manifest.workspace, resource.path);
}
export function normalizeCollaborationManifest(input: CollaborationManifest | CollaborationJson): CollaborationManifest {
	const source = JSON.stringify(input) ?? "null";
	if (Buffer.byteLength(source) > 256 * 1024) throw new Error("Collaboration manifest exceeds 256 KiB.");
	const value = readCollaborationJson(source);
	const row = object(value, ["schemaVersion", "workflowId", "runId", "manifestVersion", "workspace", "goal", "rationale", "constraints", "completion", "concurrency", "resources", "packages", "combinedChecks", "reconciliation", "runtime"], "manifest");
	if (row.schemaVersion !== 1) throw new Error("Unsupported collaboration schemaVersion.");
	const workspace = text(row.workspace, "workspace");
	if (!path.isAbsolute(workspace) || fs.realpathSync.native(workspace) !== path.resolve(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error("workspace must be an existing canonical directory.");
	const runtime = object(row.runtime, ["assets", "extensions", "environment", "network", "context7"], "runtime");
	if (runtime.network !== undefined && runtime.network !== "none" && runtime.network !== "openai-codex") throw new Error("shared-workspace-unsupported: required provider transport is not enrolled.");
	const context7 = runtime.context7 === undefined ? undefined : object(runtime.context7, ["path", "digest"], "runtime.context7");
	if (runtime.context7 && runtime.network === "none") throw new Error("shared-workspace-unsupported: hosted Context7 cannot use an offline runtime.");
	const manifest: CollaborationManifest = {
		schemaVersion: 1, workflowId: id(row.workflowId, "workflowId"), runId: id(row.runId, "runId"), manifestVersion: integer(row.manifestVersion, "manifestVersion"),
		workspace, goal: text(row.goal, "goal"), rationale: text(row.rationale, "rationale"), constraints: texts(row.constraints, "constraints"), completion: texts(row.completion, "completion"),
		concurrency: row.concurrency === undefined ? 2 : integer(row.concurrency, "concurrency", 256),
		resources: list(row.resources, "resources", (v, l) => {
			const r = object(v, ["id", "kind", "path", "initialPublication"], l);
			if (r.kind !== "path" && r.kind !== "exclusive") throw new Error(l + " kind must be path or exclusive.");
			let relative: string | undefined;
			if (r.kind === "path") {
				relative = text(r.path, l, 1024);
				if (path.isAbsolute(relative) || relative.split(/[\\/]/u).some((p) => !p || p === "." || p === ".." || p === ".git" || p === ".jj") || /[\r\n,:]/u.test(relative)) throw new Error("Resource path must be relative without aliases, traversal, metadata or delimiters.");
				const full = path.join(workspace, relative);
				if (fs.realpathSync.native(full) !== full) throw new Error("Resource path must exist without symlink aliases: " + relative);
			} else if (r.path !== undefined) throw new Error("Exclusive resources do not have filesystem paths.");
			let initialPublication: CollaborationResource["initialPublication"];
			if (r.initialPublication !== undefined) {
				const p = object(r.initialPublication, ["version", "digest"], l);
				const digest = text(p.digest, l, 64);
				if (!/^[a-f0-9]{64}$/u.test(digest) || !relative || collaborationDigest(path.join(workspace, relative)) !== digest) throw new Error("Initial publication digest is not current: " + r.id);
				initialPublication = { version: integer(p.version, l), digest };
			}
			const resource: CollaborationResource = { id: id(r.id, l), kind: r.kind };
			if (relative) resource.path = relative;
			if (initialPublication) resource.initialPublication = initialPublication;
			return resource;
		}),
		packages: list(row.packages, "packages", workPackage),
		combinedChecks: list(row.combinedChecks, "combinedChecks", check, 32),
		runtime: {
			network: runtime.network === "none" ? "none" : "openai-codex",
			assets: list(runtime.assets, "runtime.assets", (v, l) => { const a = object(v, ["path", "digest"], l); return { path: text(a.path, l), digest: text(a.digest, l, 64) }; }, 64),
			extensions: list(runtime.extensions, "runtime.extensions", (v, l) => {
				const a = object(v, ["path", "digest", "effects"], l);
				const effects = list(a.effects, l, (e) => { if (e !== "local-filesystem" && e !== "provider-network" && e !== "context7-network") throw new Error("Unmanaged/remote capability cannot enroll: " + e); return e; }, 2);
				return { path: text(a.path, l), digest: text(a.digest, l, 64), effects };
			}, 64),
			environment: list(runtime.environment, "runtime.environment", (v, l) => text(v, l, 128), 64),
		},
	};
	if (context7) manifest.runtime.context7 = { path: text(context7.path, "runtime.context7.path"), digest: text(context7.digest, "runtime.context7.digest", 64) };
	if (manifest.runtime.context7 && !manifest.runtime.extensions.some((entry) => entry.path === manifest.runtime.context7!.path && entry.digest === manifest.runtime.context7!.digest && entry.effects.includes("context7-network"))) throw new Error("shared-workspace-unsupported: configured Context7 factory lacks its exact immutable source/effect binding.");
	for (const entry of manifest.runtime.extensions) if (entry.effects.includes("context7-network") && entry.path !== manifest.runtime.context7?.path) throw new Error("shared-workspace-unsupported: Context7 effect cannot enroll another extension.");
	if (row.reconciliation !== undefined) manifest.reconciliation = workPackage(row.reconciliation, "reconciliation");
	const resources = new Map(manifest.resources.map((r) => [r.id, r]));
	const packages = new Map(manifest.packages.map((p) => [p.id, p]));
	if (!packages.size || resources.size !== manifest.resources.length || packages.size !== manifest.packages.length) throw new Error("Resources/packages must have unique identities and at least one package.");
	for (const resource of manifest.resources) if (resource.path && manifest.resources.some((other) => other.id !== resource.id && other.path === resource.path)) throw new Error("A path must have one canonical resource identity.");
	function verifyAccess(access: { reads: string[]; writes: string[]; exclusive: string[] }): void {
		for (const resourceId of [...access.reads, ...access.writes]) if (resources.get(resourceId)?.kind !== "path") throw new Error("Unknown path resource " + resourceId);
		for (const resourceId of access.exclusive) if (resources.get(resourceId)?.kind !== "exclusive") throw new Error("Unknown exclusive resource " + resourceId);
	}
	for (const pkg of [...manifest.packages, ...(manifest.reconciliation ? [manifest.reconciliation] : [])]) {
		verifyAccess(pkg);
		for (const required of pkg.requires) {
			const producer = packages.get(required.packageId);
			if (!producer || !pkg.reads.includes(required.resourceId) || !producer.publishes.some((p) => p.resourceId === required.resourceId && p.version === required.version)) throw new Error("Invalid producer/publication reference in " + pkg.id);
		}
		for (const prior of pkg.prerequisites) if (!packages.has(prior)) throw new Error("Unknown prerequisite " + prior);
		for (const publication of pkg.publishes) if (!pkg.writes.includes(publication.resourceId)) throw new Error("Only an owned write resource can be published.");
		for (const c of pkg.checks) {
			verifyAccess(c);
			if (c.reads.some((r) => !pkg.reads.includes(r) && !pkg.writes.includes(r)) || c.writes.some((r) => !pkg.writes.includes(r)) || c.exclusive.some((r) => !pkg.exclusive.includes(r))) throw new Error("Package checks cannot widen resource authority.");
		}
		if (pkg === manifest.reconciliation && packages.has(pkg.id)) throw new Error("Reconciliation must have a distinct package identity.");
		if (manifest.runId.length + pkg.id.length + 1 > 128) throw new Error("Combined workflow/package key exceeds 128 characters.");
		for (const read of pkg.reads) if (pkg !== manifest.reconciliation && !resources.get(read)?.initialPublication && !pkg.requires.some((r) => r.resourceId === read) && !pkg.writes.includes(read)) throw new Error("Read requires a declared current publication: " + read);
		for (const write of pkg.writes) if (!fs.statSync(collaborationResourcePath(manifest, write)).isDirectory()) throw new Error("Atomic file replacement requires an explicit owned directory: " + write);
	}
	for (const c of manifest.combinedChecks) verifyAccess(c);
	if (!manifest.combinedChecks.length) throw new Error("Combined verification is required.");
	const visiting = new Set<string>(), visited = new Set<string>();
	function visit(pkg: CollaborationPackage): void {
		if (visiting.has(pkg.id)) throw new Error("Collaboration prerequisite cycle.");
		if (visited.has(pkg.id)) return;
		visiting.add(pkg.id);
		for (const prior of new Set([...pkg.prerequisites, ...pkg.requires.map((r) => r.packageId)])) visit(packages.get(prior)!);
		visiting.delete(pkg.id); visited.add(pkg.id);
	}
	for (const pkg of manifest.packages) visit(pkg);
	return manifest;
}
