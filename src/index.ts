import { homedir } from 'node:os';
import { join } from 'node:path';
import { registerGoals, type GoalPi } from './integration.ts';
import { createTrace } from './trace.ts';
import type { TraceKind } from './contracts.ts';

// Only available hook observations are advertised. Abort outcomes do not imply
// that we can observe the time the user requested cancellation.
const capabilities: readonly TraceKind[] = [
  'run_start', 'turn_start', 'request_start', 'first_provider_event',
  'first_text', 'first_reasoning', 'first_tool', 'message_end', 'tool_start',
  'tool_end', 'before_settle', 'settled', 'recording_gap',
];

export default function shazamGoals(pi: GoalPi): void {
  registerGoals(pi, () => createTrace(join(
    process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'),
    'diagnostics', 'phase-trace',
  ), { capabilities }));
}
