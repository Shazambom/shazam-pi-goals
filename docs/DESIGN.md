# Design

One installable Pi package; three modules. No automatic continuation or completion
review. Checkpoints are advisory state, not execution authority. Traces are passive
and content-free. One package loading entry enables the combined capability.

## Checkpoint core

`src/checkpoint.ts` exports `restoreCheckpoint(entries): CheckpointView`,
`replacement(view, expectedRevision, input): CheckpointEvent`,
`control(action): CheckpointEvent`, and `renderCue(view): string | null`.
Contracts are in `src/contracts.ts`. Invalid replacement throws a fixed-message
error, never echoing raw input. Restore ignores malformed/unknown entries. Only
entries from the current branch are supplied. Replacement validates one versioned
note using TypeBox, 8 KiB encoded maximum, copies ingress and egress, and rejects
stale revisions. Human pause is a separate control entry; replacements never undo
it. Clear preserves pause. No operation-ID journal, duplicate task status or typed
TODO synchronization. Cues are escaped and capped at 1,200 Unicode code points.

## Trace core

`src/trace.ts` exports `createTrace(directory, options?): TraceRecorder`.
Production options permit declared capability names/runtime version and a fixed
error-code notice callback; injected clock/limits/writer for tests must remain
clearly test seams. Use monotonic time, one exclusive process file and session
segment aliases. No raw session/tool IDs or content is persisted. Request starts
and run starts allocate local aliases; missing/ambiguous correlation is unknown.
First milestones record once per request; concurrent tools use bounded aliases.

Use SonicBoom asynchronous writes, capped buffer and no unbounded write retries.
Proposed defaults: 2 KiB record, 256 KiB buffer, 256 correlation entries, 8 MiB file,
250 ms awaited shutdown flush. Limits are code constants, not optimal measurements.
No retained event state after disabling. No automatic retention/rotation; users
clean up historical files. Flush timeout does not guarantee filesystem cancellation.
Summaries are computed on demand from the bounded file and show missing data,
overlap-aware tool union/sum and no false provider-compute claims.

## Pi integration

`src/integration.ts` registers tool `task_checkpoint` (read/replace) and commands
`checkpoint` (inspect/pause/resume/clear) and `phase-trace`. `src/index.ts` composes
modules. It supplies current branch entries and checks canonical saved-entry
identity after mutations/recovery; live-only state is never called durable.

Checkpoint mutations/cues require a single root identity and current owned session
from the installed host's existing identity/lifecycle event contracts. Missing or
ambiguous contracts disable only checkpoint actions with an actionable notice;
passive trace remains available on ordinary Pi. No private paths are imported.
Human control commands require actual interactive/RPC command provenance supported
by the host; don't infer authorization from arbitrary role text. Read/replace is
model-callable; pause/resume state is not. Fork starts cue-suppressed until explicit
human resume. Abort suppresses the current execution. Rebuild on startup/resume,
tree/fork and compaction. Cache note/cue on changes, not every context request.

Cue eligibility follows changed revision, recovery and external user input. Append
at most one custom advisory while preserving original messages. No repeated cue
on unchanged ordinary requests; no new model call. Verify request/context ordering.
Trace maps only available hooks, advertises missing milestones and never invents
cancel-request timestamps from aborted results. Tool failure, trace failure or
unavailable host contracts must preserve the caller's original work.

## Delivery and accepted limits

Bash orchestrates tests/install; strict TypeScript owns runtime APIs. Dependencies
are pinned and no package lifecycle scripts are used. Test with synthetic providers,
private temporary state and the resolved actual Pi CLI. Test package installation
from GitHub, not a local import alone. Public repository contains no private sessions
or campaign data. Goal focus remains unproven even when all runtime tests pass.
