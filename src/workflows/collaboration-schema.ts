import { Type } from "typebox";
import { collaborationNamespaceSchema } from "../runs/shared/collaboration-quiescence.ts";

const id = Type.String({ minLength: 1, maxLength: 128 });
const text = Type.String({ minLength: 1 });
const version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const strings = Type.Array(Type.String());
const access = { reads: strings, writes: strings, exclusive: strings };
const configuration = Type.Object({ agent: id, model: Type.Optional(text), thinking: Type.Optional(text) }, { additionalProperties: false });
const publication = Type.Object({ resourceId: id, version }, { additionalProperties: false });
const check = Type.Object({ id, command: text, timeoutMs: version, ...access }, { additionalProperties: false });
const pkg = Type.Object({
	id, goal: text, rationale: text, constraints: strings, completion: strings, ...access,
	prerequisites: strings,
	requires: Type.Array(Type.Object({ packageId: id, resourceId: id, version }, { additionalProperties: false })),
	publishes: Type.Array(publication), checks: Type.Array(check), configuration,
}, { additionalProperties: false });
/** Persisted manifests already passed semantic/path validation at enrollment. */
export const collaborationManifestRecordSchema = Type.Object({
	schemaVersion: Type.Literal(1), workflowId: id, runId: id, manifestVersion: version, workspace: text,
	goal: text, rationale: text, constraints: strings, completion: strings, concurrency: version,
	resources: Type.Array(Type.Object({
		id, kind: Type.Union([Type.Literal("path"), Type.Literal("exclusive")]),
		path: Type.Optional(text), initialPublication: Type.Optional(Type.Object({ version, digest: text }, { additionalProperties: false })),
	}, { additionalProperties: false })),
	packages: Type.Array(pkg), combinedChecks: Type.Array(check), reconciliation: Type.Optional(pkg),
	runtime: Type.Object({
		network: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("openai-codex")])),
		context7: Type.Optional(Type.Object({ path: text, digest: text }, { additionalProperties: false })),
		assets: Type.Array(Type.Object({ path: text, digest: text }, { additionalProperties: false })),
		extensions: Type.Array(Type.Object({ path: text, digest: text, effects: Type.Array(Type.Union([Type.Literal("local-filesystem"), Type.Literal("provider-network"), Type.Literal("context7-network")])) }, { additionalProperties: false })),
		environment: strings,
	}, { additionalProperties: false }),
}, { additionalProperties: false });
const packageState = Type.Object({
	id, state: Type.Union([Type.Literal("blocked"), Type.Literal("ready"), Type.Literal("reserved"), Type.Literal("running"), Type.Literal("validating"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("interrupted")]),
	completionContractDigest: Type.Optional(text), nativeArtifactDir: Type.Optional(text),
	completionInputs: Type.Optional(Type.Record(Type.String(), Type.Object({ path: text, version, digest: text, packageId: Type.Optional(text), executionId: Type.Optional(text) }, { additionalProperties: false }))),
	completionPrerequisites: Type.Optional(Type.Record(Type.String(), text)),
	executionId: Type.Optional(text), outputDigests: Type.Optional(Type.Record(Type.String(), Type.String())),
	runId: Type.Optional(text), pid: Type.Optional(version), reason: Type.Optional(Type.String()),
	completionManifestVersion: Type.Optional(version),
	reusedFrom: Type.Optional(Type.Object({ epoch: text, manifestVersion: version, executionId: Type.Optional(text) }, { additionalProperties: false })),
}, { additionalProperties: false });
export const collaborationSnapshotSchema = Type.Object({
	version: Type.Literal(1), epoch: Type.String({ pattern: "^[a-zA-Z0-9-]{1,128}$" }),
	sequence: version, manifestDigest: text, manifest: collaborationManifestRecordSchema,
	summary: Type.Object({
		runId: id, manifestVersion: version,
		state: Type.Union([Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("failed"), Type.Literal("interrupted")]),
		residents: Type.Integer({ minimum: 0 }), ceiling: version,
		controlSequence: Type.Integer({ minimum: 0 }), capacityLimit: version,
		barrier: Type.Union([Type.Literal("none"), Type.Literal("admissions-paused"), Type.Literal("stop")]),
		effectiveConfiguration: Type.Record(Type.String(), configuration),
		ownership: Type.Array(Type.Object({ packageId: id, executionId: Type.Optional(text), ...access }, { additionalProperties: false })),
		pendingConsequential: Type.Object({ barrier: Type.Union([Type.Literal("none"), Type.Literal("admissions-paused"), Type.Literal("stop")]), controlSequence: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
		measurementCompleteness: Type.Object({ coordination: Type.Literal(false), workerUsage: Type.Literal(false) }, { additionalProperties: false }),
		packages: Type.Array(packageState),
		publications: Type.Record(Type.String(), Type.Object({ version, digest: text, packageId: Type.Optional(text), executionId: Type.Optional(text) }, { additionalProperties: false })),
		verification: Type.Union([Type.Literal("pending"), Type.Literal("passed"), Type.Literal("failed")]),
		reconciliation: Type.Optional(packageState),
		activeCheck: Type.Optional(Type.Object({ id, executionId: text, namespace: Type.Optional(collaborationNamespaceSchema) }, { additionalProperties: false })),
		activeChecks: Type.Optional(Type.Array(Type.Object({ id, executionId: text, namespace: Type.Optional(collaborationNamespaceSchema) }, { additionalProperties: false }), { maxItems: 256 })),
		artifacts: Type.Object({ snapshot: text, journal: text }, { additionalProperties: false }),
	}, { additionalProperties: true }),
}, { additionalProperties: false });
export const collaborationRecoverySchema = Type.Object({
	epoch: text, sequence: version, workspaceDigest: text,
	approval: Type.Object({ authority: Type.Union([Type.Literal("user"), Type.Literal("supervisor")]), reference: Type.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: false }),
	retryPackages: strings, reuseCompleted: strings,
}, { additionalProperties: false });
