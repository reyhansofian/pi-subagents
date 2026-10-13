import type { ChildLaunchIdentity, ChildLaunchBindings, RequiredChildExtensionSnapshot } from "./required-child-extensions.ts";
import { normalizeExtensionBindings } from "../runs/shared/extension-bindings.ts";

/** Snapshot only declared IDs using the existing bounded immutable JSON codec. */
export function snapshotChildLaunchBindings(value: unknown, required: RequiredChildExtensionSnapshot): ChildLaunchBindings | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Launch binding must be plain JSON.");
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const encoded: Record<string, unknown> = {};
	for (const key of Reflect.ownKeys(descriptors)) {
		if (typeof key !== "string" || !required.some(entry => entry.id === key)) throw new Error("Launch binding ID is not a required extension.");
		const descriptor = descriptors[key]!;
		if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("Launch binding requires data properties.");
		Object.defineProperty(encoded, `binding${required.findIndex(entry => entry.id === key)}/1`, { value: descriptor.value, enumerable: true });
	}
	const frozen = normalizeExtensionBindings(encoded)!.value;
	const bindings = Object.create(null) as Record<string, typeof frozen[string]>;
	for (const key of Object.keys(descriptors)) Object.defineProperty(bindings, key, { value: frozen[`binding${required.findIndex(entry => entry.id === key)}/1`], enumerable: true });
	return Object.freeze(bindings);
}

export function snapshotChildLaunchIdentity(launch: ChildLaunchIdentity): Readonly<ChildLaunchIdentity> {
	if (![launch.runId, launch.parentSessionId, launch.agent, launch.cwd].every(value => typeof value === "string" && value.length > 0) || !/^[a-f0-9]{64}$/.test(launch.taskSha256)) throw new Error("Invalid actual child launch identity.");
	if (launch.workflow && (![launch.workflow.runId, launch.workflow.key].every(value => typeof value === "string" && value.length > 0))) throw new Error("Invalid actual workflow identity.");
	return Object.freeze({ ...launch, ...(launch.workflow ? { workflow: Object.freeze({ ...launch.workflow }) } : {}) });
}
