import { decodeCollaboration, readCollaborationJson } from "../../src/workflows/collaboration-json.ts";
import { collaborationSnapshotSchema } from "../../src/workflows/collaboration-schema.ts";
import type { WorkflowScriptResult } from "../../src/workflows/scripted-workflow.ts";
export function collaborationResult(value: WorkflowScriptResult["value"]) {
	return decodeCollaboration(collaborationSnapshotSchema.properties.summary, readCollaborationJson(JSON.stringify(value)), "Public collaboration result is malformed.");
}
