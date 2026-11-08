# Tasks and acceptance

Root reviews source and targeted evidence before committing each unit. Implementers
own only the listed files and do not commit, push or edit shared contracts. Changes
to an interface must be agreed with root before implementation.

| Unit | Owner boundary | Deliverable and acceptance | State |
| --- | --- | --- | --- |
| 0 Foundation | Root: contracts, metadata, design/tasks | Strict TS, pinned package metadata, public-safe modular spec, no-op entry | Accepted |
| 1 Checkpoint | Agent: native/src/checkpoint.rs; root: NAPI and TS facade | Valid schema, branch reconstruction, stale update refusal, isolated snapshots, pause ownership, clear/restart, bounded escaped cues; targeted tests pass | Accepted |
| 2 Trace | Agent: native/src/trace.rs; root: NAPI and TS facade | Real buffered writer, content exclusion, aliases, caps/failures, bounded flush, interval summaries; targeted tests pass | Accepted |
| 3 Pi adapter | Agent: src/integration.ts, src/index.ts, test/integration.test.ts | Actual hook contract wiring, root/owner fence, commands/tool, saved provenance, cue lifecycle, no lost original inputs; controlled integration tests pass | Accepted |
| 4 Runtime/package acceptance | Agent: test/runtime.mjs, scripts/test-runtime.sh | Actual installed CLI/SDK and scripted-provider fixture, autoload + task tool/cue + trace path, restart/branch/cancel/error/private-state checks; no model account requests | Accepted |
| 5 Whole-project review | Fresh independent high review | Nine finder angles, verified candidates, fixes with tests, fresh final verifier | Accepted |
| 6 External installation | Root: GitHub push and config pin/deployment | Public repository, accepted-unit commits, remote third-party install in isolated state, then source-controlled Pi setup, loaded-byte/runtime check | Accepted |

## Verification records

Record actual commands, results, review findings, fixes and limits here as units
are accepted. Evidence containing machine-specific paths stays under ignored
`.private/`; public tests derive their paths. No synthetic test proves model focus.

### Unit 1 — checkpoint and Rust bridge

Short source review checked branch folding, schema limits, pause ownership, saved
history verification and escaped cue rendering. Fourteen Rust checkpoint tests and
ten TypeScript-to-native checkpoint tests passed. The addon built with Cargo 1.98.1
on macOS arm64; selected Pi Node 22.23.2 loaded it. Strict TypeScript passed. Runtime
provenance remains the adapter/runtime units' responsibility. NAPI-RS, serde and the
source-build script are included here as the minimum bridge for this accepted unit.

### Unit 2 — phase recorder

Thirteen focused Rust tests and `cargo check` passed. Short review checked the
allowlisted record fields, bounded queue/maps/file, writer ownership, duplicate-ID
ambiguity, failure paths and summary calculations. Duplicate IDs retain ambiguity
until the next session/run boundary. Standard channels and buffered I/O avoid an
extra logging framework. Shutdown waits off Node's main thread, but cannot cancel
stalled filesystem I/O; live summaries disclose buffering. Clippy was unavailable.

### Unit 3 — Pi adapter

Eleven controlled adapter tests passed on Node 22 and 26; strict TypeScript passed.
The installed Pi SDK loaded the package and registered the commands/tool, turning
the initial registration assertion green. Short review checked root ownership,
confirmation rechecks, silent/uncertain saves, fork activation, input preservation,
abort suppression and fixed trace projection. Native UI confirmation is limited
to explicit control commands because host commands lack input-source provenance.
These checks do not qualify actual T3 routing or the full CLI lifecycle.

### Unit 4 — actual CLI and package boundary

`bash scripts/test-runtime.sh` passed against Pi 1.0.4 and Node 22.23.2 on macOS
arm64: 22 scripted localhost requests, five CLI processes. It exercised manifest
autoload, Rust-backed save/read, advisory context with original input, snapshot
independence, restart, SDK branch selection followed by CLI restore, confirmed and
declined RPC controls, pause ownership, abort, provider errors, unavailable/child
host behavior and content-free traces. Short review distinguished injected cues
from tool-result text and checked process cleanup and isolated credentials.
The initial behavioral failure was a fixture canonical-path mismatch; this is not
evidence of a fixed product bug. Host admission is synthetic in this fixture.

Integration checkpoint: 27 Rust tests, 22 TypeScript tests, strict typecheck and
release addon build passed. The bridge regression confirms missing tool IDs become
unknown correlation. No account model requests or long-task benchmarks ran.

### Unit 5 — review corrections

Nine independent finder angles and seven fresh candidate verifiers reviewed the
complete package. Corrections cover canonical ownership paths, provider-compatible
tool schema, cue preservation on failed-request retries, recorder closure on all
runtime teardowns, asynchronous saved-history verification, removal of the unused
trace session identifier and conservative correlation after overlapping requests.
The overlap defect is established for the core event sequence; its late-callback
impact in actual Pi remains unmeasured. No latency or model-focus gain is claimed.

Verification after corrections: 27 Rust tests, 33 TypeScript tests, strict
typecheck and native build passed. The native FIFO test proves Node can service a
timer while file opening waits; special files remain refused. Controlled races
cover competing revisions, owner/branch changes, cancellation before/after append
and nonblocking UI confirmation. Verification does not cancel underlying OS I/O.

The expanded actual CLI fixture passed twice on Pi 1.0.4/Node 22.23.2: 25 scripted
localhost requests with synthetic admission, then 25 with the deployed lifecycle
and subagent identity extensions. Both include actual Anthropic request-schema
capture and a failed request followed by a successful automatic retry. Real host
admission can create an idle runtime before replacement; the fixture accepts its
header-only trace and checks active traces separately. No actual T3 UI/bridge run,
Linux build or long-task model evaluation is claimed.

A fresh final verifier checked the corrected source and aggregate evidence at
`6e37d489941d7b04a384f4300b9891081bb16f5d`, supporting a high review with no remaining
findings. Dependency lock entries were not individually audited.

### Unit 6 — external installation and deployment

The public GitHub repository was created and the six accepted work-unit commits
were pushed. Pi installed the exact reviewed commit from its remote Git URL in
isolated agent state. Its normal dependency installation built the native addon
from Rust source with existing Cargo. The installed checkout passed another
25-request CLI fixture with the deployed lifecycle/identity extension paths.

The configuration repository declared that Git pin and deployed it through
`init.sh --pi`. Its package mapper needed a correction to preserve remote sources;
the actual isolated setup regression failed before that correction and passed after.
The configuration change was committed separately as `14543a8` without including
unrelated existing edits. A fresh configured Pi RPC process resolved the package,
loaded the native addon and registered both `checkpoint` and `phase-trace`.
The installed Git SHA matched the reviewed commit; native hashes were recorded
privately. Registration used no provider request. The remote-copy runtime test
used only the local scripted provider. Existing sessions require reload/restart.

The setup emitted an unrelated existing render-width patch warning. RPC readiness
and package loading succeeded. Full T3 integration and Linux remain unqualified.

## Rust experiment update

The user requested Rust core with TypeScript translation after the initial scaffold.
Units 1/2 now own `native/src/checkpoint.rs` / `native/src/trace.rs` and inline Rust
tests. Their abandoned TS core/stub drafts are private reference only. Unit 3 keeps
Pi adapter ownership. Root owns NAPI binding and thin TS facades; unit 4 must exercise
that boundary and packaging, and report any required fixes before acceptance.
Bash remains the orchestration language. Native source build is an explicit
installation requirement; no Rust toolchain is downloaded automatically.

Initial actual Pi SDK registration assertion failed as intended against the no-op
entry on selected Node22.23.2/Pi1.0.4. This is registration RED, not the full behavioral
runtime fixture. The latter remains unit4's mandatory acceptance gate.
