import assert from "node:assert/strict";
import { it } from "node:test";
import type { ChildSessionEvent, ChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { makeAgent } from "../support/helpers.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectSubagentStatus } from "../../src/runs/background/run-status.ts";
import { createToolErrorWatch } from "../../src/runs/shared/tool-error-watch.ts";
import { buildControlEvent, claimControlNotification, resolveControlConfig } from "../../src/runs/shared/subagent-control.ts";

it("claims independent identical failures but not duplicate publications", () => {
 const seen = new Set<string>();
 const config = resolveControlConfig();
 const event = (toolCallId: string) => buildControlEvent({ to: "needs_attention", reason: "tool_error_stall", runId: "run", agent: "worker", index: 0, currentTool: "exec", toolCallId, recentFailureSummary: "denied" });
 assert.equal(claimControlNotification(config, event("a"), seen), true);
 assert.equal(claimControlNotification(config, event("a"), seen), false);
 assert.equal(claimControlNotification(config, event("b"), seen), true);
});

it("correlates overlapping calls without sibling completion recovering a failure", () => {
 for (const order of ["sibling-first", "failure-first"]) {
  const watch = createToolErrorWatch();
  watch.observe({ type: "tool_execution_start", toolName: "exec", toolCallId: "a" }, 1, "/a");
  watch.observe({ type: "tool_execution_start", toolName: "exec", toolCallId: "b" }, 2, "/b");
  const failed = { type: "tool_execution_end", toolName: "exec", toolCallId: "a", isError: true };
  const sibling = { type: "tool_execution_end", toolName: "exec", toolCallId: "b", isError: false };
  if (order === "sibling-first") { watch.observe(sibling, 3); watch.observe(failed, 4); }
  else { watch.observe(failed, 3); watch.observe(sibling, 4); }
  const failure = watch.due(60_005, 60_000);
  assert.equal(failure?.toolCallId, "a");
  assert.equal(failure?.path, "/a");
  watch.observe({ type: "tool_result_end", message: { role: "toolResult", toolName: "exec", toolCallId: "a", isError: true, content: [{ type: "text", text: "denied" }] } }, 60_006);
  assert.equal(watch.due(60_006, 60_000)?.failedAt, order === "sibling-first" ? 4 : 3);
  watch.observe({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "recover" }] } }, 60_007);
  watch.observe(failed, 60_008);
  assert.equal(watch.due(200_000, 60_000), undefined);
 }
});

it("does not arm invocation-specific attention from unidentified events", () => {
 const watch = createToolErrorWatch();
 watch.observe({ type: "tool_execution_start", toolName: "exec" }, 1, "/a");
 watch.observe({ type: "tool_execution_end", toolName: "exec", isError: true }, 2);
 watch.observe({ type: "tool_result_end", message: { role: "toolResult", toolName: "exec", isError: true, content: [{ type: "text", text: "denied" }] } }, 3);
 assert.equal(watch.due(100_000, 60_000), undefined);
});

it("ignores unidentified results without corrupting a known call", () => {
 const watch = createToolErrorWatch();
 watch.observe({ type: "tool_execution_start", toolName: "exec", toolCallId: "b" }, 1, "/b");
 watch.observe({ type: "tool_result_end", message: { role: "toolResult", toolName: "exec", isError: true } }, 2);
 assert.equal(watch.due(100_000, 60_000), undefined);
 watch.observe({ type: "tool_execution_end", toolName: "exec", toolCallId: "b", isError: true }, 3);
 assert.equal(watch.due(60_004, 60_000)?.failureId, "id:b");
 assert.equal(watch.due(60_004, 60_000)?.path, "/b");
});

it("does not assign a late A result to a newly started same-tool B", () => {
 const watch = createToolErrorWatch();
 watch.observe({ type: "tool_execution_start", toolName: "exec", toolCallId: "a" }, 1, "/a");
 watch.observe({ type: "tool_execution_end", toolName: "exec", toolCallId: "a", isError: true }, 2);
 const result = { type: "tool_result_end", message: { role: "toolResult", toolName: "exec", toolCallId: "a", isError: true, content: [{ type: "text", text: "denied" }] } };
 watch.observe(result, 3);
 watch.observe({ type: "tool_execution_start", toolName: "exec", toolCallId: "b" }, 4, "/b");
 watch.observe(result, 5);
 assert.equal(watch.due(100_000, 60_000), undefined);
 watch.observe({ type: "tool_execution_end", toolName: "exec", toolCallId: "b", isError: true }, 6);
 assert.equal(watch.due(60_007, 60_000)?.failureId, "id:b");
});

it("disarms pending failed-tool attention on compaction and agent settlement", () => {
 for (const terminal of ["compaction_start", "agent_settled"]) {
  const watch = createToolErrorWatch();
  watch.observe({ type: "tool_execution_start", toolName: "exec", toolCallId: "a" }, 1);
  watch.observe({ type: "tool_execution_end", toolName: "exec", toolCallId: "a", isError: true }, 2);
  assert.equal(watch.observe({ type: terminal }, 3), true);
  watch.observe({ type: "tool_result_end", message: { role: "toolResult", toolName: "exec", toolCallId: "a", isError: true } }, 4);
  assert.equal(watch.due(100_000, 60_000), undefined);
 }
});

it("tracks structured failure in either completion order, but never treats result delivery as recovery", () => {
 for (const order of ["result-first", "core-end-first"]) {
  const watch = createToolErrorWatch();
  const start = { type: "tool_execution_start", toolName: "exec", toolCallId: "a" };
  const end = { type: "tool_execution_end", toolName: "exec", toolCallId: "a", isError: true };
  const result = { type: "message_end", message: { role: "toolResult", toolName: "exec", toolCallId: "a", isError: true, content: [{ type: "text", text: "access denied" }] } };
  watch.observe(start, 1, "/tmp/file");
  if (order === "result-first") { watch.observe({ ...result, type: "tool_result_end" }, 2); watch.observe(end, 3); }
  else { watch.observe(end, 2); watch.observe({ ...result, type: "message_start" }, 3); watch.observe(result, 4); }
  assert.equal(watch.due(60_001, 60_000), undefined);
  assert.deepEqual(watch.due(60_004, 60_000), { tool: "exec", toolCallId: "a", failureId: "id:a", path: "/tmp/file", failedAt: 2, summary: "access denied" });
  watch.observe(result, 61_000); // duplicate delivery cannot extend the grace
  assert.equal(watch.due(61_000, 60_000)?.failedAt, 2);
  watch.observe({ type: "message_start", message: { role: "assistant", content: [] } }, 61_001);
  assert.equal(watch.due(61_001, 60_000)?.toolCallId, "a", "empty pending assistant start is not recovery");
  watch.observe({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: "Investigating" } }, 61_002);
  watch.observe(result, 61_002); // late duplicate cannot rearm
  assert.equal(watch.due(200_000, 60_000), undefined);
 }
});

it("clears on new tool start, success, and terminal cleanup without rearming old failures", () => {
 const watch = createToolErrorWatch();
 for (let i = 0; i < 3; i++) {
  watch.observe({ type: "tool_execution_start", toolName: "exec", toolCallId: String(i) }, i * 70_000);
  watch.observe({ type: "tool_execution_end", toolName: "exec", toolCallId: String(i), isError: true }, i * 70_000 + 1);
  assert.ok(watch.due(i * 70_000 + 60_001, 60_000));
  watch.observe({ type: "tool_execution_start", toolName: "read", toolCallId: `ok-${i}` }, i * 70_000 + 60_002);
  watch.observe({ type: "tool_execution_end", toolName: "read", toolCallId: `ok-${i}`, isError: false }, i * 70_000 + 60_003);
  assert.equal(watch.due(i * 70_000 + 65_000, 60_000), undefined);
 }
 watch.clear();
 assert.equal(watch.due(999_999, 60_000), undefined);
});

it("targeted status preserves bounded child attention and exact workflow identity", () => {
 const root = mkdtempSync(join(tmpdir(), "tool-error-status-"));
 try {
  const run = join(root, "async", "run-1");
  mkdirSync(run, { recursive: true });
  const attention = { type: "needs_attention", to: "needs_attention", ts: 61_000, runId: "child-1",
   agent: "worker", index: 0, message: "tool failed", reason: "tool_error_stall",
   currentTool: "exec", toolCallId: "call-1", failureId: "id:call-1", recentFailureSummary: "denied" };
  writeFileSync(join(run, "status.json"), JSON.stringify({ runId: "run-1", state: "running", mode: "workflow",
   startedAt: 1, lastUpdate: 61_000, steps: [{ agent: "worker", workflowKey: "write", runId: "child-1",
    status: "running", activityState: "needs_attention", attention }, ...Array.from({ length: 69 }, (_, index) => ({ agent: "worker", runId: `child-${index + 2}`, status: "running", ...(index === 68 ? { attention: { ...attention, index: 69, runId: "child-70", failureId: "id:last" } } : {}) }))] }));
  const inspected = inspectSubagentStatus({ id: "run-1" }, { asyncDirRoot: join(root, "async"), resultsDir: join(root, "results") });
  assert.equal(inspected.details?.statusSteps?.[0]?.attention?.reason, "tool_error_stall");
  assert.equal(inspected.details?.statusSteps?.[0]?.childId, "write");
  assert.equal(inspected.details?.controlEvents?.[0]?.toolCallId, "call-1");
  assert.equal(inspected.details?.controlEvents?.[0]?.failureId, "id:call-1");
  assert.equal(inspected.details?.statusSteps?.length, 64);
  assert.equal(inspected.details?.statusSteps?.at(-1)?.index, 69);
  assert.equal(inspected.details?.controlEvents?.length, 2);
  assert.equal(inspected.details?.controlEvents?.at(-1)?.failureId, "id:last");
  assert.match(inspected.content[0]?.text ?? "", /Attention: .*tool_error_stall/);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

it("reports a structured exec failure followed by silence without aborting the child", async (t) => {
 t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 0 });
 let send: (event: ChildSessionEvent) => void = () => {};
 let finish: () => void = () => {};
 let aborts = 0;
 let ready: () => void = () => {};
 const started = new Promise<void>((resolve) => { ready = resolve; });
 const factory: ChildSessionFactory = { async create() { return {
  subscribe(listener) { send = listener; return () => { send = () => {}; }; },
  prompt() { ready(); return new Promise<void>((resolve) => { finish = resolve; }); },
  async abort() { aborts++; }, async dispose() {}, async steer() {}, async followUp() {},
  messages: [], sessionId: "scripted", modelId: undefined,
 }; }, async dispose() {} };
 const events: Array<{ reason?: string; runId: string; currentTool?: string; toolCallId?: string; recentFailureSummary?: string }> = [];
 const run = runSync(process.cwd(), [makeAgent("worker")], "worker", "Recover", {
  childSessionFactory: factory, onUpdate: (update) => { events.push(...(update.details?.controlEvents ?? [])); },
 });
 await started;
 send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Considering next step" }] } });
 t.mock.timers.tick(61_000);
 assert.equal(events.filter((event) => event.reason === "idle").length, 1, "prior generic attention is independent");
 send({ type: "tool_execution_start", toolName: "exec", toolCallId: "call-1", args: { cmd: "false" } });
 send({ type: "tool_result_end", toolName: "exec", toolCallId: "call-1", message: { role: "toolResult", toolName: "exec", toolCallId: "call-1", isError: true, content: [{ type: "text", text: "permission denied" }] } });
 send({ type: "tool_execution_end", toolName: "exec", toolCallId: "call-1", isError: true });
 send({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });
 t.mock.timers.tick(61_000);
 assert.equal(aborts, 0);
 assert.equal(events.filter((event) => event.reason === "tool_error_stall").length, 1);
 assert.equal(events.find((event) => event.reason === "tool_error_stall")?.toolCallId, "call-1");
 finish();
 await run;
 const prior = new Set(events.filter((event) => event.reason === "tool_error_stall")
  .map((event) => JSON.stringify(event)));
 t.mock.timers.tick(180_000);
 assert.deepEqual(new Set(events.filter((event) => event.reason === "tool_error_stall")
  .map((event) => JSON.stringify(event))), prior, "terminal disposal must not publish new attention");
});

it("accepted foreground detach disarms failed-tool attention without aborting the child", async (t) => {
 t.mock.timers.enable({ apis: ["Date","setInterval","setTimeout"], now: 0 });
 let emit: (event: ChildSessionEvent) => void = () => {};
 let finish: () => void = () => {};
 let detach: (reason?: string) => boolean = () => false;
 let ready: () => void = () => {};
 const started = new Promise<void>((resolve) => { ready = resolve; });
 const factory: ChildSessionFactory = { async create() { return {
  subscribe(listener) { emit = listener; return () => { emit = () => {}; }; },
  prompt() { ready(); return new Promise<void>((resolve) => { finish = resolve; }); },
  async abort() { assert.fail("detaching does not abort"); }, async dispose() {}, async steer() {}, async followUp() {},
  messages: [], sessionId: "detach", modelId: undefined,
 }; }, async dispose() {} };
 const events: Array<{ reason?: string }> = [];
 const running = runSync(process.cwd(), [makeAgent("worker")], "worker", "Recover", {
  childSessionFactory: factory, onDetachReady: (value) => { detach = value; },
  onDetachReceipt: () => true,
  onUpdate: (value) => events.push(...(value.details?.controlEvents ?? [])),
 });
 await started;
 emit({ type: "tool_execution_start", toolName: "exec", toolCallId: "call-1", args: {} });
 emit({ type: "tool_execution_end", toolName: "exec", toolCallId: "call-1", isError: true });
 assert.equal(detach(), true);
 t.mock.timers.tick(120_000);
 assert.equal(events.some((event) => event.reason === "tool_error_stall"), false);
 finish();
 await running;
});

it("treats an unidentified new start as recovery without rearming an old call", () => {
 const watch = createToolErrorWatch();
 watch.observe({ type: "tool_execution_start", toolName: "exec", toolCallId: "a" }, 1);
 watch.observe({ type: "tool_execution_end", toolName: "exec", toolCallId: "a", isError: false }, 2);
 watch.observe({ type: "tool_execution_start", toolName: "read" }, 3);
 watch.observe({ type: "tool_result_end", message: { role: "toolResult", toolName: "exec", toolCallId: "a", isError: true } }, 4);
 assert.equal(watch.due(100_000, 60_000), undefined);
});
