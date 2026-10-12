import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { projectCollaborationArtifacts } from "../../src/runs/shared/collaboration-artifacts.ts";
import { resolveEffectiveAcceptance, evaluateAcceptance } from "../../src/runs/shared/acceptance.ts";

const evidenceDir = os.tmpdir();
const originalPath = process.env.PATH;

function fixture({ git = 0, jj = 1, colocated = true, wrongRoot = false } = {}) {
  const root = mkdtempSync(join(evidenceDir, "parent-staging-"));
  const cwd = join(root, "workspace");
  const bin = join(root, "bin");
  mkdirSync(cwd);
  mkdirSync(bin);
  if (colocated) mkdirSync(join(cwd, ".git"));
  if (jj === 0) mkdirSync(join(cwd, ".jj"));
  const calls = join(root, "calls.jsonl");
  for (const [command, code] of Object.entries({ git, jj })) {
    const script = `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ command: ${JSON.stringify(command)}, args: process.argv.slice(2) }) + "\\n");
if (${JSON.stringify(command)} === "jj" && ${code} === 0) process.stdout.write(${JSON.stringify(wrongRoot ? root : cwd)} + "\\n");
if (${JSON.stringify(command)} === "git" && ${code} === 1 && process.argv.includes("status")) { process.stdout.write("A  staged.txt\\n"); process.exit(0); }
process.exit(${code});
`;
    writeFileSync(join(bin, command), script, { mode: 0o700 });
  }
  return { root, cwd, bin, calls };
}

function contract(explicit = false, extra = {}) {
  const acceptance = resolveEffectiveAcceptance({
    agentName: "coder-dogfood", acceptanceRole: "writer", task: "Implement the owned regression tests",
    mode: "single", async: true, dynamic: false,
    ...(explicit ? { explicit: { level: "checked" } } : {}),
  });
  return { ...acceptance, ...extra };
}

function report(acceptance, noStagedFiles = false) {
  return {
    criteriaSatisfied: acceptance.criteria.map(({ id }) => ({ id, status: "satisfied", evidence: "Owned regression check passed." })),
    changedFiles: ["owned/test.mjs"], testsAddedOrUpdated: ["owned/test.mjs"],
    commandsRun: [{ command: "node --test owned/test.mjs", result: "passed", summary: "Passed." }],
    validationOutput: ["Tests passed."], residualRisks: [],
    ...(noStagedFiles === undefined ? {} : { noStagedFiles }),
    manualNotes: "No VCS commands issued. Repository staging cannot be inspected by this confined worker.",
  };
}

async function project(f, { explicit = false, acceptance = contract(explicit), child = report(acceptance), rawSuccess = true } = {}) {
  const parentDir = mkdtempSync(join(f.root, "projection-"));
  const privateRoot = join(parentDir, "private");
  mkdirSync(privateRoot);
  const runId = randomUUID();
  const resultPath = join(parentDir, "result.json");
  writeFileSync(join(parentDir, "status.json"), JSON.stringify({ runId, state: "running", steps: [] }));
  const proposal = JSON.stringify({ id: runId, success: rawSuccess, results: [{
    output: "Owned checks finished.",
    acceptance: { childReport: child, runtimeChecks: [{ id: "no-staged-files", status: "passed" }] },
  }] });
  writeFileSync(join(privateRoot, "result.json"), proposal);
  const projection = projectCollaborationArtifacts({
    privateRoot, parentDir, resultPath, runId, processInstanceId: randomUUID(), hostPid: process.pid,
    stop() { throw new Error("Unexpected projection stop"); }, bindings: {}, executionToken: randomUUID(),
    manifestVersion: 1, onDependencyAck() {}, hostStatus: {}, acceptance,
    agent: "coder-dogfood", model: "unchanged-test-model", cwd: f.cwd,
  });
  try {
    await projection.ended(0, null);
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    const status = JSON.parse(readFileSync(join(parentDir, "status.json"), "utf8"));
    assert.equal(readFileSync(join(privateRoot, "result.json"), "utf8"), proposal, "worker proposal must remain unchanged");
    assert.deepEqual(result.results[0].acceptance.childReport, child, "parent must preserve the worker report");
    return { result, status, ledger: result.results[0].acceptance };
  } finally { projection.close(); }
}

async function withPath(f, run) {
  process.env.PATH = f.bin;
  try { return await run(); }
  finally { process.env.PATH = originalPath; }
}

test("parent staging evidence accepts honest false and omitted worker attestations without fabricating them", async () => {
  const f = fixture();
  await withPath(f, async () => {
    for (const field of [false, undefined, true]) {
      const acceptance = contract();
      const child = report(acceptance, field);
      if (field === undefined) delete child.noStagedFiles;
      const { result, status, ledger } = await project(f, { acceptance, child });
      assert.equal(result.success, true);
      assert.equal(status.state, "complete");
      assert.equal(ledger.evidenceStatus, "checked");
      assert.equal(ledger.status, "review-required", "parent staging is not independent review");
      assert.equal(ledger.runtimeChecks.find(c => c.id === "no-staged-files")?.status, "passed");
      assert(!ledger.runtimeChecks.some(c => c.id === "evidence:no-staged-files"));
    }
  });
});

test("staged files reject both implicit and explicit acceptance despite a forged worker pass", async () => {
  const f = fixture({ git: 1 });
  await withPath(f, async () => {
    for (const explicit of [false, true]) {
      const acceptance = contract(explicit);
      const { result, status, ledger } = await project(f, { acceptance, child: report(acceptance, true) });
      assert.equal(result.success, false);
      assert.equal(status.state, "failed");
      assert.equal(ledger.status, "rejected");
      assert.equal(ledger.runtimeChecks.find(c => c.id === "no-staged-files")?.status, "failed");
    }
  });
});

test("unavailable staging inspection fails closed rather than reporting not-applicable", async () => {
  const f = fixture({ git: 128 });
  await withPath(f, async () => {
    const { result, status, ledger } = await project(f, { child: report(contract(), true) });
    assert.equal(result.success, false);
    assert.equal(status.state, "failed");
    assert.equal(ledger.evidenceStatus, "rejected");
    assert.equal(ledger.runtimeChecks.find(c => c.id === "no-staged-files")?.status, "failed");
  });
});

test("non-colocated JJ requires the exact verified root and does not invoke Git", async () => {
  const f = fixture({ jj: 0, colocated: false });
  await withPath(f, async () => {
    const { result, ledger } = await project(f);
    assert.equal(result.success, true);
    assert.equal(ledger.evidenceStatus, "checked");
    assert.match(ledger.runtimeChecks.find(c => c.id === "no-staged-files")?.message ?? "", /Jujutsu/);
    const calls = readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse);
    assert(calls.some(c => c.command === "jj" && c.args.includes("--ignore-working-copy")));
    assert(!calls.some(c => c.command === "git"));
  });
  const wrong = fixture({ jj: 0, colocated: false, wrongRoot: true });
  await withPath(wrong, async () => assert.equal((await project(wrong)).result.success, false));
});

test("a colocated JJ repository still requires a successful staging inspection", async () => {
  const f = fixture({ jj: 0, git: 128 });
  await withPath(f, async () => assert.equal((await project(f)).result.success, false));
});

test("missing executables and unknown repositories cannot pass", async () => {
  const f = fixture({ colocated: false, jj: 2, git: 128 });
  await withPath(f, async () => assert.equal((await project(f)).result.success, false));
  const emptyBin = join(f.root, "empty-bin");
  mkdirSync(emptyBin);
  await withPath({ ...f, bin: emptyBin }, async () => assert.equal((await project(f)).result.success, false));
});

test("other failed evidence and raw execution failure remain failures", async () => {
  const f = fixture();
  await withPath(f, async () => {
    const acceptance = contract();
    const child = report(acceptance, true);
    child.commandsRun = [];
    const rejected = await project(f, { acceptance, child });
    assert.equal(rejected.result.success, false);
    assert.equal(rejected.ledger.status, "rejected");
    assert(rejected.ledger.runtimeChecks.some(c => c.id === "evidence:commands-run" && c.status === "failed"));
    assert.equal((await project(f, { rawSuccess: false })).result.success, false);
    const preserved = await project(f, { acceptance: contract(false, { preserveStagedIndex: true }) });
    assert.equal(preserved.result.success, false, "missing launch index baseline cannot be bypassed");
    assert(preserved.ledger.runtimeChecks.some(c => c.id === "staged-index-unchanged" && c.status === "failed"));
  });
});

test("ordinary acceptance still rejects a false worker attestation", async () => {
  const f = fixture();
  await withPath(f, async () => {
    const acceptance = contract(true);
    const ledger = await evaluateAcceptance({ acceptance, report: report(acceptance), output: "", cwd: f.cwd });
    assert.equal(ledger.status, "rejected");
    assert(ledger.runtimeChecks.some(c => c.id === "evidence:no-staged-files" && c.status === "failed"));
  });
});

test("actual synthetic Git workspace is checked through production projection and staged changes reject", async () => {
  const cwd = mkdtempSync(join(evidenceDir, "parent-staging-git-"));
  execFileSync("git", ["init", "--quiet", cwd]);
  const f = fixture();
  const { result, ledger } = await project({ ...f, cwd });
  assert.equal(result.success, true);
  assert.equal(ledger.evidenceStatus, "checked");
  assert.match(ledger.runtimeChecks.find(c => c.id === "no-staged-files")?.message ?? "", /no staged changes/);
  writeFileSync(join(cwd, "staged.txt"), "synthetic");
  execFileSync("git", ["-C", cwd, "add", "staged.txt"]);
  assert.equal((await project({ ...f, cwd }, { child: report(contract(), true) })).result.success, false);
});
