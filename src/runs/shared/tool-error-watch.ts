type ToolEvent = { type?: string; toolName?: unknown; toolCallId?: unknown; isError?: unknown; message?: unknown; assistantMessageEvent?: unknown };

/** A pending empty assistant stream is initialization, not model continuation. */
export function isAssistantProgress(event: ToolEvent): boolean {
	if (!["message_start", "message_update", "message_end"].includes(event.type ?? "")) return false;
	const message = event.message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
	if (message?.role !== "assistant") return false;
	if (message.content?.some((part) => part.type === "toolCall" || (typeof part.text === "string" && part.text.length > 0))) return true;
	const delta = event.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
	return event.type === "message_update" && typeof delta?.delta === "string" && delta.delta.length > 0;
}

export interface FailedToolCall {
	tool: string;
	toolCallId?: string;
	failureId: string;
	path?: string;
	failedAt: number;
	summary: string;
}

/** A completion pair is one observation, not two failures or evidence of recovery. */
export function createToolErrorWatch() {
	type Call = { tool: string; id: string; path?: string; failureId: string; failed?: boolean };
	const active = new Map<string, Call>();
	const completed = new Map<string, Call>();
	let failure: FailedToolCall | undefined;
	return {
		/** True only for a new call or substantive assistant continuation. */
		observe(event: ToolEvent, now: number, path?: string): boolean {
			if (event.type === "compaction_start" || event.type === "agent_settled") {
				const hadFailure = !!failure;
				failure = undefined;
				active.clear();
				completed.clear();
				return hadFailure;
			}
			if (event.type === "tool_execution_start") {
				const id = typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : undefined;
				if (!id) {
					failure = undefined;
					for (const call of completed.values()) call.failed = true;
					return true;
				}
				const key = "id:" + id;
				if (active.has(key) || completed.has(key)) return false;
				failure = undefined;
				for (const call of completed.values()) call.failed = true;
				const call = { tool: typeof event.toolName === "string" ? event.toolName : "tool", id, path, failureId: key };
				active.set(key, call);
				if (active.size > 128) active.delete(active.keys().next().value!);
				return true;
			}
			if (isAssistantProgress(event)) {
				failure = undefined;
				for (const call of completed.values()) call.failed = true;
				return true;
			}
			const message = event.message as { role?: string; toolCallId?: string; toolName?: string; isError?: boolean; content?: Array<{ type?: string; text?: string }> } | undefined;
			const result = event.type === "tool_result_end" || ((event.type === "message_end" || event.type === "message_start") && message?.role === "toolResult");
			if (event.type !== "tool_execution_end" && !result) return false;
			const id = (typeof message?.toolCallId === "string" && message.toolCallId) || (typeof event.toolCallId === "string" && event.toolCallId);
			if (!id) return false;
			const key = "id:" + id;
			const call = active.get(key) ?? completed.get(key);
			if (!call) return false;
			if (active.has(key)) {
				active.delete(key);
				completed.set(key, call);
				if (completed.size > 64) completed.delete(completed.keys().next().value!);
			}
			if (event.isError !== true && message?.isError !== true) return false;
			const text = message?.content?.find((part) => part.type === "text" && part.text?.trim())?.text?.trim();
			if (!call.failed && !failure) {
				call.failed = true;
				failure = { tool: call.tool, failureId: call.failureId, ...(call.id ? { toolCallId: call.id } : {}), ...(call.path ? { path: call.path } : {}), failedAt: now, summary: (text || "Tool execution failed").slice(0, 180) };
			} else if (failure?.failureId === call.failureId && text && failure.summary === "Tool execution failed") failure.summary = text.slice(0, 180);
			return false;
		},
		due(now: number, graceMs: number): FailedToolCall | undefined {
			return failure && now - failure.failedAt >= graceMs ? failure : undefined;
		},
		clear(): void { failure = undefined; active.clear(); completed.clear(); },
	};
}
