import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionBindings } from "./extension-bindings.ts";
import type { McpConfig } from "./mcp-direct-tool-allowlist.ts";

export const SERENA_HANDOFF_NAMESPACE = "pi-mcp-adapter/1";
export const SERENA_READ_TOOLS = Object.freeze([
	"read_file", "list_dir", "find_file", "search_for_pattern", "get_symbols_overview",
	"find_symbol", "find_referencing_symbols", "get_incoming_calls", "get_outgoing_calls",
]);

export interface McpWorkspaceHandoff {
	config: McpConfig;
	metadata: Record<string, { tools: Array<{ name: string }> }>;
	receipt: Record<string, unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error(`${label} has unexpected fields.`);
}

function safeReceiptPath(receiptPath: string, cwd: string): string {
	const workspace = fs.realpathSync(cwd);
	if (process.getuid && fs.lstatSync(workspace).uid !== process.getuid()) throw new Error("MCP workspace handoff workspace is not owned by this user.");
	if (workspace !== path.resolve(cwd)) throw new Error("MCP workspace handoff cwd must be canonical.");
	const expected = path.join(workspace, ".pi", "mcp-handoffs", "serena.json");
	if (receiptPath !== expected || !path.isAbsolute(receiptPath)) throw new Error("MCP workspace handoff path is not canonical for this workspace.");
	let current = receiptPath;
	while (current !== workspace) {
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink() || (current === receiptPath ? !stat.isFile() : !stat.isDirectory()) || (process.getuid && stat.uid !== process.getuid())) {
			throw new Error("MCP workspace handoff path is unsafe.");
		}
		current = path.dirname(current);
		if (!current.startsWith(`${workspace}${path.sep}`) && current !== workspace) throw new Error("MCP workspace handoff escapes its workspace.");
	}
	return workspace;
}

export function loadMcpWorkspaceHandoff(bindings: ExtensionBindings | undefined, cwd = process.cwd()): McpWorkspaceHandoff | undefined {
	const rawBinding = bindings?.[SERENA_HANDOFF_NAMESPACE];
	if (rawBinding === undefined) return undefined;
	if (!record(rawBinding)) throw new Error("MCP workspace handoff binding must be an object.");
	exactKeys(rawBinding, ["path", "sha256"], "MCP workspace handoff binding");
	if (typeof rawBinding.path !== "string" || typeof rawBinding.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(rawBinding.sha256)) {
		throw new Error("MCP workspace handoff binding is invalid.");
	}
	const workspace = safeReceiptPath(rawBinding.path, cwd);
	const bytes = fs.readFileSync(rawBinding.path);
	if (createHash("sha256").update(bytes).digest("hex") !== rawBinding.sha256) throw new Error("MCP workspace handoff digest does not match.");
	let receipt: unknown;
	try { receipt = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("MCP workspace handoff receipt is not JSON."); }
	if (!record(receipt)) throw new Error("MCP workspace handoff receipt must be an object.");
	exactKeys(receipt, ["version", "workspace", "leaseId", "bootId", "observedAtMs", "definition", "tools"], "MCP workspace handoff receipt");
	if (receipt.version !== 1 || receipt.workspace !== workspace || typeof receipt.leaseId !== "string" || !/^[0-9a-f]{64}$/.test(receipt.leaseId)
		|| typeof receipt.bootId !== "string" || receipt.bootId !== fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
		|| !Number.isSafeInteger(receipt.observedAtMs)) throw new Error("MCP workspace handoff receipt identity is invalid.");
	if (!record(receipt.definition)) throw new Error("MCP workspace handoff definition is invalid.");
	const definition = receipt.definition;
	exactKeys(definition, ["url", "includeTools", "exposeResources", "lifecycle"], "MCP workspace handoff definition");
	const url = typeof definition.url === "string" ? new URL(definition.url) : undefined;
	if (!url || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/mcp" || url.search || url.hash
		|| definition.lifecycle !== "eager" || definition.exposeResources !== false
		|| !Array.isArray(definition.includeTools) || definition.includeTools.join("\0") !== SERENA_READ_TOOLS.join("\0")) {
		throw new Error("MCP workspace handoff definition violates the Serena contract.");
	}
	if (!Array.isArray(receipt.tools) || receipt.tools.length !== SERENA_READ_TOOLS.length) throw new Error("MCP workspace handoff tool metadata is incomplete.");
	const tools = receipt.tools.map((tool) => {
		if (!record(tool) || typeof tool.name !== "string" || !record(tool.inputSchema)) throw new Error("MCP workspace handoff tool metadata is invalid.");
		return tool;
	});
	if (tools.map(tool => tool.name).sort().join("\0") !== [...SERENA_READ_TOOLS].sort().join("\0")) throw new Error("MCP workspace handoff tool names do not match the grant.");
	return {
		config: { mcpServers: { serena: definition as McpConfig["mcpServers"][string] } },
		metadata: { serena: { tools: tools.map(tool => ({ name: tool.name as string })) } },
		receipt,
	};
}
