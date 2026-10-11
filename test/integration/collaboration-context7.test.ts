import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { waitForCollaborationQuiescence } from "../../src/runs/shared/collaboration-quiescence.ts";
import { it } from "node:test";
import type { Duplex } from "node:stream";
import { attachCollaborationProviderRelay, type CollaborationProviderAuthority } from "../../src/runs/shared/collaboration-provider-transport.ts";
import { collaborationSdkRoot } from "../support/collaboration-sdk.ts";
import { spawnCollaborationSandbox } from "../../src/runs/shared/collaboration-sandbox.ts";
import { collaborationSandboxTools, verifyCollaborationRuntime, prepareCollaborationAgentHome } from "../../src/runs/shared/collaboration-launch.ts";
import { collaborationDigest, normalizeCollaborationManifest, type CollaborationManifest } from "../../src/workflows/collaboration-manifest.ts";
import { collaborationManifestRecordSchema } from "../../src/workflows/collaboration-schema.ts";
import { Value } from "typebox/value";
import { resolveHostPeerAliases } from "../../src/runs/background/runner-aliases.ts";
import { readCollaborationStartupObservation } from "../../src/runs/shared/collaboration-startup-observation.ts";

it("Context7 uses a private cache home with identical SDK settings and no global mutation", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "context7-cache-home-"));
	const source = path.join(root, "global"), privateHome = path.join(root, "private");
	fs.mkdirSync(source); fs.mkdirSync(privateHome);
	const settings = '{"defaultModel":"same","defaultTools":["read","write","codemode"]}\n';
	fs.writeFileSync(path.join(source, "settings.json"), settings);
	assert.equal(prepareCollaborationAgentHome(source, privateHome, false), source);
	assert.deepEqual(fs.readdirSync(privateHome), []);
	assert.equal(prepareCollaborationAgentHome(source, privateHome, true), privateHome);
	assert.equal(fs.readFileSync(path.join(privateHome, "settings.json"), "utf8"), settings);
	fs.writeFileSync(path.join(privateHome, "mcp-cache.json"), '{"publicCatalog":true}');
	assert.deepEqual(fs.readdirSync(source), ["settings.json"]);
	assert.equal(fs.readFileSync(path.join(source, "settings.json"), "utf8"), settings);
	assert.throws(() => prepareCollaborationAgentHome(source, privateHome, true), /EEXIST/);
	const oversized = path.join(root, "oversized"); fs.mkdirSync(oversized);
	fs.writeFileSync(path.join(oversized, "settings.json"), "x".repeat(256 * 1024 + 1));
	assert.throws(() => prepareCollaborationAgentHome(oversized, privateHome, true), /bounded private enrollment/);
	const alias = path.join(root, "alias"); fs.mkdirSync(alias);
	fs.symlinkSync(path.join(source, "settings.json"), path.join(alias, "settings.json"));
	assert.throws(() => prepareCollaborationAgentHome(alias, privateHome, true), /ELOOP/);
});

for (const relayMode of [false, true]) it("ordinary configured adapter uses worker-realm fetch and retains namespace approval and shutdown under confinement" + (relayMode ? " through the protected relay" : ""), { timeout: 30000 }, async () => {
	const repo = fs.realpathSync.native(fileURLToPath(new URL("../..", import.meta.url)));
	const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-context7-")));
	const owned = path.join(workspace, "owned"); fs.mkdirSync(owned);
	const installed = "/home/reyhan/.pi/agent/npm/node_modules";
	const adapter = path.join(installed, "pi-mcp-adapter/index.ts");
	assert.ok(fs.existsSync(adapter), "Prepared ordinary adapter is required; no download fallback.");
	const code = `
		import assert from "node:assert/strict";
		import fs from "node:fs";
		import { createJiti } from ${JSON.stringify(path.join(repo, "node_modules/jiti/lib/jiti.mjs"))};
		import * as pi from ${JSON.stringify(path.join(collaborationSdkRoot, "dist/index.js"))};
		const calls=[];let recovered=false;
		globalThis.fetch=async(input,init)=>{
			assert.equal(String(input),"https://mcp.context7.com/mcp");
			assert.equal(new Headers(init.headers).has("authorization"),false);
			if(init.method==="GET")return new Response(null,{status:405});
			assert.equal(init.method,"POST");
			const message=JSON.parse(init.body);calls.push(message);
			if(message.method==="notifications/initialized")return new Response(null,{status:202});
			let result;
			if(message.method==="server/discover")return new Response(JSON.stringify({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:"legacy fixture"}}),{status:200,headers:{"content-type":"application/json"}});
			if(message.method==="initialize")result={protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"synthetic-context7",version:"test"}};
			else if(message.method==="tools/list")result={tools:[{name:"resolve-library-id",description:"Synthetic lookup",inputSchema:{type:"object",properties:{libraryName:{type:"string"},query:{type:"string"}},required:["libraryName","query"]},annotations:{readOnlyHint:true}}]};
			else if(message.method==="tools/call"){if(message.params.arguments.query==="recovery"&&!recovered){recovered=true;return new Response("expired",{status:404})}result={content:[{type:"text",text:"SYNTHETIC_RESULT_NOT_VENDOR_DOCS"+(message.params.arguments.query==="oversized"?"x\\n".repeat(3000):"")}],isError:false}}
			else throw Error("Unexpected fixture request: "+message.method);
			return new Response(JSON.stringify({jsonrpc:"2.0",id:message.id,result}),{headers:{"content-type":"application/json",...(message.method==="initialize"?{"mcp-session-id":"synthetic-session"}:{})}});
		};
		${relayMode ? `const {createCollaborationProviderClient}=await import(${JSON.stringify(path.join(repo,"src/runs/shared/collaboration-provider-transport.ts"))});
		const client=createCollaborationProviderClient(3);globalThis.fetch=(input,init)=>{if(init.method==="POST")calls.push(JSON.parse(init.body));return client.fetch(input,init)};` : ""}
		const jiti=createJiti(import.meta.url,{fsCache:false,moduleCache:true,alias:{"@earendil-works/pi-coding-agent":${JSON.stringify(path.join(collaborationSdkRoot,"dist/index.js"))},"@earendil-works/pi-tui":${JSON.stringify(path.join(path.dirname(collaborationSdkRoot),"pi-tui/dist/index.js"))},"@earendil-works/pi-ai":${JSON.stringify(path.join(path.dirname(collaborationSdkRoot),"pi-ai/dist/index.js"))}}});
		const {createMcpAdapter}=await jiti.import(${JSON.stringify(adapter)});
		let decision="allow_once";
		const broker={name:"synthetic-approval",factory(api){api.events.on("pi-mcp-adapter:tool-approval-request",request=>{request.claim(()=>decision)})}};
		const {collaborationDigest}=await import(${JSON.stringify(path.join(repo,"src/workflows/collaboration-manifest.ts"))});
		const {loadCollaborationContext7Adapter}=await import(${JSON.stringify(path.join(repo,"src/runs/shared/collaboration-context7-adapter.ts"))});
		const binding={path:${JSON.stringify(adapter)},digest:collaborationDigest(${JSON.stringify(adapter)})};
		await assert.rejects(loadCollaborationContext7Adapter({...binding,digest:"0".repeat(64)},${JSON.stringify(collaborationSdkRoot)}),/source identity changed/);
		await assert.rejects(loadCollaborationContext7Adapter({...binding,path:process.env.HOME+"/missing-adapter.ts"},${JSON.stringify(collaborationSdkRoot)}));
		const configured=${relayMode ? `await loadCollaborationContext7Adapter(binding,${JSON.stringify(collaborationSdkRoot)})` : 'createMcpAdapter({config:{mcpServers:{context7:{url:"https://mcp.context7.com/mcp",lifecycle:"lazy",directTools:false,oauth:false}},settings:{directTools:false}}})'};
		const settings=pi.SettingsManager.inMemory();
		const loader=new pi.DefaultResourceLoader({cwd:process.cwd(),agentDir:process.env.HOME,settingsManager:settings,noExtensions:true,noSkills:true,noContextFiles:true,noThemes:true,noPromptTemplates:true,extensionFactories:[configured,broker]});
		await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
		assert.equal(loader.getExtensions().extensions.some(e=>e.path===binding.path),false,"Configured factory must not pretend to be a filesystem-loaded default adapter.");
		const modelRuntime=await pi.ModelRuntime.create({modelsPath:null,allowModelNetwork:false,credentials:{read:async()=>undefined,list:async()=>[],modify:async()=>{throw Error("no credential writes")},delete:async()=>{throw Error("no credential writes")}}});
		const {createDefaultChildSessionFactory}=await import(${JSON.stringify(path.join(repo,"src/runs/shared/child-session.ts"))});
		const {createCollaborationStartupSink}=await import(${JSON.stringify(path.join(repo,"src/runs/shared/collaboration-startup-observation.ts"))});
		const startupBinding={runId:"fixture",executionToken:"fixture-epoch",manifestVersion:1,processInstanceId:"fixture-process",candidateRoot:${JSON.stringify(repo)},sdkRoot:${JSON.stringify(collaborationSdkRoot)},adapter:binding};
		const sink=createCollaborationStartupSink(process.env.HOME,startupBinding);
		const strictFactory=createDefaultChildSessionFactory({loadPiCodingAgent:async()=>pi,confinedProviderTransport:{model:"openai-codex/test-model"},confinedContext7:binding,confinedStartupObservation:sink});
		await assert.rejects(strictFactory.create({cwd:process.cwd(),storage:{kind:"memory"},tools:[],extensionPaths:[binding.path,process.env.HOME+"/missing-selected.ts"],ambientExtensions:false,hooks:[],noSkills:true,noContextFiles:true,parentProviderRegistry:modelRuntime,runtime:{fanoutChild:false,depth:1,waitTool:{enabled:false},fast:false}}),/Confined selected extension failed to load/);
		const failedObservation=JSON.parse(fs.readFileSync(process.env.HOME+"/context7-startup.json","utf8"));assert.equal(failedObservation.phase,"loaded");assert.equal(failedObservation.errors.length,1);assert.equal(failedObservation.session,undefined);assert.equal(calls.length,0,"Missing source must stop before any upstream request");
		let shutdowns=0;
		await assert.rejects(strictFactory.create({cwd:process.cwd(),storage:{kind:"memory"},extensionPaths:[binding.path],ambientExtensions:false,hooks:[{name:"synthetic-binding-error",factory(api){api.on("session_start",()=>{throw Error("synthetic startup failure")});api.on("session_shutdown",()=>{shutdowns++})}}],noSkills:true,noContextFiles:true,parentProviderRegistry:modelRuntime,runtime:{fanoutChild:false,depth:1,waitTool:{enabled:false},fast:false}}),/failed during native startup binding/);
		const bindingFailure=JSON.parse(fs.readFileSync(process.env.HOME+"/context7-startup.json","utf8"));assert.ok(bindingFailure.errors.some(e=>e.kind==="bind-error"));assert.equal(shutdowns,1);assert.equal(calls.filter(m=>m.method==="tools/call").length,0);
		let inactiveCalls=0;
		const inactive=createDefaultChildSessionFactory({loadPiCodingAgent:async()=>pi,confinedStartupObservation:()=>{inactiveCalls++}});
		const ordinary=await inactive.create({cwd:process.cwd(),storage:{kind:"memory"},extensionPaths:[],ambientExtensions:false,hooks:[],noSkills:true,noContextFiles:true,parentProviderRegistry:modelRuntime,runtime:{fanoutChild:false,depth:1,waitTool:{enabled:false},fast:false}});await ordinary.dispose();await inactive.dispose();assert.equal(inactiveCalls,0);
		const observedChild=await strictFactory.create({cwd:process.cwd(),storage:{kind:"memory"},extensionPaths:[binding.path],ambientExtensions:false,hooks:[],noSkills:true,noContextFiles:true,parentProviderRegistry:modelRuntime,runtime:{fanoutChild:false,depth:1,waitTool:{enabled:false},fast:false}});
		const actual=JSON.parse(fs.readFileSync(process.env.HOME+"/context7-startup.json","utf8"));assert.equal(actual.phase,"bound");assert.equal(actual.session.id,observedChild.sessionId);assert.deepEqual(actual.errors,[]);
		for(const name of ["read","edit","write","bash","codemode"])assert.ok(actual.session.registeredTools.includes(name),name);
		assert.equal(actual.session.registeredTools.includes("subagent"),false,"A normal leaf must not gain sibling delegation");assert.ok(actual.extensions.some(e=>e.path==="<inline:pi-subagents:hosted-context7>"));assert.equal(actual.extensions.some(e=>e.path===binding.path),false);
		await observedChild.dispose();await strictFactory.dispose();
		const {session}=await pi.createAgentSession({cwd:process.cwd(),agentDir:process.env.HOME,settingsManager:settings,resourceLoader:loader,modelRuntime,sessionManager:pi.SessionManager.inMemory(process.cwd())});
		const errors=[];await session.bindExtensions({mode:"print",onError:e=>errors.push(String(e.error))});
		try{
			const gateway=session.getToolDefinition("mcp");assert.ok(gateway);
			const connected=await gateway.execute("synthetic-connect",{connect:"context7"},undefined,undefined,session.extensionRunner.createContext());
			assert.ok(!connected.details?.error,JSON.stringify(connected));
			const tool=session.getToolDefinition("mcp__context7");assert.ok(tool,"ordinary namespace must register: "+JSON.stringify({errors,registry:loader.getExtensions().extensions.map(e=>({path:e.path,tools:[...e.tools.keys()]})),active:session.getActiveToolNames()}));
			const ctx=session.extensionRunner.createContext();
			const invoke=(args)=>tool.execute("synthetic-call",args,undefined,undefined,ctx);
			const allowed=await invoke({tool:"resolve-library-id",args:{libraryName:"react",query:"React useState documentation"}});
			assert.ok(!allowed.details?.error,JSON.stringify(allowed));assert.match(JSON.stringify(allowed),/SYNTHETIC_RESULT_NOT_VENDOR_DOCS/);
			assert.equal(calls.filter(m=>m.method==="tools/call").length,1);
			const initializedBeforeRecovery=calls.filter(m=>m.method==="initialize").length;assert.ok(initializedBeforeRecovery>0);
			const recovery=await invoke({tool:"resolve-library-id",args:{libraryName:"react",query:"recovery"}});assert.ok(!recovery.details?.error,JSON.stringify(recovery));
			assert.equal(calls.filter(m=>m.method==="initialize").length,initializedBeforeRecovery+1,"Expired session must reconnect exactly once through ordinary recovery.");
			const oversized=await invoke({tool:"resolve-library-id",args:{libraryName:"react",query:"oversized"}});assert.equal(oversized.details?.outputGuard?.truncated,true,JSON.stringify(oversized));
			assert.ok(oversized.content.filter(b=>b.type==="text").map(b=>b.text).join("").length<12000,"Ordinary output guard must bound returned text.");
			const sent=calls.filter(m=>m.method==="tools/call").length;assert.equal(sent,4);
			decision="deny";
			const denied=await invoke({tool:"resolve-library-id",args:{libraryName:"react",query:"denied"}});
			assert.ok(denied.details?.error,JSON.stringify(denied));assert.equal(calls.filter(m=>m.method==="tools/call").length,sent);
			fs.writeFileSync("owned/seam-result",JSON.stringify({location:"confined-worker",registry:loader.getExtensions().extensions.map(e=>e.path),methods:calls.map(m=>m.method),sourceFactoryBinding:binding,approvalDeniedWithoutDispatch:true}));
		}finally{await session.extensionRunner.emit({type:"session_shutdown",reason:"quit"});session.dispose()}
		assert.deepEqual(errors,[]);${relayMode ? "client.close();" : ""}console.log("ordinary-adapter-worker-fetch-ok");
	`;
	const child = spawnCollaborationSandbox({
		workspace, initializationToken: randomUUID(), namespaceRoot: fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-context7-ns-"))),
		readPaths: [], writePaths: [owned], runtimePaths: [repo, fs.realpathSync.native(path.join(repo, "node_modules")), installed, "/nix/store", "/proc"],
		hostSocketIsolation: true, providerTransport: relayMode, enrolledEnvironment: ["PI_SUBAGENT_CHILD", "PI_CODING_AGENT_DIR"], tools: collaborationSandboxTools(), command: fs.realpathSync.native(process.execPath),
		args: ["--experimental-strip-types", "--input-type=module", "-e", code],
		env: { PATH: process.env.PATH ?? "", HOME: owned, TMPDIR: owned, PI_CODING_AGENT_DIR: owned, PI_SUBAGENT_CHILD: "1" },
	});
	let upstreamCalls = 0, recovered = false;
	// SAFETY: The sandbox explicitly creates a duplex protected descriptor at stdio[3].
	const relay = relayMode ? attachCollaborationProviderRelay(child.process.stdio[3] as Duplex, { modelId: "test-model", context7: true }, {
		agentDir: owned, cwd: workspace,
		backend: {
			async fetch(url, init) {
				assert.equal(url, "https://mcp.context7.com/mcp"); assert.equal(init.redirect, "error");
				assert.equal(init.headers.has("authorization"), false);
				if (init.method === "GET") return new Response(null, { status: 405 });
				const message = JSON.parse(init.body!.toString("utf8"));
				if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
				let result;
				if (message.method === "server/discover") return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "legacy fixture" } }), { headers: { "content-type": "application/json" } });
				if (message.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "synthetic-context7", version: "test" } };
				else if (message.method === "tools/list") result = { tools: [{ name: "resolve-library-id", description: "Synthetic lookup", inputSchema: { type: "object", properties: { libraryName: { type: "string" }, query: { type: "string" } }, required: ["libraryName", "query"] }, annotations: { readOnlyHint: true } }] };
				else if (message.method === "tools/call") {
					upstreamCalls++;
					if (message.params.arguments.query === "recovery" && !recovered) { recovered = true; return new Response("expired", { status: 404 }); }
					result = { content: [{ type: "text", text: "SYNTHETIC_RESULT_NOT_VENDOR_DOCS" + (message.params.arguments.query === "oversized" ? "x\n".repeat(3000) : "") }], isError: false };
				}
				else throw new Error("Unexpected fixture method " + message.method);
				const responseHeaders = new Headers({ "content-type": "application/json" });
				if (message.method === "initialize") responseHeaders.set("mcp-session-id", "synthetic-session");
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { headers: responseHeaders });
			},
			// SAFETY: This fixture rejects construction; Context7 has no WebSocket path.
			WebSocket: class { constructor() { throw new Error("Context7 has no WebSocket grant."); } } as never,
			close() {},
		},
	}) : undefined;
	let stdout = "", stderr = "";
	child.process.stdout.on("data", (chunk) => { stdout += chunk; }); child.process.stderr.on("data", (chunk) => { stderr += chunk; });
	const timer = setTimeout(() => child.stop(), 25000);
	try {
		const namespace = await child.initialized;
		const result = await child.terminal; assert.equal(result.code, 0, stderr + stdout); assert.equal(result.signal, null);
		assert.ok(namespace); await waitForCollaborationQuiescence(namespace);
		assert.match(stdout, /ordinary-adapter-worker-fetch-ok/);
		const receipt = JSON.parse(fs.readFileSync(path.join(owned, "seam-result"), "utf8"));
		assert.equal(receipt.location, "confined-worker"); assert.equal(receipt.approvalDeniedWithoutDispatch, true);
		if (relayMode) assert.equal(upstreamCalls, 4, "Denied ordinary namespace approval must send zero upstream calls.");
		const adapterSource = { path: adapter, digest: collaborationDigest(adapter) };
		const expected = { runId: "fixture", executionToken: "fixture-epoch", manifestVersion: 1, processInstanceId: "fixture-process", candidateRoot: repo, sdkRoot: collaborationSdkRoot, adapter: adapterSource };
		const manifest: CollaborationManifest = {
			schemaVersion: 1, workflowId: "startup-fixture", runId: "fixture", manifestVersion: 1, workspace, goal: "Observe actual native startup", rationale: "No model or hosted proof", constraints: [], completion: [], concurrency: 1,
			resources: [], packages: [], combinedChecks: [], runtime: { network: "openai-codex", context7: adapterSource, assets: [{ path: repo, digest: collaborationDigest(repo) }, { path: collaborationSdkRoot, digest: collaborationDigest(collaborationSdkRoot) }], extensions: [{ ...adapterSource, effects: ["context7-network"] }], environment: [] },
		};
		const observedFile = path.join(owned, "context7-startup.json");
		const observed = readCollaborationStartupObservation(observedFile, expected, manifest);
		assert.equal(observed.phase, "bound"); assert.ok(observed.session); assert.ok(observed.extensions.some(entry => entry.path === "<inline:pi-subagents:hosted-context7>"));
		for (const executionToken of ["obsolete-epoch", "forged-grant"]) assert.throws(() => readCollaborationStartupObservation(observedFile, { ...expected, executionToken }, manifest), /wrong or stale execution/);
		assert.throws(() => readCollaborationStartupObservation(observedFile, { ...expected, processInstanceId: "wrong-process" }, manifest), /wrong or stale execution/);
		assert.throws(() => readCollaborationStartupObservation(observedFile, { ...expected, manifestVersion: 2 }, manifest), /authority/);
		assert.throws(() => readCollaborationStartupObservation(observedFile, expected, { ...manifest, runtime: { ...manifest.runtime, assets: [{ path: repo, digest: "0".repeat(64) }] } }), /immutable runtime identity changed/);
	} finally { clearTimeout(timer); relay?.close(); child.stop(); }
});

it("required installed memory extension fails closed under the confined private HOME instead of losing its durable effects", { timeout: 20000 }, async () => {
	const repo = fs.realpathSync.native(fileURLToPath(new URL("../..", import.meta.url)));
	const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "context7-required-effect-")));
	const owned = path.join(workspace, "owned"); fs.mkdirSync(owned);
	const required = "/nix/store/pvrigv63sxxd9y68ljj6k0jjj59kn5p7-pi-memory-extension/index.ts";
	assert.ok(fs.existsSync(required), "The original selected memory source must remain present.");
	const code = `
		import assert from "node:assert/strict";
		import * as pi from ${JSON.stringify(path.join(collaborationSdkRoot,"dist/index.js"))};
		import {createDefaultChildSessionFactory} from ${JSON.stringify(path.join(repo,"src/runs/shared/child-session.ts"))};
		let outbound=0;globalThis.fetch=async()=>{outbound++;throw Error("No network allowed during admission")};
		const factory=createDefaultChildSessionFactory({loadPiCodingAgent:async()=>pi,confinedProviderTransport:{model:"openai-codex/test-model"}});
		try{
			await assert.rejects(factory.create({cwd:process.cwd(),storage:{kind:"memory"},tools:[],extensionPaths:[${JSON.stringify(required)}],ambientExtensions:false,hooks:[],noSkills:true,noContextFiles:true,runtime:{fanoutChild:false,depth:1,waitTool:{enabled:false},fast:false}}),error=>String(error).includes("Confined selected extension failed to load")&&String(error).includes(${JSON.stringify(required)})&&String(error).includes("retained evidence requires an independent durable root"));
			assert.equal(outbound,0);console.log("required-memory-effect-blocked-before-network");
		}finally{await factory.dispose()}
	`;
	const child = spawnCollaborationSandbox({
		workspace, initializationToken: randomUUID(), namespaceRoot: fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "context7-required-effect-ns-"))),
		readPaths: [], writePaths: [owned], runtimePaths: [repo, fs.realpathSync.native(path.join(repo,"node_modules")), "/nix/store", "/proc"],
		hostSocketIsolation: true, tools: collaborationSandboxTools(), command: fs.realpathSync.native(process.execPath),
		args: ["--experimental-strip-types", "--input-type=module", "-e", code], env: { PATH: process.env.PATH ?? "", HOME: owned, TMPDIR: owned },
	});
	let stdout = "", stderr = ""; child.process.stdout.on("data", chunk => { stdout += chunk; }); child.process.stderr.on("data", chunk => { stderr += chunk; });
	const timer = setTimeout(() => child.stop(),15000);
	try { const namespace=await child.initialized; const result=await child.terminal;assert.equal(result.code,0,stderr+stdout);assert.equal(result.signal,null);assert.ok(namespace);await waitForCollaborationQuiescence(namespace);assert.match(stdout,/required-memory-effect-blocked-before-network/); }
	finally { clearTimeout(timer);child.stop(); }
});

it("Context7 source binding, finite profile capacity and persisted authority fail closed", () => {
	const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "context7-profile-ticket-")));
	fs.mkdirSync(path.join(workspace, "owned"));
	const immutable = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "context7-profile-assets-")));
	const entries = Array.from({ length: 42 }, (_, index) => {
		const file = path.join(immutable, index + ".mjs");
		fs.writeFileSync(file, "export default () => {};\n");
		return { path: file, digest: collaborationDigest(file), effects: ["local-filesystem"] satisfies ("local-filesystem" | "context7-network")[] };
	});
	entries[0]!.effects = ["context7-network"];
	const binding = { path: entries[0]!.path, digest: entries[0]!.digest };
	const input: CollaborationManifest = {
		schemaVersion: 1, workflowId: "context7-test", runId: "context7-test", manifestVersion: 1, workspace,
		goal: "Fixture admission", rationale: "Synthetic identity checks, not a selected-profile certificate", constraints: [], completion: [], concurrency: 1,
		resources: [{ id: "owned", kind: "path", path: "owned" }],
		packages: [{ id: "worker", goal: "Fixture", rationale: "Fixture", constraints: [], completion: [], reads: [], writes: ["owned"], exclusive: [], prerequisites: [], requires: [], publishes: [], checks: [], configuration: { agent: "coder" } }],
		combinedChecks: [{ id: "check", command: "true", timeoutMs: 1000, reads: [], writes: [], exclusive: [] }],
		runtime: { network: "openai-codex", context7: binding, assets: [{ path: immutable, digest: collaborationDigest(immutable) }], extensions: entries, environment: [] },
	};
	const normalized = normalizeCollaborationManifest(input);
	assert.equal(normalized.runtime.extensions.length, 42);
	assert.equal(Value.Check(collaborationManifestRecordSchema, normalized), true);
	verifyCollaborationRuntime(normalized);
	assert.throws(() => normalizeCollaborationManifest({ ...input, runtime: { ...input.runtime, context7: { ...binding, digest: "0".repeat(64) } } }), /source\/effect binding/);
	assert.throws(() => normalizeCollaborationManifest({ ...input, runtime: { ...input.runtime, extensions: [...entries, ...entries] } }), /bounded array/);
	assert.throws(() => normalizeCollaborationManifest({ ...input, runtime: { ...input.runtime, network: "none" } }), /offline runtime/);
	const additional = entries.map(entry => ({ ...entry, effects: [...entry.effects] }));
	additional[1]!.effects = ["context7-network"];
	assert.throws(() => normalizeCollaborationManifest({ ...input, runtime: { ...input.runtime, extensions: additional } }), /cannot enroll another extension/);
	fs.writeFileSync(binding.path, "export default () => { throw Error('changed'); };\n");
	assert.throws(() => verifyCollaborationRuntime(normalized), /immutable runtime identity changed/);
});

for (const enrolled of [false, true]) it("Context7 authority rejects escapes and drains cancellation in the real boundary, enrolled=" + enrolled, { timeout: 20000 }, async () => {
	const repo = fs.realpathSync.native(fileURLToPath(new URL("../..", import.meta.url)));
	const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "context7-route-")));
	const owned = path.join(workspace, "owned"); fs.mkdirSync(owned);
	const code = `
		import assert from "node:assert/strict";
		import net from "node:net";
		import {createCollaborationProviderClient} from ${JSON.stringify(path.join(repo,"src/runs/shared/collaboration-provider-transport.ts"))};
		const client=createCollaborationProviderClient(3);
		const route="https://mcp.context7.com/mcp";
		const init={method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})};
		for(const url of ["https://other.invalid/mcp",route+"/",route+"?escape=1","http://mcp.context7.com/mcp"])
			await assert.rejects(client.fetch(url,init));
		for(const name of ["authorization","cookie","proxy-authorization","host","x-context7-api-key","mcp-session-id","mcp-method","mcp-name"])
			await assert.rejects(client.fetch(route,{...init,headers:{...init.headers,[name]:"forged"}}));
		for(const method of ["DELETE","PUT"])await assert.rejects(client.fetch(route,{...init,method}));
		for(const method of ["resources/read","sampling/createMessage","forged-grant"])
			await assert.rejects(client.fetch(route,{...init,body:JSON.stringify({jsonrpc:"2.0",id:2,method})}));
		await assert.rejects(client.fetch(route,{...init,body:JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"delete-anything",arguments:{}}})}));
		await assert.rejects(client.fetch(route,{...init,body:JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"query-docs",arguments:{libraryId:"/react",query:"docs",grant:true}}})}));
		await assert.rejects(client.fetch(route,{...init,body:JSON.stringify([{jsonrpc:"2.0",id:2,method:"tools/list"}])}));
		await new Promise(resolve=>{const socket=net.createConnection({path:"/tmp/forbidden.sock"});socket.once("error",error=>{assert.equal(error.code,"EPERM");resolve()})});
		${enrolled ? `
		const get=await client.fetch(route,{headers:{accept:"text/event-stream"}});assert.equal(get.status,405);await get.text();
		await assert.rejects(client.fetch(route,{...init,body:JSON.stringify({jsonrpc:"2.0",id:3,method:"initialize",params:{}})}));
		const abort=new AbortController();
		const response=await client.fetch(route,{...init,signal:abort.signal});
		const reader=response.body.getReader();assert.equal(new TextDecoder().decode((await reader.read()).value),"FIRST");
		const pending=reader.read();abort.abort();await assert.rejects(pending);
		` : "await assert.rejects(client.fetch(route,init));"}
		client.close();
		await assert.rejects(client.fetch(route,init));
		console.log("context7-route-boundary-ok");
	`;
	const child = spawnCollaborationSandbox({
		workspace, initializationToken: randomUUID(), namespaceRoot: fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "context7-route-ns-"))),
		readPaths: [], writePaths: [owned], runtimePaths: [repo, fs.realpathSync.native(path.join(repo, "node_modules")), "/nix/store", "/proc"],
		hostSocketIsolation: true, providerTransport: true, tools: collaborationSandboxTools(), command: fs.realpathSync.native(process.execPath),
		args: ["--experimental-strip-types", "--input-type=module", "-e", code], env: { PATH: process.env.PATH ?? "", HOME: owned, TMPDIR: owned },
	});
	let upstream = 0, aborted = 0, cancelled = 0, closed = 0;
	const authority: CollaborationProviderAuthority = { modelId: "test-model" };
	if (enrolled) authority.context7 = true;
	// SAFETY: The sandbox explicitly creates a duplex protected descriptor at stdio[3].
	const relay = attachCollaborationProviderRelay(child.process.stdio[3] as Duplex, authority, {
		agentDir: owned, cwd: workspace, backend: {
			async fetch(url, init) {
				upstream++; assert.equal(url, "https://mcp.context7.com/mcp");
				assert.equal(init.redirect, "error");
				if (init.method === "GET") return new Response(null, { status: 405 });
				if (JSON.parse(init.body!.toString()).method === "initialize") return new Response(null, { status: 302, headers: { location: "https://not-authorized.invalid/" } });
				init.signal.addEventListener("abort", () => { aborted++; }, { once: true });
				return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("FIRST")); }, cancel() { cancelled++; } }), { headers: { "content-type": "text/event-stream" } });
			},
			// SAFETY: This fixture rejects construction; Context7 has no WebSocket path.
			WebSocket: class { constructor() { throw new Error("No WebSocket grant."); } } as never,
			close() { closed++; },
		},
	});
	let stdout = "", stderr = ""; child.process.stdout.on("data", chunk => { stdout += chunk; }); child.process.stderr.on("data", chunk => { stderr += chunk; });
	const timer = setTimeout(() => child.stop(), 15000);
	try {
		const namespace = await child.initialized;
		const result = await child.terminal; assert.equal(result.code, 0, stderr + stdout); assert.equal(result.signal, null);
		assert.ok(namespace); await waitForCollaborationQuiescence(namespace);
		relay.close();
		assert.match(stdout, /context7-route-boundary-ok/);
		assert.equal(upstream, enrolled ? 3 : 0, "Forbidden requests must have zero upstream effects; only GET, initial redirect response, and stream are admitted.");
		assert.equal(aborted, enrolled ? 1 : 0); assert.equal(cancelled, enrolled ? 1 : 0); assert.equal(closed, 1);
	} finally { clearTimeout(timer); relay.close(); child.stop(); }
});

for (const missing of [false, true]) it("normal native bootstrap constructs its own bound Context7 observation before prompt, missing=" + missing, { timeout: 30000 }, async () => {
	const repo = fs.realpathSync.native(fileURLToPath(new URL("../..", import.meta.url)));
	const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "context7-bootstrap-")));
	const owned = path.join(workspace, "owned"); fs.mkdirSync(owned);
	const host = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "context7-bootstrap-host-"))), privateRoot = path.join(owned, "private");
	fs.mkdirSync(privateRoot);
	fs.writeFileSync(path.join(host,"dependency-proceed.json"),JSON.stringify({executionToken:"bootstrap-epoch",manifestVersion:1}));
	const adapter = "/home/reyhan/.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts";
	const aliases = resolveHostPeerAliases(collaborationSdkRoot); assert.deepEqual(aliases.missing,[]);
	const code = `
		import assert from "node:assert/strict";import fs from "node:fs";
		import * as pi from ${JSON.stringify(path.join(collaborationSdkRoot,"dist/index.js"))};
		import {runConfiguredSubagent} from ${JSON.stringify(path.join(repo,"src/runs/background/subagent-runner-bootstrap.ts"))};
		const root=process.env.HOME;let upstream=0,prompts=0,protocol=0;
		fs.mkdirSync(root+"/bin");
		fs.writeFileSync(root+"/bin/npm",'#!/bin/sh\\necho forbidden > '+root+'/npm-attempt\\nexit 42\\n',{mode:0o700});
		process.env.PATH=root+"/bin:"+process.env.PATH;
		fs.writeFileSync(root+"/settings.json",JSON.stringify({packages:["npm:must-not-install@1.0.0"],defaultThinkingLevel:"low"}));
		globalThis.fetch=async(input,init)=>{
			if(String(input)!=="https://mcp.context7.com/mcp"){upstream++;throw Error("Offline bootstrap must not send provider or arbitrary traffic")}
			protocol++;if(init.method==="GET")return new Response(null,{status:405});
			const m=JSON.parse(init.body);if(m.method==="notifications/initialized")return new Response(null,{status:202});
			if(m.method==="server/discover")return new Response(JSON.stringify({jsonrpc:"2.0",id:m.id,error:{code:-32601,message:"synthetic legacy setup"}}),{headers:{"content-type":"application/json"}});
			let result;if(m.method==="initialize")result={protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"offline-bootstrap-setup-only",version:"fixture"}};else if(m.method==="tools/list")result={tools:[]};else{upstream++;throw Error("No documentation tool calls allowed in bootstrap fixture")}
			return new Response(JSON.stringify({jsonrpc:"2.0",id:m.id,result}),{headers:{"content-type":"application/json"}});
		};
		const observation=root+"/private/context7-startup.json";
		const sdk={...pi,async createAgentSession(input){
			const actual=await pi.createAgentSession(input),prompt=actual.session.prompt.bind(actual.session);
			actual.session.prompt=(...args)=>{const evidence=JSON.parse(fs.readFileSync(observation,"utf8"));assert.equal(evidence.phase,"bound");assert.equal(evidence.session.id,actual.session.sessionManager.getSessionId());prompts++;return prompt(...args)};
			return actual;
		}};
		const config={id:"bootstrap-fixture",sessionId:"synthetic-fixture-parent",runnerProcessInstanceId:"bootstrap-process",steps:[{agent:"coder",task:"Offline native startup only. No provider model is configured.",extensions:[${JSON.stringify(adapter)}${missing ? ' ,root+"/missing.ts"' : ""}],launchResolvedExtensions:{disableAmbientExtensions:true},inheritSkills:false,inheritProjectContext:false,inheritGlobalContext:false}],resultPath:root+"/result.json",cwd:process.cwd(),placeholder:"",asyncDir:${JSON.stringify(host)},piPackageRoot:${JSON.stringify(collaborationSdkRoot)},collaborationGrant:"bootstrap-epoch",collaborationManifestVersion:1,collaborationPrivateDir:root+"/private",collaborationDependencyBindings:{},collaborationContext7:{path:${JSON.stringify(adapter)},digest:${JSON.stringify(collaborationDigest(adapter))}},collaborationProviderTransport:{model:"openai-codex/test-model"},collaborationModelStorage:{readonlyAuthModule:${JSON.stringify(path.join(collaborationSdkRoot,"dist/core/auth-storage.js"))},authPath:root+"/absent-auth.json",modelsPath:root+"/absent-models.json",modelsStorePath:root+"/private/models-store.json"}};
		await runConfiguredSubagent(config,{loadPiCodingAgent:async()=>sdk});
		const evidence=JSON.parse(fs.readFileSync(observation,"utf8"));
		assert.equal(evidence.binding.runId,config.id);assert.equal(evidence.binding.executionToken,config.collaborationGrant);assert.equal(evidence.binding.processInstanceId,config.runnerProcessInstanceId);
		${missing ? 'assert.equal(evidence.phase,"loaded");assert.ok(evidence.errors.some(e=>e.path.endsWith("/missing.ts")));assert.equal(prompts,0);assert.equal(protocol,0);' : 'assert.equal(evidence.phase,"bound");assert.deepEqual(evidence.errors,[]);for(const name of ["read","edit","write","bash","codemode"])assert.ok(evidence.session.registeredTools.includes(name));assert.equal(evidence.session.registeredTools.includes("subagent"),false);assert.equal(prompts,1);'}
		assert.equal(upstream,0);
		assert.equal(fs.existsSync(root+"/npm-attempt"),false,"Explicit prepared profile must not invoke npm");
		const settings=JSON.parse(fs.readFileSync(root+"/settings.json","utf8"));assert.deepEqual(settings.packages,[]);assert.equal(settings.defaultThinkingLevel,"low");
		console.log("normal-bootstrap-observation-ok");
	`;
	const child=spawnCollaborationSandbox({
		workspace,initializationToken:randomUUID(),namespaceRoot:fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),"context7-bootstrap-ns-"))),
		readPaths:[],writePaths:[owned],runtimePaths:[repo,host,fs.realpathSync.native(path.join(repo,"node_modules")),"/home/reyhan/.pi/agent/npm/node_modules","/nix/store","/proc"],
		hostSocketIsolation:true,tools:collaborationSandboxTools(),command:fs.realpathSync.native(process.execPath),
		args:["--experimental-strip-types","--import",path.join(repo,"runner-peer-preload.mjs"),"--input-type=module","-e",code],
		env:{PATH:process.env.PATH??"",HOME:owned,TMPDIR:owned,PI_CODING_AGENT_DIR:owned,JITI_ALIAS:JSON.stringify(aliases.aliases),PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT:collaborationSdkRoot},
		enrolledEnvironment:["JITI_ALIAS","PI_CODING_AGENT_DIR","PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT"],
	});
	fs.writeFileSync(path.join(host,"status.json"),JSON.stringify({version:1,runId:"bootstrap-fixture",pid:child.process.pid,processTerminal:{runnerProcessInstanceId:"bootstrap-process"},agent:"coder",task:"offline",state:"running",startedAt:Date.now(),updatedAt:Date.now()}));
	let stdout="",stderr="";child.process.stdout.on("data",chunk=>{stdout+=chunk});child.process.stderr.on("data",chunk=>{stderr+=chunk});
	const timer=setTimeout(()=>child.stop(),25000);
	try{const identity=await child.initialized;const result=await child.terminal;assert.equal(result.code,0,stdout+stderr);assert.ok(identity);await waitForCollaborationQuiescence(identity);assert.match(stdout,/normal-bootstrap-observation-ok/)}
	finally{clearTimeout(timer);child.stop()}
});
