import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeCollaborationSocketPolicy } from "./collaboration-socket-policy.ts";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Experimental boundary primitive. Not an enrollment certificate for native
 * collaboration: SDK, extension, publication and lease checks remain required.
 */
export interface CollaborationSandboxInput {
	workspace: string;
	/** Host-generated nonce for the trusted namespace-init handshake. */
	initializationToken?: string;
	/** Probe-only tightening. Not a certificate for host IPC confinement. */
	networkIsolation?: boolean;
	/** Tighten IPC and networking together. Provider transport still requires enrollment. */
	hostSocketIsolation?: boolean;
	/** Parent-held ephemeral transport socket at fd 3; never inherited by tool spawns. */
	providerTransport?: boolean;
	/** Empty parent-owned mount target outside all worker scopes. */
	namespaceRoot: string;
	readPaths: string[];
	writePaths: string[];
	/** Host-enrolled per-execution artifacts, never shared authority directories. */
	privateWritePaths?: string[];
	/** Names authorized by the existing provider/configuration resolver. */
	enrolledEnvironment?: string[];
	runtimePaths: string[];
	command: string;
	args: string[];
	/** Explicit environment only. Never inherit the coordinator's environment. */
	env: Record<string, string>;
	tools: { setpriv: string; unshare: string; mount: string; shell: string; chroot: string };
}

export class CollaborationSandboxUnsupportedError extends Error {
	readonly code = "shared-workspace-unsupported";
	constructor(message: string) {
		super(message);
		this.name = "CollaborationSandboxUnsupportedError";
	}
}

function reject(message: string): never {
	throw new CollaborationSandboxUnsupportedError(message);
}

function canonical(input: string): string {
	if (!path.isAbsolute(input) || ["\0", "\n", "\r", ",", ":"].some((character) => input.includes(character))) reject("Use an absolute path without Landlock delimiters.");
	const resolved = fs.realpathSync.native(input);
	if (resolved !== path.resolve(input)) reject(`Enroll the canonical path, not an alias: ${input}`);
	return resolved;
}

function beneath(root: string, target: string): boolean {
	return target === root || target.startsWith(root + path.sep);
}

function auditWritableTree(root: string): void {
	let count = 0;
	function visit(current: string, depth: number): void {
		if (++count > 100_000 || depth > 32) reject("Writable scope exceeds the bounded inode audit; narrow the scope.");
		const info = fs.lstatSync(current);
		if (info.isSymbolicLink()) reject(`Writable scope contains a symlink: ${current}`);
		if (info.isFile()) {
			if (info.nlink !== 1) reject(`Writable inode has multiple links: ${current}`);
		} else if (info.isDirectory()) {
			const directory = fs.opendirSync(current);
			try {
				let entry: fs.Dirent | null;
				while ((entry = directory.readSync()) !== null) visit(path.join(current, entry.name), depth + 1);
			} finally { directory.closeSync(); }
		} else reject(`Writable scope contains a special file: ${current}`);
	}
	visit(root, 0);
}

// Arguments, never interpolated paths. Read-only inherited mounts also deny
// chmod/chown, which Landlock filesystem rights do not currently mediate.
const REANCHORED_BOOTSTRAP = `
set -eu
mount_tool="$1"; setpriv_tool="$2"; workspace="$3"; count="$4"; shift 4
while [ "$count" -gt 0 ]; do
  "$mount_tool" --bind "$1" "$1"
  "$mount_tool" -o remount,bind,rw "$1"
  shift
  count=$((count - 1))
done
cd "$workspace"
exec "$setpriv_tool" --ptracer none --no-new-privs --securebits=+noroot,+noroot_locked --bounding-set=-all --inh-caps=-all --ambient-caps=-all "$@"
`;

// A bind mount over "/" leaves the process on its old root reference.
// Use a separate target, then reanchor before adding writable submounts.
const BOOTSTRAP = `
set -eu
mount_tool="$1"; chroot_tool="$2"; shell_tool="$3"; inner="$4"; root="$5"; shift 5
"$mount_tool" --make-rprivate /
"$mount_tool" -o rbind,ro=recursive / "$root"
exec -a chroot "$chroot_tool" "$root" "$shell_tool" -c "$inner" collaboration-sandbox "$@"
`;

export interface CollaborationNamespaceIdentity {
	hostPid: number;
	hostStartTicks: string;
	initPid: number;
	initStartTicks: string;
	namespace: string;
}
export interface CollaborationSandboxProcess {
	initialized?: Promise<CollaborationNamespaceIdentity>;
	process: ChildProcessWithoutNullStreams;
	/** Only this close observation establishes that namespace init has stopped. */
	terminal: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	stop(): void;
}

/**
 * Requires exclusive operator custody of the workspace during enrollment.
 * Does not authorize remote tools or unmanaged processes.
 * No fallback is attempted if any kernel or util-linux operation fails.
 */
export function spawnCollaborationSandbox(input: CollaborationSandboxInput): CollaborationSandboxProcess {
	if (process.platform !== "linux") reject("Linux user/PID/mount namespaces and recursive read-only mounts are required.");
	let ptraceScope: number;
	try { ptraceScope = Number(fs.readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim()); } catch { reject("Yama ptrace protection is unavailable; the immutable namespace init cannot be certified."); }
	if (![1, 2, 3].includes(ptraceScope)) reject("Yama ptrace_scope must deny descendant attachment to namespace init. No host policy was changed.");
	const workspace = canonical(input.workspace);
	const namespaceRoot = canonical(input.namespaceRoot);
	if (beneath(workspace, namespaceRoot) || beneath(namespaceRoot, workspace) || fs.readdirSync(namespaceRoot).length) reject("Namespace root must be an empty parent-owned directory outside the workspace.");
	const writePaths = input.writePaths.map(canonical);
	const privateWritePaths = (input.privateWritePaths ?? []).map(canonical);
	for (const root of privateWritePaths) {
		if (beneath(workspace, root) || beneath(root, workspace) || beneath(root, namespaceRoot) || beneath(namespaceRoot, root)) reject("Runtime-private artifacts must be separate from the workspace and namespace root.");
		if (!fs.statSync(root).isDirectory()) reject("Runtime-private artifacts require directory roots.");
		auditWritableTree(root);
	}
	const readPaths = input.readPaths.map(canonical);
	const runtimePaths = input.runtimePaths.map(canonical);
	const command = canonical(input.command);
	// SAFETY: All five tool keys come from the fixed input contract; canonicalization preserves each key and executable identity.
	const tools = Object.fromEntries(Object.entries(input.tools).map(([key, value]) => [key, canonical(value)])) as CollaborationSandboxInput["tools"];
	if (writePaths.length > 32 || readPaths.length + runtimePaths.length > 128) reject("Too many scopes; narrow the manifest.");
	for (const writable of writePaths) {
		if (!beneath(workspace, writable) || writable === workspace) reject("Writes require a proper directory scope inside the workspace.");
		if (!fs.statSync(writable).isDirectory()) reject("Writable roots must be pre-created directories.");
		if (writable.split(path.sep).some((part) => part === ".git" || part === ".jj")) reject("VCS metadata cannot be writable.");
		if (runtimePaths.some((root) => beneath(root, writable) || beneath(writable, root))) reject("Runtime assets cannot overlap writable scopes.");
		auditWritableTree(writable);
	}
	// A broad read grant would expose unpublished sibling inputs.
	for (const readable of [...readPaths, ...runtimePaths]) {
		if (beneath(readable, workspace)) reject("Do not grant read access to the workspace or an ancestor; enroll current inputs individually.");
	}
	const mountinfo = fs.readFileSync("/proc/self/mountinfo", "utf8");
	for (const line of mountinfo.trim().split("\n")) {
		const mountpoint = line.split(" ")[4]?.replace(/\\([0-7]{3})/gu, (_, digits: string) => String.fromCharCode(parseInt(digits, 8)));
		if (mountpoint && beneath(workspace, mountpoint)) reject("Workspace contains a mount alias; use a workspace without nested mounts.");
	}
	const supportedEnvironment = new Set(["PATH", "HOME", "TMPDIR", "PI_CODING_AGENT_DIR", ...(input.enrolledEnvironment ?? [])]);
	for (const [key, value] of Object.entries(input.env)) {
		if (!supportedEnvironment.has(key) || /^(?:LD_|DYLD_|LIBMOUNT_|GCONV_|GLIBC_|BASH_ENV$|ENV$|SHELLOPTS$|BASHOPTS$|NODE_OPTIONS$|NODE_PATH$)/u.test(key) || value.includes("\0")) reject(`Unsupported environment key: ${key}. This experimental primitive has not enrolled provider or extension environments.`);
	}
	const rights = "read-file,read-dir,write-file,make-dir,make-reg,remove-file,remove-dir,make-sym,refer,truncate";
	const landlock = ["--landlock-access", "fs"];
	if (input.hostSocketIsolation) landlock.push("--seccomp-filter", writeCollaborationSocketPolicy(namespaceRoot));
	for (const root of [...readPaths, ...runtimePaths]) {
		const readableRights = fs.statSync(root).isDirectory() ? "read-file,read-dir,execute" : "read-file,execute";
		landlock.push("--landlock-rule", `path-beneath:${readableRights}:${root}`);
	}
	for (const root of [...writePaths, ...privateWritePaths]) landlock.push("--landlock-rule", `path-beneath:${rights}:${root}`);
	// Native shell uses /dev/null for ignored stdin. Character-device creation
	// remains forbidden; this grants access only to the existing device inode.
	landlock.push("--landlock-rule", "path-beneath:read-file,write-file:/dev/null");
	const child = spawn(tools.setpriv, [
		"--pdeathsig", "KILL", tools.unshare,
		"--user", "--map-root-user", "--mount", "--pid", "--fork", ...(input.networkIsolation || input.hostSocketIsolation ? ["--net"] : []),
		"--kill-child=KILL", "--mount-proc", "--propagation", "private",
		tools.shell, "-c", BOOTSTRAP, "collaboration-sandbox",
		tools.mount, tools.chroot, tools.shell, REANCHORED_BOOTSTRAP, namespaceRoot,
		tools.mount, tools.setpriv, workspace, String(writePaths.length + privateWritePaths.length), ...writePaths, ...privateWritePaths,
		...landlock, tools.shell, "-c", 'if [ "$1" != "-" ]; then printf "PI_COLLABORATION_INIT:%s\\n" "$1"; fi; shift; "$@" <&0 & worker=$!; wait "$worker"; exit $?', "collaboration-init", input.initializationToken ?? "-", command, ...input.args,
	], { cwd: workspace, env: input.env, stdio: input.providerTransport ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"] });
	const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, rejectPromise) => {
		child.once("error", rejectPromise);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	const initialized = input.initializationToken ? new Promise<CollaborationNamespaceIdentity>((resolve, rejectPromise) => {
		let prefix = "";
		const timer = setTimeout(() => { child.kill("SIGKILL"); rejectPromise(new Error("Namespace initialization was not observed; ownership is not transferable until terminal drain.")); }, 10000);
		const cleanup = () => { clearTimeout(timer); child.stdout.off("data", observe); };
		const startTicks = (pid: number) => { const raw = fs.readFileSync("/proc/" + pid + "/stat", "utf8"); const fields = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/u); if (!fields[19]) throw new Error("Process start identity is unavailable."); return fields[19]; };
		const observe = (chunk: Buffer) => {
			prefix += chunk.toString("utf8");
			if (prefix.length > 1024) { cleanup(); child.kill("SIGKILL"); rejectPromise(new Error("Invalid namespace startup frame.")); return; }
			if (!prefix.includes("\n")) return;
			try {
				if (prefix.split("\n")[0] !== "PI_COLLABORATION_INIT:" + input.initializationToken || !child.pid) throw new Error("Namespace startup nonce mismatch.");
				const children = fs.readFileSync("/proc/" + child.pid + "/task/" + child.pid + "/children", "utf8").trim().split(/\s+/u).filter(Boolean);
				if (children.length !== 1) throw new Error("Namespace init identity is ambiguous.");
				const initPid = Number(children[0]);
				const namespace = fs.readlinkSync("/proc/" + initPid + "/ns/pid");
				if (namespace === fs.readlinkSync("/proc/self/ns/pid")) throw new Error("Private PID namespace was not established.");
				const identity = { hostPid: child.pid, hostStartTicks: startTicks(child.pid), initPid, initStartTicks: startTicks(initPid), namespace };
				cleanup(); resolve(identity);
			} catch (error) { cleanup(); child.kill("SIGKILL"); rejectPromise(error); }
		};
		child.stdout.on("data", observe);
		child.once("close", () => { cleanup(); rejectPromise(new Error("Namespace closed before startup identity was observed.")); });
	}) : undefined;
	initialized?.catch(() => {});
	return { process: child, terminal, initialized, stop: () => { child.kill("SIGKILL"); } };
}
