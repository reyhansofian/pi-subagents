# Opt-in shared-workspace collaboration

This design specifies an explicit exception to the ordinary one-writer policy. It does not authorize concurrent writers in ordinary workflows.

Implementation status: native public scheduling, reservations, publication, namespace drain, stable combined checks, conditional reconciliation, live ceilings, bounded controls and explicitly inspected recovery have retained native scripted-provider tests. A bounded HTTP/WebSocket transport-only relay preserves the installed native Codex auto transport and worker-local callbacks. Enrollment always requires private networking and AF_UNIX denial. Offline providers require an explicit `runtime.network: "none"` contract; no network fallback is implied. Live model dogfood and complete acceptance still require the parent-owned run and independent review. See [the public contract and dogfood driver](shared-workspace-collaboration.md) for restrictions and evidence limits. Ordinary workflows retain the one-writer policy.

## Existing primitives

Native workflow execution already provides stable keyed children, lifecycle-driven rolling launches, launch configuration resolution, detached runners, supervisor requests, steering receipts, status, FleetView, and result artifacts. Required extension snapshots and session leases provide fail-closed contracts. Reuse these paths.

## Missing guarantees

Tool-name ceilings do not bound filesystem effects. Current SDK sessions share a hosting process. Neither a child result nor a shell parent exit proves that descendants stopped. Existing workflows do not reserve package resources, publish dependency generations, own a canonical workspace across processes, or freeze the combined dirty and untracked candidate for verification.

## Public contract and transitions

Add `runs.collaborate(manifest)` to the existing workflow host. The manifest describes externally planned packages, one canonical workspace, immutable version identities, goals and constraints, read/write/exclusive resources, prerequisites, dependency publications, agent configuration, verification, optional reconciliation, and a resident ceiling. The opt-in default ceiling is two; it is not an architectural maximum.

Validate the entire manifest before launching. Reject invalid references, cycles, unsafe aliases, impossible ownership, stale bindings, and unsupported required capabilities. Overlapping access is valid when serialized.

One parent-owned reducer admits packages deterministically on lifecycle events. It atomically acquires all resources and resident capacity. Paused and waiting workers remain residents. Successful results advance through drain, validation, publication, and completion. Failure leaves partial outputs unpublished. Completed packages are not relaunched to refill capacity.

A process-safe workspace lease and execution generations fence every transition. Persist bounded control records and atomic snapshots outside worker write scopes. Ambiguous previous ownership blocks admission; a timeout does not establish quiescence.

An approved shared change stops admissions, drains conflicting operations, confirms runtime quiescence, grants its designated owner, validates and publishes the replacement, then refreshes dependent contexts and records their exact version acknowledgments. Delivery is not acknowledgment or permission to continue. Amendments preserve historical results and require explicit compatibility decisions for reuse.

After all implementation writers stop, freeze and identify the combined candidate, including relevant dirty and untracked bytes. Run combined checks under declared authority. Launch one exclusive reconciliation Coder only for concrete integration work, then repeat final checks. Package-local checks do not establish combined correctness.

## Supported enforcement boundary

Opted-in workers use the existing native runner in separate confined Linux processes, all sharing the same real ticket worktree through `RLM_WORKSPACE`. There is no per-worker checkout or repository copy. Ordinary foreground and background behavior remains unchanged.

Compose kernel filesystem restrictions with a user/PID/mount namespace, private proc, read-only external mounts, sanitized descriptors and environment, dropped capabilities, and bounded descendant lifetime. Landlock alone is insufficient: writable hardlinks and inherited descriptors can carry authority across path scopes. Audit ownership roots and inode aliases before enrollment. Keep runtime, Git/jj metadata, and parent control state outside worker mutation authority.

Kernel restrictions apply to native file tools, shell commands, Code Mode's nested host calls, and local extension operations. Allow only declared current publications as dependency inputs. Opaque compilers, tests, formatters, installs, and generated output require their actual access scope; serialization does not expand authority.

The boundary does not control unmanaged host processes, malicious administrators, or arbitrary remote API effects. Require exclusive operator custody of the workspace and approved immutable extension capabilities. Reject unsupported required tools or runtime capabilities before execution. Do not remove essential tools silently or fall back to unsafe parallelism.

## Verification and rollout

Use controlled barriers to prove A/B overlap and C refill after A publishes while B remains resident. Exercise actual positive and negative native, shell, Code Mode, extension, alias, and descendant effects. Cover authority conflicts, stale messages, partial writes, amendments, cancellation, replacement, stable acceptance, storage overload, and non-opt-in regressions.

Measure retained coordination heap, process-tree memory, status/event overhead, storage backpressure, and repeated cleanup. The initial eight-scripted-child incremental retained-heap target is below 10 MiB, not an assumed measurement. Bound messages, queues, and active state independently of resident capacity.

Package a fixed runtime outside the subsequent dogfood ticket workspace. Use the same public manifest and workflow for a bounded live coding task and the future RLM adapter. Report deterministic evidence separately from real model execution and any unavailable live-runtime evidence.
