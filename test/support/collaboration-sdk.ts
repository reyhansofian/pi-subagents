import * as fs from "node:fs";
import { resolveInstalledPiPackageRoot, resolvePiPackageRoot } from "../../src/runs/shared/pi-spawn.ts";

const root = resolvePiPackageRoot()
	?? process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT
	?? resolveInstalledPiPackageRoot();
if (!root) throw new Error("Set PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT to the selected Pi SDK package root.");
export const collaborationSdkRoot = fs.realpathSync.native(root);
