import * as fs from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
const processTicks = Type.String({ pattern: "^[0-9]+$" });
export const collaborationNamespaceSchema = Type.Object({ hostPid: Type.Integer({ minimum: 1 }), initPid: Type.Integer({ minimum: 1 }), hostStartTicks: processTicks, initStartTicks: processTicks, namespace: Type.String({ pattern: "^pid:\\[[0-9]+\\]$" }) }, { additionalProperties: true });
import type { CollaborationNamespaceIdentity } from "./collaboration-sandbox.ts";

export class CollaborationQuiescenceError extends Error {
	readonly code = "quiescence-unproven";
}
/** Await observed kernel termination after the host wrapper closes. A deadline never grants authority. */
export async function waitForCollaborationQuiescence(identity: CollaborationNamespaceIdentity): Promise<void> {
	const deadline = Date.now() + 5000;
	for (;;) {
		try { assertCollaborationQuiescent(identity); return; }
		catch (cause) {
			if (!(cause instanceof CollaborationQuiescenceError) || Date.now() >= deadline) throw cause;
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		}
	}
}
/** The immutable namespace init must have ended before any reservation transfers. */
export function assertCollaborationQuiescent(identity: CollaborationNamespaceIdentity): void {
	if (!Value.Check(collaborationNamespaceSchema, identity) || !Number.isSafeInteger(identity.hostPid) || !Number.isSafeInteger(identity.initPid)) {
		throw new CollaborationQuiescenceError("quiescence-unproven: namespace identity is invalid.");
	}
	try {
		const raw = fs.readFileSync("/proc/" + identity.initPid + "/stat", "utf8");
		const fields = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/u);
		if (fields[19] !== identity.initStartTicks || fields[0] === "Z") return;
		throw new CollaborationQuiescenceError("quiescence-unproven: the original namespace init still exists.");
	} catch (error) {
		if (Value.Check(Type.Object({ code: Type.Literal("ENOENT") }, { additionalProperties: true }), error)) return;
		if (error instanceof CollaborationQuiescenceError) throw error;
		throw new CollaborationQuiescenceError("quiescence-unproven: namespace init identity is unreadable.");
	}
}
