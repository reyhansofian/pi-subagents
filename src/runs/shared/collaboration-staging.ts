import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AcceptanceRuntimeCheck } from "../../shared/types.ts";

function exists(file: string): boolean {
	try { fs.lstatSync(file); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Host-only repository inspection. Worker proposals never supply this evidence. */
export function checkCollaborationStaging(cwd: string): AcceptanceRuntimeCheck {
	const failed: AcceptanceRuntimeCheck = { id: "no-staged-files", status: "failed", message: "Parent staging inspection is unavailable." };
	try {
		const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
		// An inherited alternate index/worktree must not redirect the workspace check.
		for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
		const options = { cwd, env, encoding: "utf8" as const, windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 };
		if (exists(path.join(cwd, ".jj"))) {
			const root = spawnSync("jj", ["root", "--ignore-working-copy"], options);
			if (root.error || root.signal || root.status !== 0 || !path.isAbsolute(root.stdout.trim())
				|| fs.realpathSync(root.stdout.trim()) !== fs.realpathSync(cwd)) return failed;
			if (!exists(path.join(cwd, ".git"))) {
				return { id: "no-staged-files", status: "passed", message: "Parent verified a non-colocated Jujutsu workspace with no Git staging area." };
			}
		}
		const result = spawnSync("git", ["diff", "--cached", "--quiet", "--exit-code", "--no-ext-diff"], options);
		if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) return failed;
		return result.status === 0
			? { id: "no-staged-files", status: "passed", message: "Parent verified no staged changes." }
			: { id: "no-staged-files", status: "failed", message: "Parent detected staged changes." };
	} catch { return failed; }
}
