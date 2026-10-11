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
import * as zlib from "node:zlib";
import { attachCollaborationProviderRelay } from "../../src/runs/shared/collaboration-provider-transport.ts";
import { spawnCollaborationSandbox } from "../../src/runs/shared/collaboration-sandbox.ts";
import { collaborationSandboxTools } from "../../src/runs/shared/collaboration-launch.ts";

for (const fallback of [false, true]) it("installed native SDK retains local callbacks and auto WebSocket" + (fallback ? " then its SSE fallback" : " success"), { timeout: 20000 }, async () => {
	const repo = fs.realpathSync.native(fileURLToPath(new URL("../..", import.meta.url)));
	const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-sdk-transport-")));
	const owned = path.join(workspace, "owned"), sibling = path.join(workspace, "sibling");
	fs.mkdirSync(owned); fs.mkdirSync(sibling); fs.writeFileSync(path.join(sibling, "protected"), "ORIGINAL");
	const jwt = "synthetic." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-isolated-account" } })).toString("base64") + ".test";
	const authPath = path.join(sibling, "synthetic-provider-auth.json");
	fs.writeFileSync(authPath, JSON.stringify({ "openai-codex": { type: "oauth", access: jwt, refresh: "SYNTHETIC_NOT_VALID", expires: Date.now() + 3600000 } }));
	const completed = JSON.stringify({ type: "response.completed", response: { id: "isolated-response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } });
	let upgradeCount = 0, httpCount = 0, messageCount = 0;
	const server = http.createServer((req, res) => {
		assert.equal(req.headers.authorization, "Bearer " + jwt);
		assert.equal(req.headers["x-local-callback"], "preserved");
		const chunks: Buffer[] = []; req.on("data", (chunk) => { chunks.push(chunk); });
		req.on("end", () => {
			const wire = Buffer.concat(chunks);
			const body = req.headers["content-encoding"] === "zstd" ? zlib.zstdDecompressSync(wire) : wire;
			assert.equal(JSON.parse(body.toString("utf8")).model, "test-model");
			httpCount++; res.writeHead(200, { "content-type": "text/event-stream" });
			res.end("data: " + completed + "\n\ndata: [DONE]\n\n");
		});
	});
	server.on("upgrade", (req, socket) => {
		upgradeCount++; socket.on("error", () => {});
		assert.equal(req.headers.authorization, "Bearer " + jwt);
		assert.equal(req.headers["x-local-callback"], "preserved");
		if (fallback) { socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return; }
		const accept = createHash("sha1").update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
		socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]); if (buffer.length < 2) return;
			const opcode = buffer[0]! & 15;
			let length = buffer[1]! & 127, offset = 2;
			if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
			assert.notEqual(length, 127, "Synthetic request remains bounded.");
			if (buffer.length < offset + 4 + length) return;
			if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
			const mask = buffer.subarray(offset, offset + 4); offset += 4;
			const body = Buffer.from(buffer.subarray(offset, offset + length));
			for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4]!;
			buffer = buffer.subarray(offset + length);
			assert.equal(JSON.parse(body.toString()).model, "test-model"); messageCount++;
			const payload = Buffer.from(completed), header = Buffer.alloc(4);
			header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
			socket.write(Buffer.concat([header, payload]));
		});
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(Value.Check(Type.Object({ port: Type.Integer(), address: Type.String(), family: Type.String() }), address));
	const target = "http://127.0.0.1:" + address.port + "/codex/responses";
	const undici: typeof import("undici") = createRequire(import.meta.url)("undici");
	const sdk = "/nix/store/fylxrmnhiffb7f18lmwmwr013r9a1nqy-pi-1.1.0/lib/pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
	const code = `
		import assert from "node:assert/strict";
		import fs from "node:fs";
		import * as pi from ${JSON.stringify(sdk)};
		import { createCollaborationProviderClient } from ${JSON.stringify(path.join(repo,"src/runs/shared/collaboration-provider-transport.ts"))};
		const client=createCollaborationProviderClient(3);
		globalThis.WebSocket=client.WebSocket;
		assert.throws(()=>fs.readFileSync(${JSON.stringify(authPath)}));
		const credentials={read:async(provider,opts)=>provider==="openai-codex"?client.readCredential("test-model",opts?.signal):undefined,list:async()=>[{providerId:"openai-codex",type:"oauth"}],modify:async()=>{throw Error("readonly")},delete:async()=>{throw Error("readonly")}};
		const runtime=await pi.ModelRuntime.create({credentials,modelsPath:null,allowModelNetwork:false});
		const model={type:"chat",provider:"openai-codex",api:"openai-codex-responses",baseUrl:"https://chatgpt.com/backend-api",id:"test-model",name:"test",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65536,maxTokens:256};
		let payloadCalls=0,headerCalls=0,eventCalls=0,responseCalls=0;
		const stream=runtime.streamSimple(model,{messages:[{role:"user",content:"hello",timestamp:1}]},{
			apiKey:${JSON.stringify(jwt)},fetch:client.fetch,sessionId:"synthetic-" + ${JSON.stringify(String(fallback))},
			timeoutMs:3000,websocketConnectTimeoutMs:3000,maxRetries:0,
			async transformHeaders(headers) {
				headerCalls++;fs.writeFileSync("owned/header-callback","LOCAL");
				let denied=false;try{fs.writeFileSync("sibling/protected","BAD")}catch{denied=true};assert.equal(denied,true);
				return {...headers,"x-local-callback":"preserved"};
			},
			async onPayload(body,selected){payloadCalls++;assert.equal(selected.id,"test-model");fs.writeFileSync("owned/payload-callback","LOCAL");return body},
			async onProviderStreamEvent(){eventCalls++;fs.writeFileSync("owned/event-callback","LOCAL")},
			async onResponse(){responseCalls++;fs.writeFileSync("owned/response-callback","LOCAL")}
		});
		const result=await stream.result();
		assert.equal(result.stopReason,"stop",result.errorMessage);
		assert.equal(headerCalls,1);assert.equal(payloadCalls,1);assert.ok(eventCalls>0);
		assert.equal(responseCalls,${fallback ? 1 : 0});
		const {cleanupSessionResources}=await import("/nix/store/fylxrmnhiffb7f18lmwmwr013r9a1nqy-pi-1.1.0/lib/pi/node_modules/@earendil-works/pi-ai/dist/session-resources.js");
		cleanupSessionResources();client.close();console.log("native-sdk-callbacks-ok");
	`;
	const child = spawnCollaborationSandbox({
		workspace, namespaceRoot: fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-sdk-transport-ns-"))),
		readPaths: [], writePaths: [owned], runtimePaths: [repo, fs.realpathSync.native(path.join(repo, "node_modules")), "/nix/store", "/proc"],
		hostSocketIsolation: true, providerTransport: true, tools: collaborationSandboxTools(), command: fs.realpathSync.native(process.execPath),
		args: ["--experimental-strip-types", "--input-type=module", "-e", code], env: { PATH: process.env.PATH ?? "", HOME: owned, TMPDIR: owned, PI_CODING_AGENT_DIR: owned },
	});
	let stdout = "", stderr = ""; child.process.stdout.on("data", (chunk) => { stdout += chunk; }); child.process.stderr.on("data", (chunk) => { stderr += chunk; });
	// SAFETY: The real sandbox explicitly creates its duplex protected transport at stdio[3].
	const relay = attachCollaborationProviderRelay(child.process.stdio[3] as Duplex, { modelId: "test-model" }, {
		agentDir: owned, cwd: workspace, authPath,
		backend: {
			fetch: ((_url: any, options: any) => undici.fetch(target, options)) as typeof globalThis.fetch,
			WebSocket: class extends undici.WebSocket { constructor(_url: string, options: any) { super(target.replace("http:", "ws:"), options); } },
			close() {},
		},
	});
	const timer = setTimeout(() => child.stop(), 12000);
	try {
		const result = await child.terminal; assert.equal(result.code, 0, stderr + stdout); assert.equal(result.signal, null, stderr);
		assert.match(stdout,/native-sdk-callbacks-ok/);
		assert.equal(upgradeCount, 1); assert.equal(httpCount, fallback ? 1 : 0); assert.equal(messageCount, fallback ? 0 : 1);
		assert.equal(fs.readFileSync(path.join(owned,"header-callback"),"utf8"),"LOCAL");
		assert.equal(fs.readFileSync(path.join(sibling,"protected"),"utf8"),"ORIGINAL");
	} finally { clearTimeout(timer); child.stop(); relay.close(); server.closeAllConnections(); server.close(); }
});
