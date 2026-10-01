type ToolEvent = { type?: string; toolName?: unknown; toolCallId?: unknown; args?: unknown; isError?: unknown; message?: unknown; assistantMessageEvent?: unknown };

export interface FailedToolCall {
	tool: string;
	toolCallId: string;
	path?: string;
	failedAt: number;
	summary: string;
}

/** Local observer only: a paired result is not a second failure or a recovery. */
export function createToolErrorWatch() {
	const calls = new Map<string, { tool: string; path?: string; failed: boolean }>();
	const failedIds = new Set<string>();
	let pending: FailedToolCall | undefined;
	return {
		observe(event: ToolEvent, now: number, path?: string): void {
			if (event.type === "agent_settled" || event.type === "compaction_start") {
				pending = undefined;
				calls.clear();
				return;
			}
			if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
				const message = event.message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
				const delta = event.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
				if (message?.role === "assistant" && (message.content?.some((part) => part.type === "toolCall" || Boolean(part.text?.trim())) || (event.type === "message_update" && typeof delta?.delta === "string" && delta.delta.trim().length > 0))) pending = undefined;
			}
			const id = event.type === "tool_result_end"
				? (event.message as { toolCallId?: unknown } | undefined)?.toolCallId ?? event.toolCallId
				: event.toolCallId;
			if (event.type === "tool_execution_start") {
				if (typeof id !== "string" || !id) pending = undefined;
				if (typeof id === "string" && id && !calls.has(id)) {
					pending = undefined;
					calls.set(id, { tool: typeof event.toolName === "string" ? event.toolName : "tool", path, failed: false });
					if (calls.size > 128) calls.delete(calls.keys().next().value!);
				}
				return;
			}
			if ((event.type !== "tool_execution_end" && event.type !== "tool_result_end") || typeof id !== "string") return;
			const call = calls.get(id);
			if (!call) return;
			const result = event.message as { role?: string; isError?: unknown; content?: Array<{ type?: string; text?: string }> } | undefined;
			const failed = event.type === "tool_execution_end" ? event.isError === true : result?.role === "toolResult" && result.isError === true;
			if (!failed) return;
			if (!call.failed && failedIds.has(id)) return;
			failedIds.add(id);
			const summary = result?.content?.find((part) => part.type === "text" && part.text?.trim())?.text?.trim().slice(0, 180);
			if (!call.failed && !pending) pending = { tool: call.tool, toolCallId: id, path: call.path, failedAt: now, summary: summary || "Tool execution failed" };
			else if (pending?.toolCallId === id && summary && pending.summary === "Tool execution failed") pending.summary = summary;
			call.failed = true;
		},
		due(now: number, graceMs: number): FailedToolCall | undefined {
			return pending && now - pending.failedAt >= graceMs ? pending : undefined;
		},
		clear(): void { calls.clear(); failedIds.clear(); pending = undefined; },
	};
}
