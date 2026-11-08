import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTrace } from '../src/trace.ts';

test('native trace bridge retains missing tool IDs as unknown correlation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shazam-native-bridge-'));
  try {
    const trace = createTrace(directory);
    trace.beginSession('PRIVATE_SESSION');
    trace.event('run_start');
    trace.event('request_start');
    trace.event('tool_start', { toolCallId: undefined });
    trace.event('tool_end', { toolCallId: undefined, outcome: 'ok' });
    await trace.close();
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    const content = await readFile(join(directory, files[0]!), 'utf8');
    assert(!content.includes('PRIVATE_SESSION'));
    const records = content.trim().split('\n').map(line => JSON.parse(line));
    for (const event of ['tool_start', 'tool_end']) {
      const record = records.find(record => record.event === event);
      assert(record, `${event} crosses TypeScript/NAPI/Rust boundary`);
      assert.equal(record.gap, 'unknown_correlation');
      assert.equal(record.tool, undefined);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
