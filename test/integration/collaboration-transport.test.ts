import assert from "node:assert/strict";
import { Type } from "typebox";
import { Value } from "typebox/value";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { createRequire } from "node:module";
import { attachCollaborationProviderRelay, collaborationProviderAuthority } from "../../src/runs/shared/collaboration-provider-transport.ts";
import { spawnCollaborationSandbox } from "../../src/runs/shared/collaboration-sandbox.ts";
import { collaborationSandboxTools } from "../../src/runs/shared/collaboration-launch.ts";

it("protected transport carries HTTP and WebSocket under real socket confinement, rejects route/model escapes and withholds the descriptor from tools", { timeout: 20000 }, async () => {
	const repo = fs.realpathSync.native(fileURLToPath(new URL("../..", import.meta.url)));
	const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-transport-")));
	const owned = path.join(workspace, "owned"); fs.mkdirSync(owned);
	const authPath = path.join(workspace, "synthetic-auth.json");
	fs.writeFileSync(authPath, JSON.stringify({ "openai-codex": { type: "oauth", access: "SYNTHETIC_TEST_ONLY", refresh: "SYNTHETIC_REFRESH_ONLY", expires: Date.now() + 60000 } }));
	const server = http.createServer((req, res) => {
		assert.equal(req.url, "/codex/responses");
		assert.equal(req.headers.authorization, "Bearer SYNTHETIC_TEST_ONLY");
		assert.equal(req.headers["x-worker-callback"], "local");
		let body = ""; req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			assert.equal(JSON.parse(body).model, "test-model"); httpCount++;
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write("data: FIRST\n\n"); res.end("data: SECOND\n\n");
		});
	});
	let httpCount = 0, wsCount = 0;
	server.on("upgrade", (req, socket) => {
		assert.equal(req.url, "/codex/responses");
		assert.equal(req.headers.authorization, "Bearer SYNTHETIC_TEST_ONLY");
		const accept = createHash("sha1").update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
		socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
		socket.on("error", () => {});
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length < 6) return;
			const size = buffer[1]! & 127;
			if (buffer.length < size + 6) return;
			const opcode = buffer[0]! & 15;
			if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
			assert.equal(size < 126, true); assert.equal(buffer[1]! & 128, 128);
			const body = Buffer.from(buffer.subarray(6, size + 6));
			for (let i = 0; i < body.length; i++) body[i] ^= buffer[2 + (i % 4)]!;
			buffer = buffer.subarray(size + 6);
			assert.equal(JSON.parse(body.toString()).model, "test-model"); wsCount++;
			const reply = Buffer.from("WEBSOCKET_OK"); socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
		});
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(Value.Check(Type.Object({ port: Type.Integer(), address: Type.String(), family: Type.String() }), address));
	const target = "http://127.0.0.1:" + address.port + "/codex/responses";
	const undici: typeof import("undici") = createRequire(import.meta.url)("undici");
	const tools = collaborationSandboxTools();
	const code = `
		import assert from "node:assert/strict";
		import fs from "node:fs";
		import net from "node:net";
		import { spawnSync } from "node:child_process";
		import { createCollaborationProviderClient } from ${JSON.stringify(path.join(repo, "src/runs/shared/collaboration-provider-transport.ts"))};
		const client = createCollaborationProviderClient(3);
		assert.throws(()=>fs.readFileSync(${JSON.stringify(authPath)}));
		const credential = await client.readCredential("test-model");
		assert.equal(credential.access,"SYNTHETIC_TEST_ONLY");
		await assert.rejects(client.readCredential("wrong-model"));
		const h = {authorization:"Bearer " + credential.access, "x-worker-callback":"local"};
		const route = "https://chatgpt.com/backend-api/codex/responses";
		const response = await client.fetch(route,{method:"POST",headers:h,body:JSON.stringify({model:"test-model"})});
		assert.equal(await response.text(),"data: FIRST\\n\\ndata: SECOND\\n\\n");
		await assert.rejects(client.fetch("https://not-authorized.invalid/",{method:"POST",headers:h,body:JSON.stringify({model:"test-model"})}));
		await assert.rejects(client.fetch(route,{method:"POST",headers:h,body:JSON.stringify({model:"wrong-model"})}));
		await assert.rejects(client.fetch(route,{method:"POST",headers:{...h,host:"127.0.0.1"},body:JSON.stringify({model:"test-model"})}));
		await assert.rejects(client.fetch(route,{method:"POST",headers:h,body:new Uint8Array(4*1024*1024+1)}));
		const ws = new client.WebSocket("wss://chatgpt.com/backend-api/codex/responses",{headers:h});
		const message = new Promise((resolve,reject)=>{ws.addEventListener("message", e=>resolve(e.data),{once:true});ws.addEventListener("error",reject,{once:true})});
		await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true})});
		ws.send(JSON.stringify({type:"response.create",model:"test-model"}));
		assert.equal(await message,"WEBSOCKET_OK");
		ws.close();
		const shell=spawnSync(process.execPath,["-e",'const fs=require("fs");let denied=false;try{fs.fstatSync(3)}catch{denied=true};if(!denied&&fs.readlinkSync("/proc/self/fd/3").startsWith("socket:"))process.exit(2)'],{encoding:"utf8"});
		assert.equal(shell.status,0,shell.stderr);
		assert.throws(()=>fs.openSync("/proc/self/fd/3","r"));
		await new Promise(resolve=>{const s=net.createConnection({path:"/tmp/nonexistent-host.sock"});s.once("error",e=>{assert.equal(e.code,"EPERM");resolve()})});
		fs.writeFileSync("owned/result","TRANSPORT_AND_LOCAL_TOOLS_OK");
		client.close();
		console.log("transport-boundary-ok");
	`;
	const child = spawnCollaborationSandbox({
		workspace, namespaceRoot: fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-transport-ns-"))),
		readPaths: [], writePaths: [owned], runtimePaths: [repo, fs.realpathSync.native(path.join(repo, "node_modules")), "/nix/store", "/proc"],
		hostSocketIsolation: true, providerTransport: true, tools, command: fs.realpathSync.native(process.execPath),
		args: ["--experimental-strip-types", "--input-type=module", "-e", code], env: { PATH: process.env.PATH ?? "", HOME: owned, TMPDIR: owned },
	});
	let stdout = "", stderr = ""; child.process.stdout.on("data", (chunk) => { stdout += chunk; }); child.process.stderr.on("data", (chunk) => { stderr += chunk; });
	// SAFETY: The real sandbox explicitly creates its duplex protected transport at stdio[3].
	const relay = attachCollaborationProviderRelay(child.process.stdio[3] as Duplex, { modelId: "test-model" }, {
		agentDir: owned, cwd: workspace, authPath,
		backend: {
			fetch: ((url: any, options: any) => { assert.equal(url, "https://chatgpt.com/backend-api/codex/responses"); return undici.fetch(target, options); }),
			WebSocket: class extends undici.WebSocket {
				constructor(url: string, options: any) { assert.equal(url, "wss://chatgpt.com/backend-api/codex/responses"); super(target.replace("http:", "ws:"), options); }
			},
			close() {},
		},
	});
	const timer = setTimeout(() => child.stop(), 12000);
	try {
		const result = await child.terminal;
		assert.equal(result.code, 0, stderr); assert.equal(result.signal, null, stderr);
		assert.match(stdout, /transport-boundary-ok/);
		assert.equal(httpCount, 1); assert.equal(wsCount, 1);
		assert.equal(fs.readFileSync(path.join(owned, "result"), "utf8"), "TRANSPORT_AND_LOCAL_TOOLS_OK");
		assert.deepEqual(collaborationProviderAuthority("openai-codex/test-model:low"), { modelId: "test-model" });
		assert.throws(() => collaborationProviderAuthority("unapproved-provider/model"), /unsupported/);
	} finally { clearTimeout(timer); child.stop(); relay.close(); server.closeAllConnections(); server.close(); }
});
