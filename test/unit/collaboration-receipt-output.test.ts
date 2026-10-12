import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";

import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { parse } from "acorn";
import { resolveStepBehavior } from "../../src/runs/shared/child-launch-plan.ts";
import { prepareWorkflowLaunchParams } from "../../src/runs/foreground/subagent-executor.ts";
import * as outputApi from "../../src/runs/shared/single-output.ts";
import { collaborationResourcePath } from "../../src/workflows/collaboration-manifest.ts";
import { projectCollaborationArtifacts } from "../../src/runs/shared/collaboration-artifacts.ts";
import { resolveEffectiveAcceptance } from "../../src/runs/shared/acceptance.ts";

const candidate = fileURLToPath(new URL("../..", import.meta.url));
const evidenceDir = os.tmpdir();
// Read actual launch configuration without scheduling workers or acquiring live leases.
const source = stripTypeScriptTypes(readFileSync(path.join(candidate, "src/workflows/collaboration.ts"), "utf8"));
const tree = parse(source, { ecmaVersion: "latest", sourceType: "module" });
const expressions = [];
function visit(node) {
  if (!node || typeof node !== "object") return;
  if (node.type === "VariableDeclarator" && node.id.name === "params" && node.init?.type === "ObjectExpression") {
    const property = node.init.properties.find(p => p.type === "Property" && p.key.name === "output");
    assert(property, "every collaboration launch parameter object must declare output ownership");
    const outputProperties = node.init.properties.filter(p => p.type === "Property" && ["output", "outputMode"].includes(p.key.name));
    expressions.push("({" + outputProperties.map(p => p.key.name + ": " + source.slice(p.value.start, p.value.end)).join(", ") + "})");
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") visit(value);
  }
}
visit(tree);
assert.equal(expressions.length, 2, "inspect both package and exclusive-reconciliation launch sites");

function fixture() {
  const root = mkdtempSync(path.join(evidenceDir, "receipt-output-"));
  const owned = path.join(root, "owned");
  mkdirSync(owned);
  execFileSync("git", ["init", "--quiet", root]);
  const files = [".collaboration-receipt.md", ".collaboration-reconciliation.md"];
  for (const file of files) writeFileSync(path.join(owned, file), "Historical " + file + "\n");
  return { root, owned, files, manifest: { workspace: root, resources: [{ id: "owned", kind: "path", path: "owned" }] } };
}

function launchOutputOverrides(expression, fixture, writes) {
  return runInNewContext(expression, {
    path, manifest: fixture.manifest, pkg: { writes }, collaborationResourcePath,
  }, { timeout: 1000 });
}

for (const [index, label] of ["package", "exclusive reconciliation"].entries()) {
  test(label + " output plumbing retains historical receipts and returns current findings", () => {
    const f = fixture();
    const configured = launchOutputOverrides(expressions[index], f, ["owned"]);
    // The live workflow selects file-only for its aggregate output. It must not leak into children.
    const params = prepareWorkflowLaunchParams(
      { output: path.join(f.root, "workflow.md"), outputMode: "file-only" },
      { agent: "coder", ...configured }, "fixture-workflow", label,
    );
    const behavior = resolveStepBehavior({ name: "coder", output: path.join(f.owned, f.files[index]) }, params);
    const outputPath = outputApi.resolveSingleOutputPath(behavior.output, f.root);
    assert.equal(outputApi.validateFileOnlyOutputMode(behavior.outputMode, outputPath, "Async single run (coder-dogfood)"), undefined);
    const before = outputApi.captureSingleOutputSnapshot(outputPath);
    const current = "Current findings, not historical receipt bytes.";
    const result = outputApi.resolveSingleOutput(outputPath, current, before);
    for (const file of f.files) assert.equal(readFileSync(path.join(f.owned, file), "utf8"), "Historical " + file + "\n");
    assert.equal(result.fullOutput, current);
    assert.equal(result.savedPath, undefined);
    assert.equal(outputApi.injectSingleOutputInstruction("Preserve historical receipts.", outputPath), "Preserve historical receipts.");
    assert.equal(outputApi.injectOutputPathSystemPrompt("Base policy.", outputPath), "Base policy.");
    assert.equal(outputApi.finalizeSingleOutput({ ...result, outputMode: behavior.outputMode, exitCode: 0 }).displayOutput, current);
  });
}

test("read-only collaboration has no inferred workspace output", () => {
  const f = fixture();
  for (const expression of expressions) {
    const configured = launchOutputOverrides(expression, f, []);
    const params = prepareWorkflowLaunchParams({ outputMode: "file-only" }, { agent: "reader", ...configured }, "fixture-workflow", "read-only");
    const behavior = resolveStepBehavior({ name: "reader", output: "inherited.md", outputMode: "file-only" }, params);
    const outputPath = outputApi.resolveSingleOutputPath(behavior.output, f.root);
    assert.equal(outputPath, undefined);
    assert.equal(outputApi.validateFileOnlyOutputMode(behavior.outputMode, outputPath, "Read-only collaboration"), undefined);
  }
});

test("ordinary configured output files still persist the current response", () => {
  const f = fixture();
  const target = path.join(f.root, "ordinary.md");
  const behavior = resolveStepBehavior({ name: "coder", output: target, outputMode: "file-only" }, {});
  const outputPath = outputApi.resolveSingleOutputPath(behavior.output, f.root);
  assert.equal(behavior.outputMode, "file-only");
  assert.equal(outputApi.validateFileOnlyOutputMode(behavior.outputMode, outputPath, "Ordinary output"), undefined);
  const result = outputApi.resolveSingleOutput(outputPath, "Ordinary findings.", outputApi.captureSingleOutputSnapshot(outputPath));
  assert.equal(readFileSync(target, "utf8"), "Ordinary findings.");
  assert.equal(result.savedPath, target);
  assert.match(outputApi.injectSingleOutputInstruction("Task", outputPath), /Write your findings to exactly this path:/);
});

test("ordinary file-only output still requires a file", () => {
  const behavior = resolveStepBehavior({ name: "coder", outputMode: "file-only" }, { output: false });
  const outputPath = outputApi.resolveSingleOutputPath(behavior.output, os.tmpdir());
  assert.match(outputApi.validateFileOnlyOutputMode(behavior.outputMode, outputPath, "Ordinary output"), /does not configure an output file/);
});

async function project(f, output, acceptance) {
  const parentDir = path.join(f.root, "native-run");
  const privateRoot = path.join(parentDir, "private");
  mkdirSync(privateRoot, { recursive: true });
  const runId = randomUUID();
  const proposal = JSON.stringify({ id: runId, success: true, results: [{ output }] });
  writeFileSync(path.join(privateRoot, "result.json"), proposal);
  writeFileSync(path.join(parentDir, "status.json"), JSON.stringify({ runId, state: "running" }));
  const projection = projectCollaborationArtifacts({
    privateRoot, parentDir, resultPath: path.join(parentDir, "result.json"), runId,
    processInstanceId: randomUUID(), hostPid: process.pid, stop() { throw new Error("Unexpected stop"); },
    bindings: {}, executionToken: randomUUID(), manifestVersion: 1, onDependencyAck() {},
    hostStatus: {}, acceptance, agent: "coder", model: "fixture-model", cwd: f.root,
  });
  try {
    await projection.ended(0, null);
    assert.equal(readFileSync(path.join(privateRoot, "result.json"), "utf8"), proposal);
    const result = JSON.parse(readFileSync(path.join(parentDir, "result.json"), "utf8"));
    const status = JSON.parse(readFileSync(path.join(parentDir, "status.json"), "utf8"));
    for (const file of f.files) assert.equal(readFileSync(path.join(f.owned, file), "utf8"), "Historical " + file + "\n");
    assert(!existsSync(path.join(f.root, ".collaboration-receipt.md")));
    return { result, status };
  } finally { projection.close(); }
}

test("native parent artifacts retain the complete response and checked acceptance without a workspace receipt", async () => {
  const f = fixture();
  const acceptance = resolveEffectiveAcceptance({ agentName: "coder", acceptanceRole: "writer", task: "Verify retained checks", mode: "single", async: true });
  const report = {
    criteriaSatisfied: acceptance.criteria.map(({ id }) => ({ id, status: "satisfied", evidence: "Retained checks passed." })),
    changedFiles: [], testsAddedOrUpdated: [], commandsRun: [{ command: "node --test owned.test.mjs", result: "passed", summary: "Passed." }],
    validationOutput: ["Checks passed."], residualRisks: [], noStagedFiles: false,
  };
  const output = "Current findings.\n\x60\x60\x60acceptance-report\n" + JSON.stringify(report) + "\n\x60\x60\x60";
  const { result, status } = await project(f, output, acceptance);
  assert.equal(result.success, true);
  assert.equal(status.state, "complete");
  assert.equal(result.results[0].output, output);
  assert.deepEqual(result.results[0].acceptance.childReport, report);
  assert.equal(result.results[0].acceptance.evidenceStatus, "checked");
  assert.equal(result.results[0].acceptance.status, "review-required");
});

test("returning findings without required acceptance evidence still fails closed", async () => {
  const f = fixture();
  const acceptance = resolveEffectiveAcceptance({ agentName: "coder", acceptanceRole: "writer", task: "Verify retained checks", mode: "single", async: true });
  const { result, status } = await project(f, "Findings without an acceptance report.", acceptance);
  assert.equal(result.success, false);
  assert.equal(status.state, "failed");
  assert.equal(result.results[0].acceptance.status, "rejected");
});
