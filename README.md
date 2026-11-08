# shazam-pi-goals

A Pi extension combining task checkpoints and local phase diagnostics. The core
is Rust, with a strict TypeScript adapter for Pi. It does not schedule work, call
another model, or perform automatic completion review.

## Development

Requirements: Node >=22.19, Rust >=1.88 and a C linker. Build and test commands:

```bash
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
cargo test --manifest-path native/Cargo.toml --locked
```

Bash scripts own build/install orchestration; NAPI-RS supplies the native binding.
The dependency locks are committed. Native output is generated and not committed.

## Installation

After a release or reviewed commit is published:

```bash
pi install git:github.com/Shazambom/shazam-pi-goals@<reviewed-commit>
```

Pi installs dependencies and runs the package's Bash build script. Rust and a C
linker must already be installed. The installer never installs global tools or a
Rust toolchain. macOS/Linux source builds are intended; only tested platforms will
be listed in the acceptance record. No prebuilt binary distribution is promised.

When Pi is managed by another configuration repository, declare the Git pin in its
source settings and use its setup entry point rather than editing deployed defaults.
Restart/reload the affected Pi session after changing extension loading.

## Capabilities and limits

`task_checkpoint` reads or replaces one sourced task note. `/checkpoint` inspects
it; pause/resume/clear control commands require UI confirmation because Pi command
handlers do not provide trustworthy input-source provenance. Ordinary tool updates,
startup and task execution never request confirmation. Confirmed pause cannot be
cleared by a model note update. Clear preserves history rather than securely erasing it.

Checkpoint writes and cues require the host's `subagents:identity` and
`session-lifecycle:admission` root ownership contracts. Without them checkpoints
report unavailable; passive tracing still operates. These host-specific contracts
are qualified against the installed runtime, not claimed as universal Pi APIs.

`/phase-trace` summarizes local observed timings. It excludes prompts, reasoning,
tool arguments/results and raw identifiers. It cannot distinguish server queueing
from model computation or diagnose reasoning quality. Missing milestones remain
unknown. Recordings are bounded individually, but users must remove old files;
there is no automatic historical disk quota. Crashes can lose buffered records.

See [design](docs/DESIGN.md) and [task acceptance](docs/TASKS.md) for module boundaries,
qualification status and known limits. Runtime tests use synthetic data, not model
accounts. Passing those tests does not establish improved long-task focus.

## Removal

Remove the package declaration through the same configuration/install path, then
reload affected sessions. Task notes stay in native history and diagnostic files
stay on disk for manual cleanup. No provider work is owned by this plugin.
