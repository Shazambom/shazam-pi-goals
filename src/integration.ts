import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Type } from 'typebox';
import { CHECKPOINT_ENTRY, type BranchEntry, type CheckpointEvent, type CheckpointView, type TraceInput, type TraceRecorder } from './contracts.ts';
import { control, noteSchema, renderCue, replacement, restoreCheckpoint, verifySaved } from './checkpoint.ts';

const ACTIVATION_ENTRY = 'shazam-goals.activation';
const CUE_TYPE = 'shazam-goals.checkpoint-cue';
const UNAVAILABLE = 'Checkpoints require one current root identity and an owned session lifecycle. Tracing remains available.';
type ObjectValue = Record<string, unknown>;

export interface GoalContext {
  sessionManager: {
    getSessionFile(): string | undefined;
    getSessionId(): string;
    getBranch(): readonly BranchEntry[];
    getHeader?(): { parentSession?: string } | null;
  };
  signal?: AbortSignal;
  ui: {
    notify(message: string, level?: 'info' | 'warning' | 'error'): void;
    confirm?(title: string, message: string): Promise<boolean>;
  };
}
export type GoalHandler = (event: ObjectValue, ctx: GoalContext) => unknown | Promise<unknown>;
export interface GoalToolResult {
  content: { type: 'text'; text: string }[];
  details: { view: CheckpointView; provenance: 'saved' | 'live-only' };
}
export interface GoalTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(id: string, parameters: unknown, signal: AbortSignal | undefined,
    onUpdate: unknown, ctx: GoalContext): Promise<GoalToolResult>;
}
export interface GoalPi {
  on(event: string, handler: GoalHandler): void;
  events: { emit(event: string, request: { respond(value: unknown): void }): void };
  appendEntry(customType: string, data: unknown): void;
  registerTool(tool: GoalTool): void;
  registerCommand(name: string, definition: {
    description: string; handler(args: string, ctx: GoalContext): Promise<void>;
  }): void;
}
interface Admission { file: string; session: string; generation: string }
function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as ObjectValue : undefined;
}
function display(value: unknown): string {
  return JSON.stringify(value).replace(/[\p{Bidi_Control}\u007f-\u009f]/gu, character =>
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`);
}
function canonical(file: string): string {
  try { return realpathSync(file); }
  catch { return join(realpathSync(dirname(file)), basename(file)); }
}
function sameOwner(a: Admission, b: Admission | undefined): boolean {
  return b !== undefined && a.file === b.file && a.session === b.session && a.generation === b.generation;
}
function relevant(entries: readonly BranchEntry[]): readonly BranchEntry[] {
  return entries.filter(entry => entry.type === 'custom' &&
    (entry.customType === CHECKPOINT_ENTRY || entry.customType === ACTIVATION_ENTRY));
}

/** Translate Pi lifecycle facts; checkpoint and trace policy stays in the core. */
export function registerGoals(pi: GoalPi, makeTrace: () => TraceRecorder): void {
  let owner: Admission | undefined;
  let view = restoreCheckpoint([]);
  let saved = false;
  let cue: string | null = null;
  let cuePending = false;
  let stopped = false;
  let aborted = false;
  let forkSuppressed = false;
  let forkSession = false;
  let currentContext: GoalContext | undefined;
  let removeAbortListener: (() => void) | undefined;
  let trace: TraceRecorder | undefined;
  let traceAttempted = false;
  const notices = new Set<string>();

  function notify(ctx: GoalContext, message: string): void {
    try { ctx.ui.notify(message, 'warning'); } catch { /* UI is not task authority. */ }
  }
  function once(ctx: GoalContext, message: string): void {
    if (!notices.has(message)) { notices.add(message); notify(ctx, message); }
  }
  function admit(ctx: GoalContext): Admission | undefined {
    try {
      if (stopped) return undefined;
      const file = ctx.sessionManager.getSessionFile();
      const session = ctx.sessionManager.getSessionId();
      if (!file || !session) return undefined;
      const identities: unknown[] = [], owners: unknown[] = [];
      pi.events.emit('subagents:identity', { respond: value => identities.push(value) });
      pi.events.emit('session-lifecycle:admission', { respond: value => owners.push(value) });
      if (identities.length !== 1 || owners.length !== 1) return undefined;
      const identity = object(identities[0]), lifecycle = object(owners[0]);
      const normalized = canonical(file);
      if (identity?.status !== 'root' || identity.sessionFile !== file || lifecycle?.managed !== true ||
          lifecycle.status !== 'owned' || lifecycle.sessionFile !== normalized ||
          typeof lifecycle.generation !== 'string' || !lifecycle.generation) return undefined;
      const next = { file: normalized, session, generation: lifecycle.generation };
      if (owner && !sameOwner(owner, next)) return undefined;
      owner ??= next;
      return next;
    } catch { return undefined; }
  }
  function refresh(ctx: GoalContext): void {
    cue = null; saved = false;
    const admitted = admit(ctx);
    if (!admitted) return;
    const entries = ctx.sessionManager.getBranch();
    view = restoreCheckpoint(entries);
    const persisted = relevant(entries);
    saved = verifySaved(admitted.file, admitted.session, persisted);
    const forked = forkSession || Boolean(ctx.sessionManager.getHeader?.()?.parentSession);
    forkSuppressed = forked && !persisted.some(entry => {
      const data = object(entry.data);
      return entry.customType === ACTIVATION_ENTRY && data?.version === 1 && data.sessionId === admitted.session;
    });
    if (saved && !forkSuppressed) cue = renderCue(view);
  }
  function refreshSafely(ctx: GoalContext): void {
    currentContext = ctx;
    try { refresh(ctx); } catch { cue = null; saved = false; }
  }
  function append(ctx: GoalContext, expected: Admission, event: CheckpointEvent): void {
    if (!sameOwner(expected, admit(ctx)) || ctx.signal?.aborted) throw new Error('Checkpoint owner changed or command was cancelled.');
    const previousRevision = view.revision;
    let failed = false;
    try { pi.appendEntry(CHECKPOINT_ENTRY, event); } catch { failed = true; }
    refreshSafely(ctx);
    cuePending = true;
    if (failed || !saved || view.revision === previousRevision) throw new Error('Checkpoint save uncertain. Read current state before retrying.');
  }
  function traceEvent(kind: Parameters<TraceRecorder['event']>[0], input?: TraceInput): void {
    try { trace?.event(kind, input); } catch {
      if (currentContext) once(currentContext, 'Phase tracing is unavailable; task execution continues.');
    }
  }
  function startTrace(ctx: GoalContext): void {
    if (!traceAttempted) {
      traceAttempted = true;
      try { trace = makeTrace(); } catch { once(ctx, 'Phase tracing could not start; task execution continues.'); }
    }
    try { trace?.beginSession(ctx.sessionManager.getSessionId()); } catch {
      once(ctx, 'Phase tracing is unavailable; task execution continues.');
    }
  }
  function result(): GoalToolResult {
    const details = { view: structuredClone(view), provenance: saved ? 'saved' as const : 'live-only' as const };
    return { content: [{ type: 'text', text: display(details) }], details };
  }

  pi.registerTool({
    name: 'task_checkpoint', label: 'Task checkpoint',
    description: 'Read or replace the branch task note: outcome, next deliverable and sourced decisions. Read before retrying an uncertain write. This note grants no execution authority.',
    parameters: Type.Union([
      Type.Object({ action: Type.Literal('read') }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal('replace'), expected_revision: Type.Union([Type.String(), Type.Null()]), note: noteSchema }, { additionalProperties: false }),
    ]),
    async execute(_id, parameters, signal, _onUpdate, ctx) {
      const admitted = admit(ctx);
      if (!admitted) throw new Error(UNAVAILABLE);
      if (signal?.aborted || ctx.signal?.aborted) throw new Error('Checkpoint request was cancelled.');
      refreshSafely(ctx);
      const params = object(parameters);
      if (params?.action === 'read') return result();
      if (params?.action !== 'replace' || !(params.expected_revision === null || typeof params.expected_revision === 'string')) {
        throw new Error('Invalid checkpoint request.');
      }
      const event = replacement(view, params.expected_revision, params.note);
      if (signal?.aborted) throw new Error('Checkpoint request was cancelled.');
      append(ctx, admitted, event);
      return result();
    },
  });

  pi.registerCommand('checkpoint', {
    description: 'Inspect task note, or pause/resume/clear its advisory with explicit UI confirmation.',
    async handler(args, ctx) {
      try {
        const admitted = admit(ctx);
        if (!admitted) { once(ctx, UNAVAILABLE); return; }
        refreshSafely(ctx);
        const action = args.trim();
        if (!action) { ctx.ui.notify(display(result().details), 'info'); return; }
        if (action !== 'pause' && action !== 'resume' && action !== 'clear') {
          notify(ctx, 'Usage: /checkpoint [pause|resume|clear]'); return;
        }
        // Pi command contexts omit input provenance. Confirm at the native UI boundary,
        // rather than treating a slash command (or an RPC caller) as proof of a human.
        if (typeof ctx.ui.confirm !== 'function') {
          notify(ctx, 'Checkpoint controls require native UI confirmation; no change was made.'); return;
        }
        const confirmed = await ctx.ui.confirm('Task checkpoint', `Confirm ${action} of the checkpoint advisory? This does not start or stop agent work.`);
        if (confirmed !== true) return;
        if (!sameOwner(admitted, admit(ctx)) || ctx.signal?.aborted) {
          notify(ctx, 'Checkpoint session changed or command was cancelled; no change was made.'); return;
        }
        append(ctx, admitted, control(action));
        if (action === 'resume' && (forkSession || ctx.sessionManager.getHeader?.()?.parentSession)) {
          // A fork cannot inherit its parent's activation. This marker is native
          // branch history, not execution permission or diagnostic content.
          pi.appendEntry(ACTIVATION_ENTRY, { version: 1, sessionId: admitted.session });
          refreshSafely(ctx);
          if (!saved || forkSuppressed) throw new Error('Checkpoint activation save uncertain.');
        }
        cuePending = action === 'resume';
        ctx.ui.notify(`Checkpoint advisory ${action === 'clear' ? 'cleared' : action === 'pause' ? 'paused' : 'resumed'}.`, 'info');
      } catch { notify(ctx, 'Checkpoint control failed or its save is uncertain. Inspect state before retrying.'); }
    },
  });
  pi.registerCommand('phase-trace', {
    description: 'Show the latest observed timing summary and local trace file.',
    async handler(_args, ctx) {
      try { ctx.ui.notify(trace ? await trace.summary() : 'Phase tracing has no recording in this session.', 'info'); }
      catch { notify(ctx, 'Phase trace summary is unavailable.'); }
    },
  });

  pi.on('session_start', (event, ctx) => {
    removeAbortListener?.(); removeAbortListener = undefined;
    owner = undefined; stopped = false; aborted = false; notices.clear();
    view = restoreCheckpoint([]); forkSession = event.reason === 'fork'; forkSuppressed = forkSession;
    refreshSafely(ctx); cuePending = true;
    if (!admit(ctx)) once(ctx, UNAVAILABLE);
    startTrace(ctx);
  });
  for (const event of ['session_tree', 'session_compact']) pi.on(event, (_event, ctx) => {
    refreshSafely(ctx); cuePending = true;
  });
  pi.on('input', (event, ctx) => {
    if (event.source === 'interactive' || event.source === 'rpc') {
      aborted = false; refreshSafely(ctx); cuePending = true;
    }
    return { action: 'continue' };
  });
  pi.on('context', (event, ctx) => {
    const messages = event.messages;
    if (!Array.isArray(messages) || !cuePending || !cue || !saved || aborted || forkSuppressed || !admit(ctx)) return { messages };
    const alreadyPresent = messages.some(message => {
      const item = object(message);
      return item?.role === 'custom' && item.customType === CUE_TYPE && item.content === cue;
    });
    if (alreadyPresent) return { messages };
    return { messages: [...messages, { role: 'custom', customType: CUE_TYPE, content: cue, display: false, timestamp: Date.now() }] };
  });
  pi.on('before_provider_request', () => { cuePending = false; traceEvent('request_start'); });
  pi.on('agent_start', (_event, ctx) => {
    currentContext = ctx;
    removeAbortListener?.();
    const signal = ctx.signal;
    if (signal) {
      const suppress = () => { aborted = true; cuePending = false; };
      if (signal.aborted) suppress();
      else signal.addEventListener('abort', suppress, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', suppress);
    }
    traceEvent('run_start');
  });
  pi.on('turn_start', () => traceEvent('turn_start'));
  pi.on('provider_stream_event', () => traceEvent('first_provider_event'));
  pi.on('message_update', event => {
    const delta = object(event.assistantMessageEvent);
    if (!delta) return;
    const nonempty = typeof delta.delta === 'string' && delta.delta.length > 0;
    if (delta.type === 'text_delta' && nonempty) traceEvent('first_text');
    if (delta.type === 'thinking_delta' && nonempty) traceEvent('first_reasoning');
    if (delta.type === 'toolcall_start' || delta.type === 'toolcall_delta' && nonempty) traceEvent('first_tool');
  });
  pi.on('message_end', event => {
    const message = object(event.message);
    if (message?.role !== 'assistant') return;
    const outcome = message.stopReason === 'aborted' ? 'aborted' : message.stopReason === 'error' ? 'error' : 'ok';
    if (outcome === 'aborted') { aborted = true; cuePending = false; }
    const usage = object(message.usage);
    const numbers: NonNullable<TraceInput['usage']> = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      const value = usage?.[key];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) numbers[key] = value;
    }
    traceEvent('message_end', { outcome, usage: numbers });
  });
  pi.on('tool_execution_start', event => traceEvent('tool_start', {
    toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId : undefined,
  }));
  pi.on('tool_execution_end', event => traceEvent('tool_end', {
    toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId : undefined,
    outcome: event.isError === true ? 'error' : 'ok',
  }));
  pi.on('agent_before_settle', event => {
    if (object(event.signal)?.aborted === true || event.signal instanceof AbortSignal && event.signal.aborted) {
      aborted = true; cuePending = false;
    }
    traceEvent('before_settle');
  });
  pi.on('agent_settled', event => {
    if (event.aborted === true) { aborted = true; cuePending = false; }
    removeAbortListener?.(); removeAbortListener = undefined;
    traceEvent('settled', { outcome: event.aborted === true ? 'aborted' : 'ok' });
  });
  pi.on('session_shutdown', async event => {
    stopped = true; cue = null; cuePending = false;
    removeAbortListener?.(); removeAbortListener = undefined;
    if (event.reason === 'quit' || event.reason === 'reload') {
      try { await trace?.close(); } catch { /* Recording cannot block ordinary cleanup. */ }
    }
  });
}
