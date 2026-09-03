import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "../shared/utils.ts";

const CODE_MODE_MODULE = "@howaboua/pi-codex-conversion/code-mode";
const CODE_MODE_PACKAGE = "@howaboua/pi-codex-conversion";
type AnyToolDefinition = ToolDefinition<any, any, any>;

export interface CodeModeRegistration {
	unregister(): void;
}

interface CodeModeModule {
	adaptToolForCodeMode(tool: AnyToolDefinition, options: { usage: string }): unknown;
	registerCodeModeExtensionTools(pi: ExtensionAPI, provider: () => readonly unknown[]): CodeModeRegistration;
}

type CodeModeImporter = () => Promise<unknown>;

function missingOptionalPackage(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) return false;
	const code = (error as { code?: unknown }).code;
	if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return false;
	const message = String((error as { message?: unknown }).message ?? "");
	return message.includes(`'${CODE_MODE_MODULE}'`) || message.includes("'@howaboua/pi-codex-conversion'") || message.includes('"@howaboua/pi-codex-conversion"');
}

function incompatibleCodeMode(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) return false;
	const code = (error as { code?: unknown }).code;
	return code === "ERR_PACKAGE_PATH_NOT_EXPORTED" || code === "ERR_UNSUPPORTED_DIR_IMPORT";
}

async function loadCodeModeModule(): Promise<unknown> {
	try {
		return await import(CODE_MODE_MODULE);
	} catch (error) {
		if (!missingOptionalPackage(error)) throw error;
		const packageRoot = path.join(getAgentDir(), "npm", "node_modules", ...CODE_MODE_PACKAGE.split("/"));
		let manifest: { exports?: Record<string, string | { import?: string; default?: string }> };
		try {
			manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"));
		} catch (manifestError) {
			if ((manifestError as NodeJS.ErrnoException).code === "ENOENT") throw error;
			throw manifestError;
		}
		const codeModeExport = manifest.exports?.["./code-mode"];
		const target = typeof codeModeExport === "string" ? codeModeExport : codeModeExport?.import ?? codeModeExport?.default;
		const resolvedTarget = target?.startsWith("./") ? path.resolve(packageRoot, target) : undefined;
		const relativeTarget = resolvedTarget ? path.relative(packageRoot, resolvedTarget) : undefined;
		if (!resolvedTarget || relativeTarget === ".." || relativeTarget?.startsWith(`..${path.sep}`)) {
			throw Object.assign(new Error("Package subpath './code-mode' is not defined by exports"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
		}
		return import(pathToFileURL(resolvedTarget).href);
	}
}

export function registerSubagentCodeMode(
	pi: ExtensionAPI,
	tool: AnyToolDefinition,
	load: CodeModeImporter = loadCodeModeModule,
): CodeModeRegistration {
	let disposed = false;
	let registration: CodeModeRegistration | undefined;
	void load().then((loaded) => {
		const module = loaded as Partial<CodeModeModule>;
		if (typeof module.adaptToolForCodeMode !== "function" || typeof module.registerCodeModeExtensionTools !== "function") {
			console.warn("[pi-subagents] Code Mode bridge skipped: pi-codex-conversion >=3.0.24 is required.");
			return;
		}
		const adapted = module.adaptToolForCodeMode(tool, { usage: "await tools.subagent({...})" });
		registration = module.registerCodeModeExtensionTools(pi, () => [adapted]);
		if (disposed) registration.unregister();
	}).catch((error) => {
		const reason = missingOptionalPackage(error)
			? "pi-codex-conversion is not installed"
			: incompatibleCodeMode(error)
				? "pi-codex-conversion >=3.0.24 is required"
				: `pi-codex-conversion failed to load (${error instanceof Error ? error.message : String(error)})`;
		console.warn(`[pi-subagents] Code Mode bridge skipped: ${reason}.`);
	});
	return { unregister() { disposed = true; registration?.unregister(); } };
}
