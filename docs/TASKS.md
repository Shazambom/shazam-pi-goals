# Tasks and acceptance

Root reviews source and targeted evidence before committing each unit. Implementers
own only the listed files and do not commit, push or edit shared contracts. Changes
to an interface must be agreed with root before implementation.

| Unit | Owner boundary | Deliverable and acceptance | State |
| --- | --- | --- | --- |
| 0 Foundation | Root: contracts, metadata, design/tasks | Strict TS, pinned package metadata, public-safe modular spec, no-op entry | Prepared |
| 1 Checkpoint | Agent: src/checkpoint.ts, test/checkpoint.test.ts | Valid schema, branch reconstruction, stale update refusal, isolated snapshots, pause ownership, clear/restart, bounded escaped cues; targeted tests pass | Pending |
| 2 Trace | Agent: src/trace.ts and trace helper files, test/trace*.test.ts | Real buffered writer, content exclusion, aliases, caps/failures, bounded flush, interval summaries; targeted tests pass | Pending |
| 3 Pi adapter | Agent: src/integration.ts, src/index.ts, test/integration.test.ts | Actual hook contract wiring, root/owner fence, commands/tool, saved provenance, cue lifecycle, no lost original inputs; controlled integration tests pass | Pending |
| 4 Runtime/package acceptance | Agent: test/runtime.mjs, scripts/test-runtime.sh | Actual installed CLI/SDK and scripted-provider fixture, autoload + task tool/cue + trace path, restart/branch/cancel/error/private-state checks; no model account requests | Pending |
| 5 Whole-project review | Fresh independent high review | Nine finder angles, verified candidates, fixes with tests, fresh final verifier | Pending |
| 6 External installation | Root: GitHub push and config pin/deployment | Public repository, accepted-unit commits, remote third-party install in isolated state, then source-controlled Pi setup, loaded-byte/runtime check | Pending |

## Verification records

Record actual commands, results, review findings, fixes and limits here as units
are accepted. Evidence containing machine-specific paths stays under ignored
`.private/`; public tests derive their paths. No synthetic test proves model focus.
