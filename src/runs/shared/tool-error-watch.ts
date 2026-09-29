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
	path?: string;
	failedAt: number;
	summary: string;
}

/** A completion pair is one observation, not two failures or evidence of recovery. */
export function createToolErrorWatch() {
	let current: { tool: string; id?: string; path?: string } | undefined;
	let eligible = true;
	let failure: FailedToolCall | undefined;
	return {
		observe(event: ToolEvent, now: number, path?: string): void {
			if (event.type === "tool_execution_start") {
				failure = undefined;
				eligible = true;
				current = { tool: typeof event.toolName === "string" ? event.toolName : "tool", id: typeof event.toolCallId === "string" ? event.toolCallId : undefined, path };
				return;
			}
			if (isAssistantProgress(event)) {
				failure = undefined;
				eligible = false;
				return;
			}
			const message = event.message as { role?: string; toolCallId?: string; toolName?: string; isError?: boolean; content?: Array<{ type?: string; text?: string }> } | undefined;
			const result = event.type === "tool_result_end" || ((event.type === "message_end" || event.type === "message_start") && message?.role === "toolResult");
			if (event.type !== "tool_execution_end" && !result) return;
			const id = message?.toolCallId ?? (typeof event.toolCallId === "string" ? event.toolCallId : undefined);
			if (!eligible || (current?.id && id && current.id !== id)) return;
			const tool = message?.toolName ?? (typeof event.toolName === "string" ? event.toolName : undefined) ?? current?.tool ?? "tool";
			if (event.isError !== true && message?.isError !== true) return;
			const text = message?.content?.find((part) => part.type === "text" && part.text?.trim())?.text?.trim();
			if (!failure) failure = { tool, ...(id ? { toolCallId: id } : {}), ...(current?.path ? { path: current.path } : {}), failedAt: now, summary: (text || "Tool execution failed").slice(0, 180) };
			else if (text && failure.summary === "Tool execution failed") failure.summary = text.slice(0, 180);
		},
		due(now: number, graceMs: number): FailedToolCall | undefined {
			return failure && now - failure.failedAt >= graceMs ? failure : undefined;
		},
		clear(): void { failure = undefined; eligible = false; current = undefined; },
	};
}
