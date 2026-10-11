import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import { once } from "node:events";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { spawnCollaborationSandbox, CollaborationSandboxUnsupportedError, type CollaborationSandboxInput } from "../../src/runs/shared/collaboration-sandbox.ts";

function fixture() {
	const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-collaboration-boundary-")));
	const owned = path.join(workspace, "owned");
	const other = path.join(workspace, "other");
	fs.mkdirSync(owned);
	fs.mkdirSync(other);
	fs.writeFileSync(path.join(owned, "leaf"), "OWNED");
	fs.writeFileSync(path.join(other, "leaf"), "PRIVATE");
	const bin = "/run/current-system/sw/bin";
	const tool = (name: string) => fs.realpathSync.native(path.join(bin, name));
	const input: CollaborationSandboxInput = {
		workspace, namespaceRoot: fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-collaboration-root-"))), readPaths: [], writePaths: [owned],
		runtimePaths: ["/nix/store", "/proc"],
		command: fs.realpathSync.native(process.execPath), args: [],
		env: { PATH: bin, HOME: owned, TMPDIR: owned },
		tools: { setpriv: tool("setpriv"), unshare: tool("unshare"), mount: tool("mount"), shell: tool("bash"), chroot: tool("chroot") },
	};
	return { workspace, owned, other, input };
}

async function run(input: CollaborationSandboxInput, code: string) {
	const sandbox = spawnCollaborationSandbox({ ...input, args: ["--input-type=module", "-e", code] });
	let stdout = "";
	let stderr = "";
	sandbox.process.stdout.setEncoding("utf8");
	sandbox.process.stderr.setEncoding("utf8");
	sandbox.process.stdout.on("data", (chunk: string) => { stdout += chunk; });
	sandbox.process.stderr.on("data", (chunk: string) => { stderr += chunk; });
	const timer = setTimeout(() => sandbox.stop(), 15_000);
	try {
		const result = await sandbox.terminal;
		assert.equal(result.code, 0, stderr);
		assert.equal(result.signal, null, stderr);
		return JSON.parse(stdout);
	} finally {
		clearTimeout(timer);
	}
}

describe("experimental composed collaboration boundary (not workflow enrollment)", () => {
	it("allows real owned writes and shell children; denies sibling reads/writes and metadata effects", { timeout: 20_000 }, async () => {
		const { owned, other, input } = fixture();
		const result = await run(input, `
			import fs from "node:fs";
			import { spawnSync } from "node:child_process";
			const owned = ${JSON.stringify(owned)}, other = ${JSON.stringify(other)};
			const rows = {};
			function allowed(name, fn) { try { fn(); rows[name] = true; } catch { rows[name] = false; } }
			allowed("writeOwned", () => fs.writeFileSync(owned + "/new", "ALLOWED"));
			allowed("readOther", () => fs.readFileSync(other + "/leaf"));
			allowed("writeOther", () => fs.writeFileSync(other + "/leaf", "BAD"));
			allowed("chmodOther", () => fs.chmodSync(other + "/leaf", 0o777));
			allowed("unlinkOther", () => fs.unlinkSync(other + "/leaf"));
			fs.symlinkSync(other + "/leaf", owned + "/alias");
			allowed("readAlias", () => fs.readFileSync(owned + "/alias"));
			allowed("writeAlias", () => fs.writeFileSync(owned + "/alias", "BAD"));
			allowed("hardlinkOther", () => fs.linkSync(other + "/leaf", owned + "/hard"));
			allowed("procAlias", () => fs.readFileSync("/proc/self/root" + other + "/leaf"));
			const shell = spawnSync(${JSON.stringify(input.tools.shell)}, ["-c", 'printf SHELL > "$1/shell"; printf BAD > "$2/leaf"', "probe", owned, other], { encoding: "utf8" });
			rows.shellDenied = shell.status !== 0;
			const status = fs.readFileSync("/proc/self/status", "utf8");
			console.log(JSON.stringify({ rows, status, pid: process.pid, ppid: process.ppid }));
		`);
		assert.deepEqual(result.rows, {
			writeOwned: true, readOther: false, writeOther: false, chmodOther: false,
			unlinkOther: false, readAlias: false, writeAlias: false, hardlinkOther: false,
			procAlias: false, shellDenied: true,
		});
		assert.ok(result.pid > 1, "An immutable init, not the untrusted worker, must hold PID 1.");
		assert.equal(result.ppid, 1);
		assert.match(result.status, /^CapEff:\s+0+$/m);
		assert.match(result.status, /^CapPrm:\s+0+$/m);
		assert.match(result.status, /^CapBnd:\s+0+$/m);
		assert.match(result.status, /^NoNewPrivs:\s+1$/m);
		assert.equal(fs.readFileSync(path.join(owned, "shell"), "utf8"), "SHELL");
		assert.equal(fs.readFileSync(path.join(other, "leaf"), "utf8"), "PRIVATE");
		assert.notEqual(fs.statSync(path.join(other, "leaf")).mode & 0o777, 0o777);
	});

	it("rejects pre-existing writable inode aliases, symlinks and injected environments before launch", () => {
		const { owned, other, input } = fixture();
		fs.linkSync(path.join(other, "leaf"), path.join(owned, "hard"));
		assert.throws(() => spawnCollaborationSandbox(input), /multiple links/);
		const second = fixture();
		fs.symlinkSync(path.join(second.other, "leaf"), path.join(second.owned, "alias"));
		assert.throws(() => spawnCollaborationSandbox(second.input), /symlink/);
		const third = fixture();
		assert.throws(() => spawnCollaborationSandbox({ ...third.input, env: { NODE_OPTIONS: "--require=evil" } }), CollaborationSandboxUnsupportedError);
		assert.throws(() => spawnCollaborationSandbox({ ...third.input, readPaths: [third.workspace] }), /ancestor/);
		assert.throws(() => spawnCollaborationSandbox({ ...third.input, writePaths: [third.workspace] }), /proper directory/);
	});

	it("uses only pipe descriptors and does not inherit the parent environment", { timeout: 20_000 }, async () => {
		const { other, input } = fixture();
		const descriptor = fs.openSync(path.join(other, "leaf"), "r+");
		const previous = process.env.PI_COLLABORATION_UNENROLLED;
		process.env.PI_COLLABORATION_UNENROLLED = "PRIVATE";
		try {
			const result = await run(input, `
				import fs from "node:fs";
				let outsideFileFd = false;
				for (const fd of fs.readdirSync("/proc/self/fd")) {
					try { if (fs.readlinkSync("/proc/self/fd/" + fd) === ${JSON.stringify(path.join(other, "leaf"))}) outsideFileFd = true; } catch {}
				}
				console.log(JSON.stringify({ outsideFileFd, poisoned: process.env.PI_COLLABORATION_UNENROLLED !== undefined }));
			`);
			assert.deepEqual(result, { outsideFileFd: false, poisoned: false });
		} finally {
			fs.closeSync(descriptor);
			if (previous === undefined) delete process.env.PI_COLLABORATION_UNENROLLED;
			else process.env.PI_COLLABORATION_UNENROLLED = previous;
		}
	});

	it("kernel namespace-init exit kills a detached descendant before terminal authority can be reused", { timeout: 20_000 }, async () => {
		const { owned, input } = fixture();
		const descendant = `
			import fs from "node:fs";
			process.stdin.once("data", () => { fs.writeFileSync(${JSON.stringify(path.join(owned, "late"))}, "BAD"); process.exit(0); });
			process.stdout.write("ready\\n");
		`;
		const result = await run(input, `
			import { spawn } from "node:child_process";
			const child = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(descendant)}], { detached: true, stdio: ["pipe", "pipe", "ignore"] });
			await new Promise((resolve) => child.stdout.once("data", resolve));
			// A deterministic barrier establishes a live detached child waiting
			// for its mutation trigger when PID namespace init exits.
			console.log(JSON.stringify({ liveDetachedChild: true }));
			process.exit(0);
		`);
		assert.equal(result.liveDetachedChild, true);
		assert.equal(fs.existsSync(path.join(owned, "late")), false);
	});

	it("stop drains double-forked writers even when the untrusted worker clears its own parent-death signal", { timeout: 20_000 }, async () => {
		const { input } = fixture();
		const python = (process.env.PATH ?? "").split(path.delimiter).map((root) => path.join(root, "python3")).find((candidate) => fs.existsSync(candidate));
		assert.ok(python, "The local Python ctypes/fork test fixture is required.");
		input.command = fs.realpathSync.native(python);
		input.args = ["-B", "-c", [
			"import ctypes,os,signal",
			"libc=ctypes.CDLL(None,use_errno=True)",
			"assert libc.prctl(1,0,0,0,0) == 0",
			"assert libc.ptrace(16,1,0,0) == -1 and ctypes.get_errno() == 1, 'Worker attached to immutable namespace init'",
			"pid=os.fork()",
			"if pid == 0:",
			" os.setsid()",
			" if os.fork() != 0: os._exit(0)",
			" print('DETACHED_READY',flush=True)",
			" while True: signal.pause()",
			"while True: signal.pause()",
		].join("\n")];
		const sandbox = spawnCollaborationSandbox(input);
		let stderr = "";
		sandbox.process.stderr.on("data", (chunk) => { stderr += chunk; });
		const watchdog = setTimeout(() => sandbox.stop(), 15000);
		try {
			await new Promise<void>((resolve, reject) => {
				let output = "";
				sandbox.process.stdout.on("data", (chunk) => { output += chunk; if (output.includes("DETACHED_READY")) resolve(); });
				sandbox.process.once("exit", () => reject(new Error("Worker exited before the detached-child barrier: " + stderr)));
				sandbox.process.once("error", reject);
			});
			sandbox.stop();
			const terminal = await sandbox.terminal;
			assert.equal(terminal.signal, "SIGKILL", stderr);
			assert.equal(terminal.code, null);
			// Descendants inherit stdout. A surviving detached writer would keep
			// the pipe open and prevent this close-confirmed terminal result.
			assert.equal(sandbox.process.stdout.readableEnded, true);
		} finally { clearTimeout(watchdog); }
	});

	it("runs actual installed Pi 1.1 native read/write/bash tool definitions under the boundary", { timeout: 20_000 }, async () => {
		const { owned, other, input } = fixture();
		input.hostSocketIsolation = true;
		const sdk = "/nix/store/fylxrmnhiffb7f18lmwmwr013r9a1nqy-pi-1.1.0/lib/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/tools";
		assert.ok(fs.existsSync(sdk), "The exact Pi 1.1 fixture is required, not the 0.87 development peer.");
		const result = await run(input, `
			import { createReadToolDefinition } from "${sdk}/read.js";
			import { createWriteToolDefinition } from "${sdk}/write.js";
			import { createEditToolDefinition } from "${sdk}/edit.js";
			import { createBashToolDefinition } from "${sdk}/bash.js";
			const owned = ${JSON.stringify(owned)}, other = ${JSON.stringify(other)};
			const read = createReadToolDefinition(owned), write = createWriteToolDefinition(owned);
			const rows = {};
			async function allowed(name, fn) { try { await fn(); rows[name] = true; } catch { rows[name] = false; } }
			await allowed("readOwned", () => read.execute("r1", { path: owned + "/leaf" }));
			await allowed("readOther", () => read.execute("r2", { path: other + "/leaf" }));
			await allowed("writeOwned", () => write.execute("w1", { path: owned + "/native/new", content: "NATIVE" }));
			await allowed("writeOther", () => write.execute("w2", { path: other + "/leaf", content: "BAD" }));
			const edit = createEditToolDefinition(owned);
			await allowed("editOwned", () => edit.execute("e1", { path: owned + "/leaf", edits: [{ oldText: "OWNED", newText: "EDITED" }] }));
			await allowed("editOther", () => edit.execute("e2", { path: other + "/leaf", edits: [{ oldText: "PRIVATE", newText: "BAD" }] }));
			const bash = createBashToolDefinition(owned, { shellPath: ${JSON.stringify(input.tools.shell)} });
			const shell = await bash.execute("b1", { command: "printf NATIVE_SHELL > native-shell; printf OK", timeout: 3 });
			const deniedShell = await bash.execute("b2", { command: "printf BAD > " + JSON.stringify(other + "/leaf"), timeout: 3 });
			console.log(JSON.stringify({ rows, shell: shell.structuredContent, deniedShell: deniedShell.structuredContent }));
		`);
		assert.deepEqual(result.rows, { readOwned: true, readOther: false, writeOwned: true, writeOther: false, editOwned: true, editOther: false });
		assert.equal(fs.readFileSync(path.join(owned, "leaf"), "utf8"), "EDITED");
		assert.equal(result.shell.exit_code, 0);
		assert.notEqual(result.deniedShell.exit_code, 0);
		assert.equal(fs.readFileSync(path.join(owned, "native-shell"), "utf8"), "NATIVE_SHELL");
		assert.equal(fs.readFileSync(path.join(other, "leaf"), "utf8"), "PRIVATE");
	});

	it("enforces actual Pi 1.1 AgentSession Code Mode nested calls without a live provider", { timeout: 20_000 }, async () => {
		const { owned, other, input } = fixture();
		input.hostSocketIsolation = true;
		const repo = fs.realpathSync.native(new URL("../..", import.meta.url).pathname);
		const sdk = "/nix/store/fylxrmnhiffb7f18lmwmwr013r9a1nqy-pi-1.1.0/lib/pi/node_modules/@earendil-works";
		input.runtimePaths.push(path.join(repo, "src"), fs.realpathSync.native(path.join(repo, "node_modules")));
		input.env.PI_CODING_AGENT_DIR = owned;
		const source = `
			import fs from "node:fs";
			import { createDefaultChildSessionFactory } from ${JSON.stringify(path.join(repo, "src/runs/shared/child-session.ts"))};
			import * as pi from "${sdk}/pi-coding-agent/dist/index.js";
			import * as ai from "${sdk}/pi-ai/dist/index.js";
			const owned = ${JSON.stringify(owned)}, other = ${JSON.stringify(other)};
			const faux = ai.fauxProvider({ provider: "boundary-evidence", models: [{ id: "local" }], tokensPerSecond: 100000 });
			const nested = "text(await tools.write({path: " + JSON.stringify(owned + "/nested") + ", content: 'NESTED'})); text(await tools.read({path: " + JSON.stringify(other + "/leaf") + "}));";
			faux.setResponses([
				ai.fauxAssistantMessage(ai.fauxToolCall("local_probe", {}), { stopReason: "toolUse" }),
				ai.fauxAssistantMessage(ai.fauxToolCall("codemode", { code: nested }), { stopReason: "toolUse" }),
				ai.fauxAssistantMessage("done"),
			]);
			const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
			const session = await factory.create({
				cwd: owned, projectTrusted: true, storage: { kind: "memory" }, model: "boundary-evidence/local",
				tools: ["codemode", "read", "write", "local_probe"], extensionPaths: [], ambientExtensions: false,
				hooks: [
					{ name: "fixture-provider", factory: (api) => api.registerProvider(faux.provider) },
					{ name: "immutable-local-effects", factory: (api) => api.registerTool({
						name: "local_probe", label: "Local probe", description: "Scripted extension-local filesystem boundary check",
						parameters: { type: "object", properties: {} },
						async execute() {
							fs.writeFileSync(owned + "/extension", "EXTENSION");
							let denied = false;
							try { fs.writeFileSync(other + "/leaf", "BAD"); } catch (error) { denied = error.code === "EACCES" || error.code === "EROFS"; }
							return { content: [{ type: "text", text: JSON.stringify({ denied }) }], details: {} };
						},
					}) },
				],
				noSkills: true, noContextFiles: true, runtime: {},
			});
			const ends = [];
			session.subscribe((event) => { if (event.type === "tool_execution_end") ends.push({ name: event.toolName, error: event.isError, nested: typeof event.parentToolCallId === "string", result: event.result }); });
			await session.prompt("Run the scripted boundary check.");
			await session.dispose();
			await factory.dispose();
			console.log(JSON.stringify({ ends, owned: fs.existsSync(owned + "/nested") ? fs.readFileSync(owned + "/nested", "utf8") : null }));
		`;
		const script = path.join(input.workspace, "native-session.mts");
		fs.writeFileSync(script, source);
		input.readPaths.push(script);
		const sandbox = spawnCollaborationSandbox({ ...input, args: ["--experimental-strip-types", script] });
		let stdout = "", stderr = "";
		sandbox.process.stdout.on("data", (chunk) => { stdout += chunk; });
		sandbox.process.stderr.on("data", (chunk) => { stderr += chunk; });
		const timer = setTimeout(() => sandbox.stop(), 15000);
		try {
			const terminal = await sandbox.terminal;
			assert.equal(terminal.code, 0, stderr);
			const result = JSON.parse(stdout);
			assert.equal(result.owned, "NESTED", stdout);
			assert.equal(fs.readFileSync(path.join(owned, "extension"), "utf8"), "EXTENSION");
			assert.ok(result.ends.some((event: any) => event.name === "local_probe" && event.error === false && event.result.content.some((block: any) => block.text === '{"denied":true}')), stdout);
			assert.ok(result.ends.some((event: any) => event.name === "write" && event.nested && event.error === false), stdout);
			assert.ok(result.ends.some((event: any) => event.name === "read" && event.nested && event.error === true), stdout);
			assert.ok(result.ends.some((event: any) => event.name === "codemode" && event.error === true), stdout);
			assert.equal(fs.readFileSync(path.join(other, "leaf"), "utf8"), "PRIVATE");
		} finally { clearTimeout(timer); }
	});

	it("rejects undeclared host Unix-socket delegation to sibling filesystem resources", { timeout: 20000 }, async () => {
		const { other, input } = fixture();
		const socket = path.join(other, "host-service.sock");
		const server = net.createServer((stream) => stream.once("data", () => {
			fs.writeFileSync(path.join(other, "leaf"), "RPC_CHANGED"); stream.end("ACK");
		}));
		server.listen(socket); await once(server, "listening");
		try {
			await run({ ...input, hostSocketIsolation: true }, `
				import net from "node:net";
				const socket = net.createConnection(${JSON.stringify(socket)});
				socket.on("connect", () => socket.write("WRITE"));
				socket.on("data", () => console.log(JSON.stringify({ connected: true })));
				socket.on("error", (error) => console.log(JSON.stringify({ connected: false, code: error.code })));
			`);
			assert.equal(fs.readFileSync(path.join(other, "leaf"), "utf8"), "PRIVATE", "Kernel confinement must reject host RPC effects, not only direct file opens.");
		} finally { server.close(); await once(server, "close"); }
	});
});
