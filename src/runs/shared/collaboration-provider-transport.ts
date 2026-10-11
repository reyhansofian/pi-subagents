import { Socket } from "node:net";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { decodeCollaboration, readCollaborationJson, type CollaborationJson } from "../../workflows/collaboration-json.ts";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import { createRequire } from "node:module";
import * as zlib from "node:zlib";
import { resolveHttpIdleTimeoutMs, runnerHttpDispatcherOptions } from "../background/runner-http-dispatcher.ts";
import { COLLABORATION_CONTEXT7_ROUTE, validateCollaborationContext7 } from "./collaboration-context7.ts";

/**
 * Ephemeral provider traffic only. Never send this channel to coordination,
 * logging, tool results or artifacts. Provider code and callbacks stay local.
 */
const MAX_BODY = 4 * 1024 * 1024;
const MAX_FRAME = 6 * 1024 * 1024;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_ACTIVE = 4;
const HTTP_ROUTE = "https://chatgpt.com/backend-api/codex/responses";
const WS_ROUTE = "wss://chatgpt.com/backend-api/codex/responses";
const FAILURE = "Confined provider transport rejected, interrupted or exceeded its byte bound.";
const credentialSchema = Type.Object({ type: Type.Literal("oauth"), access: Type.String(), refresh: Type.String(), expires: Type.Number() }, { additionalProperties: true });
const headerSchema = Type.Array(Type.Tuple([Type.String(), Type.String()]), { maxItems: 128 });
const frameSchema = Type.Object({
	id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), kind: Type.String(),
	url: Type.Optional(Type.String()), method: Type.Optional(Type.String()), headers: Type.Optional(headerSchema), body: Type.Optional(Type.String()),
	modelId: Type.Optional(Type.String()), provider: Type.Optional(Type.String()), credential: Type.Optional(credentialSchema),
	code: Type.Optional(Type.Number()), reason: Type.Optional(Type.String()), wasClean: Type.Optional(Type.Boolean()),
	status: Type.Optional(Type.Number()), statusText: Type.Optional(Type.String()), protocol: Type.Optional(Type.String()), extensions: Type.Optional(Type.String()),
}, { additionalProperties: false });
interface Frame {
	id: number; kind: string; url?: string; method?: string; headers?: [string, string][]; body?: string; modelId?: string; provider?: string;
	credential?: CollaborationOAuthCredential; code?: number; reason?: string; wasClean?: boolean; status?: number; statusText?: string; protocol?: string; extensions?: string;
}
interface ActiveTransport {
	abort: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array>; ws?: WireSocket; busy?: boolean; bytes: number;
}
interface ProviderRelay { close(): void }
interface ProviderClient {
	fetch: typeof globalThis.fetch;
	WebSocket: new (url: string | URL, options?: CollaborationWebSocketOptions) => EventTarget & { readyState: number; binaryType: string; send(value: string): void; close(code?: number, reason?: string): void };
	readCredential(modelId: string, signal?: AbortSignal): Promise<CollaborationOAuthCredential>;
	close(): void;
}
interface CollaborationWebSocketOptions { headers?: NonNullable<Parameters<typeof globalThis.fetch>[1]>["headers"] }
const websocketOptionsSchema = Type.Object({ headers: Type.Optional(Type.Union([Type.Record(Type.String(), Type.String()), headerSchema])) }, { additionalProperties: false });

class Channel {
	private tail = Buffer.alloc(0);
	private closed = false;
	private socket: Duplex;
	private ended: () => void;
	constructor(socket: Duplex, receive: (frame: Frame) => void, ended: () => void) {
		this.socket = socket; this.ended = ended;
		socket.on("data", (chunk: Buffer) => {
			try {
				if (this.tail.length + chunk.length > MAX_FRAME + 4) throw new Error(FAILURE);
				this.tail = Buffer.concat([this.tail, chunk]);
				while (this.tail.length >= 4) {
					const size = this.tail.readUInt32BE(0);
					if (!size || size > MAX_FRAME) throw new Error(FAILURE);
					if (this.tail.length < size + 4) break;
					const decoded = decodeCollaboration(frameSchema, readCollaborationJson(this.tail.subarray(4, size + 4).toString("utf8")), FAILURE);
					// SAFETY: Frame fields and the credential structure are checked before dispatch. Credential extras stay inside protected transport.
					const value = decoded as Frame;
					this.tail = this.tail.subarray(size + 4);
					if (!Number.isSafeInteger(value.id) || value.id < 1) throw new Error(FAILURE);
					receive(value);
				}
				if (!this.tail.length) this.tail = Buffer.alloc(0);
			} catch { this.close(); }
		});
		socket.on("error", () => this.close());
		socket.on("end", () => this.close());
		socket.on("close", () => this.close());
	}
	send(frame: Frame): void {
		if (this.closed) throw new Error(FAILURE);
		const body = Buffer.from(JSON.stringify(frame));
		if (body.length > MAX_FRAME || this.socket.writableLength + body.length + 4 > MAX_BUFFER) {
			this.close(); throw new Error(FAILURE);
		}
		const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
		this.socket.cork(); this.socket.write(size); this.socket.write(body); this.socket.uncork();
	}
	close(): void {
		if (this.closed) return;
		this.closed = true; this.tail = Buffer.alloc(0);
		this.socket.destroy(); this.ended();
	}
}

export interface CollaborationProviderAuthority { modelId: string; context7?: true }
export interface CollaborationOAuthCredential { type: "oauth"; access: string; refresh: string; expires: number; [key: string]: CollaborationJson | undefined }
export function collaborationProviderAuthority(model: string | undefined): CollaborationProviderAuthority {
	if (!Value.Check(Type.String(), model)) throw new Error("shared-workspace-unsupported: collaboration requires the existing resolved model identity.");
	const match = /^openai-codex\/([^/:]+)(?::[a-z]+)?$/u.exec(model);
	if (!match) throw new Error("shared-workspace-unsupported: only the selected native openai-codex transport is enrolled. No provider or model fallback was selected.");
	return { modelId: match[1]! };
}
/** Check only existing auth metadata. No token leaves this scope or enters an artifact. */
export function assertCollaborationCredentialLease(authPath: string, deadlineAt: number | undefined): void {
	const message = "shared-workspace-unsupported: native Codex requires existing OAuth credentials valid through the bounded run deadline. Refresh through the existing authorized parent before admission; no credential writes or auth-route fallback were granted.";
	if (!Value.Check(Type.Number(), deadlineAt) || !Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) throw new Error(message);
	let fd: number | undefined;
	try {
		fd = fs.openSync(authPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const info = fs.fstatSync(fd);
		if (!info.isFile() || info.size > 1024 * 1024) throw new Error(message);
		const store = decodeCollaboration(Type.Object({ "openai-codex": credentialSchema }, { additionalProperties: true }), readCollaborationJson(fs.readFileSync(fd, "utf8")), message);
		const selected = store["openai-codex"];
		if (!selected.access || !Number.isFinite(selected.expires) || selected.expires <= deadlineAt || Buffer.byteLength(JSON.stringify(selected)) > 32 * 1024) throw new Error(message);
	} catch { throw new Error(message); }
	finally { if (fd !== undefined) fs.closeSync(fd); }
}
function headers(value: Frame["headers"], request = true): Headers {
	if (!Array.isArray(value) || value.length > 128) throw new Error(FAILURE);
	const checked = decodeCollaboration(headerSchema, value, FAILURE);
	const result = new Headers(checked);
	let size = 0; result.forEach((v, k) => { size += Buffer.byteLength(k) + Buffer.byteLength(v); });
	if (size > 32 * 1024 || (request && (result.has("host") || result.has("connection") || result.has("upgrade") || result.has("proxy-authorization")))) throw new Error(FAILURE);
	return result;
}
function decode(value: Frame["body"]): Buffer {
	if (!Value.Check(Type.String(), value) || value.length > Math.ceil(MAX_BODY / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) throw new Error(FAILURE);
	const body = Buffer.from(value, "base64");
	if (body.length > MAX_BODY) throw new Error(FAILURE);
	return body;
}
function validateModel(body: Buffer, authority: CollaborationProviderAuthority, compression?: string | null): void {
	if (compression && compression !== "zstd") throw new Error(FAILURE);
	if (compression && !zlib.zstdDecompressSync) throw new Error(FAILURE);
	const bytes = compression ? zlib.zstdDecompressSync(body, { maxOutputLength: MAX_BODY }) : body;
	const value = decodeCollaboration(Type.Object({ model: Type.String(), type: Type.Optional(Type.String()) }, { additionalProperties: true }), readCollaborationJson(bytes.toString("utf8")), FAILURE);
	if (value.model !== authority.modelId || (value.type !== undefined && value.type !== "response.create")) throw new Error(FAILURE);
}

type WireSocket = Pick<InstanceType<typeof import("undici").WebSocket>, "readyState" | "binaryType" | "protocol" | "extensions" | "send" | "close" | "addEventListener">;
interface BackendRequest { method: "POST" | "GET"; headers: Headers; body?: Buffer; redirect: "error"; signal: AbortSignal }
interface TransportBackend {
	fetch: (url: string, init: BackendRequest) => Promise<Response>;
	WebSocket: new (url: string, options: any) => WireSocket;
	close(): void;
}
function nativeBackend(options: { agentDir: string; cwd: string }): TransportBackend {
	// SAFETY: The pinned prepared dependency supplies these dispatcher/fetch/WebSocket contracts.
	const undici: typeof import("undici") = createRequire(import.meta.url)("undici");
	const idle = resolveHttpIdleTimeoutMs(options);
	// Same selected proxy environment and idle settings as the existing runner.
	// Do not install a different global dispatcher in the coordinator.
	let dispatcher: InstanceType<typeof undici.EnvHttpProxyAgent>;
	try { dispatcher = new undici.EnvHttpProxyAgent(runnerHttpDispatcherOptions(idle.timeoutMs)); }
	catch { throw new Error("shared-workspace-unsupported: selected proxy transport configuration could not be enrolled. No environment value or credential was logged."); }
	EventEmitter.prototype.on.call(dispatcher, "error", () => {});
	return {
		fetch: (url, init) => undici.fetch(url, { ...init, headers: [...init.headers], dispatcher }),
		WebSocket: class extends undici.WebSocket {
			constructor(url: string, options: any) { super(url, { ...options, dispatcher }); }
		},
		close() { void dispatcher.destroy().catch(() => {}); },
	};
}

/** Transport-only relay. It never imports a model registry, provider or extension. */
export function attachCollaborationProviderRelay(socket: Duplex, authority: CollaborationProviderAuthority, options: {
	agentDir: string; cwd: string;
	/** Existing selected credential source, never a new store or worker filesystem grant. */
	authPath?: string;
	/** Isolated synthetic transport fixture only, never exposed through manifests. */
	backend?: TransportBackend;
}): ProviderRelay {
	const backend = options.backend ?? nativeBackend(options);
	const active = new Map<number, ActiveTransport>();
	let ended = false, highestId = 0;
	let context7SessionId: string | undefined;
	const finish = (id: number) => {
		const operation = active.get(id); if (!operation) return;
		active.delete(id); operation.abort.abort();
		void operation.reader?.cancel().catch(() => {});
		try { operation.ws?.close(1000, "done"); } catch {}
	};
	const channel = new Channel(socket, (frame) => {
		void receive(frame).catch(() => {
			try { channel.send({ id: frame.id, kind: "error" }); } catch {}
			finish(frame.id);
		});
	}, () => {
		ended = true;
		for (const id of active.keys()) finish(id);
		backend.close();
	});
	async function receive(frame: Frame): Promise<void> {
		const existing = active.get(frame.id);
		if (frame.kind === "abort") { finish(frame.id); return; }
		if (frame.kind === "pull") {
			if (!existing?.reader || existing.busy) throw new Error(FAILURE);
			existing.busy = true;
			const chunk = await existing.reader.read();
			if (active.get(frame.id) !== existing) return;
			existing.busy = false;
			if (chunk.done) { channel.send({ id: frame.id, kind: "end" }); finish(frame.id); return; }
			existing.bytes += chunk.value.length;
			if (existing.bytes > 64 * 1024 * 1024 || chunk.value.length > MAX_BODY) throw new Error(FAILURE);
			channel.send({ id: frame.id, kind: "chunk", body: Buffer.from(chunk.value).toString("base64") });
			return;
		}
		if (frame.kind === "send") {
			if (!existing?.ws || existing.ws.readyState !== 1 || !Value.Check(Type.String(), frame.body) || Buffer.byteLength(frame.body) > MAX_BODY) throw new Error(FAILURE);
			validateModel(Buffer.from(frame.body), authority);
			existing.ws.send(frame.body); return;
		}
		if (frame.kind === "close") {
			if (!existing?.ws) throw new Error(FAILURE);
			existing.ws.close(Value.Check(Type.Number(), frame.code) ? frame.code : 1000, Value.Check(Type.String(), frame.reason) ? frame.reason.slice(0, 123) : "done");
			return;
		}
		if (existing || ended || active.size >= MAX_ACTIVE || frame.id <= highestId) throw new Error(FAILURE);
		highestId = frame.id;
		if (frame.kind === "credential") {
			if (frame.modelId !== authority.modelId || frame.provider !== "openai-codex" || !options.authPath) throw new Error(FAILURE);
			const fd = fs.openSync(options.authPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
			try {
				const info = fs.fstatSync(fd); if (!info.isFile() || info.size > 1024 * 1024) throw new Error(FAILURE);
				const store = decodeCollaboration(Type.Object({ "openai-codex": credentialSchema }, { additionalProperties: true }), readCollaborationJson(fs.readFileSync(fd, "utf8")), FAILURE);
				const credential = store["openai-codex"];
				if ( !Number.isFinite(credential.expires) || Buffer.byteLength(JSON.stringify(credential)) > 32 * 1024) throw new Error(FAILURE);
				// SAFETY: The selected OAuth fields are decoded above; extra source fields remain protected JSON data.
				channel.send({ id: frame.id, kind: "credential", credential: credential as CollaborationOAuthCredential });
			} finally { fs.closeSync(fd); }
			return;
		}
		const operation: ActiveTransport = { abort: new AbortController(), bytes: 0 };
		if (frame.kind === "fetch") {
			const context7 = frame.url === COLLABORATION_CONTEXT7_ROUTE && authority.context7 === true;
			if (!context7 && (frame.url !== HTTP_ROUTE || frame.method !== "POST")) throw new Error(FAILURE);
			const requestHeaders = headers(frame.headers), body = decode(frame.body);
			if (context7) {
				validateCollaborationContext7(frame.method, requestHeaders, body);
				if (requestHeaders.has("mcp-session-id") && requestHeaders.get("mcp-session-id") !== context7SessionId) throw new Error(FAILURE);
			}
			else validateModel(body, authority, requestHeaders.get("content-encoding"));
			active.set(frame.id, operation);
			const method = context7 && frame.method === "GET" ? "GET" : "POST";
			const request: BackendRequest = { method, headers: requestHeaders, redirect: "error", signal: operation.abort.signal };
			if (method === "POST") request.body = body;
			const response = await backend.fetch(context7 ? COLLABORATION_CONTEXT7_ROUTE : HTTP_ROUTE, request);
			if (context7 && (response.redirected || (response.status >= 300 && response.status < 400) || response.headers.has("set-cookie"))) {
				await response.body?.cancel(); throw new Error(FAILURE);
			}
			if (active.get(frame.id) !== operation) { await response.body?.cancel(); return; }
			if (context7 && response.ok && method === "POST") {
				const message = readCollaborationJson(body.toString("utf8"));
				if (Value.Check(Type.Object({ method: Type.Literal("initialize") }, { additionalProperties: true }), message)) {
					const issued = response.headers.get("mcp-session-id");
					if (issued && (issued.length > 256 || /[\r\n]/u.test(issued))) { await response.body?.cancel(); throw new Error(FAILURE); }
					context7SessionId = issued ?? undefined;
				}
			}
			operation.reader = response.body?.getReader();
			channel.send({ id: frame.id, kind: "headers", status: response.status, statusText: response.statusText, headers: [...response.headers] });
			if (!operation.reader) { channel.send({ id: frame.id, kind: "end" }); finish(frame.id); }
		} else if (frame.kind === "websocket") {
			if (frame.url !== WS_ROUTE) throw new Error(FAILURE);
			const requestHeaders = headers(frame.headers);
			active.set(frame.id, operation);
			const ws = new backend.WebSocket(WS_ROUTE, { headers: Object.fromEntries(requestHeaders) });
			operation.ws = ws; ws.binaryType = "arraybuffer";
			ws.addEventListener("open", () => {
				try { channel.send({ id: frame.id, kind: "open", protocol: ws.protocol ?? "", extensions: ws.extensions ?? "" }); } catch { finish(frame.id); }
			});
			ws.addEventListener("message", (event) => {
				try {
					if (!Value.Check(Type.String(), event.data) || Buffer.byteLength(event.data) > MAX_BODY) throw new Error(FAILURE);
					operation.bytes += Buffer.byteLength(event.data);
					if (operation.bytes > 64 * 1024 * 1024) throw new Error(FAILURE);
					channel.send({ id: frame.id, kind: "message", body: event.data });
				} catch { channel.close(); }
			});
			ws.addEventListener("error", () => { try { channel.send({ id: frame.id, kind: "error" }); } catch {} finish(frame.id); });
			ws.addEventListener("close", (event) => {
				if (!active.has(frame.id)) return;
				try { channel.send({ id: frame.id, kind: "closed", code: event.code, reason: "", wasClean: event.wasClean }); } catch {}
				finish(frame.id);
			});
		} else throw new Error(FAILURE);
	}
	return { close: () => channel.close() };
}

/** Runs only in the confined native worker. The socket is never inherited by tools. */
export function createCollaborationProviderClient(fd: number): ProviderClient {
	const socket = new Socket({ fd, readable: true, writable: true });
	const receivers = new Map<number, (frame: Frame) => void>();
	let sequence = 0, ended = false;
	const id = () => { if (ended || receivers.size >= MAX_ACTIVE || sequence >= Number.MAX_SAFE_INTEGER) throw new Error(FAILURE); return ++sequence; };
	const channel = new Channel(socket, (frame) => receivers.get(frame.id)?.(frame), () => {
		ended = true; for (const [key, receive] of receivers) receive({ id: key, kind: "error" }); receivers.clear();
	});
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		if (request.signal.aborted) throw new Error(FAILURE);
		if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) throw new Error(FAILURE);
		const body = request.body ? await readBoundedBody(request.body) : Buffer.alloc(0);
		const key = id();
		return new Promise<Response>((resolve, reject) => {
			let controller: ReadableStreamDefaultController<Uint8Array> | undefined, resolved = false;
			const cleanup = () => { receivers.delete(key); request.signal.removeEventListener("abort", abort); };
			const abort = () => {
				try { channel.send({ id: key, kind: "abort" }); } catch {}
				cleanup(); const error = new Error(FAILURE); if (resolved) controller?.error(error); else reject(error);
			};
			const stream = new ReadableStream<Uint8Array>({
				start(value) { controller = value; },
				pull() { if (resolved && receivers.has(key)) channel.send({ id: key, kind: "pull" }); },
				cancel() { abort(); },
			}, { highWaterMark: 0 });
			receivers.set(key, (frame) => {
				if (frame.kind === "headers") {
					resolved = true;
					try { resolve(new Response(stream, { status: Number(frame.status), statusText: String(frame.statusText), headers: headers(frame.headers, false) })); } catch { abort(); }
				} else if (frame.kind === "chunk") controller?.enqueue(decode(frame.body));
				else if (frame.kind === "end") { cleanup(); controller?.close(); }
				else { cleanup(); const error = new Error(FAILURE); if (resolved) controller?.error(error); else reject(error); }
			});
			request.signal.addEventListener("abort", abort, { once: true });
			try {
				channel.send({ id: key, kind: "fetch", url: request.url, method: request.method, headers: [...request.headers], body: body.toString("base64") });
				if (request.signal.aborted) abort();
			} catch { abort(); }
		});
	};
	class RelayWebSocket extends EventTarget {
		static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
		readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
		readyState = 0; binaryType = "blob"; bufferedAmount = 0; protocol = ""; extensions = "";
		readonly url: string;
		private key: number;
		constructor(url: string | URL, options: CollaborationWebSocketOptions = {}) {
			super(); this.url = String(url); this.key = id();
			if (!Value.Check(websocketOptionsSchema, options)) throw new Error(FAILURE);
			receivers.set(this.key, (frame) => {
				if (frame.kind === "open") { this.readyState = 1; this.protocol = String(frame.protocol); this.extensions = String(frame.extensions); this.dispatchEvent(new Event("open")); }
				else if (frame.kind === "message") this.dispatchEvent(new MessageEvent("message", { data: frame.body }));
				else {
					this.readyState = 3; receivers.delete(this.key);
					if (frame.kind === "error") this.dispatchEvent(new Event("error"));
					const event = new Event("close");
					Object.assign(event, { code: frame.kind === "closed" ? frame.code : 1006, reason: "", wasClean: frame.kind === "closed" && frame.wasClean === true });
					this.dispatchEvent(event);
				}
			});
			try { channel.send({ id: this.key, kind: "websocket", url: this.url, headers: [...new Headers(options.headers)] }); } catch { receivers.delete(this.key); throw new Error(FAILURE); }
		}
		send(value: string): void {
			if (this.readyState !== 1 || !Value.Check(Type.String(), value) || Buffer.byteLength(value) > MAX_BODY) throw new Error(FAILURE);
			channel.send({ id: this.key, kind: "send", body: value });
		}
		close(code = 1000, reason = ""): void {
			if (this.readyState === 3) return;
			this.readyState = 2;
			channel.send({ id: this.key, kind: "close", code, reason });
		}
	}
	const readCredential = (modelId: string, signal?: AbortSignal): Promise<CollaborationOAuthCredential> => {
		const key = id();
		return new Promise((resolve, reject) => {
			const cleanup = () => { receivers.delete(key); signal?.removeEventListener("abort", abort); };
			const abort = () => { cleanup(); reject(new Error(FAILURE)); };
			receivers.set(key, (frame) => {
				cleanup();
				if (frame.kind !== "credential" || !frame.credential) reject(new Error(FAILURE));
				else resolve(frame.credential);
			});
			signal?.addEventListener("abort", abort, { once: true });
			try { if (signal?.aborted) abort(); else channel.send({ id: key, kind: "credential", provider: "openai-codex", modelId }); }
			catch { abort(); }
		});
	};
	return { fetch, WebSocket: RelayWebSocket, readCredential, close: () => channel.close() };
}
async function readBoundedBody(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
	const reader = stream.getReader(), chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const result = await reader.read(); if (result.done) return Buffer.concat(chunks);
			bytes += result.value.length; if (bytes > MAX_BODY) throw new Error(FAILURE);
			chunks.push(result.value);
		}
	} catch { await reader.cancel().catch(() => {}); throw new Error(FAILURE); }
	finally { reader.releaseLock(); }
}
