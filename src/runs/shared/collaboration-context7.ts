import { Type } from "typebox";
import { decodeCollaboration, readCollaborationJson, type CollaborationJson } from "../../workflows/collaboration-json.ts";

/** This one test-local authority is not a general MCP or remote API grant. */
export const COLLABORATION_CONTEXT7_ROUTE = "https://mcp.context7.com/mcp";
const failure = "Confined Context7 transport rejected.";
const text = Type.String({ minLength: 1, maxLength: 16384 });
// SAFETY: Nested values originate only from readCollaborationJson, never host objects.
const json = Type.Unsafe<CollaborationJson>({});
const metadata = Type.Optional(Type.Record(Type.String(), json));
const params = {
	"resolve-library-id": Type.Object({ libraryName: text, query: text }, { additionalProperties: false }),
	"query-docs": Type.Object({ libraryId: text, query: text }, { additionalProperties: false }),
};
const envelope = Type.Object({
	jsonrpc: Type.Literal("2.0"),
	id: Type.Optional(Type.Union([Type.String({ maxLength: 128 }), Type.Integer()])),
	method: Type.String(),
	params: Type.Optional(Type.Record(Type.String(), json)),
}, { additionalProperties: false });

export function validateCollaborationContext7(method: string | undefined, headers: Headers, body: Buffer): void {
	const allowedHeaders = new Set(["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "mcp-method", "mcp-name", "last-event-id"]);
	for (const name of headers.keys()) if (!allowedHeaders.has(name)) throw new Error(failure);
	if (method === "GET") {
		if (body.length || !headers.get("accept")?.includes("text/event-stream")) throw new Error(failure);
		return;
	}
	if (method !== "POST" || headers.get("content-type") !== "application/json") throw new Error(failure);
	const message = decodeCollaboration(envelope, readCollaborationJson(body.toString("utf8")), failure);
	if (headers.has("mcp-method") && headers.get("mcp-method") !== message.method) throw new Error(failure);
	if (headers.has("mcp-name") && (message.method !== "tools/call" || headers.get("mcp-name") !== message.params?.name)) throw new Error(failure);
	switch (message.method) {
		case "tools/call": {
			const call = decodeCollaboration(Type.Object({
				name: Type.Union([Type.Literal("resolve-library-id"), Type.Literal("query-docs")]),
				arguments: Type.Record(Type.String(), json),
				_meta: metadata,
			}, { additionalProperties: false }), message.params, failure);
			decodeCollaboration(params[call.name], call.arguments, failure);
			break;
		}
		case "tools/list":
			decodeCollaboration(Type.Object({ cursor: Type.Optional(text), _meta: metadata }, { additionalProperties: false }), message.params ?? {}, failure);
			break;
		case "notifications/cancelled":
			if (message.id !== undefined) throw new Error(failure);
			decodeCollaboration(Type.Object({
				requestId: Type.Union([Type.String({ maxLength: 128 }), Type.Integer()]), reason: Type.Optional(text),
			}, { additionalProperties: false }), message.params, failure);
			break;
		case "notifications/initialized":
			if (message.id !== undefined || Object.keys(message.params ?? {}).length) throw new Error(failure);
			break;
		case "initialize":
		case "server/discover":
			// Setup only, never a tool, sampling callback or worker-created transport grant.
			if (message.id === undefined) throw new Error(failure);
			break;
		default: throw new Error(failure);
	}
}
