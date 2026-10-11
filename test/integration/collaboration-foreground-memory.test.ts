import assert from "node:assert/strict";
import { Type } from "typebox";
import { Value } from "typebox/value";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { it } from "node:test";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { createDefaultChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import type { RunSyncOptions } from "../../src/shared/types.ts";
import { makeAgent } from "../support/helpers.ts";

function memoryTree() {
 const seen = new Set<number>(), pending = [process.pid];
 let rss = 0, pss = 0;
 const unavailable: string[] = [];
 while (pending.length) {
  const pid = pending.pop()!; if (seen.has(pid)) continue; seen.add(pid);
  try {
   const status = fs.readFileSync("/proc/"+pid+"/status","utf8");
   rss += Number(/^VmRSS:\s+(\d+) kB$/mu.exec(status)?.[1] ?? 0)*1024;
   const rollup = fs.readFileSync("/proc/"+pid+"/smaps_rollup","utf8");
   pss += Number(/^Pss:\s+(\d+) kB$/mu.exec(rollup)?.[1] ?? 0)*1024;
   pending.push(...fs.readFileSync("/proc/"+pid+"/task/"+pid+"/children","utf8").trim().split(/\s+/u).filter(Boolean).map(Number));
  } catch(error) { unavailable.push("pid="+pid+":"+String(error)); }
 }
 return {rss,pss,pids:[...seen],unavailable};
}
it("measures eight ordinary foreground sessions once per process, native subprocesses and repeated cleanup", {timeout:90000}, async()=>{
 assert.ok(Value.Check(Type.Function([], Type.Any()), globalThis.gc), "Use --expose-gc for retained heap measurement.");
 const workspace=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),"foreground-memory-")));
 const sdk="/nix/store/fylxrmnhiffb7f18lmwmwr013r9a1nqy-pi-1.1.0/lib/pi/node_modules/@earendil-works/pi-coding-agent";
 const pi=await import(pathToFileURL(path.join(sdk,"dist/index.js")).href);
 const ai=await import(pathToFileURL(path.join(path.dirname(sdk),"pi-ai/dist/index.js")).href);
 const names=Array.from({length:8},(_,i)=>"f"+i), measurements=[];
 for(let cycle=0;cycle<2;cycle++){
  const factory=createDefaultChildSessionFactory({loadPiCodingAgent:async()=>pi});
  const models=await pi.ModelRuntime.create();
  const active=new Set<string>(), snapshots=new Map<string, Parameters<NonNullable<RunSyncOptions["onUpdate"]>>[0]>();let events=0;
  fs.writeFileSync(path.join(workspace,"hold"),"0");
  for(const name of names){
   const faux=ai.fauxProvider({provider:"foreground-memory-"+name,models:[{id:"model"}],tokensPerSecond:100000});
   const source='const fs=require("fs");const t=setInterval(()=>{if(fs.readFileSync("hold","utf8")==="1")clearInterval(t)},5);';
   faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("bash",{command:JSON.stringify(process.execPath)+" -e "+JSON.stringify(source),timeout:30}),{stopReason:"toolUse"}),ai.fauxAssistantMessage("Synthetic read-only foreground observation ended.")]);
   models.registerNativeProvider(faux.provider);
  }
  await models.refresh({allowNetwork:false});
  globalThis.gc!();const before=process.memoryUsage(),beforeTree=memoryTree();
  const agents=names.map(name=>makeAgent(name,{acceptanceRole:"read-only",model:"foreground-memory-"+name+"/model",tools:["bash"],extensions:[]}));
  const outcomes: unknown[]=[];
  const running=names.map(name=>runSync(workspace,agents,name,"Read the synthetic hold marker until released; do not write application files.",{runId:"foreground-"+cycle+"-"+name,cwd:workspace,modelOverride:"foreground-memory-"+name+"/model",childSessionFactory:factory,parentProviderRegistry:models,timeoutMs:35000,onUpdate(progress){snapshots.set(name,progress);events++;if(progress.details.progress?.some(entry=>entry.currentTool==="bash"))active.add(name);}}).then(result=>{outcomes.push({agent:result.agent,exitCode:result.exitCode,error:result.error});return result;}));
  try {
   const deadline=Date.now()+20000;
   while(active.size!==8||memoryTree().pids.filter(pid=>pid!==process.pid&&fs.readFileSync("/proc/"+pid+"/cmdline","utf8").includes('readFileSync("hold"')).length!==8){if(Date.now()>deadline)throw Error("Foreground native barrier did not arrive: "+JSON.stringify({active:[...active],tree:memoryTree(),outcomes}));await new Promise(resolve=>setTimeout(resolve,10));}
   globalThis.gc!();const held=process.memoryUsage(),heldTree=memoryTree();
   assert.equal(new Set(heldTree.pids).size,heldTree.pids.length);
   assert.equal(heldTree.pids.filter(pid=>pid===process.pid).length,1,"Shared foreground RSS is counted once, not once per session.");
   const start=performance.now();for(let i=0;i<2000;i++){assert.equal(snapshots.size,8);assert.ok(JSON.stringify([...snapshots.values()]).includes("bash"));}const statusReadMs=performance.now()-start;
   fs.writeFileSync(path.join(workspace,"hold"),"1");
   const results=await Promise.all(running);assert.ok(results.every(result=>result.exitCode===0),JSON.stringify(results));
   await factory.dispose();for(const name of names)models.unregisterProvider("foreground-memory-"+name);globalThis.gc!();
   measurements.push({cycle,before,held,after:process.memoryUsage(),beforeTree,heldTree,afterTree:memoryTree(),events,statusReads:2000,statusReadMs,scope:"Existing ordinary foreground runSync/SDK sessions and bash descendants. No foreground shared-workspace worker mode was added."});
  } finally {fs.writeFileSync(path.join(workspace,"hold"),"1");await Promise.allSettled(running);await factory.dispose();}
 }
 console.log("FOREGROUND_MEASUREMENTS "+JSON.stringify({measurements,completeness:{heap:true,rss:true,external:true,uniqueProcessTree:true,pss:true,ordinaryForeground:true}}));
});
