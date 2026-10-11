# Shared-workspace collaboration

`runs.collaborate(manifest, recovery?)` is an opt-in exception to the ordinary one-writer rule. It uses the existing workflow, native launch, supervisor, status and acceptance paths. It is not a second workflow engine.

## Contract

The externally approved manifest declares:
- Stable workflow/run/package identities and manifest version.
- One canonical ticket workspace, goals, rationale, constraints and completion.
- Read resources, owned writable directories, exclusive tokens, prerequisites and required publication versions.
- Existing agent/model/thinking configuration, package checks, combined checks and optional exclusive reconciliation.
- Fixed runtime assets and authentic selected extension paths, digests and approved effects.
- A resident ceiling, default two. Existing global workflow capacity also applies.

All Coders share the same `RLM_WORKSPACE`. No per-Coder checkout or copy is made. The coordinator reserves complete resource sets and capacity in one serialized transition. Compatible packages overlap; conflicting access serializes. Waiting sessions remain residents. Lower ceilings stop new admission, not active work.

A producer must stop its namespace, pass configured checks and publish content/version identity before a consumer starts. The consumer reads and acknowledges current dependency bytes before session creation. Failed partial writes remain unpublished. Final checks run after every implementation namespace stops, identify combined dirty/untracked content, and repeat after concrete exclusive reconciliation.

## Supported boundary

Enrollment requires the native Node runner on Linux x86-64, supported util-linux Landlock/seccomp, user/PID/mount/network namespaces, recursive read-only mounts and Yama protection. Unsupported enrollment fails before unsafe execution. There is no filesystem-only or unsafe serial fallback.

New socket syscalls permit only IPv4/IPv6 in the mandatory private network namespace. Unix, VSOCK, netlink, packet and all other families are denied. New Unix socketpairs permit only connected STREAM IPC, including standard nonblocking/close-on-exec flags; datagram/seqpacket pairs are denied. Retained kernel tests challenge stream reconnect, peer-close, shutdown, sendto/sendmsg and AF_UNSPEC disconnection. Unknown required IPC capabilities remain unsupported, not silently removed.

Native read/edit/write/bash, Code Mode and approved local extension effects retain normal authorized operations. Kernel restrictions cover subprocesses, new files, rename/delete and aliases. Enrollment rejects writable hardlinks/symlinks/special files, mount aliases, broad workspace reads and runtime overlap. Git/jj metadata and parent control state are not writable.

Provider code and callbacks remain confined in the worker. A bounded ephemeral transport-only relay preserves the native Codex auto WebSocket/SSE path, existing proxy/idle configuration and selected route/model. It executes no provider, extension or agent loop. Authentication comes from the existing host-owned source through the protected channel; the auth file is not a worker filesystem grant. No credential store, secret-bearing coordination record or transport log is created. Existing credential metadata must cover the bounded run deadline.

The enrolled route is the native `openai-codex` responses endpoint at `https://chatgpt.com/backend-api/codex/responses` and its WebSocket equivalent. Other routes, custom fetch, different/virtual models, credential writes/refresh and Bun transport are not certified. An explicitly offline provider uses `runtime.network: "none"`, without relaxing network restrictions.

Unknown ambient or required MCP effects remain unsupported. An empty extension list is not evidence that the selected profile has none. Do not disable required tools/extensions to pass enrollment. The parent must obtain an authentic selected snapshot; if it cannot, the live phase is blocked. Unmanaged host writers, administrators and arbitrary remote effects are outside this boundary.

## Controls and recovery

The canonical workspace lease and authoritative history use one private, owner-validated Linux UID directory under the fixed system `/tmp`, independent of `TMPDIR`, `PI_SUBAGENTS_TEMP_ROOT` and run name. Worker artifacts can use a different temp root; their trusted native artifact paths remain recorded in parent state. Ticket workspaces cannot overlap authority storage. Epoch, manifest version and monotonic control sequence reject stale/duplicate/reordered operations. A control mailbox holds one pending request. Journal, snapshot and historical snapshot bounds are 8 MiB, 1 MiB and 32 MiB. Storage failure stops unsafe advancement; optional metrics do not block or hide status.

`pause-admissions` pauses new admission only. It does not establish shell quiescence. `stop` terminates/drains namespaces. Queued/applied receipts do not establish safe transfer: inspect terminal state and namespace evidence.

For a consequential change:
1. Receive the proposal through the existing supervisor path.
2. Record parent authorization and pause admission.
3. Drain/stop conflicting namespaces and observe termination.
4. Inspect partial effects; supply the approved amended manifest and recovery decision.
5. Run the designated owner, validate and publish the new version.
6. Resume consumers through fresh context and exact refresh acknowledgments.

Recovery requires prior epoch/sequence, current combined workspace digest, approval authority/reference, explicit retry packages and compatible completed reuse. Amendments advance the version. Historical results retain their original completion version and execution identity. Compatible reuse requires parent-recorded package/check contract identity, actual read-publication content/producer execution bindings, and prerequisite execution identities. Missing legacy metadata fails closed; do not reconstruct it or migrate legacy authority automatically. A consumer cannot be reused while its producer is retried. Failed or interrupted reconciliation also requires an explicit inspected retry decision, even when its partial effects make combined checks pass. A dead coordinator or timeout alone is not proof of quiescence. Missing startup identities or corrupt persistence fail closed, never blind retry/reset.

Status/Fleet links the bounded snapshot with readiness, residents/capacity, ownership, waits, pending controls, effective configuration, checks and reconciliation. Native artifacts retain usage, timings and observed process termination. Private worker status and results are bounded untrusted proposals. The parent projects its own configuration/control identity and evaluates the child report under the parent-resolved acceptance contract; worker acceptance and review ledgers never become authority. A declared asynchronous writer keeps its existing checked-evidence level and required independent review. Selected acceptance verify commands or required tool-evidence gates need parent-certified confined evidence and currently fail enrollment with an actionable restriction; they are not silently disabled or accepted from worker claims. Invocation completion and combined-check success do not change a `review-required` ledger into final acceptance. Measurement completeness remains explicit.

## Fixed-candidate dogfood

The driver packages existing prepared dependencies, installs nothing and refuses an existing candidate destination. It prepares real digest, bounded FIFO and dependent verifier modules with behavioral checks and conditional reconciliation.

In Fish, set operator-owned absolute paths:
```fish
set SOURCE /path/to/implementation-workspace
set CANDIDATE /path/to/new-fixed-candidate
set TICKET /path/to/one-isolated-ticket-worktree
set OUTPUT /path/to/new-dogfood-artifacts
set CONFIG /path/to/selected-agent-configuration.json
set CHILD_EXTENSIONS /path/to/authentic-selected-child-extensions.json
set PARENT_EXTENSIONS /path/to/authentic-selected-parent-extensions.json

cd "$SOURCE"
node --experimental-strip-types shared-workspace-dogfood.mjs package "$CANDIDATE"
node "$CANDIDATE/shared-workspace-dogfood.mjs" prepare "$TICKET" "$OUTPUT" "$CONFIG" "$CHILD_EXTENSIONS"
node "$CANDIDATE/shared-workspace-dogfood.mjs" validate "$OUTPUT/plan.json"
node "$CANDIDATE/shared-workspace-dogfood.mjs" parent-host-command "$OUTPUT/plan.json" "$PARENT_EXTENSIONS"
```

These are operator instructions, not claims that your environment executed them. Exact executed commands, candidate hashes and local evidence belong to the implementation handoff, not this portable guide.

Configuration may name the existing agent without model/thinking overrides. Omitting the child snapshot creates a structurally validated **pending-enrollment template**, not a launch request. Do not submit that template until the authorized parent materializes the authentic selected snapshot.

The parent snapshot has `version: 1`, `complete: true`, the full selected `extensions` list (including builtin entries), and the exact `replacedExtension` for the old pi-subagents entry. `parent-host-command` prints a temporary Pi invocation with explicit selection: it replaces only this package with the fixed `index.js` and preserves every other supplied parent extension. It sets no model, thinking, authentication or permission override and edits no global activation file. Execute it only after verifying the snapshot is complete and authentic.

In that new parent session, obtain and submit the existing public `subagent` tool request:
```sh
node "$CANDIDATE/shared-workspace-dogfood.mjs" request "$OUTPUT/plan.json"
node "$CANDIDATE/shared-workspace-dogfood.mjs" status "$OUTPUT/plan.json"
```

Printing a request does not execute it or add the new API to an old loaded runtime. The fixed parent must actually load `index.js`. Do not edit or hot-reload the candidate while workers run.

Controls locate the shared authoritative snapshot independently of the artifact temp root:
```sh
node "$CANDIDATE/shared-workspace-dogfood.mjs" stop "$OUTPUT/plan.json"
node "$CANDIDATE/shared-workspace-dogfood.mjs" inspect-recovery "$OUTPUT/plan.json"
node "$CANDIDATE/shared-workspace-dogfood.mjs" resume-request "$OUTPUT/plan.json" /path/to/approved-inspected-recovery.json
node "$CANDIDATE/shared-workspace-dogfood.mjs" serial-request "$OUTPUT/plan.json" /path/to/approved-inspected-recovery.json
```

Resume/serial commands validate inspection and print public requests, without inventing approval or launching workers. Serial continuation advances the stored manifest version and uses ceiling one; it keeps the same confinement.

## Evidence and adapter handoff

Native scripted tests prove physical overlap/refill, conflicts, capacities, stale inputs, supervisor delivery/global drain/version update/fresh acknowledgment, recovery/history, coordinator replacement, filesystem/socket restrictions, final barriers, storage failures and memory cleanup. These are not live-model evidence.

Measure retained coordination heap separately from worker/process-tree memory. Sum each PID once; RSS still includes shared pages per process, while PSS apportions them. Report missing measurements and exact causes. The eight-scripted-child incremental heap target below 10 MiB is an initial target, not an assumed result.

The future Universe adapter supplies the same approved manifest, authentic configuration/capability snapshots, publication contracts, consequential authorization and explicit compatibility decisions. The runtime validates/enforces them; it does not invent task semantics, approvals or requirement changes.
