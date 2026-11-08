/** Module contracts. Runtime validation belongs to each owning module. */
export const CHECKPOINT_ENTRY = 'shazam-goals.checkpoint';
export interface Note {
  schema_version: 1;
  outcome: string;
  source_ref: string;
  origin: 'user_request' | 'agent_interpretation';
  next_deliverable: string | null;
  decisions: { statement: string; source_ref: string; provenance: 'accepted' | 'proposed' }[];
  blocker?: string;
}
export type CheckpointEvent =
  | { version: 1; action: 'replace'; note: Note }
  | { version: 1; action: 'pause' | 'resume' | 'clear' };
export interface BranchEntry {
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
}
export interface CheckpointView {
  revision: string | null;
  note: Note | null;
  paused: boolean;
}
export type TraceKind = 'run_start' | 'turn_start' | 'request_start'
  | 'first_provider_event' | 'first_text' | 'first_reasoning' | 'first_tool'
  | 'message_end' | 'tool_start' | 'tool_end' | 'cancel_requested'
  | 'before_settle' | 'settled' | 'recording_gap';
export interface TraceInput {
  toolCallId?: string;
  outcome?: 'ok' | 'error' | 'aborted';
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}
export interface TraceRecorder {
  beginSession(): void;
  event(kind: TraceKind, input?: TraceInput): void;
  summary(): Promise<string>;
  close(): Promise<void>;
}
