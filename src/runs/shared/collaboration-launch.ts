import * as fs from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { SubagentRunConfig } from "../background/subagent-runner.ts";
import type { Duplex } from "node:stream";
import { attachCollaborationProviderRelay, collaborationProviderAuthority, assertCollaborationCredentialLease } from "./collaboration-provider-transport.ts";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { projectCollaborationArtifacts } from "./collaboration-artifacts.ts";
import { waitForCollaborationQuiescence, CollaborationQuiescenceError } from "./collaboration-quiescence.ts";
import type { CollaborationManifest, CollaborationPackage } from "../../workflows/collaboration-manifest.ts";
import { collaborationDigest, collaborationResourcePath } from "../../workflows/collaboration-manifest.ts";
import { spawnCollaborationSandbox, type CollaborationSandboxProcess } from "./collaboration-sandbox.ts";
import { supervisorChannelDir } from "./child-tool-plan.ts";
import { ensureSupervisorChannelDir } from "../../intercom/native-supervisor-channel.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { TEMP_ROOT_DIR } from "../../shared/types.ts";
import { childCacheRetentionEnv } from "../../shared/child-cache-retention.ts";

export interface CollaborationLaunchGrant {
	manifest: CollaborationManifest;
	pkg: CollaborationPackage;
	readArtifacts?: string[];
	bindings: Record<string, { path: string; version: number; digest: string }>;
	onDependencyAck: () => void;
	onStarted: (pid: number, runId: string, configuration: CollaborationPackage["configuration"], nativeArtifactDir: string) => void;
}
interface Entry { grant: CollaborationLaunchGrant; process?: CollaborationSandboxProcess; used: boolean }
const grants = new Map<string, Entry>();
export interface CollaborationLaunchHandle { token: string; drain(): Promise<void>; stopAndDrain(): Promise<void>; stop(): void; dispose(): void }
export function registerCollaborationLaunch(grant: CollaborationLaunchGrant): CollaborationLaunchHandle {
	const token = randomUUID(), entry: Entry = { grant, used: false };
	grants.set(token, entry);
	return {
		token,
		async drain() {
			if (!entry.used) throw new Error("Native collaboration launch did not enroll; no publication is permitted.");
			if (entry.process) {
				await entry.process.terminal;
				if (!entry.process.initialized) throw new CollaborationQuiescenceError("quiescence-unproven: namespace identity is absent.");
				const identity = await entry.process.initialized;
				await waitForCollaborationQuiescence(identity);
			}
		},
		async stopAndDrain() {
			if (!entry.process) return;
			entry.process.stop();
			await entry.process.terminal;
			if (!entry.process.initialized) throw new CollaborationQuiescenceError("quiescence-unproven: namespace identity is absent.");
			await waitForCollaborationQuiescence(await entry.process.initialized);
		},
		stop() { entry.process?.stop(); },
		dispose() { if (!entry.process || entry.process.process.exitCode !== null || entry.process.process.signalCode !== null) grants.delete(token); },
	};
}
export function collaborationRunMarker(runId: string): string {
	if (!/^[A-Za-z0-9._-]+$/u.test(runId)) throw new Error("Invalid collaboration native run identity.");
	return path.join(TEMP_ROOT_DIR, "collaboration-native-runs", runId + ".json");
}
export function isCollaborationNativeRun(runId: string): boolean { return fs.existsSync(collaborationRunMarker(runId)); }

function executable(name: string): string {
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		const file = path.join(directory, name);
		try { fs.accessSync(file, fs.constants.X_OK); return fs.realpathSync.native(file); } catch {}
	}
	throw new Error("shared-workspace-unsupported: required executable unavailable: " + name);
}
export function collaborationSandboxTools() {
	const setpriv = executable("setpriv");
	// Use the same unprivileged util-linux distribution, not a host setuid mount wrapper.
	const sibling = (name: string) => {
		const candidate = path.join(path.dirname(setpriv), name);
		try { fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync.native(candidate); } catch { return executable(name); }
	};
	return { setpriv, unshare: sibling("unshare"), mount: sibling("mount"), shell: executable("bash"), chroot: executable("chroot") };
}
export function verifyCollaborationRuntime(manifest: CollaborationManifest): void {
	for (const asset of [...manifest.runtime.assets, ...manifest.runtime.extensions]) {
		const canonical = fs.realpathSync.native(asset.path);
		if (canonical !== asset.path || canonical === manifest.workspace || canonical.startsWith(manifest.workspace + path.sep)) throw new Error("shared-workspace-unsupported: runtime assets must be canonical and fixed outside the mutable workspace.");
		if (collaborationDigest(canonical) !== asset.digest) throw new Error("shared-workspace-unsupported: immutable runtime identity changed: " + canonical);
	}
}
export function spawnEnrolledCollaborationRunner(input: {
	token: string; command: string; args: string[]; cwd: string; configPath: string;
	config: SubagentRunConfig; env: NodeJS.ProcessEnv; hostStatus: Omit<import("../../shared/types.ts").AsyncStatus, "pid" | "processTerminal">;
}): CollaborationSandboxProcess {
	const entry = grants.get(input.token);
	if (!entry || entry.used) throw new Error("Collaboration execution grant is missing, obsolete or already consumed.");
	const { manifest, pkg } = entry.grant;
	if (input.env.PI_ASYNC_NATIVE_RUNNER !== "1") throw new Error("shared-workspace-unsupported: the protected provider transport is enrolled only for the existing native Node runner; no Bun/proxy transport fallback was selected.");
	if (input.cwd !== manifest.workspace) throw new Error("Collaboration runner changed the canonical workspace.");
	const steps = input.config.steps;
	if (!steps || steps.length !== 1 || input.config.revivalLease) throw new Error("shared-workspace-unsupported: collaboration requires a fresh single native local runner.");
	const step = steps[0]!;
	if (!Value.Check(Type.Object({
		agent: Type.String(), model: Type.String(), sessionFile: Type.Optional(Type.String()), thinking: Type.Optional(Type.String()),
		launchResolvedExtensions: Type.Object({ disableAmbientExtensions: Type.Boolean(), effective: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: true }),
	}, { additionalProperties: true }), step)) throw new Error("shared-workspace-unsupported: selected single-step launch metadata is incomplete.");
	const acceptance = "effectiveAcceptance" in step ? step.effectiveAcceptance : undefined;
	if (!acceptance) throw new Error("shared-workspace-unsupported: parent-resolved acceptance is absent.");
	if (acceptance.verify.length || acceptance.toolEvidence.length) throw new Error("shared-workspace-unsupported: acceptance verify/tool-evidence requires parent-certified confined evidence; these gates cannot be trusted from worker proposals. Use declared package checks without disabling required gates.");
	const authority = manifest.runtime.network === "none" ? undefined : collaborationProviderAuthority(step.model);
	if (("runner" in step && step.runner) || ("machine" in step && step.machine)) throw new Error("shared-workspace-unsupported: a fresh native local runner is required.");
	input.config.collaborationProviderTransport = { model: step.model };
	if (authority) { input.config.collaborationProviderTransport.authority = authority; input.config.collaborationProviderTransport.fd = 3; }
	const resolved = step.launchResolvedExtensions;
	if (!resolved?.disableAmbientExtensions) throw new Error("shared-workspace-unsupported: ambient extensions have no immutable capability snapshot. Enroll the existing selected extension configuration explicitly; no extensions were removed.");
	if (("builtinMcpTools" in step && Array.isArray(step.builtinMcpTools) && step.builtinMcpTools.length) || ("mcpDirectTools" in step && Array.isArray(step.mcpDirectTools) && step.mcpDirectTools.length)) throw new Error("shared-workspace-unsupported: host/remote MCP filesystem effects have not been enrolled.");
	verifyCollaborationRuntime(manifest);
	const packageRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
	const extensionPaths = input.config.collaborationExtensionPaths;
	if (!Value.Check(Type.Array(Type.String()), extensionPaths)) throw new Error("shared-workspace-unsupported: native resolved extension paths are missing.");
	for (const extension of extensionPaths) {
		const canonical = fs.realpathSync.native(extension);
		const bundled = canonical.startsWith(packageRoot + path.sep) && manifest.runtime.assets.some((a) => canonical === a.path || canonical.startsWith(a.path + path.sep));
		if (!bundled && !manifest.runtime.extensions.some((e) => e.path === canonical)) throw new Error("shared-workspace-unsupported: extension lacks host-approved immutable effects: " + canonical);
	}
	const asyncDir = input.config.asyncDir;
	const runId = input.config.id;
	if (!Value.Check(Type.String(), asyncDir) || !Value.Check(Type.String(), runId)) throw new Error("Collaboration runner lacks private artifact identity.");
	const privateRoot = path.join(asyncDir, "collaboration-private");
	const home = path.join(privateRoot, "home"), temp = path.join(privateRoot, "tmp");
	const sessions = path.join(privateRoot, "sessions"), artifacts = path.join(privateRoot, "artifacts");
	for (const root of [privateRoot, home, temp, sessions, artifacts]) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	input.config.collaborationPrivateDir = privateRoot;
	input.config.collaborationDependencyBindings = entry.grant.bindings;
	input.config.collaborationManifestVersion = manifest.manifestVersion;
	const parentResultPath = String(input.config.resultPath);
	input.config.sessionDir = sessions;
	input.config.artifactsDir = artifacts;
	if (step.sessionFile) step.sessionFile = path.join(sessions, "session.jsonl");
	writePrivateAtomicJson(input.configPath, input.config);
	for (const asset of manifest.runtime.assets) if (privateRoot === asset.path || privateRoot.startsWith(asset.path + path.sep)) throw new Error("shared-workspace-unsupported: mutable private artifacts overlap runtime code assets.");
	const namespaceRoot = fs.mkdtempSync(path.join(TEMP_ROOT_DIR, "collaboration-ns-"));
	const tools = collaborationSandboxTools();
	for (const executable of [...Object.values(tools), fs.realpathSync.native(input.command)]) {
		if (!executable.startsWith("/nix/store/") && !manifest.runtime.assets.some((asset) => executable === asset.path || executable.startsWith(asset.path + path.sep))) throw new Error("shared-workspace-unsupported: launch executable lacks immutable asset enrollment: " + executable);
	}
	const reads = pkg.reads.map((r) => collaborationResourcePath(manifest, r));
	const privateWrites = [privateRoot];
	const readRuntime = [...manifest.runtime.assets, ...manifest.runtime.extensions].map((a) => a.path);
	readRuntime.push(...(entry.grant.readArtifacts ?? []));
	const clientChannel = supervisorChannelDir(runId, String(step.agent), 0);
	ensureSupervisorChannelDir(clientChannel);
	privateWrites.push(path.join(clientChannel, "requests"));
	readRuntime.push(path.join(clientChannel, "replies"), input.configPath, asyncDir, "/proc");
	if (fs.existsSync("/nix/store")) readRuntime.push("/nix/store");
	const fanout = input.config.runFanoutBudget;
	if (fanout?.directory) readRuntime.push(fs.realpathSync.native(fanout.directory));
	// These are host-owned read paths. Do not copy credentials or change routes.
	const oldHome = process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? "", ".pi", "agent");
	if (!Value.Check(Type.String(), input.config.piPackageRoot)) throw new Error("shared-workspace-unsupported: selected host exposes no immutable read-only credential module.");
	if (path.join(oldHome, "auth.json").startsWith(manifest.workspace + path.sep)) throw new Error("shared-workspace-unsupported: existing credential source must be host-owned outside the ticket workspace.");
	if (authority) assertCollaborationCredentialLease(path.join(oldHome, "auth.json"), input.config.deadlineAt);
	const priorCatalog = path.join(oldHome, "models-store.json");
	if (fs.existsSync(priorCatalog)) {
		const fd = fs.openSync(priorCatalog, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		try {
			const info = fs.fstatSync(fd);
			if (!info.isFile() || info.size > 1024 * 1024) throw new Error("shared-workspace-unsupported: existing model catalog cache exceeds bounded enrollment.");
			const bytes = Buffer.alloc(info.size); fs.readSync(fd, bytes, 0, bytes.length, 0);
			fs.writeFileSync(path.join(privateRoot, "models-store.json"), bytes, { mode: 0o600 });
		} finally { fs.closeSync(fd); }
	}
	input.config.collaborationModelStorage = { readonlyAuthModule: path.join(input.config.piPackageRoot, "dist/core/auth-storage.js"), authPath: path.join(oldHome, "auth.json"), modelsPath: path.join(oldHome, "models.json"), modelsStorePath: path.join(privateRoot, "models-store.json") };
	writePrivateAtomicJson(input.configPath, input.config);
	for (const name of ["models.json", "settings.json"]) {
		const file = path.join(oldHome, name);
		if (fs.existsSync(file)) readRuntime.push(fs.realpathSync.native(file));
	}
	const env: import("./collaboration-sandbox.ts").CollaborationSandboxInput["env"] = { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: temp, PI_CODING_AGENT_DIR: oldHome, RLM_WORKSPACE: manifest.workspace };
	const runtimeKeys = [...Object.keys(childCacheRetentionEnv()), "PI_CACHE_RETENTION", "PI_SUBAGENT_CACHE_RETENTION", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "PI_CODING_AGENT_PACKAGE_ROOT", "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT", "PI_PACKAGE_DIR", "JITI_ALIAS", "PI_ASYNC_NATIVE_RUNNER", "PI_SUBAGENTS_TEMP_ROOT", "PI_SUBAGENT_PARENT_SESSION"];
	for (const name of [...runtimeKeys, ...manifest.runtime.environment]) if (input.env[name] !== undefined) env[name] = input.env[name]!;
	fs.mkdirSync(path.dirname(collaborationRunMarker(runId)), { recursive: true, mode: 0o700 });
	writePrivateAtomicJson(collaborationRunMarker(runId), { version: 1, runId, workspace: manifest.workspace, manifestVersion: manifest.manifestVersion, packageId: pkg.id });
	// The coordinator has already persisted the full reservation. Record spawning
	// before the OS launch; an interrupted startup is a recovery obligation.
	entry.used = true;
	const sandbox = spawnCollaborationSandbox({
		workspace: manifest.workspace, hostSocketIsolation: true, providerTransport: Boolean(authority), initializationToken: randomUUID(), namespaceRoot, readPaths: reads, writePaths: pkg.writes.map((r) => collaborationResourcePath(manifest, r)),
		privateWritePaths: privateWrites, runtimePaths: readRuntime,
		command: fs.realpathSync.native(input.command), args: input.args, env,
		enrolledEnvironment: [...runtimeKeys, ...manifest.runtime.environment, "RLM_WORKSPACE"], tools,
	});
	entry.process = sandbox;
	if (authority) {
		// SAFETY: providerTransport adds exactly one duplex pipe at stdio[3]; the sandbox owns this descriptor.
		const socket = sandbox.process.stdio[3] as Duplex | null;
		if (!socket) { sandbox.stop(); throw new Error("Confined provider transport descriptor is unavailable."); }
		const relay = attachCollaborationProviderRelay(socket, authority, { agentDir: oldHome, cwd: manifest.workspace, authPath: path.join(oldHome, "auth.json") });
		sandbox.process.once("close", () => relay.close());
	}
	if (!sandbox.process.pid) { sandbox.stop(); throw new Error("Collaboration namespace launch has no process identity."); }
	const projection = projectCollaborationArtifacts({ privateRoot, parentDir: asyncDir, resultPath: parentResultPath, runId, processInstanceId: String(input.config.runnerProcessInstanceId), hostPid: sandbox.process.pid, stop: sandbox.stop, bindings: entry.grant.bindings, executionToken: input.token, manifestVersion: manifest.manifestVersion, onDependencyAck: entry.grant.onDependencyAck, hostStatus: input.hostStatus, acceptance, agent: step.agent, model: step.model, thinking: step.thinking, cwd: manifest.workspace });
	sandbox.process.once("close", (code, signal) => { void projection.ended(code, signal).finally(() => projection.close()).catch(() => sandbox.stop()); });
	const configuration: CollaborationPackage["configuration"] = { agent: step.agent, model: step.model };
	if (step.thinking !== undefined) configuration.thinking = step.thinking;
	try { entry.grant.onStarted(sandbox.process.pid, runId, configuration, asyncDir); } catch (error) { sandbox.stop(); projection.close(); throw error; }
	return sandbox;
}
