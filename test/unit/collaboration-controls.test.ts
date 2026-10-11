import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { validateCollaborationControl, requestCollaborationControl } from "../../src/workflows/collaboration-control.ts";
import { inspectCollaborationJournal } from "../../src/workflows/collaboration-journal.ts";
import { assertCollaborationQuiescent } from "../../src/runs/shared/collaboration-quiescence.ts";
import { assertCollaborationCredentialLease } from "../../src/runs/shared/collaboration-provider-transport.ts";

it("validates monotonic bounded controls and keeps one complete pending mailbox record", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-control-test-"));
	fs.writeFileSync(path.join(directory, "snapshot.json"), JSON.stringify({ epoch: "test-epoch", manifest: { manifestVersion: 3 }, summary: { controlSequence: 7 } }));
	const id = requestCollaborationControl(directory, "ceiling", 4);
	const row = JSON.parse(fs.readFileSync(path.join(directory, "control", "request.json"), "utf8"));
	assert.equal(row.id, id); assert.equal(row.sequence, 8); assert.equal(row.manifestVersion, 3);
	assert.deepEqual(validateCollaborationControl(row), row);
	assert.throws(() => requestCollaborationControl(directory, "stop"), /EEXIST/);
	assert.deepEqual(fs.readdirSync(path.join(directory, "control")), ["request.json"]);
	for (const invalid of [
		{ ...row, id: undefined }, { ...row, epoch: 123 }, { ...row, sequence: 0 },
		{ ...row, ceiling: 0 }, { ...row, ceiling: 257 }, { ...row, extraAuthority: true },
		{ ...row, action: "stop", ceiling: 1 }, { ...row, id: "x".repeat(5000) },
	]) assert.throws(() => validateCollaborationControl(invalid), /control/);
});

it("inspects bounded journal records without changing partial or duplicate history", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-journal-test-")), file = path.join(directory, "journal.jsonl");
	const record = (sequence: number) => JSON.stringify({ version: 1, epoch: "test-epoch", sequence }) + "\n";
	fs.writeFileSync(file, record(1) + record(2) + '{"version":');
	assert.deepEqual(inspectCollaborationJournal(file), { sequence: 2, trailingPartial: true });
	assert.equal(fs.readFileSync(file, "utf8"), record(1) + record(2) + '{"version":');
	fs.writeFileSync(file, record(1) + record(1));
	assert.throws(() => inspectCollaborationJournal(file), /Duplicate/);
	fs.writeFileSync(file, "x".repeat(65537));
	assert.throws(() => inspectCollaborationJournal(file), /byte bound/);
});

it("rejects malformed process identities instead of certifying a live namespace as stopped", () => {
	const raw = fs.readFileSync("/proc/self/stat", "utf8");
	const ticks = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/u)[19]!;
	const identity = { hostPid: process.pid, hostStartTicks: ticks, initPid: process.pid, initStartTicks: ticks, namespace: fs.readlinkSync("/proc/self/ns/pid") };
	assert.throws(() => assertCollaborationQuiescent(identity), /still exists/);
	// SAFETY: This deliberately malformed test input verifies that numeric ticks cannot certify a live process as stopped.
	assert.throws(() => assertCollaborationQuiescent({ ...identity, initStartTicks: Number(ticks) } as any), /invalid/);
	// SAFETY: This deliberately empty test input must fail the runtime identity schema.
	assert.throws(() => assertCollaborationQuiescent({} as any), /invalid/);
});

it("checks existing synthetic OAuth deadline metadata without credential writes or secret-bearing errors", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-auth-metadata-test-")), file = path.join(directory, "synthetic-auth.json");
	const now = Date.now(), secret = "SYNTHETIC_TEST_NOT_A_CREDENTIAL";
	const value = { "openai-codex": { type: "oauth", access: secret, refresh: secret, expires: now + 60000 } };
	fs.writeFileSync(file, JSON.stringify(value)); const before = fs.readFileSync(file, "utf8");
	assert.doesNotThrow(() => assertCollaborationCredentialLease(file, now + 10000));
	assert.equal(fs.readFileSync(file, "utf8"), before);
	for (const deadline of [undefined, now - 1, now + 120000]) assert.throws(() => assertCollaborationCredentialLease(file, deadline), (error: Error) => /unsupported/.test(error.message) && !error.message.includes(secret));
	fs.writeFileSync(file, secret);
	assert.throws(() => assertCollaborationCredentialLease(file, now + 10000), (error: Error) => /unsupported/.test(error.message) && !error.message.includes(secret));
});
