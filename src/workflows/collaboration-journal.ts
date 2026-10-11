import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { Type } from "typebox";
import { decodeCollaboration, readCollaborationJson } from "./collaboration-json.ts";
const journalRecordSchema = Type.Object({ version: Type.Literal(1), epoch: Type.String({ minLength: 1 }), sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }, { additionalProperties: true });
export interface CollaborationJournalInspection { sequence: number; trailingPartial: boolean }

/** Stream recovery records once. Never retain history or scan transcripts. */
export function inspectCollaborationJournal(file: string): CollaborationJournalInspection {
	if (!fs.existsSync(file)) return { sequence: 0, trailingPartial: false };
	const fd = fs.openSync(file, "r"), buffer = Buffer.alloc(64 * 1024);
	const decoder = new StringDecoder("utf8");
	let tail = "", sequence = 0;
	try {
		let count: number;
		while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
			tail += decoder.write(buffer.subarray(0, count));
			let newline: number;
			while ((newline = tail.indexOf("\n")) >= 0) {
				const line = tail.slice(0, newline); tail = tail.slice(newline + 1);
				if (Buffer.byteLength(line) > 64 * 1024) throw new Error("Consequential journal record exceeds its byte bound.");
				const row = decodeCollaboration(journalRecordSchema, readCollaborationJson(line), "Corrupt consequential journal record.");
				if (row.version !== 1 || !row.epoch || !Number.isSafeInteger(row.sequence) || row.sequence! < 1 || row.sequence! <= sequence) throw new Error("Duplicate, reordered or corrupt consequential journal record.");
				sequence = row.sequence!;
			}
			if (Buffer.byteLength(tail) > 64 * 1024) throw new Error("Incomplete journal record exceeds its byte bound.");
		}
		tail += decoder.end();
		return { sequence, trailingPartial: tail.length !== 0 };
	} finally { fs.closeSync(fd); }
}
