import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionBindingJson } from "../runs/shared/extension-bindings.ts";
import { snapshotChildLaunchBindings, snapshotChildLaunchIdentity } from "./child-launch-binding.ts";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_REQUIRED_EXTENSIONS = 32;
const MAX_PATH_BYTES = 4096;
const EMPTY_SNAPSHOT: RequiredChildExtensionSnapshot = Object.freeze([]);

export interface RequiredChildExtension {
	/** Safe host-owned identity exposed in launch evidence. */
	id: string;
	/** Existing importable module path. Snapshotted to its canonical absolute path. */
	path: string;
}

export interface ChildLaunchIdentity {
	runId: string;
	parentSessionId: string;
	agent: string;
	cwd: string;
	taskSha256: string;
	workflow?: Readonly<{ runId: string; key: string }>;
}

export type ChildLaunchBindings = Readonly<Record<string, ExtensionBindingJson>>;
export type BindChildLaunch = (launch: Readonly<ChildLaunchIdentity>) => Promise<ChildLaunchBindings | undefined>;

export interface RegisterRequiredChildExtensionsInput {
	sessionId: string;
	extensions: readonly RequiredChildExtension[];
	/** Trusted host callback; never accepted in model launch arguments. */
	bindLaunch?: BindChildLaunch;
}

export interface RequiredChildExtensionRegistration { dispose(): void }
export type RequiredChildExtensionSnapshot = ReadonlyArray<Readonly<RequiredChildExtension>>;

/** Validate and freeze a snapshot; registration canonicalizes once, while retained launches preserve that identity. */
export function snapshotRequiredChildExtensions(value: unknown, label = "Required child extensions", canonicalizeFiles = false): RequiredChildExtensionSnapshot {
	if (!Array.isArray(value) || value.length > MAX_REQUIRED_EXTENSIONS) throw new Error(`${label} must be an array of at most ${MAX_REQUIRED_EXTENSIONS} entries.`);
	const ids = new Set<string>();
	const paths = new Set<string>();
	return Object.freeze(value.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some((key) => key !== "id" && key !== "path")) throw new Error(`${label} entry ${index} requires only id and path.`);
		const id = "id" in entry ? entry.id : undefined;
		const rawPath = "path" in entry ? entry.path : undefined;
		if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error(`${label} entry ${index} requires a safe id of at most 128 characters.`);
		if (ids.has(id)) throw new Error(`${label} id '${id}' is duplicated.`);
		if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0") || Buffer.byteLength(rawPath, "utf8") > MAX_PATH_BYTES || (!canonicalizeFiles && !path.isAbsolute(rawPath))) throw new Error(`${label} '${id}' requires ${canonicalizeFiles ? "a" : "an absolute"} non-empty path of at most ${MAX_PATH_BYTES} bytes without NUL.`);
		let extensionPath = rawPath;
		if (canonicalizeFiles) {
			try {
				extensionPath = fs.realpathSync(path.resolve(rawPath));
				if (!fs.statSync(extensionPath).isFile()) throw new Error("not a file");
			} catch (error) {
				throw new Error(`${label} '${id}' is not an importable file: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (paths.has(extensionPath)) throw new Error(`${label} path '${extensionPath}' is duplicated.`);
		ids.add(id);
		paths.add(extensionPath);
		return Object.freeze({ id, path: extensionPath });
	}));
}

interface Registry { version: 1; bySession: Map<string, RequiredChildExtensionSnapshot>; binders?: Map<string, BindChildLaunch> }

function registry(): Registry {
	const key = Symbol.for("pi-subagents.required-child-extensions.v1");
	const root = globalThis as Record<PropertyKey, unknown>;
	const existing = root[key];
	if (existing === undefined) {
		const created: Registry = { version: 1, bySession: new Map() };
		root[key] = created;
		return created;
	}
	if (!existing || typeof existing !== "object" || !("version" in existing) || existing.version !== 1 || !("bySession" in existing) || !(existing.bySession instanceof Map)) throw new Error("Malformed or unsupported required child extension registry.");
	return existing as Registry;
}

/** Register one immutable host-required extension snapshot for a parent session. */
export function registerRequiredChildExtensions(input: RegisterRequiredChildExtensionsInput): RequiredChildExtensionRegistration {
	if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "sessionId" && key !== "extensions" && key !== "bindLaunch")) throw new Error("Required child extension registration requires only sessionId and extensions.");
	if (typeof input.sessionId !== "string" || !input.sessionId || input.sessionId.trim() !== input.sessionId || input.sessionId.length > 256 || input.sessionId.includes("\0")) throw new Error("Required child extension registration requires a non-empty trimmed sessionId of at most 256 characters without NUL.");
	if (input.bindLaunch !== undefined && typeof input.bindLaunch !== "function") throw new Error("bindLaunch must be a trusted callback.");
	const frozen = snapshotRequiredChildExtensions(input.extensions, "Required child extensions", true);
	const store = registry();
	if (store.bySession.has(input.sessionId)) throw new Error(`Required child extensions are already registered for session '${input.sessionId}'; dispose them first.`);
	store.bySession.set(input.sessionId, frozen);
	if (input.bindLaunch) (store.binders ??= new Map()).set(input.sessionId, input.bindLaunch);
	return { dispose() {
		if (store.bySession.get(input.sessionId) !== frozen) return;
		store.bySession.delete(input.sessionId);
		store.binders?.delete(input.sessionId);
	} };
}

/** Internal opt-in check: ordinary launches do not hash tasks or await a binder. */
export function hasRequiredChildLaunchBinding(sessionId: string): boolean {
	return registry().binders?.has(sessionId) === true;
}

/** Called by the native async host once, after its logical launch tuple is fixed. */
export async function bindRequiredChildLaunch(launch: ChildLaunchIdentity, required: RequiredChildExtensionSnapshot): Promise<ChildLaunchBindings | undefined> {
	const store = registry();
	const binder = store.binders?.get(launch.parentSessionId);
	if (!binder) return undefined;
	const registered = store.bySession.get(launch.parentSessionId);
	if (!registered || JSON.stringify(registered) !== JSON.stringify(required)) throw new Error("Required launch extensions changed before binding.");
	return snapshotChildLaunchBindings(await binder(snapshotChildLaunchIdentity(launch)), required);
}

export function resolveRequiredChildExtensions(sessionId: string | undefined): RequiredChildExtensionSnapshot {
	if (!sessionId) return EMPTY_SNAPSHOT;
	return registry().bySession.get(sessionId) ?? EMPTY_SNAPSHOT;
}
