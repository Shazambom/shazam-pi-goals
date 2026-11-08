import type { TraceKind, TraceRecorder } from './contracts.ts';
import { json, native } from './native.ts';
export interface TraceOptions {
  capabilities?: readonly TraceKind[];
  runtimeVersion?: string;
  notice?: (code: 'recorder_unavailable') => void;
}
export function createTrace(directory: string, options: TraceOptions = {}): TraceRecorder {
  try {
    const recorder = new (native().NativeTrace)(directory, json({
      capabilities: options.capabilities ?? [], runtimeVersion: options.runtimeVersion ?? 'unknown',
    }));
    return {
      beginSession: () => recorder.beginSession(),
      event: (kind, input = {}) => recorder.event(kind, json(Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
      ))),
      summary: async () => recorder.summary(),
      close: () => recorder.close(),
    };
  } catch {
    try { options.notice?.('recorder_unavailable'); } catch { /* Diagnostics cannot break the caller. */ }
    return {
      beginSession() {}, event() {},
      async summary() { return 'Phase recording unavailable'; }, async close() {},
    };
  }
}
