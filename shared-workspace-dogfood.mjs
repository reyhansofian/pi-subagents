#!/usr/bin/env node
import fs from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = path.dirname(fileURLToPath(import.meta.url));
const moduleAt = async (relative) => {
	const compiled = path.join(root, relative + ".js");
	const source = path.join(root, relative + ".ts");
	return import(pathToFileURL(fs.existsSync(compiled) ? compiled : source).href);
};
const { normalizeCollaborationManifest, collaborationDigest } = await moduleAt("src/workflows/collaboration-manifest");
const { collaborationArtifactDirectory } = await moduleAt("src/workflows/collaboration");
const { validateWorkflowScript } = await moduleAt("src/workflows/scripted-workflow");
const { requestCollaborationControl } = await moduleAt("src/workflows/collaboration-control");
const { readCollaborationSnapshot, validateCollaborationRecovery } = await moduleAt("src/workflows/collaboration-recovery");
const readJson = (file) => {
	const info = fs.statSync(file);
	if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Input must be a bounded JSON file.");
	return JSON.parse(fs.readFileSync(file, "utf8"));
};
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const canonical = (value) => fs.realpathSync.native(path.resolve(value));
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const loadPlan = (file) => {
	const plan = readJson(file);
	const manifest = normalizeCollaborationManifest(plan.manifest);
	const validation = validateWorkflowScript(fs.readFileSync(plan.workflow, "utf8"));
	if (!validation.ok) throw new Error(JSON.stringify(validation.errors));
	return { ...plan, manifest };
};
const request = (plan, manifest = plan.manifest, recovery) => {
	const args = { manifest };
	if (recovery) args.recovery = recovery;
	return { workflow: plan.workflow, cwd: manifest.workspace, async: true, args };
};
const [command, ...args] = process.argv.slice(2);
try {
	if (command === "package") {
		const target = path.resolve(args[0] ?? "");
		if (!args[0] || fs.existsSync(target) || inside(root, target)) throw new Error("Supply a new fixed-candidate directory outside the source tree.");
		if (!fs.existsSync(path.join(root, "node_modules"))) throw new Error("WORKSPACE_NOT_READY: prepared workspace dependencies are absent.");
		execFileSync(process.execPath, [path.join(root, "scripts/build-package.mjs")], { cwd: root, stdio: "inherit" });
		fs.mkdirSync(target, { recursive: true, mode: 0o700 });
		fs.cpSync(path.join(root, "dist-pkg"), target, { recursive: true });
		// Package the existing prepared dependency bytes. No install and no per-Coder checkout.
		fs.cpSync(path.join(root, "node_modules"), path.join(target, "node_modules"), { recursive: true, dereference: true });
		console.log(JSON.stringify({ candidate: canonical(target), digest: collaborationDigest(target), preparedDependencies: true }));
	} else if (command === "prepare") {
		const [workspaceArg, outputArg, configurationFile, extensionsFile] = args;
		if (!workspaceArg || !outputArg || !configurationFile) throw new Error("prepare WORKSPACE NEW_OUTPUT_DIRECTORY CONFIGURATION_JSON [AUTHENTIC_SELECTED_EXTENSIONS_JSON]");
		if (!fs.existsSync(path.join(root, "index.js"))) throw new Error("Preparation requires the fixed compiled candidate. Package it first.");
		const workspace = canonical(workspaceArg), output = path.resolve(outputArg);
		if (!fs.existsSync(path.join(workspace, ".git"))) throw new Error("Use the existing isolated ticket Git worktree. This driver does not create per-Coder worktrees.");
		if (inside(workspace, root) || inside(root, workspace) || inside(root, output) || inside(output, root) || fs.existsSync(output)) throw new Error("Use a fixed packaged runtime and a new separate output directory, both outside the mutable ticket workspace.");
		const configuration = readJson(configurationFile);
		if (!configuration.agent || (configuration.model !== undefined && !configuration.model.startsWith("openai-codex/"))) throw new Error("Supply the existing authorized agent/model/thinking configuration; this driver does not choose or override it.");
		const extensions = extensionsFile ? readJson(extensionsFile) : [];
		if (!Array.isArray(extensions)) throw new Error("Extensions must be the host-resolved immutable capability snapshot.");
		const target = path.join(workspace, "collaboration-dogfood");
		if (fs.existsSync(target)) throw new Error("Dogfood target already exists. Preserve it; use status/recovery, not preparation again.");
		for (const name of ["digest", "fifo", "verify", "checks"]) fs.mkdirSync(path.join(target, name), { recursive: true });
		const prefix = "collaboration-dogfood/";
		const node = canonical(process.execPath);
		const checks = {
			digest: `const a=require("assert/strict"),{digest}=require("../digest/index.cjs");a.equal(digest(""),"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");a.equal(digest("abc"),"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");a.equal(digest("é"),require("crypto").createHash("sha256").update("é","utf8").digest("hex"));`,
			fifo: `const a=require("assert/strict"),{queue}=require("../fifo/index.cjs");for(const n of [0,-1,1.5])a.throws(()=>queue(n));const q=queue(2);a.equal(q.size(),0);a.equal(q.shift(),undefined);q.push("a");q.push("b");a.equal(q.size(),2);a.throws(()=>q.push("c"));a.equal(q.shift(),"a");q.push("c");a.equal(q.shift(),"b");a.equal(q.shift(),"c");a.equal(q.shift(),undefined);a.equal(q.size(),0);`,
			verify: `const a=require("assert/strict"),{verify}=require("../verify/index.cjs");a.equal(verify("abc","ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),true);a.equal(verify("abcd","ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),false);for(const h of ["","bad","A".repeat(64),"0".repeat(64)])a.equal(verify("abc",h),false);`,
		};
		for (const [name, source] of Object.entries(checks)) fs.writeFileSync(path.join(target, "checks", name + ".cjs"), source + "\n");
		fs.writeFileSync(path.join(target, "checks", "combined.cjs"), 'require("./digest.cjs");require("./fifo.cjs");require("./verify.cjs");\n');
		const resources = ["digest", "fifo", "verify", "checks"].map((id) => {
			const resource = { id, kind: "path", path: prefix + id };
			if (id === "checks") resource.initialPublication = { version: 1, digest: collaborationDigest(path.join(target, id)) };
			return resource;
		});
		const check = (id, reads) => ({ id, command: JSON.stringify(node) + " " + prefix + "checks/" + id + ".cjs", timeoutMs: 10000, reads: [...reads, "checks"], writes: [], exclusive: [] });
		const base = (id, resource, goal, reads = []) => ({
			id, goal, rationale: "A bounded useful module with real behavior checks in one shared ticket worktree",
			constraints: ["CommonJS index.cjs export; no dependency installation, VCS mutation or undeclared files", "Do not modify checks or fixed runtime assets"], completion: ["Configured package and stable combined behavior checks pass"],
			reads: [...reads, "checks"], writes: [resource], exclusive: [], prerequisites: [], requires: [], publishes: [], checks: [], configuration,
		});
		const A = { ...base("A", "digest", "Implement digest(text): lowercase SHA-256 hex of UTF-8 text. Export digest from index.cjs."), publishes: [{ resourceId: "digest", version: 1 }], checks: [check("digest", ["digest"])] };
		const B = { ...base("B", "fifo", "Implement queue(capacity), a bounded ring-buffer FIFO with push(value), shift(), size(). Reject non-positive/non-integer capacities, throw when full, return undefined when empty, clear removed references. Export queue from index.cjs."), checks: [check("fifo", ["fifo"])] };
		const C = { ...base("C", "verify", "Implement verify(text,expected): boolean matching the published digest(text). Return false unless expected is exactly 64 lowercase hex characters. Use ../digest/index.cjs rather than reimplementing SHA-256. Export verify from index.cjs.", ["digest"]), requires: [{ packageId: "A", resourceId: "digest", version: 1 }], checks: [check("verify", ["digest", "verify"])] };
		const R = { ...base("R", "verify", "Repair a concrete combined verification failure only inside verify/index.cjs. Consume the published digest and failed check artifacts.", ["digest", "fifo"]), requires: [{ packageId: "A", resourceId: "digest", version: 1 }], checks: [check("verify", ["digest", "verify"])] };
		const manifest = normalizeCollaborationManifest({
			schemaVersion: 1, workflowId: "shared-workspace-dogfood", runId: "dogfood-" + randomUUID(), manifestVersion: 1, workspace,
			goal: "Implement digest, bounded FIFO and a dependent digest verifier", rationale: "A/B are independent; C consumes A while compatible with B", constraints: ["Use the same canonical RLM_WORKSPACE; no per-Coder checkout"], completion: ["Stable combined checks pass after every implementation namespace drains"],
			concurrency: 2, resources, packages: [A, B, C], combinedChecks: [check("combined", ["digest", "fifo", "verify"])], reconciliation: R,
			runtime: { network: "openai-codex", assets: [{ path: canonical(root), digest: collaborationDigest(root) }], extensions, environment: [] },
		});
		fs.mkdirSync(output, { recursive: true, mode: 0o700 });
		const workflow = path.join(output, "workflow.js");
		fs.writeFileSync(workflow, "return await runs.collaborate(args.manifest, args.recovery);\n", { flag: "wx", mode: 0o600 });
		const plan = { version: 1, candidate: canonical(root), workflow, manifest, enrollmentReady: Boolean(extensionsFile), enrollmentNote: extensionsFile ? "Supplied by the authorized parent; runtime still validates the actual selected launch." : "Parent must materialize the authentic selected child-extension snapshot. No absence/effects or model override were inferred." };
		save(path.join(output, "plan.json"), plan);
		if (plan.enrollmentReady) save(path.join(output, "launch-request.json"), request(plan));
		console.log(JSON.stringify({ plan: path.join(output, "plan.json"), workflow, launchRequest: plan.enrollmentReady ? path.join(output, "launch-request.json") : null, enrollmentReady: plan.enrollmentReady, state: "prepared-not-launched" }));
	} else {
		const plan = loadPlan(args[0]);
		const artifactDir = collaborationArtifactDirectory(plan.manifest);
		if (command === "validate") {
			for (const asset of [...plan.manifest.runtime.assets, ...plan.manifest.runtime.extensions]) if (collaborationDigest(asset.path) !== asset.digest) throw new Error("Fixed runtime or extension identity changed.");
			console.log(JSON.stringify({ valid: true, runId: plan.manifest.runId, artifactDir, liveVerified: false, enrollmentReady: plan.enrollmentReady === true }));
		} else if (command === "request") {
			if (plan.enrollmentReady !== true) throw new Error("Live enrollment is blocked pending the authentic parent-selected child-extension snapshot. Do not infer absence or remove required capabilities.");
			console.log(JSON.stringify(request(plan), null, 2));
		} else if (command === "parent-host-command") {
			const selected = readJson(args[1]);
			if (!Value.Check(Type.Object({ version: Type.Literal(1), complete: Type.Literal(true), replacedExtension: Type.String(), extensions: Type.Array(Type.String()) }, { additionalProperties: false }), selected) || !selected.extensions.includes(selected.replacedExtension)) throw new Error("Supply the complete authentic selected parent-extension list, including builtins, and the exact pi-subagents entry being replaced. No registry was inferred.");
			const entries = [...new Set([path.join(root, "index.js"), ...selected.extensions.filter((value) => value !== selected.replacedExtension)])];
			const argv = ["pi", "--no-extensions", ...entries.flatMap((entry) => ["--extension", entry])];
			const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
			console.log(JSON.stringify({ cwd: plan.manifest.workspace, argv, shellCommand: argv.map(quote).join(" "), modelOverride: false, thinkingOverride: false, otherSelectedExtensionsPreserved: true, executed: false }, null, 2));
		}
		else if (command === "status") {
			const snapshot = path.join(artifactDir, "snapshot.json");
			console.log(JSON.stringify(fs.existsSync(snapshot) ? readCollaborationSnapshot(snapshot).summary : { state: "not-started", artifactDir }, null, 2));
		} else if (["stop", "pause-admissions", "resume-admissions", "ceiling"].includes(command)) {
			const id = requestCollaborationControl(artifactDir, command, command === "ceiling" ? Number(args[1]) : undefined);
			console.log(JSON.stringify({ id, state: "queued", artifactDir, quiescence: "not-established-by-this-receipt" }));
		} else if (command === "inspect-recovery") {
			const prior = readCollaborationSnapshot(path.join(artifactDir, "snapshot.json"));
			console.log(JSON.stringify({ epoch: prior.epoch, sequence: prior.sequence, workspaceDigest: collaborationDigest(plan.manifest.workspace), packages: prior.summary.packages, approvalRequired: true }, null, 2));
		} else if (command === "resume-request" || command === "serial-request") {
			const prior = readCollaborationSnapshot(path.join(artifactDir, "snapshot.json")), recovery = readJson(args[1]);
			const manifest = command === "serial-request" ? { ...prior.manifest, manifestVersion: prior.manifest.manifestVersion + 1, concurrency: 1 } : prior.manifest;
			validateCollaborationRecovery(recovery, prior, manifest);
			console.log(JSON.stringify(request(plan, manifest, recovery), null, 2));
		} else throw new Error("Commands: package, prepare, validate, request, status, stop, pause-admissions, resume-admissions, ceiling, inspect-recovery, resume-request, serial-request.");
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
