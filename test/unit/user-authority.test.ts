import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, it } from "node:test";
import { createNativeSupervisorChannel, registerNativeSupervisorClient, resolveSupervisorChannelDir, ensureSupervisorChannelDir, USER_ATTENTION_EVENT } from "../../src/intercom/native-supervisor-channel.ts";
import { HerdrPiSession } from "../../src/runs/shared/herdr-placed-run.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });

function host(owner = randomUUID(), entries: any[] = [], upstreamSupervisor?: any) {
	const handlers = new Map<string, Function>();
	const tools = new Map<string, any>();
	const events: any[] = [];
	const notices: any[] = [];
	const ctx = { sessionManager: { getSessionId: () => owner, getBranch: () => entries, getEntries: () => entries } };
	const pi: any = {
		on(name: string, fn: Function) { handlers.set(name, fn); return () => handlers.delete(name); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", id: randomUUID(), customType, data }); },
		events: { emit(name: string, data: unknown) { if (name === USER_ATTENTION_EVENT) events.push(data); } },
		getAllTools: () => [...tools.keys()].map(name => ({ name })),
		registerTool(tool: any) { tools.set(tool.name, tool); },
		sendMessage(message: unknown, options: unknown) { notices.push({ message, options }); },
	};
	const dirs: string[] = [];
	const state: any = { currentSessionId: owner, supervisorOwnerSessionId: owner, lastUiContext: ctx, asyncJobs: new Map(), foregroundControls: new Map() };
	const channel = createNativeSupervisorChannel(pi, state, { getChannelDirs: () => ({ dirs }), upstreamSupervisor });
	channel.start();
	cleanups.push(() => channel.dispose());
	return { pi, ctx, owner, channel, entries, events, notices, dirs, state,
		input(source = "interactive", context = ctx) { handlers.get("input")?.({ source, text: "Yes" }, context); },
		call(params: any, context = ctx) { return tools.get("subagent_supervisor").execute("t", params, undefined, undefined, context); },
	};
}

function child(parent: ReturnType<typeof host>, params: any, mode = "foreground") {
	const runId = randomUUID(), agent = "worker", channelDir = resolveSupervisorChannelDir(runId, agent, 0);
	parent.dirs.push(channelDir);
	cleanups.push(() => fs.rmSync(channelDir, { force: true, recursive: true }));
	if (mode === "background") parent.state.asyncJobs.set(runId, { status: "running" });
	let tool: any;
	registerNativeSupervisorClient({ registerTool(t: any) { tool = t; }, getAllTools: () => [] } as never, { channelDir, runId, agent, childIndex: 0, orchestratorSessionId: parent.owner });
	const abort = new AbortController();
	cleanups.push(() => abort.abort());
	const result = tool.execute("ask", params, abort.signal);
	// Observe rejections even when a cancellation test does not consume the tool result.
	result.catch(() => {});
	parent.channel.activateTransport();
	const [request] = parent.channel.pending.values();
	return { result, abort, request, channelDir, runId };
}

for (const mode of ["foreground", "background"]) {
	it(`preserves explicit supervisor authority through ${mode} and allows autonomous replies`, async () => {
		const h = host();
		const c = child(h, { reason: "need_decision", authority: "supervisor", message: "Reuse helper?" }, mode);
		assert.equal(c.request?.authority, "supervisor");
		assert.equal(h.notices[0].options.triggerTurn, true);
		assert.deepEqual(h.events, []);
		await h.call({ action: "reply", replyTo: c.request!.id, message: "Reuse it" });
		assert.equal((await c.result).details.authority, "supervisor");
	});
	for (const authority of ["user", undefined]) {
		it(`${mode}: ${authority ?? "missing"} authority requires genuine post-boundary input, including on reload`, async () => {
			const h = host();
			h.input(); // Older genuine input must not count.
			const c = child(h, { reason: "need_decision", ...(authority ? { authority } : {}), message: "Preserve API?" }, mode);
			assert.equal(c.request?.authority, "user");
			assert.equal(c.request?.authorityImplicit, authority ? undefined : true);
			assert.equal(h.notices[0].options.triggerTurn, true);
			const reply = { action: "reply", replyTo: c.request!.id, message: "Preserve it" };
			await assert.rejects(h.call(reply), /USER_AUTHORITY_REQUIRED/);
			h.input("extension"); h.input("rpc");
			const foreignContext = { sessionManager: { ...h.ctx.sessionManager, getSessionId: () => "other-session" } };
			h.input("interactive", foreignContext);
			h.entries.push({ type: "message", message: { role: "user", content: "Synthetic" } });
			h.pi.sendMessage({ customType: "another-child" }, { triggerTurn: true });
			await assert.rejects(h.call(reply), /USER_AUTHORITY_REQUIRED/);
			for (let i = 0; i < 3; i++) h.channel.activateTransport();
			assert.equal(h.events.filter(e => e.active).length, 1);
			assert.equal(h.notices.filter(n => n.message.details?.requestId === c.request!.id).length, 1);
			h.input();
			await assert.rejects(h.call(reply, foreignContext), /USER_AUTHORITY_REQUIRED/);
			// New extension runtime, same persisted branch. No wall-clock proof.
			h.channel.dispose();
			const restored = host(h.owner, JSON.parse(JSON.stringify(h.entries)));
			restored.dirs.push(c.channelDir); restored.channel.activateTransport();
			await restored.call(reply);
			assert.equal((await c.result).details.replyMessage, "Preserve it");
			assert.deepEqual(restored.events.map(e => e.active), [true, false]);
			assert.ok(restored.events.every(e => !('message' in e) && e.sessionId === h.owner));
		});
	}
}

it("root wake instructs evidence-backed explanation, a direct question, and stopping without duplicate attention", async () => {
	const h = host();
	const c = child(h, { reason: "need_decision", authority: "user", message: "Keep the API to preserve callers, or remove it to reduce maintenance?" });
	const content = h.notices[0].message.content;
	assert.match(content, /Explain the decision, available options, and consequences using the available evidence/);
	assert.match(content, /Do not invent missing options or an answer/);
	assert.match(content, /Ask the user directly in ordinary text, then stop and wait for genuine new user input/);
	assert.match(content, /Do not reply to the child or resume its work before that input/);
	assert.match(content, /Attention is already registered\. Do not call request_user_attention or register duplicate attention/);
	assert.ok(content.includes(c.request!.message));
	assert.ok(content.includes(c.request!.id));
	await assert.rejects(h.call({ action: "reply", replyTo: c.request!.id, message: "Remove it" }), /USER_AUTHORITY_REQUIRED/);
	assert.equal(fs.existsSync(path.join(c.channelDir, "replies", `${c.request!.id}.json`)), false);
});

it("root structured interview wakes once and preserves the shape and genuine user reply", async () => {
	const h = host();
	const interview = { title: "API compatibility", questions: [{ id: "api", prompt: "Keep the API?", options: ["Keep", "Remove"] }] };
	const c = child(h, { reason: "interview_request", interview, message: "Keep preserves callers; removal reduces maintenance." });
	assert.equal(h.notices[0].options.triggerTurn, true);
	assert.deepEqual(h.notices[0].message.details.interview, interview);
	assert.ok(h.notices[0].message.content.includes(JSON.stringify(interview, null, "\t")));
	assert.match(h.notices[0].message.content, /Reply with JSON/);
	for (let i = 0; i < 3; i++) h.channel.activateTransport();
	assert.equal(h.notices.length, 1);
	assert.equal(h.events.filter(e => e.active).length, 1);
	const reply = { action: "reply", replyTo: c.request!.id, message: JSON.stringify({ api: "Keep" }) };
	await assert.rejects(h.call(reply), /USER_AUTHORITY_REQUIRED/);
	h.input();
	await h.call(reply);
	assert.deepEqual((await c.result).details.structuredReply, { api: "Keep" });
	assert.deepEqual(h.events.map(e => e.active), [true, false]);
	assert.equal(h.channel.pending.size, 0);
});

it("progress stays nonblocking without authority, notice, or attention", async () => {
	const h = host(); const c = child(h, { reason: "progress_update", message: "Evidence found" });
	assert.equal((await c.result).details.delivered, true);
	assert.equal(h.channel.pending.size, 0); assert.deepEqual(h.events, []); assert.deepEqual(h.notices, []);
});

for (const ending of ["cancel", "expire", "inactive"]) {
	it(`${ending} clears exactly one user attention record`, async () => {
		const h = host(); const c = child(h, { reason: "interview_request", interview: {} }, "background");
		assert.equal(c.request?.authority, "user");
		if (ending === "cancel") { c.abort.abort(); await assert.rejects(c.result, /cancelled/); }
		if (ending === "expire") c.request!.expiresAt = Date.now() - 1;
		if (ending === "inactive") h.state.asyncJobs.get(c.runId).status = "complete";
		h.channel.activateTransport(); h.channel.activateTransport();
		assert.deepEqual(h.events.map(e => e.active), [true, false]);
	});
}

for (const reason of ["need_decision", "interview_request"]) {
	it(`nested ${reason} relays without an intermediate wake and wakes the root without granting reply authority`, async () => {
		const root = host(), runId = randomUUID(), agent = "coordinator", channelDir = resolveSupervisorChannelDir(runId, agent, 0);
		root.dirs.push(channelDir); cleanups.push(() => fs.rmSync(channelDir, { recursive: true, force: true }));
		const coordinator = host(randomUUID(), [], { channelDir, runId, agent, childIndex: 0, orchestratorSessionId: root.owner });
		const interview = reason === "interview_request" ? { questions: [{ id: "api", prompt: "Preserve API?", options: ["Keep", "Remove"] }] } : undefined;
		const leaf = child(coordinator, { reason, authority: "user", message: "Preserve API?", ...(interview ? { interview } : {}) });
		assert.equal(coordinator.notices[0].options.triggerTurn, false);
		await assert.rejects(coordinator.call({ action: "reply", replyTo: leaf.request!.id, message: "Invented yes" }), /USER_AUTHORITY_REQUIRED/);
		coordinator.input("extension");
		await assert.rejects(coordinator.call({ action: "reply", replyTo: leaf.request!.id, message: "Still invented" }), /USER_AUTHORITY_REQUIRED/);
		root.channel.activateTransport();
		const [upstream] = root.channel.pending.values();
		assert.equal(upstream?.authority, "user"); assert.equal(upstream?.agent, "coordinator");
		assert.equal(root.notices[0].options.triggerTurn, true);
		assert.deepEqual(root.notices[0].message.details.interview, interview);
		assert.match(root.notices[0].message.content, /Ask the user directly in ordinary text, then stop/);
		for (let i = 0; i < 3; i++) { coordinator.channel.activateTransport(); root.channel.activateTransport(); }
		assert.equal(coordinator.notices.length, 1);
		assert.equal(root.notices.length, 1);
		await assert.rejects(root.call({ action: "reply", replyTo: upstream!.id, message: "Invented" }), /USER_AUTHORITY_REQUIRED/);
		assert.equal(root.events.filter(e => e.active).length, 1);
		const message = interview ? JSON.stringify({ api: "Keep" }) : "Keep API";
		root.input(); await root.call({ action: "reply", replyTo: upstream!.id, message });
		const result = await leaf.result;
		assert.equal(result.details.replyMessage, message);
		if (interview) assert.deepEqual(result.details.structuredReply, { api: "Keep" });
		assert.deepEqual(coordinator.events.map(e => e.active), [true, false]);
		assert.deepEqual(root.events.map(e => e.active), [true, false]);
	});
}

it("Herdr relay persists explicit and implicit authority and rejects authority-changing replay", async () => {
	const h = host(), runId = randomUUID(), channelDir = resolveSupervisorChannelDir(runId, "remote", 0);
	ensureSupervisorChannelDir(channelDir); h.dirs.push(channelDir); cleanups.push(() => fs.rmSync(channelDir, { recursive: true, force: true }));
	const listeners = new Set<Function>();
	const bridge: any = { listeners, close() {}, supervisorDelivered() {}, fail(e: Error) { throw e; } };
	const owner: any = { identity: { nativeSessionId: "remote-session", runId }, cleanup() {}, snapshot: {} };
	const session = new HerdrPiSession(owner, { async close() {} }, bridge, undefined, undefined, { supervisorChannelDir: channelDir, runId, agent: "remote", childIndex: 0, orchestratorSessionId: h.owner } as never);
	cleanups.push(() => { void session.dispose(); });
	for (const authority of ["supervisor", "user", undefined]) {
		const id = randomUUID();
		const frame = { type: "supervisor-request", requestId: id, reason: "need_decision", authority, message: "Question", nativeSessionId: "remote-session" };
		for (const listener of listeners) listener(frame);
		const stored = JSON.parse(fs.readFileSync(path.join(channelDir, "requests", `${id}.json`), "utf8"));
		assert.equal(stored.authority, authority ?? "user");
		for (const listener of listeners) assert.throws(() => listener({ ...frame, authority: authority === "supervisor" ? "user" : "supervisor" }), /identity changed/);
	}
	h.channel.activateTransport();
	assert.equal(h.events.filter(e => e.active).length, 2);
});
