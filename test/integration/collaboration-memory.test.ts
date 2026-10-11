import assert from "node:assert/strict";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { collaborationResult } from "../support/collaboration-results.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { runWorkflowScript } from "../../src/workflows/scripted-workflow.ts";
import { collaborationDigest } from "../../src/workflows/collaboration-manifest.ts";
import { makeAgent, createEventBus } from "../support/helpers.ts";
import { DIRS, DEFAULT_ARTIFACT_CONFIG } from "../../src/shared/types.ts";

async function until<T>(read: () => T | undefined): Promise<T> {
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		const value = read(); if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Native memory barrier did not arrive.");
}
interface TreeMemory { rssBytes: number; pssBytes: number; privateBytes: number; processCount: number; complete: boolean; pssUnavailable: string[] }
function treeMemory(): TreeMemory {
	const seen = new Set<number>(), pending = [process.pid];
	let rssBytes = 0, pssBytes = 0, privateBytes = 0, complete = true;
	const pssUnavailable: string[] = [];
	while (pending.length) {
		const pid = pending.pop()!; if (seen.has(pid)) continue; seen.add(pid);
		try {
			const status = fs.readFileSync("/proc/" + pid + "/status", "utf8");
			const match = /^VmRSS:\s+(\d+) kB$/mu.exec(status); if (match) rssBytes += Number(match[1]) * 1024; else complete = false;
			try {
				const rollup = fs.readFileSync("/proc/" + pid + "/smaps_rollup", "utf8");
				const pss = /^Pss:\s+(\d+) kB$/mu.exec(rollup);
				if (!pss) throw new Error("Pss field is absent");
				pssBytes += Number(pss[1]) * 1024;
				for (const match of rollup.matchAll(/^Private_(?:Clean|Dirty|Hugetlb):\s+(\d+) kB$/gmu)) privateBytes += Number(match[1]) * 1024;
			// SAFETY: Only the optional Node filesystem error code is read for honest metric incompleteness, not authority.
			} catch (error) { pssUnavailable.push("pid=" + pid + ":" + (Value.Check(Type.Object({ code: Type.String() }, { additionalProperties: true }), error) ? error.code : String(error))); }
			pending.push(...fs.readFileSync("/proc/" + pid + "/task/" + pid + "/children", "utf8").trim().split(/\s+/u).filter(Boolean).map(Number));
		} catch { complete = false; }
	}
	return { rssBytes, pssBytes, privateBytes, processCount: seen.size, complete, pssUnavailable };
}
it("measures retained coordination and unique native process-tree RSS for eight held children and repeated cleanup", { timeout: 90000 }, async () => {
	assert.ok(Value.Check(Type.Function([], Type.Any()), globalThis.gc), "Run this measurement with --expose-gc; do not fabricate retained heap from allocations.");
	const repo = fs.realpathSync.native(fileURLToPath(new URL("../..", import.meta.url)));
	const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),"collaboration-eight-")));
	const fixed = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),"collaboration-memory-fixed-")));
	const sdk = "/nix/store/fylxrmnhiffb7f18lmwmwr013r9a1nqy-pi-1.1.0/lib/pi/node_modules/@earendil-works/pi-coding-agent";
	const oldSdk = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
	process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = sdk;
	const {executeAsyncSingle,workflowAwaitedAsyncResultPath}=await import("../../src/runs/background/async-execution.ts");
	const names=Array.from({length:8},(_,i)=>"p"+i);
	for (const name of [...names,"checks"]) fs.mkdirSync(path.join(workspace,name));
	fs.writeFileSync(path.join(workspace,"checks","combined.cjs"),names.map(name=>"require('assert/strict').equal(require('../"+name+"/sum.cjs').sum(2,3),5);").join("\n"));
	const provider=path.join(fixed,"provider.mjs");
	fs.writeFileSync(provider,`
		import fs from "node:fs";
		import * as ai from "${path.dirname(sdk)}/pi-ai/dist/index.js";
		export default function(api){
			const faux=ai.fauxProvider({provider:"memory-scripted",models:${JSON.stringify(names.map(id=>({id})))},tokensPerSecond:100000});
			api.registerProvider(faux.provider);
			api.on("session_start",(_event,ctx)=>{
				const config=JSON.parse(fs.readFileSync(process.argv.at(-1),"utf8"));
				const name=ctx.model.id;
				const source='const fs=require("fs");fs.writeFileSync('+JSON.stringify(name+"/ready")+','+JSON.stringify(config.id)+');const t=setInterval(()=>{if(fs.readFileSync('+JSON.stringify(name+"/hold")+',"utf8")==="1"){clearInterval(t);fs.writeFileSync('+JSON.stringify(name+"/sum.cjs")+',"exports.sum=(a,b)=>a+b;")}},5);';
				const receipt={criteriaSatisfied:[{id:"criterion-1",status:"satisfied",evidence:"Owned module implemented by native shell"}],changedFiles:[],testsAddedOrUpdated:[],commandsRun:[],validationOutput:[],residualRisks:[],noStagedFiles:true,manualNotes:"Controlled synthetic provider, not live evidence"};
				faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("bash",{command:${JSON.stringify(process.execPath)}+" -e "+JSON.stringify(source),timeout:30}),{stopReason:"toolUse"}),ai.fauxAssistantMessage("done\\n\\x60\\x60\\x60acceptance-report\\n"+JSON.stringify(receipt)+"\\n\\x60\\x60\\x60")]);
			});
		}
	`);
	const assets=[repo,fs.realpathSync.native(path.join(repo,"node_modules"))].map(asset=>({path:asset,digest:collaborationDigest(asset)}));
	const extensions=[{path:provider,digest:collaborationDigest(provider),effects:["local-filesystem","provider-network"]}];
	const measurements: any[]=[];
	try {
		for(let cycle=0;cycle<2;cycle++){
			for(const name of names) fs.writeFileSync(path.join(workspace,name,"hold"),"0");
			globalThis.gc!(); const before=process.memoryUsage(), beforeTree=treeMemory();
			const manifest={
				schemaVersion:1,workflowId:"eight-native",runId:"eight-"+randomUUID(),manifestVersion:1,workspace,
				goal:"Measure eight native resident children",rationale:"Retained coordinator state is separate from worker memory",constraints:[],completion:["All combined sums pass"],concurrency:8,
				resources:[...names.map(name=>({id:name,kind:"path",path:name})),{id:"checks",kind:"path",path:"checks",initialPublication:{version:1,digest:collaborationDigest(path.join(workspace,"checks"))}}],
				packages:names.map(name=>({id:name,goal:"Implement sum(a,b)",rationale:"Independent owned module",constraints:[],completion:["sum(2,3) returns 5"],reads:[],writes:[name],exclusive:[],prerequisites:[],requires:[],publishes:[],checks:[],configuration:{agent:name,model:"memory-scripted/"+name}})),
				combinedChecks:[{id:"sums",command:JSON.stringify(process.execPath)+" checks/combined.cjs",timeoutMs:5000,reads:[...names,"checks"],writes:[],exclusive:[]}],
				runtime:{network:"none",assets,extensions,environment:[]},
			};
			const nativeIds=new Map<string,string>();let latest:any,statusEvents=0,maxResidents=0;
			const running=runWorkflowScript({
				script:"return await runs.collaborate(args.manifest)",args:{manifest},workflowRunId:manifest.workflowId,timeoutMs:45000,
				status:async()=>{throw Error("No status launch substitute")},
				onCollaborationStatus(summary){latest=summary;statusEvents++;maxResidents=Math.max(maxResidents,summary.residents)},
				launch:async(key,params)=>{
					const runId="memory-native-"+randomUUID();nativeIds.set(String(params.agent),runId);
					const output = params.output;
					assert.ok(Value.Check(Type.Union([Type.String(), Type.Boolean()]), output));
					const start=await executeAsyncSingle(runId,{
						agent:String(params.agent),agentConfig:makeAgent(String(params.agent),{extensions:[provider],tools:["read","write","edit","bash","codemode"]}),
						task:String(params.task),cwd:workspace,collaborationGrant:String(params.collaborationGrant),modelOverride:String(params.model),output,
						// SAFETY: This fixture binds real native artifacts to its dedicated directory; the native runner owns artifact validation.
						parentWorkflowRunId:manifest.workflowId,workflowKey:key,workflowAwaitAsync:true,artifactConfig:{...DEFAULT_ARTIFACT_CONFIG,enabled:true,dir:fixed},shareEnabled:false,maxSubagentDepth:0,timeoutMs:35000,
						// SAFETY: The isolated fixture supplies the exact methods/data exercised below; no claimed kernel or SDK behavior is mocked.
						ctx:{cwd:workspace,currentSessionId:"memory-parent",parentSessionId:"memory-parent",projectTrusted:true,pi:{events:createEventBus(),sendMessage(){}}} as any,
					});
					assert.notEqual(start.isError,true,JSON.stringify(start));
					const file=workflowAwaitedAsyncResultPath(path.join(DIRS.async,runId));
					const result=await until(()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):undefined);
					return {key,runId,ok:result.success===true,output:String(result.results?.[0]?.output??result.error??"")};
				},
			});
			let settled=false;running.finally(()=>{settled=true}).catch(()=>{});
			try{
				await until(()=>{
					if(settled)throw Error("Native run ended before eight-way barrier");
					return names.every(name=>{try{return fs.readFileSync(path.join(workspace,name,"ready"),"utf8")===nativeIds.get(name)}catch{return false}})?true:undefined;
				});
				globalThis.gc!();const held=process.memoryUsage(),heldTree=treeMemory();
				const statusStart=performance.now();
				for(let i=0;i<2000;i++) {const snapshot=JSON.parse(fs.readFileSync(latest.artifacts.snapshot,"utf8"));assert.equal(snapshot.summary.residents,8)}
				const statusReadMs=performance.now()-statusStart;
				for(const name of names)fs.writeFileSync(path.join(workspace,name,"hold"),"1");
				const result=await running;assert.equal(collaborationResult(result.value).state,"completed",JSON.stringify(result.value));assert.equal(maxResidents,8);
				globalThis.gc!();const after=process.memoryUsage(),afterTree=treeMemory();
				measurements.push({cycle,before,held,after,beforeTree,heldTree,afterTree,statusEvents,statusReads:2000,statusReadMs,incrementalRetainedHeapBytes:held.heapUsed-before.heapUsed,afterCleanupHeapBytes:after.heapUsed-before.heapUsed,initialHeapTargetBytes:10*1024*1024,belowInitialTarget:held.heapUsed-before.heapUsed<10*1024*1024,scope:"Parent workflow coordination, native launch resolution and worker-thread host. Worker/model memory is separate. RSS sums unique processes but includes shared pages in each process; PSS apportions those pages. Missing PSS reads include the exact PID and error."});
			}catch(error){
				console.error("MEMORY_READINESS_DIAGNOSTIC " + JSON.stringify({ cycle, latest, nativeIds: Object.fromEntries(nativeIds), ready: Object.fromEntries(names.map(name => { try { return [name, fs.readFileSync(path.join(workspace, name, "ready"), "utf8")]; } catch { return [name, null]; } })), nativeStatuses: [...nativeIds].map(([name,id]) => { try { return { name, status: JSON.parse(fs.readFileSync(path.join(DIRS.async,id,"status.json"),"utf8")) }; } catch { return { name, unavailable: true }; } }) }));
				throw error;
			}finally{for(const name of names)fs.writeFileSync(path.join(workspace,name,"hold"),"1");await running.catch(()=>{})}
		}
		console.log("COLLABORATION_MEASUREMENTS "+JSON.stringify({measurements,completeness:{retainedHeap:true,parentRss:true,external:true,wholeNativeProcessTree:true,foregroundInProcess:false,slowStorage:false,unwritableStorage:false}}));
	}finally{if(oldSdk===undefined)delete process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;else process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT=oldSdk}
});
