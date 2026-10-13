/** Native runner construction, separate from its executable entrypoint and attempt loop. */
import * as path from "node:path";
import { createWorkerRuntime, workerBound, type WorkerBound } from "../shared/worker-runtime.ts";
import { snapshotChildLaunchBindings, snapshotChildLaunchIdentity } from "../../shared/child-launch-binding.ts";
import { buildInProcessChildLaunch, type BuildInProcessChildLaunchInput, type InheritedChildRuntime } from "../shared/child-launch.ts";
import { deriveForkPromptCacheKey } from "../shared/child-tool-plan.ts";
import { normalizeExtensionBindings } from "../shared/extension-bindings.ts";
import type { RunnerSubagentStep } from "../shared/parallel-utils.ts";
import { formatAcceptancePrompt } from "../shared/acceptance.ts";
import { isAgentContract } from "../shared/agent-contract.ts";

export interface RunnerChildLaunchContext {
	cwd: string;
	id: string;
	flatIndex: number;
	artifactsDir?: string;
	childIntercomTarget?: string;
	orchestratorIntercomTarget?: string;
	nestedRoute?: BuildInProcessChildLaunchInput["nestedRoute"];
	runFanoutBudget?: BuildInProcessChildLaunchInput["runFanoutBudget"];
	capabilityCeiling?: BuildInProcessChildLaunchInput["capabilityCeiling"];
	inheritedChildRuntime?: InheritedChildRuntime;
	projectTrusted?: boolean;
	deadlineAt?: number;
	workerEnclosingBounds?: readonly WorkerBound[];
}

export function buildRunnerChildLaunch(step: RunnerSubagentStep, ctx: RunnerChildLaunchContext, attempt: {
	model?: string;
	sessionEnabled: boolean;
	sessionDir?: string;
	sessionName?: string;
	structuredOutput?: BuildInProcessChildLaunchInput["structuredOutput"];
	childWatchdog?: BuildInProcessChildLaunchInput["childWatchdog"];
	watchdogStatus: NonNullable<BuildInProcessChildLaunchInput["watchdogStatus"]>;
}) {
	// Resource-backed system instructions survive SDK split-turn compaction verbatim.
	const acceptancePrompt = step.effectiveAcceptance
		? formatAcceptancePrompt(step.effectiveAcceptance, { reportOptional: isAgentContract(step.agentContract), structuredOutput: Boolean(step.structuredOutput?.acceptanceReportPath) })
		: "";
	const launch = buildInProcessChildLaunch({
		machine: step.machine,
		remoteSkillNames: step.skills,
		remoteReads: step.remoteReads,
		parentSessionId: step.parentSessionId,
		forkCacheKey: step.context === "fork" ? deriveForkPromptCacheKey(step.parentSessionId) : undefined,
		sessionEnabled: attempt.sessionEnabled,
		sessionDir: attempt.sessionDir,
		sessionFile: step.sessionFile,
		model: attempt.model,
		inheritProjectContext: step.inheritProjectContext,
		inheritGlobalContext: step.inheritGlobalContext,
		inheritSkills: step.inheritSkills,
		requireReadTool: Boolean(step.skills?.length),
		tools: step.tools,
		excludeTools: step.excludeTools,
		allowNestedSubagents: step.allowNestedSubagents,
		descendantAllowedAgents: step.allowedAgents,
		extensions: step.extensions,
		subagentOnlyExtensions: step.subagentOnlyExtensions,
		requiredExtensions: step.requiredExtensions,
		fast: step.fast,
		systemPrompt: acceptancePrompt ? `${step.systemPrompt ?? ""}\n${acceptancePrompt}` : step.systemPrompt ?? "",
		systemPromptMode: step.systemPromptMode,
		mcpDirectTools: step.mcpDirectTools,
		builtinMcpTools: step.builtinMcpTools,
		extensionBindings: normalizeExtensionBindings(step.extensionBindings)?.value,
		capabilityCeiling: step.capabilityCeiling ?? ctx.capabilityCeiling,
		cwd: step.cwd ?? ctx.cwd,
		intercomSessionName: ctx.childIntercomTarget,
		projectTrusted: ctx.projectTrusted,
		sessionName: attempt.sessionName,
		orchestratorIntercomTarget: ctx.orchestratorIntercomTarget,
		runId: ctx.id,
		childAgentName: step.agent,
		childIndex: ctx.flatIndex,
		nestedRoute: ctx.nestedRoute,
		runFanoutBudget: ctx.runFanoutBudget ? {
			...ctx.runFanoutBudget,
			...(step.runFanoutPath ? { parentPath: `${ctx.runFanoutBudget.parentPath ? `${ctx.runFanoutBudget.parentPath}/` : ""}${step.runFanoutPath}` } : {}),
		} : undefined,
		structuredOutput: attempt.structuredOutput,
		toolBudget: step.toolBudget,
		permissionRules: step.permissionRules,
		permissionAuditPath: step.permissionRules && ctx.artifactsDir
			? path.join(ctx.artifactsDir, "permission-audit", `${ctx.id}-${ctx.flatIndex}.jsonl`) : undefined,
		childWatchdog: attempt.childWatchdog,
		// registerChildWatchdog returns before reading the sink when unconfigured.
		...(attempt.childWatchdog ? { watchdogStatus: attempt.watchdogStatus } : {}),
		waitToolEnabled: step.waitToolEnabled,
		waitToolDefaultTimeoutMs: step.waitToolDefaultTimeoutMs,
		thinkingCeiling: step.thinkingCeiling,
		maxSubagentDepth: step.maxSubagentDepth,
		inherited: ctx.inheritedChildRuntime,
		host: "runner",
	});
	if (step.workerLaunch) {
		const identity = snapshotChildLaunchIdentity(step.workerLaunch.identity);
		if (identity.runId !== ctx.id || identity.agent !== step.agent || identity.cwd !== (step.cwd ?? ctx.cwd) || identity.parentSessionId !== step.parentSessionId) throw new Error("Worker launch transport identity mismatch.");
		const bindings = snapshotChildLaunchBindings(step.workerLaunch.bindings, step.requiredExtensions ?? []);
		if (!bindings) throw new Error("Worker binding transport unavailable.");
		launch.session.workerRuntime = createWorkerRuntime(identity, bindings, workerBound(ctx.deadlineAt), ctx.workerEnclosingBounds ?? (identity.workflow ? [{ kind: "unavailable", reason: "workflow-ancestry-unavailable" }] : []));
	}
	return launch;
}
