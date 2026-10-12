import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { collaborationSdkRoot } from "../support/collaboration-sdk.ts";
import { normalizeCollaborationManifest, collaborationCredentialAgentDir } from "../../src/workflows/collaboration-manifest.ts";
import { enrollCollaborationModelStorage, prepareCollaborationAgentHome, assertCollaborationCredentialGrants } from "../../src/runs/shared/collaboration-launch.ts";
import { resolveHttpIdleTimeoutMs } from "../../src/runs/background/runner-http-dispatcher.ts";

const candidate = fileURLToPath(new URL("../..", import.meta.url));
const evidenceDir = os.tmpdir();

const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600, flag: "wx" });
function fixture() {
  const root = fs.mkdtempSync(path.join(evidenceDir, "credential-source-"));
  const workspace = path.join(root, "ticket"), source = path.join(root, "source");
  const agent = path.join(root, "profile"), privateRoot = path.join(root, "private");
  for (const dir of [workspace, source, agent, privateRoot, path.join(workspace, "owned"), path.join(workspace, ".pi")])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  write(path.join(agent, "settings.json"), { packages: [], httpIdleTimeoutMs: 1234 });
  write(path.join(source, "settings.json"), { packages: ["/synthetic/unselected-package"], httpIdleTimeoutMs: 9999 });
  write(path.join(workspace, ".pi/settings.json"), { packages: [] });
  write(path.join(source, "models.json"), { models: ["SYNTHETIC_SOURCE_METADATA"] });
  write(path.join(source, "models-store.json"), { catalog: "SYNTHETIC_SOURCE_CATALOG" });
  const check = { id: "check", command: "node --version", timeoutMs: 1000, reads: [], writes: [], exclusive: [] };
  const manifest = {
    schemaVersion: 1, workflowId: "synthetic-workflow", runId: "synthetic-run", manifestVersion: 1,
    workspace, goal: "Synthetic path check", rationale: "No native launch", constraints: [], completion: [], concurrency: 1,
    resources: [{ id: "owned", kind: "path", path: "owned" }],
    packages: [{ id: "A", goal: "Check", rationale: "Fixture", constraints: [], completion: [], reads: [], writes: ["owned"],
      exclusive: [], prerequisites: [], requires: [], publishes: [], checks: [check], configuration: { agent: "coder" } }],
    combinedChecks: [check], runtime: { assets: [], extensions: [], environment: [], network: "openai-codex" },
  };
  return { root, workspace, source, agent, privateRoot, manifest };
}
function auth(dir, expires = Date.now() + 3600000) {
  write(path.join(dir, "auth.json"), { "openai-codex": {
    type: "oauth", access: "SYNTHETIC_NOT_REAL_ACCESS", refresh: "SYNTHETIC_NOT_REAL_REFRESH", expires,
  } });
}
function explicit(f, directory = f.source) {
  return { ...f.manifest, runtime: { ...f.manifest.runtime, credentialAgentDir: directory } };
}
function enroll(f, manifest = normalizeCollaborationManifest(explicit(f))) {
  return enrollCollaborationModelStorage({
    manifest, profileAgentDir: f.agent, piPackageRoot: collaborationSdkRoot, privateRoot: f.privateRoot,
    deadlineAt: Date.now() + 10000, requiresCredentialLease: true,
  });
}
function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name)).toString("hex")]));
}

test("explicit manifest source survives production normalization; omission remains absent", () => {
  const f = fixture();
  assert.equal(normalizeCollaborationManifest(explicit(f)).runtime.credentialAgentDir, f.source);
  assert(!Object.hasOwn(normalizeCollaborationManifest(f.manifest).runtime, "credentialAgentDir"));
});

test("native model enrollment uses the separate source and does not mutate source/profile bytes", () => {
  const f = fixture(); auth(f.source);
  const beforeSource = snapshot(f.source), beforeProfile = snapshot(f.agent);
  const result = enroll(f);
  assert.equal(result.storage.authPath, path.join(f.source, "auth.json"));
  assert.equal(result.storage.modelsPath, path.join(f.source, "models.json"));
  assert.equal(result.storage.readonlyAuthModule, path.join(collaborationSdkRoot, "dist/core/auth-storage.js"));
  assert.equal(result.storage.modelsStorePath, path.join(f.privateRoot, "models-store.json"));
  assert.deepEqual(result.modelReadPaths, [path.join(f.source, "models.json")]);
  assert.deepEqual(fs.readFileSync(result.storage.modelsStorePath), fs.readFileSync(path.join(f.source, "models-store.json")));
  assert.equal(fs.existsSync(path.join(f.agent, "auth.json")), false, "profile cannot satisfy the source lease");
  assert.equal(fs.existsSync(path.join(f.privateRoot, "auth.json")), false, "credentials must not be copied");
  assert.deepEqual(snapshot(f.source), beforeSource);
  assert.deepEqual(snapshot(f.agent), beforeProfile);
});

test("omitted source retains profile-based lease and storage paths", () => {
  const f = fixture(); auth(f.agent);
  const before = snapshot(f.agent);
  const result = enroll(f, normalizeCollaborationManifest(f.manifest));
  assert.equal(result.storage.authPath, path.join(f.agent, "auth.json"));
  assert.equal(result.storage.modelsPath, path.join(f.agent, "models.json"));
  assert.deepEqual(result.modelReadPaths, []);
  assert.deepEqual(snapshot(f.agent), before);
});

test("unsafe explicit directories fail both normalization and native selection without fallback", () => {
  const f = fixture(); auth(f.agent);
  const alias = path.join(f.root, "alias");
  fs.symlinkSync(f.source, alias, "dir");
  const file = path.join(f.source, "models.json");
  for (const directory of [
    "", "source", path.join(f.root, "missing"), f.workspace, path.join(f.workspace, "owned"),
    alias, file, f.source + "/", f.source + "/../source", f.root, "/", "/nix/store", "/proc", null, 12,
  ]) {
    assert.throws(() => normalizeCollaborationManifest(explicit(f, directory)));
    assert.throws(() => enroll(f, explicit(f, directory)), /credentialAgentDir/);
  }
});

test("a validated manifest source is rechecked at native enrollment after directory substitution", () => {
  const f = fixture(); auth(f.source);
  const manifest = normalizeCollaborationManifest(explicit(f));
  fs.renameSync(f.source, path.join(f.root, "retained-source"));
  fs.symlinkSync(path.join(f.root, "retained-source"), f.source, "dir");
  assert.throws(() => enroll(f, manifest), /credentialAgentDir/);
});

test("credential directory/auth cannot be enrolled as runtime filesystem assets", () => {
  const f = fixture(); auth(f.source);
  const alias = path.join(f.root, "auth-alias.json");
  fs.symlinkSync(path.join(f.source, "auth.json"), alias);
  const hardlink = path.join(f.root, "auth-hardlink.json");
  fs.linkSync(path.join(f.source, "auth.json"), hardlink);
  for (const assetPath of [f.source, f.root, "/", path.join(f.source, "auth.json"), alias, hardlink]) {
    for (const kind of ["assets", "extensions"]) {
      const manifest = explicit(f);
      manifest.runtime[kind] = [{ path: assetPath, digest: "0".repeat(64), ...(kind === "extensions" ? { effects: ["local-filesystem"] } : {}) }];
      assert.throws(() => normalizeCollaborationManifest(manifest), /credentialAgentDir/);
      assert.throws(() => enroll(f, manifest), /credentialAgentDir/);
    }
  }
});

test("missing, symlinked, expired and unsafe auth reject the source even with valid profile auth", () => {
  for (const mode of ["missing", "symlink", "expired", "directory", "oversized", "malformed"]) {
    const f = fixture(); auth(f.agent);
    const file = path.join(f.source, "auth.json");
    if (mode === "symlink") fs.symlinkSync(path.join(f.agent, "auth.json"), file);
    if (mode === "expired") auth(f.source, Date.now() - 1);
    if (mode === "directory") fs.mkdirSync(file);
    if (mode === "oversized") fs.writeFileSync(file, "x".repeat(1024 * 1024 + 1));
    if (mode === "malformed") fs.writeFileSync(file, "SYNTHETIC_MALFORMED_SECRET");
    const sourceStat = fs.lstatSync(f.source), beforeProfile = snapshot(f.agent);
    assert.throws(() => enroll(f), error => /bounded run deadline/.test(error.message) && !error.message.includes("SYNTHETIC"));
    assert.deepEqual(snapshot(f.agent), beforeProfile);
    assert.equal(fs.statSync(f.source).mtimeMs, sourceStat.mtimeMs);
    assert.equal(fs.existsSync(path.join(f.privateRoot, "models-store.json")), false);
  }
});

test("model metadata and catalog aliases cannot expose or copy selected credentials", () => {
  for (const name of ["models.json", "models-store.json"]) {
    for (const kind of ["symlink", "hardlink"]) {
      const f = fixture(); auth(f.source);
      const file = path.join(f.source, name);
      fs.renameSync(file, file + ".retained");
      if (kind === "symlink") fs.symlinkSync(path.join(f.source, "auth.json"), file);
      else fs.linkSync(path.join(f.source, "auth.json"), file);
      const before = fs.readFileSync(path.join(f.source, "auth.json"));
      assert.throws(() => enroll(f), /credential|ELOOP/);
      assert.deepEqual(fs.readFileSync(path.join(f.source, "auth.json")), before);
      const copied = path.join(f.privateRoot, "models-store.json");
      if (fs.existsSync(copied)) assert.notDeepEqual(fs.readFileSync(copied), before);
    }
  }
});

test("model catalog enrollment accepts the byte bound and rejects oversized or nonregular catalogs", () => {
  for (const mode of ["bounded", "oversized", "directory"]) {
    const f = fixture(); auth(f.source);
    const catalog = path.join(f.source, "models-store.json");
    fs.renameSync(catalog, catalog + ".retained");
    if (mode === "directory") fs.mkdirSync(catalog);
    else fs.writeFileSync(catalog, "x".repeat(1024 * 1024 + (mode === "oversized" ? 1 : 0)));
    const beforeSource = fs.readFileSync(path.join(f.source, "auth.json"));
    if (mode === "bounded") {
      const result = enroll(f);
      assert.deepEqual(fs.readFileSync(result.storage.modelsStorePath), fs.readFileSync(catalog));
    } else {
      assert.throws(() => enroll(f), /bounded enrollment/);
      assert.equal(fs.existsSync(path.join(f.privateRoot, "models-store.json")), false);
    }
    assert.deepEqual(fs.readFileSync(path.join(f.source, "auth.json")), beforeSource);
  }
});

test("SDK package sources and transport settings stay on the isolated profile", async () => {
  const f = fixture(); auth(f.source);
  const beforeSource = snapshot(f.source), beforeProfile = snapshot(f.agent);
  enroll(f);
  const home = path.join(f.root, "context7-home"); fs.mkdirSync(home);
  assert.equal(prepareCollaborationAgentHome(f.agent, home, false), f.agent);
  assert.equal(prepareCollaborationAgentHome(f.agent, home, true), home);
  assert.deepEqual(fs.readFileSync(path.join(home, "settings.json")), fs.readFileSync(path.join(f.agent, "settings.json")));
  assert.equal(fs.existsSync(path.join(home, "auth.json")), false);
  assert.equal(resolveHttpIdleTimeoutMs({ agentDir: f.agent, cwd: f.workspace }).timeoutMs, 1234);
  const { SettingsManager } = await import(pathToFileURL(path.join(collaborationSdkRoot, "dist/core/settings-manager.js")));
  const { DefaultPackageManager } = await import(pathToFileURL(path.join(collaborationSdkRoot, "dist/core/package-manager.js")));
  for (const agentDir of [f.agent, home]) {
    const settingsManager = SettingsManager.create(f.workspace, agentDir);
    const packages = new DefaultPackageManager({ cwd: f.workspace, agentDir, settingsManager });
    assert.deepEqual(packages.listConfiguredPackages(), [], "project packages=[] alone must not conceal ambient user sources");
  }
  const sourceSettings = SettingsManager.create(f.workspace, f.source);
  assert.equal(new DefaultPackageManager({ cwd: f.workspace, agentDir: f.source, settingsManager: sourceSettings }).listConfiguredPackages().length, 1);
  assert.deepEqual(snapshot(f.source), beforeSource);
  assert.deepEqual(snapshot(f.agent), beforeProfile);
});

test("B-SEC-001: nested hardlinks fail bounded enrollment without an asset-tree scan", () => {
  for (const omitted of [false, true]) {
    const f = fixture(); auth(omitted ? f.agent : f.source);
    const authPath = path.join(omitted ? f.agent : f.source, "auth.json");
    const asset = path.join(f.root, "asset"), nested = path.join(asset, "nested");
    fs.mkdirSync(nested, { recursive: true });
    fs.linkSync(authPath, path.join(nested, "unrelated-name"));
    const manifest = omitted ? f.manifest : explicit(f);
    manifest.runtime.assets = [{ path: asset, digest: "0".repeat(64) }];
    assert.throws(() => enroll(f, manifest), /credential|hardlink/i);
    assert.throws(() => assertCollaborationCredentialGrants(authPath, {
      readPaths: [], writePaths: [], privateWritePaths: [], runtimePaths: [asset],
    }), /credential/i);
  }
});

test("B-001: final effective grant collections reject credential exposure and retain safe files", () => {
  for (const omitted of [false, true]) {
    const f = fixture(); auth(omitted ? f.agent : f.source);
    const source = omitted ? f.agent : f.source;
    const authPath = path.join(source, "auth.json");
    const sibling = source + "-sibling"; fs.mkdirSync(sibling);
    const grants = { readPaths: [path.join(f.workspace, "owned")], writePaths: [path.join(f.workspace, "owned")],
      runtimePaths: [path.join(source, "settings.json"), sibling], privateWritePaths: [f.privateRoot] };
    assert.doesNotThrow(() => assertCollaborationCredentialGrants(authPath, grants));
    for (const collection of ["readPaths", "writePaths", "runtimePaths", "privateWritePaths"]) {
      for (const unsafe of [source, f.root, authPath]) {
        assert.throws(() => assertCollaborationCredentialGrants(authPath, { ...grants, [collection]: [unsafe] }), /credential/i);
      }
    }
    const alias = path.join(f.root, "alias.json");
    fs.symlinkSync(authPath, alias);
    assert.throws(() => assertCollaborationCredentialGrants(authPath, { ...grants, runtimePaths: [alias] }), /credential/i);
    assert.doesNotThrow(() => assertCollaborationCredentialGrants(authPath, {
      ...grants, runtimePaths: [f.workspace, sibling],
    }));
    for (const name of ["dependency", "async", "config", "supervisor", "fanout"]) {
      const directory = path.join(f.root, name); fs.mkdirSync(directory);
      assert.doesNotThrow(() => assertCollaborationCredentialGrants(authPath, { ...grants, runtimePaths: [directory] }));
      const nestedSource = path.join(directory, "credentials"); fs.mkdirSync(nestedSource); auth(nestedSource);
      assert.throws(() => assertCollaborationCredentialGrants(path.join(nestedSource, "auth.json"), {
        ...grants, runtimePaths: [directory],
      }), /credential/i, name + " ancestor grant must fail");
    }
  }
});

test("patched native integration retains profile ownership and passes the storage authPath to relay (inspection only)", () => {
  const source = fs.readFileSync(path.join(candidate, "src/runs/shared/collaboration-launch.ts"), "utf8");
  assert.match(source, /const modelEnrollment = enrollCollaborationModelStorage\(/);
  assert.match(source, /input\.config\.collaborationModelStorage = modelEnrollment\.storage;/);
  assert.match(source, /authPath: modelEnrollment\.storage\.authPath/);
  assert.match(source, /agentDir: oldHome, cwd: manifest\.workspace/);
  assert.match(source, /prepareCollaborationAgentHome\(oldHome, home,/);
  assert(!source.includes('readRuntime.push(directory)'));
  assert.match(source, /assertCollaborationCredentialGrants\(modelEnrollment\.storage\.authPath, sandboxInput\);/);
  assert.match(source, /spawnCollaborationSandbox\(sandboxInput\)/);
  assert(source.indexOf("assertCollaborationCredentialGrants(modelEnrollment.storage.authPath, sandboxInput)") < source.indexOf("consumeCollaborationSpawnAuthority(input.token)"));
  assert.match(source, /consumeCollaborationSpawnAuthority\(input\.token\);\s*const sandbox = spawnCollaborationSandbox\(sandboxInput\);/);
  assert(!source.includes("readdirSync"), "credential checking must not recursively scan assets");
  // This is wiring inspection, not executed worker enrollment or provider proof.
});
