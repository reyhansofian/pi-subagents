# Upstream v0.74.0 fork sync

Base: upstream pi-subagents **v0.74.0** (b6bda32f03b7f549623bc404c9be14dca298ddc4). Historical fork baseline: **fcde3049a76ae6d0b44ff68f78dd9f2b486ffb1f**, diverged after 0fc0eebb. This branch begins at the upstream tag; no old-tree files are wholesale copied. Historical patches are classified by behavior below, including mixed commits. "Covered" means a locally tested upstream behavior, not tree-wide parity. Tests use synthetic sessions; no live provider or service is required.

## Pi 1.0.0 npm host compatibility follow-up

Source: Albert Gwo's upstream pi-subagents [#2634](https://github.com/nicobailon/pi-subagents/pull/2634), commit 10694a673cb077b4d3ec6a6cfe68acb6c28b83a5. The Pi 1.0.0 pi-agent-core manifest exports its root and package.json but **not** ./node. The old detached alias resolver required ./node even though the runner import graph does not import it; it rejected the real host before spawn. Ported the source's optional-export guard only for this alias: absent ./node is skipped, present exports resolve to realpath, declared missing files and missing packages still fail. No other alias, dependency, pin, loader, or lifecycle path changed. The test fixture and this record are fork-local additions.

The measured Pi 1.0.0 npm layout placed pi-coding-agent at sdk/node_modules/@earendil-works/pi-coding-agent; pi-agent-core, pi-ai, pi-tui, chord (all 1.0.0) and typebox (1.3.27) resolved from its nested node_modules. The selected 0.99.2 and 0.87.1 SDK roots were also sdk/node_modules/@earendil-works/pi-coding-agent in separate isolated fixtures; the SDK tests check selected host and peer versions/containment. Baseline and candidate were packed and installed into separate node_modules/pi-subagents trees, and the smoke exercised compiled JS, not worktree TypeScript. No ambient SDK fallback, real credentials, provider network, or host settings were used.

Reproduce from the repository at the candidate commit (Node 22.20.0 and npm 10.9.3 were measured). The following is a **Bash script**, not Fish syntax; run it in Bash even when your interactive shell is Fish. It makes a fresh temporary root, never deletes it, and does not install into the running Pi host. Use a trusted npm registry; installs use a disposable package cache and only the named isolated prefixes. The baseline is commit daf98af0e69ec846615f9b8c3498cb06c708a022, not a hidden retained pack. Each archived source uses its own lockfile; no installation is required in the live worktree.

~~~bash
set -euo pipefail
REPO="$PWD" # run from the repository root at the candidate commit
NODE="$(command -v node)"
NPM="$(command -v npm)"
TOOLS_PATH="$(dirname "$NODE"):$(dirname "$NPM"):/usr/bin:/bin"
R="$(mktemp -d /tmp/pi-subagents-1.0-smoke.XXXXXXXX)"
mkdir -p "$R"/{baseline-src,candidate-src,base-tar,candidate-tar,cache,baseline-packed,candidate-packed,setup-home,setup-tmp}
npm_clean() {
  env -i PATH="$TOOLS_PATH" HOME="$R/setup-home" XDG_CONFIG_HOME="$R/setup-home/.config" XDG_CACHE_HOME="$R/cache" TMPDIR="$R/setup-tmp" NPM_CONFIG_USERCONFIG="$R/setup-home/.npmrc" NPM_CONFIG_GLOBALCONFIG="$R/setup-home/global.npmrc" NPM_CONFIG_CACHE="$R/cache" "$NPM" "$@"
}
git -C "$REPO" archive daf98af0e69ec846615f9b8c3498cb06c708a022 | tar -x -C "$R/baseline-src"
git -C "$REPO" archive HEAD | tar -x -C "$R/candidate-src"
npm_clean --prefix "$R/baseline-src" ci --ignore-scripts
npm_clean --prefix "$R/candidate-src" ci --ignore-scripts
npm_clean --prefix "$R/baseline-src" run build:pkg
npm_clean --prefix "$R/candidate-src" run build:pkg
npm_clean pack "$R/baseline-src/dist-pkg" --ignore-scripts --pack-destination "$R/base-tar"
npm_clean pack "$R/candidate-src/dist-pkg" --ignore-scripts --pack-destination "$R/candidate-tar"
npm_clean --prefix "$R/baseline-packed" install --ignore-scripts --no-save --no-package-lock --legacy-peer-deps "$R/base-tar/pi-subagents-0.74.0.tgz"
npm_clean --prefix "$R/candidate-packed" install --ignore-scripts --no-save --no-package-lock --legacy-peer-deps "$R/candidate-tar/pi-subagents-0.74.0.tgz"
npm_clean --prefix "$R/sdk-1.0.0" install --ignore-scripts --no-save --no-package-lock --install-strategy=nested @earendil-works/pi-coding-agent@1.0.0
HOST="$R/sdk-1.0.0/node_modules/@earendil-works/pi-coding-agent"
test "$("$NODE" -p "require(process.argv[1]).version" "$HOST/package.json")" = 1.0.0
for pair in pi-agent-core pi-ai pi-tui chord; do
  test "$("$NODE" -p "require(process.argv[1]).version" "$HOST/node_modules/@earendil-works/$pair/package.json")" = 1.0.0
done
test "$("$NODE" -p "require(process.argv[1]).version" "$HOST/node_modules/typebox/package.json")" = 1.3.27
for spec in 'baseline-packed failure pre-fix' 'candidate-packed success post-fix'; do
  read -r pack expectation run <<< "$spec"
  RUN="$R/$run" # must not exist: fixture creates its own home, agent, work, sessions and tmp
  env -i PATH=/usr/bin:/bin HOME="$RUN/home" XDG_CONFIG_HOME="$RUN/home/.config" XDG_CACHE_HOME="$RUN/cache" PI_CODING_AGENT_DIR="$RUN/agent" TMPDIR="$RUN/tmp" PI_OFFLINE=1 JITI_FS_CACHE=false PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT="$HOST" "$NODE" "$REPO/test/smoke/npm-detached-host.mjs" "$R/$pack/node_modules/pi-subagents" "$HOST" "$RUN" "$expectation"
done
printf 'Smoke artifacts retained under %s\n' "$R"

# Optional: reproduce the separately measured three-version SDK matrix (7/7).
npm_clean --prefix "$R/sdk-0.99.2" install --ignore-scripts --no-save --no-package-lock --install-strategy=nested @earendil-works/pi-coding-agent@0.99.2
npm_clean --prefix "$R/sdk-0.87.1" install --ignore-scripts --no-save --no-package-lock --install-strategy=nested @earendil-works/pi-coding-agent@0.87.1 @earendil-works/pi-ai@0.87.1
mkdir -p "$R/sdk-check"/{home,agent,tmp,cache}
cd "$R/candidate-src"
env -i PATH=/usr/bin:/bin HOME="$R/sdk-check/home" XDG_CONFIG_HOME="$R/sdk-check/home/.config" XDG_CACHE_HOME="$R/sdk-check/cache" PI_CODING_AGENT_DIR="$R/sdk-check/agent" TMPDIR="$R/sdk-check/tmp" PI_SUBAGENTS_TEST_SDK_ROOT="$R/sdk-0.99.2/node_modules/@earendil-works/pi-coding-agent" PI_SUBAGENTS_TEST_PI1_SDK_ROOT="$HOST" PI_SUBAGENTS_TEST_LEGACY_SDK_ROOT="$R/sdk-0.87.1/node_modules/@earendil-works/pi-coding-agent" "$NODE" --experimental-strip-types --import ./test/support/register-loader.mjs --test test/integration/native-codemode-evidence.test.ts
~~~

The fixture accepts INSTALLED_EXTENSION PI_PACKAGE_ROOT FRESH_ROOT failure|success in that order; FRESH_ROOT must not exist. It verifies the selected host manifest is 1.0.0 and peers belong to the selected SDK fixture. The exact measured baseline was **PASS expected rejection** (missing pi-agent-core/node alias; no child start); the candidate was **PASS real detached compiled runner** (synthetic read, two provider turns, selected-host SDK identity, complete status and observed child process close). The script above is a reproducible recipe, not a claim that these fresh commands were run on every machine or every npm layout: the measured npm host used nested peers; --install-strategy=nested and the version assertions make that layout explicit. This is an **unsandboxed isolated Node test**, not evidence of network namespace isolation or a live deployed Pi installation; the existing bwrap-only 0.86.1 smoke is unchanged and was not run here. Real host credentials, deployed model/provider behavior, full workflow and cross-version recovery remain **UNVERIFIED**.

| Historical behavior / commits | Decision on v0.74.0 | Persistent evidence / qualification |
| --- | --- | --- |
| 63232dd9 / 0b731c6c / fcde3049: exact-name tool execution requirement; ambient versus explicit-empty inventory | **PORT** flat `acceptance.toolEvidence` (OR). Native current-launch start plus successful end/result; failures override paired completions. No tool content retained. Explicit gate precedes report and agent-contract shortcuts. | `test/unit/tool-evidence.test.ts`, `test/unit/acceptance.test.ts`, `test/integration/acceptance-file-report.test.ts`, `test/integration/native-codemode-evidence.test.ts`. Minimum execution, not proof of correct-file investigation. |
| bb2bcdf4: identified failed tool without substantive continuation | **PORT** minimal observer into upstream foreground/background control channel; nested IDs, grace period, clearing on progress/compaction/settlement, distinct notice per invocation. | `test/unit/tool-error-watch.test.ts` (whitespace-only regression), `test/integration/single-execution.part-2.test.ts`, `test/integration/async-execution.part-4.test.ts`. Observer does not steer, retry or stop. |
| 3d0f43d8: file-only report distinct from assistant receipt, child-authored file preference, failure diagnostics | **UPSTREAM COVERED + LOCAL GAP FIX**: native codemode nested writes use paired successful SDK summaries; an intact report authored before compaction recovery is retained instead of overwritten by the resumed receipt. No old code copied. | `test/integration/acceptance-file-report.test.ts` (separate JSON/report, stale/sibling file rejection, retained recovery, foreground/background receipts), `test/integration/native-codemode-evidence.test.ts`, `test/unit/single-output.test.ts` (actual native nested write). Full historical parity **UNVERIFIED**. |
| 428f6011: drain, supervisor contact and nested lifecycle | **UPSTREAM COVERED** in focused paths; no old lifecycle port. | `test/unit/child-lifecycle.test.ts`, `test/unit/supervisor-ask-registration.test.ts`, `test/unit/compaction-resume.test.ts`, `test/integration/async-execution.part-4.test.ts`. Cross-version nested coordinator cancellation **UNVERIFIED**. |
| ce418000: foreground extension bindings | **UPSTREAM COVERED** by generic launch/sandbox binding support, not Serena specialization. | `test/unit/extension-bindings.test.ts`, `test/unit/workflow-launch-params.test.ts`, `test/unit/scripted-workflow.test.ts`. |
| 9a5b797a: workspace-specific Serena handoffs, tool lists and overrides | **REMOVE by omission**: preserve generic MCP, extension selection, bindings, trust and permissions. | `test/unit/mcp-direct-tool-resolution.test.ts`, `test/unit/extension-bindings.test.ts`. Consumers configure ordinary MCP explicitly. |
| e6cf2e71: converter Code Mode subagent bridge | **REMOVE by omission**: upstream child loader selects native SDK codemode where available; orchestration tools stay model-facing. | `test/integration/native-codemode-evidence.test.ts` executes native nested read on Pi 0.99.2; `test/unit/child-session-host-sdk.test.ts` covers loader. |
| 47526c10 / 479d1295: apply_patch special case and converter trace/codeMode mutation parser | **REMOVE by omission**; native events supply observed tools. Old special-case completion heuristics are intentionally not retained. | Native event integration above. |
| ab73f63d: mutation provenance across resumes | **UPSTREAM COVERED** for focused outcomes, not full old parity: completed sibling remains settled; resumed child cannot borrow prior read; unresolved write outcome is not automatically replayed; old receipt-v1 remains readable. No mutation-provenance heuristics ported. | `test/integration/single-execution.part-2.test.ts` (resume gate, distinct receipt run identities), `test/unit/abort-recovery.test.ts` (unknown write settles), `test/unit/async-resume.test.ts`, `test/unit/workflow-revival.test.ts`, `test/unit/workflow-receipt.test.ts`, `test/integration/async-execution.part-3.test.ts`. Full historical mutation provenance parity **UNVERIFIED**. |
| f29ed045: agent-dir model exclusions | **REMOVE by omission**: upstream model/settings paths own selection. Historical scoping parity **UNVERIFIED**. | No old config/cache override installed. |
| 8e5673d3: Herdr busy-state synchronization | **UNVERIFIED**: no copy without active-consumer and base-failure evidence; generic upstream Herdr retained. | No claim of equivalence. |
| f2638c42 ignore-file addition; 823f941c old dev dependencies | **REMOVE by omission**: upstream ignore rules and lockfile authoritative. | `package.json` and lockfile unchanged; no dependency removed. |
| f8ad1b3e suppress attention after recent activity | **UPSTREAM COVERED** for ordinary idle; failed-tool attention ported separately. | `test/unit/subagent-control.test.ts`, `test/integration/single-execution.part-2.test.ts`. |

## Reproduce the scoped checks

Use isolated, credential-free Pi packages; do not install into or activate a live host. For the SDK matrix, the Bash recipe above installs explicit 0.99.2, 1.0.0 and 0.87.1 package roots and supplies PI_SUBAGENTS_TEST_SDK_ROOT, PI_SUBAGENTS_TEST_PI1_SDK_ROOT and PI_SUBAGENTS_TEST_LEGACY_SDK_ROOT. The other commands below are the recorded focused checks, not another claim of a full-suite run. From the repository with its existing workspace-local dependencies:

~~~sh
npm run typecheck
node scripts/build-package.mjs
node --experimental-strip-types --import ./test/support/isolated-temp-root.mjs --test test/unit/acceptance.test.ts test/unit/subagent-control.test.ts test/unit/tool-evidence.test.ts test/unit/tool-error-watch.test.ts test/unit/child-session-host-sdk.test.ts test/unit/single-output.test.ts test/unit/abort-recovery.test.ts test/unit/async-resume.test.ts test/unit/workflow-revival.test.ts test/unit/workflow-receipt.test.ts test/unit/compaction-resume.test.ts test/unit/host-peer-runtime-imports.test.ts test/unit/async-spawn-preload.test.ts
node --experimental-strip-types --import ./test/support/isolated-temp-root.mjs --test test/unit/child-lifecycle.test.ts test/unit/supervisor-ask-registration.test.ts test/unit/extension-bindings.test.ts test/unit/workflow-launch-params.test.ts test/unit/scripted-workflow.test.ts test/unit/mcp-direct-tool-resolution.test.ts
node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/integration/acceptance-file-report.test.ts
node --experimental-strip-types --import ./test/support/register-loader.mjs --test --test-name-pattern='workflow runs.run retains an explicit tool gate|a resumed workflow child cannot borrow|reports an identified failed nested call stalled|resumes a retained compaction-aborted session once' test/integration/single-execution.part-2.test.ts
node --experimental-strip-types --import ./test/support/register-loader.mjs --test --test-name-pattern='does not gate shared-cwd sibling completion on mutation evidence|agent contract keeps async acceptance and file-mutation effects separate from execution|fails closed when a retained workflow child lacks original-authority metadata' test/integration/async-execution.part-3.test.ts
node --experimental-strip-types --import ./test/support/register-loader.mjs --test --test-name-pattern='bg_wait wakes|background final-drain|background forced drain|reports one background failed-tool stall|compaction failure context' test/integration/async-execution.part-4.test.ts
node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/integration/native-codemode-evidence.test.ts
~~~

On the three-version isolated local fixtures, the 13-file focused unit partition passed 239 tests with one Windows-only skip and the six-file retained-contract partition passed 207/207; the file-report integration passed 19/19, foreground workflow/stall/compaction selection 4/4, background resume/mutation selection 3/3, background drain/stall selection 7/7, and the SDK fixture 7/7. The post-fix build and typecheck passed. An initial baseline build with the workspace-local 0.0.0 test shim instead of lockfile SDK 0.87.0 failed eight unrelated SDK type errors; lockfile dependency provisioning resolved this without source changes. Named persistent cases: `keeps requested JSON separate from a child-authored file-only report`, `does not treat a stale or sibling-written file as this child's authored report`, `retains an authored valid report across a compaction recovery receipt`, `does not borrow a pre-compaction read for the recovered launch tool gate`, `a resumed workflow child cannot borrow its earlier read or relaunch a completed sibling`, `does not automatically replay an unknown write outcome after compaction`, `reads old receipt-v1 files without external adapter metadata`, and `keeps a failed call pending through whitespace-only assistant text and deltas`.

The SDK fixture tests actually execute native nested read and write on 0.99.2 and 1.0.0, 0.87.1 direct read and explicit unsupported-codemode rejection, a non-Serena extension tool, and a projectTrusted: false child whose read is denied by a synthetic permission hook (not proof of host trust enforcement). The workflow fixture checks both rejected and accepted structured-output launches with an explicit tool gate. The integration/SDK fixtures use synthetic providers, not a live Pi host; the full unit suite exceeded a bounded run and is not claimed passing. Full deployed RLM workflows, credentialed MCP, production trust policy, and cross-version resume parity remain **UNVERIFIED**. The host must install a reviewed package version with the desired SDK, configure ordinary extensions/MCP explicitly, and confirm real workflow output and recovery before operational use.

## Consumer handoff

Install the eventual reviewed fork package commit in the Pi host; do not activate a development worktree live. Pi **0.99.2** and **1.0.0** provide native `codemode` (SDK factory and nested `parentToolCallId` events). Pi **0.87.1** has no native factory: use supported direct read tools or upgrade, and never treat an installed package or allowlist entry as tool execution. `acceptance: { level: "checked", toolEvidence: ["read", "mcp__docs__read"] }` requires one successful exact-name child invocation in addition to, not instead of, any requested acceptance report/criteria and separate outputSchema JSON. Ambient inventory may be unknown; explicit `tools: []` is empty. Native `tools.read` uses event name `read` unless the registered tool literally has another name. Keep subagent, supervisor and structured_output model-facing, not exposed through codemode for old converter patterns.

Standalone RLM feature-dev uses `runs.all([...])` for an independent scout wave, then one coder and bounded review; standalone RCA uses scoped read-only investigation workers and a coder only after approval. Consumers also use `subagent({ agent, cwd, task, async: false, ... })`, `outputMode: "file-only"` and optional `outputSchema`. Child-authored report content remains distinct from a compact receipt. The Universe skills and older converter are outside this package and are untouched. No Universe workspace, Serena, provider, or wrapper is hardcoded into this fork. Live credentialed hosts and full workflow parity remain integration blockers; check real installation and native event flow before production use.
