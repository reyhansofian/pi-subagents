import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import * as os from "node:os";
import { fileURLToPath } from "node:url";
import * as launchApi from "../../src/runs/shared/collaboration-launch.ts";
import * as workflow from "../../src/workflows/collaboration.ts";
import * as recovery from "../../src/workflows/collaboration-recovery.ts";
import { normalizeCollaborationManifest, collaborationDigest } from "../../src/workflows/collaboration-manifest.ts";
import { createAtomicJsonWriter } from "../../src/shared/atomic-json.ts";

const candidate = fileURLToPath(new URL("../..", import.meta.url));
const evidenceDir = os.tmpdir();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const epoch = "11111111-1111-4111-8111-111111111111", executionId = "22222222-2222-4222-8222-222222222222";
// Use real atomic writes and fsync; cleanup removes only this test’s temporary files.
const writeSnapshot = createAtomicJsonWriter({ mode: 0o600, fs: {
  mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, rmSync: fs.rmSync,
}});
function fixture(explicit = false, reconciliation = false, readOnlyJournal = false) {
  const root = fs.mkdtempSync(path.join(evidenceDir, "pre-spawn-"));
  const workspace = path.join(root, "ticket"), source = path.join(root, "synthetic-source");
  for (const dir of [workspace, source, path.join(workspace, "owned")]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pkg = { id: reconciliation ? "R" : "A", goal: "Synthetic", rationale: "No launch",
    constraints: [], completion: [], reads: [], writes: ["owned"], exclusive: [], prerequisites: [],
    requires: [], publishes: [], checks: [], configuration: { agent: "coder" } };
  const manifest = normalizeCollaborationManifest({
    schemaVersion: 1, workflowId: "synthetic-workflow", runId: "synthetic-run", manifestVersion: 1,
    workspace, goal: "Synthetic", rationale: "Retained proof", constraints: [], completion: [], concurrency: 1,
    resources: [{ id: "owned", kind: "path", path: "owned" }],
    packages: reconciliation ? [{ ...pkg, id: "A" }] : [pkg], ...(reconciliation ? { reconciliation: pkg } : {}),
    combinedChecks: [{ id: "synthetic-check", command: "never executed", timeoutMs: 1000, reads: [], writes: [], exclusive: [] }], runtime: { assets: [], extensions: [], environment: [], network: "none",
      ...(explicit ? { credentialAgentDir: source } : {}) },
  });
  const state = { id: pkg.id, state: "reserved", executionId };
  const snapshot = path.join(root, "snapshot.json"), journal = path.join(root, "journal.jsonl");
  const summary = { runId: manifest.runId, manifestVersion: 1, controlSequence: 0, barrier: "none",
    effectiveConfiguration: { [pkg.id]: pkg.configuration }, state: "failed", residents: 1, ceiling: 1, capacityLimit: 256,
    packages: reconciliation ? [{ id: "A", state: "ready" }] : [state], ...(reconciliation ? { reconciliation: state } : {}),
    ownership: [], pendingConsequential: { barrier: "none", controlSequence: 0 }, publications: {},
    verification: "pending", activeChecks: [], artifacts: { snapshot, journal },
    measurementCompleteness: { coordination: false, workerUsage: false } };
  const manifestDigest = hash(JSON.stringify(manifest));
  const binding = { epoch, manifestDigest, executionId };
  const grant = { manifest, pkg, binding, bindings: {}, onDependencyAck() { assert.fail("no dependency event"); },
    onStarted() { assert.fail("no native start"); } };
  const handle = launchApi.registerCollaborationLaunch(grant);
  let sequence = 0, storageFailed = false, quiescenceUnproven = false;
  if (readOnlyJournal) fs.writeFileSync(journal, "", { flag: "wx", mode: 0o600 });
  const fd = fs.openSync(journal, readOnlyJournal ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    : fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  function persist(event, detail, writer = writeSnapshot) {
    if (storageFailed) throw new Error("Collaboration storage failed; admission remains frozen.");
    try { workflow.writeCollaborationState({ fd, snapshot, epoch, manifestDigest, sequence: ++sequence,
      manifest, summary, event, detail, writeSnapshot: writer }); }
    catch (error) { storageFailed = true; handle.stop(); throw error; }
  }
  function settle(cause, options = {}) {
    return workflow.settleCollaborationFailure({ launch: handle, state, signal: options.signal ?? new AbortController().signal,
      cause, reconciliation, storageFailed: () => storageFailed,
      markQuiescenceUnproven: () => { quiescenceUnproven = true; }, persist: options.persist ?? persist });
  }
  return { root, manifest, manifestDigest, binding, pkg, state, summary, snapshot, journal, handle, grant, persist, settle,
    close() { handle.dispose(); fs.closeSync(fd); }, flags: () => ({ storageFailed, quiescenceUnproven }) };
}
const inert = token => ({ token, command: "/synthetic/never-executed", args: [], cwd: "/synthetic",
  configPath: "/synthetic/never-written", config: {}, env: {}, hostStatus: {} });
function preValidation(f) {
  try { launchApi.spawnEnrolledCollaborationRunner(inert(f.handle.token)); assert.fail("must reject"); }
  catch (error) { assert.match(error.message, /protected provider transport/); return error; }
}
const decision = prior => ({ epoch: prior.epoch, sequence: prior.sequence,
  workspaceDigest: collaborationDigest(prior.manifest.workspace), approval: { authority: "user", reference: "synthetic-only" },
  retryPackages: [prior.summary.reconciliation?.id ?? "A"], reuseCompleted: [] });
const attempt = prior => prior.summary.reconciliation ?? prior.summary.packages[0];
async function persisted(explicit = false, reconciliation = false, interrupted = false) {
  const f = fixture(explicit, reconciliation);
  const signal = interrupted ? AbortSignal.abort() : undefined;
  await f.settle(preValidation(f), { signal });
  f.summary.residents = 0;
  f.persist("resident-released", { packageId: f.pkg.id, executionId });
  f.persist("settled", null);
  const prior = recovery.readCollaborationSnapshot(f.snapshot);
  f.close();
  return { f, prior };
}

test("stopped unused grant cannot re-enter native pre-validation", () => {
  const f = fixture();
  try {
    f.handle.stop();
    assert.throws(() => launchApi.spawnEnrolledCollaborationRunner(inert(f.handle.token)), /missing, obsolete or already consumed/);
  } finally { f.close(); }
});

test("real rejection settles, persists, strictly reads and validates explicit/omitted ordinary/reconciliation failures", async () => {
  for (const explicit of [false, true]) for (const reconciliation of [false, true]) for (const interrupted of [false, true]) {
    const { f, prior } = await persisted(explicit, reconciliation, interrupted);
    const state = attempt(prior), proof = state.neverSpawned;
    assert.deepEqual(proof, { version: 1, kind: "never-spawned", epoch, manifestDigest: f.manifestDigest,
      manifestVersion: 1, collaborationRunId: "synthetic-run", packageId: f.pkg.id, executionId });
    assert.equal(state.state, interrupted ? "interrupted" : "failed");
    assert.equal(prior.summary.residents, 0);
    assert.deepEqual(prior.summary.publications, {});
    assert.deepEqual(prior.summary.measurementCompleteness, { coordination: false, workerUsage: false });
    assert.equal(Object.hasOwn(prior.manifest.runtime, "credentialAgentDir"), explicit);
    if (explicit) assert.equal(prior.manifest.runtime.credentialAgentDir, f.manifest.runtime.credentialAgentDir);
    for (const key of ["runId", "pid", "nativeArtifactDir", "completionInputs", "outputDigests"]) assert(!Object.hasOwn(state, key));
    const rows = fs.readFileSync(f.journal, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows.map(row => row.event), [reconciliation ? "reconciliation-failed" : "interrupted", "resident-released", "settled"]);
    assert.deepEqual(rows[0].detail.neverSpawned, proof);
    assert.equal(Object.hasOwn(rows[0].detail, "packageId"), !reconciliation);
    assert.match(state.reason, /protected provider transport/);
    const before = [hash(fs.readFileSync(f.snapshot)), hash(fs.readFileSync(f.journal))];
    assert.deepEqual(recovery.validateCollaborationRecovery(decision(prior), prior, prior.manifest), decision(prior));
    assert.deepEqual([hash(fs.readFileSync(f.snapshot)), hash(fs.readFileSync(f.journal))], before);
  }
});

test("finalization is one-shot, frozen, copies bindings and closes before settlement yields", async () => {
  const f = fixture();
  try {
    const pending = f.settle(preValidation(f));
    assert.throws(() => launchApi.consumeCollaborationSpawnAuthority(f.handle.token), /missing/);
    assert.throws(() => launchApi.spawnEnrolledCollaborationRunner(inert(f.handle.token)), /missing/);
    await pending;
    assert(Object.isFrozen(f.state.neverSpawned));
    assert.equal(f.handle.finalizeNeverSpawned(), undefined);
    assert.throws(() => launchApi.consumeCollaborationSpawnAuthority(f.handle.token), /missing/);
  } finally { f.close(); }
  const g = fixture();
  try {
    g.binding.epoch = "changed"; g.binding.executionId = "changed"; g.binding.manifestDigest = "changed";
    g.manifest.runId = "changed"; g.manifest.manifestVersion = 2; g.pkg.id = "changed";
    const proof = g.handle.finalizeNeverSpawned();
    assert.equal(proof.epoch, epoch); assert.equal(proof.executionId, executionId);
    assert.equal(proof.collaborationRunId, "synthetic-run"); assert.equal(proof.packageId, "A");
    assert.equal(proof.manifestVersion, 1); assert.equal(proof.manifestDigest, g.manifestDigest);
  } finally { g.close(); }
});

test("consume is irreversible even without process; actual drain and settlement refuse proof", async () => {
  for (const reconciliation of [false, true]) {
    const f = fixture(false, reconciliation);
    try {
      launchApi.consumeCollaborationSpawnAuthority(f.handle.token);
      assert.throws(() => launchApi.consumeCollaborationSpawnAuthority(f.handle.token), /consumed/);
      await assert.rejects(f.handle.drain(), /consumed launch lacks process/);
      await assert.rejects(f.handle.stopAndDrain(), /consumed launch lacks process/);
      assert.equal(f.handle.finalizeNeverSpawned(), undefined);
      await f.settle(new Error("post-boundary"));
      assert(!Object.hasOwn(f.state, "neverSpawned"));
      assert.equal(f.flags().quiescenceUnproven, true);
      const prior = recovery.readCollaborationSnapshot(f.snapshot);
      assert.throws(() => recovery.validateCollaborationRecovery(decision(prior), prior, prior.manifest), /native identity/);
    } finally { f.close(); }
  }
});

test("stopped/disposed unused handles retain one-shot safe finalization but never reopen authority", () => {
  for (const action of ["stop", "dispose"]) {
    const f = fixture();
    try {
      f.handle[action]();
      assert(f.handle.finalizeNeverSpawned());
      assert.equal(f.handle.finalizeNeverSpawned(), undefined);
      assert.throws(() => launchApi.consumeCollaborationSpawnAuthority(f.handle.token), /missing/);
    } finally { f.close(); }
  }
});

test("P6 refusal matrix rejects stale, duplicate, malformed, contradictory and nonterminal evidence", async () => {
  const { prior } = await persisted();
  const cases = [];
  for (const [key, value] of Object.entries({ epoch: "stale", manifestDigest: "0".repeat(64), manifestVersion: 2,
    collaborationRunId: "stale", packageId: "B", executionId: "stale", kind: "other", version: 2, extra: true }))
    cases.push([key, p => { attempt(p).neverSpawned[key] = value; }]);
  for (const state of ["blocked", "ready", "reserved", "running", "validating", "completed"])
    cases.push([state, p => { attempt(p).state = state; }]);
  for (const key of ["runId", "pid", "nativeArtifactDir", "outputDigests", "completionContractDigest",
    "completionInputs", "completionPrerequisites", "completionManifestVersion", "reusedFrom"])
    cases.push([key, p => { attempt(p)[key] = key === "pid" || key === "completionManifestVersion" ? 1 : {}; }]);
  cases.push(["duplicate state", p => p.summary.packages.push(structuredClone(attempt(p)))],
    ["duplicate execution", p => p.summary.packages.push({ id: "B", state: "ready", executionId })],
    ["duplicate manifest package", p => p.manifest.packages.push(p.manifest.packages[0])],
    ["summary run", p => { p.summary.runId = "stale"; }],
    ["summary version", p => { p.summary.manifestVersion = 2; }],
    ["snapshot digest", p => { p.manifestDigest = "0".repeat(64); }],
    ["publication package", p => { p.summary.publications.owned = { version: 1, digest: "0".repeat(64), packageId: "A" }; }],
    ["publication execution", p => { p.summary.publications.owned = { version: 1, digest: "0".repeat(64), executionId }; }],
    ["active check", p => { p.summary.activeChecks = [{ id: "check", executionId: "check-execution" }]; }],
    ["legacy activeCheck", p => { p.summary.activeCheck = { id: "check", executionId: "check-execution" }; }]);
  for (const [name, mutate] of cases) {
    const p = structuredClone(prior); mutate(p);
    assert.throws(() => recovery.validateCollaborationRecovery(decision(p), p, p.manifest), undefined, name);
  }
  for (const state of ["failed", "interrupted", "reserved", "running", "validating"]) {
    const p = structuredClone(prior); delete attempt(p).neverSpawned; attempt(p).state = state;
    assert.throws(() => recovery.validateCollaborationRecovery(decision(p), p, p.manifest), /native identity/);
  }
  const native = structuredClone(prior); delete attempt(native).neverSpawned; attempt(native).runId = "synthetic-no-sidecar";
  attempt(native).nativeArtifactDir = path.dirname(prior.summary.artifacts.snapshot);
  assert.throws(() => recovery.validateCollaborationRecovery(decision(native), native, native.manifest), /ENOENT/);
  const completed = structuredClone(prior); attempt(completed).state = "completed";
  assert.throws(() => recovery.reuseCollaborationCompletion(completed, completed.manifest, attempt(completed)), /not content-compatible/);
  for (const mutate of [
    d => { d.epoch = "stale"; }, d => { d.sequence++; }, d => { d.workspaceDigest = "stale"; },
    d => { d.approval.reference = " "; }, d => { d.retryPackages = []; },
    d => { d.retryPackages = ["A", "A"]; }, d => { d.reuseCompleted = ["A"]; },
  ]) { const d = decision(prior); mutate(d); assert.throws(() => recovery.validateCollaborationRecovery(d, prior, prior.manifest)); }
});

test("strict reader rejects extra/duplicate/oversized proof fields; old missing-proof snapshots still parse", async () => {
  const { f, prior } = await persisted(true);
  for (const [name, change] of [
    ["extra", p => { attempt(p).neverSpawned.extra = true; }],
    ["oversized", p => { attempt(p).neverSpawned.executionId = "x".repeat(129); }],
    ["empty", p => { attempt(p).neverSpawned.executionId = ""; }],
    ["unsafe-version", p => { attempt(p).neverSpawned.manifestVersion = Number.MAX_SAFE_INTEGER + 1; }],
    ["unknown-runtime", p => { p.manifest.runtime.extra = true; }],
  ]) {
    const p = structuredClone(prior); change(p);
    const file = path.join(f.root, name + ".json"); fs.writeFileSync(file, JSON.stringify(p));
    assert.throws(() => recovery.readCollaborationSnapshot(file), /Invalid/);
  }
  const duplicate = path.join(f.root, "duplicate.json");
  fs.writeFileSync(duplicate, JSON.stringify(prior).replace('"kind":"never-spawned"', '"kind":"never-spawned","kind":"never-spawned"'));
  assert.throws(() => recovery.readCollaborationSnapshot(duplicate), /duplicate/i);
  const old = structuredClone(prior); delete attempt(old).neverSpawned;
  const file = path.join(f.root, "old.json"); fs.writeFileSync(file, JSON.stringify(old));
  const decoded = recovery.readCollaborationSnapshot(file);
  assert.throws(() => recovery.validateCollaborationRecovery(decision(decoded), decoded, decoded.manifest), /native identity/);
});


test("B-001: duplicate decoded keys in proof containers and enclosing objects reject before native contradictions disappear", async () => {
  for (const reconciliation of [false, true]) {
    const { f, prior } = await persisted(false, reconciliation);
    const valid = attempt(prior);
    const native = { id: valid.id, state: "running", executionId: valid.executionId,
      runId: "synthetic-never-launched", pid: 999999 };
    const key = reconciliation ? "reconciliation" : "packages";
    const hidden = reconciliation ? native : [native];
    const withSummary = summary => JSON.stringify({ ...prior, summary: null }).replace('"summary":null', '"summary":' + summary);
    const raw = JSON.stringify(prior);
    const cases = [];
    for (const escaped of [false, true]) {
      const last = escaped ? (reconciliation ? "reconciliat\\u0069on" : "pack\\u0061ges") : key;
      cases.push(["container-" + escaped, withSummary(JSON.stringify(prior.summary).replace(JSON.stringify(key) + ":",
        JSON.stringify(key) + ":" + JSON.stringify(hidden) + ',"' + last + '":'))]);
      const conflictingSummary = { ...prior.summary, [key]: hidden };
      const summaryKey = escaped ? "summ\\u0061ry" : "summary";
      cases.push(["summary-" + escaped, raw.replace('"summary":', '"summary":' + JSON.stringify(conflictingSummary) + ',"' + summaryKey + '":')]);
      const idKey = escaped ? "\\u0069d" : "id";
      cases.push(["state-object-" + escaped, raw.replace('"id":"' + valid.id + '"',
        '"id":"conflicting","' + idKey + '":"' + valid.id + '"')]);
      const runtimeKey = escaped ? "runt\\u0069me" : "runtime";
      cases.push(["manifest-object-" + escaped, raw.replace('"runtime":',
        '"runtime":{},"' + runtimeKey + '":')]);
    }
    for (const [name, source] of cases) {
      const file = path.join(f.root, "B-001-" + name + ".json");
      fs.writeFileSync(file, source, { flag: "wx", mode: 0o600 });
      assert.throws(() => recovery.readCollaborationSnapshot(file), /duplicate recovery snapshot object key/, name);
    }
    const control = structuredClone(prior);
    if (reconciliation) control.summary.reconciliation = { ...valid, ...native };
    else control.summary.packages = [{ ...valid, ...native }];
    assert.throws(() => recovery.validateCollaborationRecovery(decision(control), control, control.manifest), /never-spawned proof/);

    // Valid decoded keys stay unique; proof-like content remains a string, not a key.
    const positive = structuredClone(prior);
    attempt(positive).reason = 'proof text: {"packages":[],"pack\\u0061ges":[],"neverSpawned":{"kind":"x","kind":"y"}} [ ] : \\"';
    positive.summary.observation = [{ "escaped\"key": "value", "back\\slash": "value" },
      { same: "first" }, { same: "second" }];
    let escapedRaw = JSON.stringify(positive).replace('"summary":', '"summ\\u0061ry":')
      .replace(JSON.stringify(key) + ":", '"' + (reconciliation ? "reconciliat\\u0069on" : "pack\\u0061ges") + '":');
    const file = path.join(f.root, "B-001-valid-escaped-string-control.json");
    fs.writeFileSync(file, escapedRaw, { flag: "wx", mode: 0o600 });
    const decoded = recovery.readCollaborationSnapshot(file);
    assert.equal(attempt(decoded).reason, attempt(positive).reason);
    assert.deepEqual(recovery.validateCollaborationRecovery(decision(decoded), decoded, decoded.manifest), decision(decoded));

    const malformed = path.join(f.root, "B-001-malformed.json");
    fs.writeFileSync(malformed, raw.slice(0, -1), { flag: "wx", mode: 0o600 });
    assert.throws(() => recovery.readCollaborationSnapshot(malformed), SyntaxError);
    const oversized = path.join(f.root, "B-001-oversized.json");
    fs.writeFileSync(oversized, " ".repeat(1024 * 1024 + 1), { flag: "wx", mode: 0o600 });
    assert.throws(() => recovery.readCollaborationSnapshot(oversized), /byte bound/);
  }
});

test("production persistence faults preserve journal-first uncertainty and revoke admission", async () => {
  for (const reconciliation of [false, true]) {
    const f = fixture(false, reconciliation);
    try {
      await assert.rejects(f.settle(preValidation(f), { persist: (event, detail) => f.persist(event, detail,
        createAtomicJsonWriter({ mode: 0o600, fs: { mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync,
          renameSync() { throw new Error("synthetic rename failure"); }, rmSync: fs.rmSync } })) }), /synthetic rename failure/);
      assert.equal(f.flags().storageFailed, true);
      assert(!fs.existsSync(f.snapshot));
      assert.equal(fs.readFileSync(f.journal, "utf8").trim().split("\n").length, 1);
      assert.throws(() => f.persist("forbidden-admission", null), /frozen/);
      assert.throws(() => launchApi.consumeCollaborationSpawnAuthority(f.handle.token), /missing/);
      await f.settle(new Error("already frozen"), { persist() { assert.fail("must skip persistence"); } });
      assert.equal(f.handle.finalizeNeverSpawned(), undefined);
    } finally { f.close(); }
  }
  for (const reconciliation of [false, true]) {
    const f = fixture(false, reconciliation, true);
    try {
      await assert.rejects(f.settle(preValidation(f)), /EBADF/);
      assert.equal(f.flags().storageFailed, true);
      assert.equal(fs.statSync(f.journal).size, 0);
      assert(!fs.existsSync(f.snapshot));
      assert.throws(() => f.persist("forbidden-admission", null), /frozen/);
      assert.throws(() => launchApi.consumeCollaborationSpawnAuthority(f.handle.token), /missing/);
    } finally { f.close(); }
  }
  const f = fixture();
  try {
    assert.throws(() => f.persist("oversized", "x".repeat(64 * 1024)), /64 KiB/);
    assert.equal(fs.statSync(f.journal).size, 0);
  } finally { f.close(); }
});

test("source-inspected orchestration uses shared helpers and storage failure prevents lease release", () => {
  const source = fs.readFileSync(path.join(candidate, "src/workflows/collaboration.ts"), "utf8");
  assert.equal((source.match(/settleCollaborationFailure\(\{/g) ?? []).length, 2);
  assert.match(source, /if \(!active.size && !activeChecks.size && !quiescenceUnproven && !storageFailed\)/);
  assert.match(source, /storageFailed = true;\s*for \(const worker of active.values\(\)\) worker.stop\(\);/);
  const launcher = fs.readFileSync(path.join(candidate, "src/runs/shared/collaboration-launch.ts"), "utf8");
  assert.match(launcher, /consumeCollaborationSpawnAuthority\(input.token\);\s*const sandbox = spawnCollaborationSandbox/);
});

test("synthetic proofless snapshot and journal remain byte-identical while recovery stays blocked", async () => {
  const { f, prior } = await persisted();
  delete attempt(prior).neverSpawned;
  prior.sequence = 24;
  fs.writeFileSync(f.snapshot, JSON.stringify(prior));
  const files = [f.snapshot, f.journal];
  const before = files.map(file => hash(fs.readFileSync(file)));
  const decoded = recovery.readCollaborationSnapshot(f.snapshot);
  assert.equal(decoded.sequence, 24);
  assert.throws(() => recovery.proveCollaborationSnapshotQuiescent(decoded), /native identity/);
  assert.deepEqual(files.map(file => hash(fs.readFileSync(file))), before);
});
