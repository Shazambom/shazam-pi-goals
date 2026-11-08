import { createRequire } from 'node:module';

interface NativeRecorder {
  beginSession(): void;
  event(kind: string, input: string): void;
  summary(): string;
  close(): Promise<void>;
}
interface NativeBinding {
  checkpointRestore(entries: string): string;
  checkpointReplace(view: string, revision: string, note: string): string;
  checkpointControl(action: string): string;
  checkpointRender(view: string): string | null;
  checkpointVerifySaved(file: string, sessionId: string, entries: string): Promise<boolean>;
  NativeTrace: new (directory: string, options: string) => NativeRecorder;
}
let binding: NativeBinding | undefined;
export function native(): NativeBinding {
  binding ??= createRequire(import.meta.url)('../native/index.node') as NativeBinding;
  return binding;
}

/** JSON-only FFI input: do not invoke user-defined accessors or toJSON methods. */
export function json(value: unknown): string {
  const visiting = new Set<object>();
  let visited = 0;
  function check(item: unknown, depth: number): void {
    if (++visited > 100_000 || depth > 64) throw new Error('invalid_json_input');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || visiting.has(item)) throw new Error('invalid_json_input');
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) throw new Error('invalid_json_input');
    visiting.add(item);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === 'length') continue;
      if (!('value' in descriptor) || !descriptor.enumerable) throw new Error('invalid_json_input');
      check(descriptor.value, depth + 1);
    }
    visiting.delete(item);
  }
  check(value, 0);
  try { return JSON.stringify(value); }
  catch { throw new Error('invalid_json_input'); }
}
