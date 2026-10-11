import * as fs from "node:fs";
import * as path from "node:path";
import { createJiti } from "jiti";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { decodeCollaboration, readCollaborationJson } from "../../workflows/collaboration-json.ts";
import { collaborationDigest } from "../../workflows/collaboration-manifest.ts";
import { resolveHostPeerAliases } from "../background/runner-aliases.ts";
import { COLLABORATION_CONTEXT7_ROUTE } from "./collaboration-context7.ts";

export interface CollaborationContext7Binding { path: string; digest: string }
interface OrdinaryFactory {
	createMcpAdapter(options: { config: {
		mcpServers: { context7: { url: string; lifecycle: "lazy"; directTools: false; oauth: false } };
		settings: { directTools: false };
	} }): (pi: ExtensionAPI) => void;
}

/** Worker-local ordinary public factory. The registry remains honestly inline. */
export async function loadCollaborationContext7Adapter(binding: CollaborationContext7Binding, sdkRoot: string) {
	if (fs.realpathSync.native(binding.path) !== binding.path || collaborationDigest(binding.path) !== binding.digest) throw new Error("shared-workspace-unsupported: prepared Context7 adapter source identity changed.");
	decodeCollaboration(Type.Object({
		name: Type.Literal("pi-mcp-adapter"), version: Type.Literal("5.0.0"),
	}, { additionalProperties: true }), readCollaborationJson(fs.readFileSync(path.join(path.dirname(binding.path), "package.json"), "utf8")), "shared-workspace-unsupported: prepared ordinary adapter identity is incompatible.");
	const peers = resolveHostPeerAliases(sdkRoot);
	if (peers.missing.length) throw new Error("shared-workspace-unsupported: selected SDK peer closure is incomplete.");
	const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: peers.aliases });
	// SAFETY: The host binds this prepared package/source to immutable runtime assets before worker creation.
	const ordinary = await jiti.import<OrdinaryFactory>(binding.path);
	return {
		name: "pi-subagents:hosted-context7",
		factory: ordinary.createMcpAdapter({ config: {
			mcpServers: { context7: { url: COLLABORATION_CONTEXT7_ROUTE, lifecycle: "lazy", directTools: false, oauth: false } },
			settings: { directTools: false },
		} }),
	};
}
