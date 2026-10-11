import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

/** Wire values are JSON data, never functions or host objects. */
export type CollaborationJson = string | number | boolean | null | CollaborationJson[] | CollaborationJsonObject;
export interface CollaborationJsonObject { [key: string]: CollaborationJson | undefined }
export function readCollaborationJson(source: string): CollaborationJson {
	// SAFETY: JSON.parse creates only JSON values. Each domain reader validates its own schema next.
	return JSON.parse(source) as CollaborationJson;
}
export function collaborationObject(value: CollaborationJson | undefined, fields: readonly string[], label: string): CollaborationJsonObject {
	if (!Value.Check(Type.Object({}, { additionalProperties: true }), value) || Array.isArray(value)) throw new Error(label + " must be an object.");
	// SAFETY: The input is decoded JSON and the schema establishes a non-array object.
	const row = value as CollaborationJsonObject;
	for (const key of Object.keys(row)) if (!fields.includes(key)) throw new Error(label + " has unsupported field " + key);
	return row;
}
export function collaborationString(value: CollaborationJson | undefined, label: string, limit = 4096): string {
	if (!Value.Check(Type.String(), value) || !value.trim() || value.includes("\0") || Buffer.byteLength(value) > limit) throw new Error(label + " must be a bounded nonempty string.");
	return value;
}
export function collaborationInteger(value: CollaborationJson | undefined, label: string, max = Number.MAX_SAFE_INTEGER): number {
	if (!Value.Check(Type.Integer({ minimum: 1, maximum: max }), value) || !Number.isSafeInteger(value)) throw new Error(label + " must be a positive safe integer.");
	return value;
}
export function collaborationArray<T>(value: CollaborationJson | undefined, label: string, parse: (entry: CollaborationJson, label: string) => T, max = 256): T[] {
	if (!Array.isArray(value) || value.length > max) throw new Error(label + " must be a bounded array.");
	return value.map((entry, index) => parse(entry, label + "[" + index + "]"));
}
export function decodeCollaboration<S extends TSchema>(schema: S, value: CollaborationJson | undefined, message: string): Static<S> {
	if (!Value.Check(schema, value)) throw new Error(message);
	return value;
}
