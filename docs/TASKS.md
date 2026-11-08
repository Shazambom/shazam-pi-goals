# Tasks and acceptance

Root reviews source and targeted evidence before committing each unit. Implementers
own only the listed files and do not commit, push or edit shared contracts. Changes
to an interface must be agreed with root before implementation.

| Unit | Owner boundary | Deliverable and acceptance | State |
| --- | --- | --- | --- |
| 0 Foundation | Root: contracts, metadata, design/tasks | Strict TS, pinned package metadata, public-safe modular spec, no-op entry | Accepted |
| 1 Checkpoint | Agent: native/src/checkpoint.rs; root: NAPI and TS facade | Valid schema, branch reconstruction, stale update refusal, isolated snapshots, pause ownership, clear/restart, bounded escaped cues; targeted tests pass | Accepted |
| 2 Trace | Agent: native/src/trace.rs; root: NAPI and TS facade | Real buffered writer, content exclusion, aliases, caps/failures, bounded flush, interval summaries; targeted tests pass | Pending |
| 3 Pi adapter | Agent: src/integration.ts, src/index.ts, test/integration.test.ts | Actual hook contract wiring, root/owner fence, commands/tool, saved provenance, cue lifecycle, no lost original inputs; controlled integration tests pass | Pending |
| 4 Runtime/package acceptance | Agent: test/runtime.mjs, scripts/test-runtime.sh | Actual installed CLI/SDK and scripted-provider fixture, autoload + task tool/cue + trace path, restart/branch/cancel/error/private-state checks; no model account requests | Pending |
| 5 Whole-project review | Fresh independent high review | Nine finder angles, verified candidates, fixes with tests, fresh final verifier | Pending |
| 6 External installation | Root: GitHub push and config pin/deployment | Public repository, accepted-unit commits, remote third-party install in isolated state, then source-controlled Pi setup, loaded-byte/runtime check | Pending |

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
