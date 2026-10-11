import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { collaborationDigest, type CollaborationManifest } from "../../src/workflows/collaboration-manifest.ts";
import { reuseCollaborationCompletion, type CollaborationSnapshot } from "../../src/workflows/collaboration-recovery.ts";
import type { CollaborationPackageState } from "../../src/workflows/collaboration.ts";

function fixture() {
 const workspace=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),"reuse-generation-")));
 for(const id of ["input","output"])fs.mkdirSync(path.join(workspace,id));
 fs.writeFileSync(path.join(workspace,"input","value"),"PUBLISHED");
 fs.writeFileSync(path.join(workspace,"output","value"),"CONSUMED_V1");
 const digest=collaborationDigest(path.join(workspace,"input"));
 const pkg={id:"C",goal:"Consume published input",rationale:"Generation-bound reuse",constraints:[],completion:["Consume current publication"],reads:["input"],writes:["output"],exclusive:[],prerequisites:[],requires:[],publishes:[],checks:[],configuration:{agent:"C"}};
 const manifest: CollaborationManifest={schemaVersion:1,workflowId:"closure",runId:"generation",manifestVersion:1,workspace,goal:"generation",rationale:"closure",constraints:[],completion:[],concurrency:1,resources:[{id:"input",kind:"path",path:"input",initialPublication:{version:1,digest}},{id:"output",kind:"path",path:"output"}],packages:[pkg],combinedChecks:[],runtime:{network:"none",assets:[],extensions:[],environment:[]}};
 const state: CollaborationPackageState={id:"C",state:"completed",executionId:"consumer-v1",completionContractDigest:createHash("sha256").update(JSON.stringify(pkg)).digest("hex"),completionInputs:{input:{path:path.join(workspace,"input"),version:1,digest}},completionPrerequisites:{},outputDigests:{output:collaborationDigest(path.join(workspace,"output"))}};
 const prior: CollaborationSnapshot={version:1,epoch:"prior",sequence:1,manifestDigest:"historical",manifest,summary:{runId:"generation",manifestVersion:1,controlSequence:0,barrier:"none",effectiveConfiguration:{C:pkg.configuration},state:"completed",residents:0,ceiling:1,capacityLimit:1,packages:[state],ownership:[],pendingConsequential:{barrier:"none",controlSequence:0},publications:{input:{version:1,digest}},verification:"passed",artifacts:{snapshot:"fixture",journal:"fixture"},measurementCompleteness:{coordination:false,workerUsage:false}}};
 return {manifest,state,prior};
}
it("completion reuse rejects changed current initial publication generation with unchanged bytes",()=>{
 const {manifest,state,prior}=fixture();
 reuseCollaborationCompletion(prior,manifest,state);
 const amended=structuredClone(manifest);amended.manifestVersion=2;
 amended.resources[0]!.initialPublication!.version=2;
 assert.throws(()=>reuseCollaborationCompletion(prior,amended,state),/content-compatible/);
});
it("completion reuse rejects changed or removed current initial publication content contract",()=>{
 const {manifest,state,prior}=fixture();
 for(const change of ["digest","removed"]){
  const amended=structuredClone(manifest);amended.manifestVersion=2;
  if(change==="digest")amended.resources[0]!.initialPublication!.digest="different-current-content";
  else delete amended.resources[0]!.initialPublication;
  assert.throws(()=>reuseCollaborationCompletion(prior,amended,state),/content-compatible/);
 }
});
it("completion reuse preserves an unchanged seed superseded by a reused producer publication",()=>{
 const {manifest,state,prior}=fixture();
 manifest.packages.unshift({...manifest.packages[0]!,id:"A",reads:[],writes:["input"],publishes:[{resourceId:"input",version:2}],configuration:{agent:"A"}});
 prior.summary.publications.input={...prior.summary.publications.input!,version:2,packageId:"A",executionId:"producer-v2"};
 state.completionInputs!.input={...state.completionInputs!.input!,version:2,packageId:"A",executionId:"producer-v2"};
 reuseCollaborationCompletion(prior,manifest,state);
 const amended=structuredClone(manifest);amended.manifestVersion=2;amended.resources[0]!.initialPublication!.version=3;
 assert.throws(()=>reuseCollaborationCompletion(prior,amended,state),/content-compatible/);
});
