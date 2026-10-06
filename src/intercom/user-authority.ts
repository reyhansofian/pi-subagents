import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BOUNDARY = "subagents:user-authority:v1:pending";
const INPUT = "subagents:user-authority:v1:input";
type Session = ExtensionContext["sessionManager"];

/** Only the public interactive input event proves human provenance. RPC has no such proof. */
export function registerUserAuthorityInput(pi: ExtensionAPI): () => void {
	return pi.on("input", (event, ctx) => {
		if (event.source === "interactive") pi.appendEntry(INPUT, { sessionId: ctx.sessionManager.getSessionId() });
	});
}

/** The branch journal, not clocks or role=user messages, is the authority boundary. */
export function markUserAuthorityBoundary(pi: ExtensionAPI, session: Session | undefined, requestId: string): void {
	if (!session?.getBranch) return; // Older hosts/missing journal fail closed at reply.
	if (session.getBranch().some(entry => entry.type === "custom" && entry.customType === BOUNDARY
		&& (entry.data as { requestId?: unknown })?.requestId === requestId)) return;
	pi.appendEntry(BOUNDARY, { requestId, sessionId: session.getSessionId() });
}

export function hasUserAuthority(session: Session | undefined, requestId: string): boolean {
	if (!session?.getBranch) return false;
	let pending = false;
	for (const entry of session.getBranch()) {
		if (entry.type !== "custom") continue;
		const data = entry.data as { requestId?: unknown; sessionId?: unknown } | undefined;
		if (data?.sessionId !== session.getSessionId()) continue;
		if (entry.customType === BOUNDARY && data.requestId === requestId) pending = true;
		if (pending && entry.customType === INPUT) return true;
	}
	return false;
}
