import { CHECKPOINT_ENTRY, type BranchEntry, type CheckpointEvent, type CheckpointView } from './contracts.ts';
import { json, native } from './native.ts';
import { Type } from 'typebox';

/** Pi-facing tool declaration; Rust validates every saved record and mutation. */
export const noteSchema = Type.Object({
  schema_version: Type.Literal(1),
  outcome: Type.String({ minLength: 1 }), source_ref: Type.String({ minLength: 1 }),
  origin: Type.Union([Type.Literal('user_request'), Type.Literal('agent_interpretation')]),
  next_deliverable: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  decisions: Type.Array(Type.Object({
    statement: Type.String({ minLength: 1 }), source_ref: Type.String({ minLength: 1 }),
    provenance: Type.Union([Type.Literal('accepted'), Type.Literal('proposed')]),
  }, { additionalProperties: false })),
  blocker: Type.Optional(Type.String()),
}, { additionalProperties: false });

function relevant(entries: readonly BranchEntry[]): BranchEntry[] {
  return entries.filter(entry => entry.type === 'custom'
    && (entry.customType === CHECKPOINT_ENTRY || entry.customType === 'shazam-goals.activation'))
    .map(entry => ({ id: entry.id, type: entry.type, customType: entry.customType!, data: entry.data ?? null }));
}
export function restoreCheckpoint(entries: readonly BranchEntry[]): CheckpointView {
  return JSON.parse(native().checkpointRestore(json(relevant(entries)))) as CheckpointView;
}
export function replacement(view: CheckpointView, expectedRevision: string | null, input: unknown): CheckpointEvent {
  return JSON.parse(native().checkpointReplace(json(view), json(expectedRevision), json(input))) as CheckpointEvent;
}
export function control(action: 'pause' | 'resume' | 'clear'): CheckpointEvent {
  return JSON.parse(native().checkpointControl(action)) as CheckpointEvent;
}
export function renderCue(view: CheckpointView): string | null {
  return native().checkpointRender(json(view));
}
export function verifySaved(file: string, sessionId: string, entries: readonly BranchEntry[]): boolean {
  return native().checkpointVerifySaved(file, sessionId, json(relevant(entries)));
}
