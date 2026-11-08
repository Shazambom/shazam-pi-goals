# shazam-pi-goals

A modular Pi extension combining advisory task checkpoints and local phase traces.
Read docs/DESIGN.md and docs/TASKS.md before changing module contracts.

- Prefer Bash for setup, packaging, installation and test orchestration. Runtime
  extension code uses strict TypeScript because Pi and selected libraries require it.
- Keep checkpoint policy, passive trace recording and Pi lifecycle wiring separate.
  No new scheduler, provider client, completion controller or database.
- Do not log prompts, reasoning, tool arguments/results, credentials or raw errors.
- Keep tunable limits as code constants, not environment feature switches.
- Use paths derived from repository/scripts, HOME or system temporary directories.
- Tests use synthetic data and scripted providers, never credentials or paid calls.
- Never execute a PATH Pi wrapper to discover/version a runtime; inspect and resolve
  the real CLI first. Public docs must not include private user/session evidence.
- Root owns shared contracts, package metadata, integration, review and commits.
  Delegated implementers edit only their assigned files, never commit or push.
- Each accepted unit gets one commit after targeted tests and a short source review.
  Record actual validation and limits in docs/TASKS.md; do not claim tests not run.
