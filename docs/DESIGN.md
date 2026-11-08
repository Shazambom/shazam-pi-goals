# Design

One installable Pi package combines advisory task checkpoints and passive phase
traces. A small TypeScript translation layer registers Pi tools, commands and
hooks. Rust owns note validation/reconstruction/rendering, saved-history inspection,
trace projection/correlation, bounded file writing and summaries. NAPI-RS supplies
the in-process Node bridge; no runtime subprocess, scheduler or provider client.

## Interfaces and ownership

- `native/src/checkpoint.rs`: typed serde note/events behind JSON transport;
  `restore`, `replacement`, `control`, `render`, `verify_saved`. Current-branch fold,
  revision guard, cloned values, human pause separate from model updates. Saved
  history is inspected read-only and never repaired. Caps are code constants.
- `native/src/trace.rs`: `Recorder::new`, `begin_session`, `event`, `summary`,
  `close`. Fixed allowlist, monotonic clock, local aliases and bounded resources.
  Standard Rust bounded channels and buffered I/O replace custom queue algorithms.
  One writer thread; event callbacks never wait for disk. No rotation/retention.
- `native/src/lib.rs`: NAPI-RS exports, fixed transport errors and async shutdown
  task. Serde validates core data. No Pi-specific behavior in this binding.
- `src/native.ts`, `checkpoint.ts`, `trace.ts`: typed FFI facades and Pi-facing
  JSON-schema declaration. No second core implementation. JSON transport rejects
  non-JSON values/accessors; Rust remains the authoritative note validator.
- `src/integration.ts` and `index.ts`: Pi lifecycle/tool/command translation,
  source/owner admission, cached cue eligibility and package composition.

`src/contracts.ts` documents the bridge's public shapes. Changes require agreement
with root and corresponding Rust/bridge tests. Host TypeBox supplies tool schema;
serde supplies Rust types/validation; NAPI-RS supplies native ABI; standard Rust
primitives supply writer/channel ownership. No SonicBoom dependency remains.

## Checkpoint behavior

One sourced note per branch: outcome, next deliverable, sourced decisions, optional
blocker. No duplicate task-status machine, standalone IDs or typed TODO sync.
`task_checkpoint` supports read and revision-checked whole replacement. A conflict
requires read/reconcile; no exact retry-receipt promise. `checkpoint` inspects or
pauses/resumes/clears the cue. Agent replacement cannot undo a human pause.

The installed host runs extension command handlers without input-source provenance.
Therefore control mutations require native UI confirmation; absent confirmation
fails that command closed. Ordinary reads/writes/startup/tasks never prompt. This
is not a claim that RPC automation is authenticated human input.

Checkpoint writes/cues require exactly one matching root identity and owned session
from existing host events. Missing/ambiguous responders suppress only checkpoint
functionality; tracing remains available. No private config paths are imported.
Forks inherit notes as history but require a confirmed current-session activation
entry before cues resume. Abort suppresses the affected execution. Resume/tree/
compaction/revision/external-input boundaries refresh cached notes/cues; unchanged
ordinary requests do not receive repeated reminders. Original messages stay intact.

Use an 8 KiB record cap and 1,200-code-point cue cap, with escaped controls and
explicit omissions. These are proposed engineering bounds, not proven optima.
Canonical saved-state visibility is bounded; missing/corrupt/oversized history is
unknown, never repaired or described as durable. Checks happen at changes/recovery,
not unconditional whole-history scans on every context request.

## Trace behavior

One exclusive local process file, with per-session headers and no raw content or
identifiers. Record available run/turn/request, first provider/text/reasoning/tool,
response end, tool execution and settlement boundaries. Actual cancellation time
is unsupported unless a real host notification exists. Unknown phases are never
zero, and client timings never claim provider queue/compute separation.

Bound record bytes, queued records, correlation maps and admitted file bytes. At
capacity/error, drop or stop recording with fixed-code diagnostics; retain no
unbounded event state. No raw errors/prompts/reasoning/tool arguments/results/paths
in records. Manual cleanup means cumulative historical disk use is not capped.
Rust's writer thread owns files; native close waits a bounded interval off Node's
main thread. This does not guarantee OS I/O cancellation or complete crash durability.
Summaries compute elapsed and overlapping-tool union/sum honestly on demand.

## Build and delivery

Bash orchestrates build/test/install. `npm install` runs the reviewed Bash native
build script, using installed Cargo and a C linker; it never installs a toolchain.
This deliberate exception to the earlier no-build-script sketch is required by the
user's Rust experiment. `Cargo.lock` and package-lock pin dependency resolution.
The source-build path initially targets macOS/Linux; only platforms actually tested
are qualified. NAPI-RS generates a Node-API addon usable by the selected Node runtime.

Each accepted unit gets its own commit after tests and short source review. Then
/code-review high, fixes and fresh final verification. Push public source only,
install the remote pinned Git package in isolated Pi state, then configure/deploy
through the existing config repository init path. Never hand-edit deployed defaults.
Synthetic providers prove the exercised runtime path, not improved model focus.
