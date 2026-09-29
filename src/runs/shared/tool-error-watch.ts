type ToolEvent = { type?: string; toolName?: unknown; toolCallId?: unknown; isError?: unknown; message?: unknown };

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
			if ((event.type === "message_start" || event.type === "message_update" || event.type === "message_end") && (event.message as { role?: string } | undefined)?.role === "assistant") {
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
